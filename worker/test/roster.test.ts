import { beforeEach, describe, expect, test } from "bun:test";
import { boot, type TestEnv } from "./harness";
import { getRoster, type RosterCard } from "../src/roster";
import { disrupt, impactIdFor } from "../src/dev-disrupt";

let env: TestEnv;
beforeEach(async () => {
  env = await boot();
});

const NOW = new Date("2026-09-13T18:00:00Z");

async function roster(): Promise<any> {
  const res = await getRoster(env as any, "evt-busan");
  return res.json();
}
const byId = (cards: RosterCard[], id: string) => cards.find((c) => c.employeeId === id)!;

describe("the calm board — seed state, no disruption", () => {
  test("returns all 26 travellers, not just the ones on fire", async () => {
    const { cards } = await roster();
    expect(cards).toHaveLength(26);
  });

  test("24 on track, and the two structural risks still surface", async () => {
    const { counts } = await roster();
    expect(counts.on_track).toBe(24);
    expect(counts.at_risk).toBe(2);
    expect(counts.needs_you).toBe(0);
  });

  test("Grace Lombardi is at risk because she lands past the cut-off", async () => {
    // UA805 arrives 2026-09-15T19:20Z; event.arrival_by is 2026-09-15T15:00Z.
    const grace = byId((await roster()).cards, "emp-us-07");
    expect(grace.status).toBe("AT_RISK");
    expect(grace.advisory).toMatch(/after the arrival cut-off/);
  });

  test("Nora Feldman is at risk because she has no booking", async () => {
    const nora = byId((await roster()).cards, "emp-us-10");
    expect(nora.status).toBe("AT_RISK");
    expect(nora.advisory).toMatch(/No booking at all/);
  });

  test("a green card carries no advisory", async () => {
    const minjun = byId((await roster()).cards, "emp-kr-01");
    expect(minjun.status).toBe("GREEN");
    expect(minjun.advisory).toBeNull();
    expect(minjun.band).toBe("ON_TRACK");
  });

  test("the calm board is never actionable", async () => {
    const { cards } = await roster();
    expect(cards.filter((c: RosterCard) => c.canApprove)).toHaveLength(0);
  });
});

describe("after the disruption", () => {
  beforeEach(async () => {
    await disrupt(env as any, NOW);
  });

  test("four cards move to at risk, still 26 total", async () => {
    const { cards, counts } = await roster();
    expect(cards).toHaveLength(26);
    expect(counts.at_risk).toBe(6); // 4 disrupted + Grace + Nora
    expect(counts.on_track).toBe(20);
  });

  test("CRITICAL: Elena's advisory names the codeshare in plain English", async () => {
    // The sentence that justifies the entire product.
    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.advisory).toContain("DL7842");
    expect(elena.advisory).toContain("the same aircraft as cancelled KE82");
  });

  test("a marketing-KE82 traveller does NOT get the codeshare wording", async () => {
    const daniel = byId((await roster()).cards, "emp-us-01");
    expect(daniel.advisory).toContain("KE82 was cancelled");
    expect(daniel.advisory).not.toContain("same aircraft");
  });

  test("the advisory carries the best option, its price and the gate", async () => {
    const elena = byId((await roster()).cards, "emp-us-04");
    // Top offer is MIN(rank) = the $120 PASS option.
    expect(elena.advisory).toContain("Asiana 223");
    expect(elena.advisory).toContain("$120.00");
    expect(elena.policyVerdict).toBe("PASS");
    expect(elena.offerCount).toBe(3);
  });

  test("exposure sums the top offers without float drift", async () => {
    // 4 travellers x $120.00. A float would give 480.00000000000006.
    const { exposure } = await roster();
    expect(exposure.amount).toBe("480.00");
    expect(exposure.currency).toBe("USD");
  });

  test("the other codeshare is untouched", async () => {
    const alex = byId((await roster()).cards, "emp-us-06"); // DL7861 / KE24
    expect(alex.status).toBe("GREEN");
    expect(alex.impactId).toBeNull();
  });
});

describe("top offer uses MIN(rank), not rank = 1", () => {
  // schema.sql:209 — rank is a priority, not the number spoken aloud. Callers
  // renumber by position, so ranks 1/3/5 read out as 1,2,3. A `rank = 1` query
  // returns nothing once the top option is withdrawn.
  test("deleting rank 1 promotes rank 2 rather than blanking the advisory", async () => {
    await disrupt(env as any, NOW);
    const impactId = impactIdFor("emp-us-04");
    await env.DB.prepare(`DELETE FROM offer WHERE impact_id = ? AND rank = 1`)
      .bind(impactId)
      .run();

    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.advisory).toContain("Cathay Pacific"); // rank 2
    expect(elena.totalDelta).toBe("200.00");
    expect(elena.offerCount).toBe(2);
  });
});

describe("states that used to render GREEN", () => {
  beforeEach(async () => {
    await disrupt(env as any, NOW);
  });

  const setState = (state: string) =>
    env.DB.prepare(`UPDATE disruption_impact SET state = ? WHERE employee_id = 'emp-us-04'`)
      .bind(state)
      .run();

  test("EXECUTING renders BOOKING, not GREEN", async () => {
    await setState("EXECUTING");
    expect(byId((await roster()).cards, "emp-us-04").status).toBe("BOOKING");
  });

  test("CONTACTING renders CALLING, not GREEN", async () => {
    await setState("CONTACTING");
    expect(byId((await roster()).cards, "emp-us-04").status).toBe("CALLING");
  });

  test("FAILED renders FAILED and lands in its own band", async () => {
    await setState("FAILED");
    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.status).toBe("FAILED");
    expect(elena.band).toBe("FAILED");
  });
});

describe("the approval gate", () => {
  beforeEach(async () => {
    await disrupt(env as any, NOW);
  });

  test("an open approval makes the card actionable", async () => {
    const impactId = impactIdFor("emp-us-04");
    const offerId = `ofr-${impactId}-2`; // the $200 NEEDS_APPROVAL option
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE disruption_impact SET state='AWAITING_APPROVAL', selected_offer_id=? WHERE id=?`,
      ).bind(offerId, impactId),
      env.DB.prepare(`DELETE FROM offer WHERE impact_id = ? AND rank = 1`).bind(impactId),
      env.DB.prepare(
        `INSERT INTO approval (id, impact_id, offer_id, reason, requested_at)
         VALUES ('apr-test', ?, ?, 'OVER_THRESHOLD', ?)`,
      ).bind(impactId, offerId, NOW.toISOString()),
    ]);

    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.status).toBe("NEEDS_YOU");
    expect(elena.band).toBe("NEEDS_YOU");
    expect(elena.approvalId).toBe("apr-test");
    expect(elena.canApprove).toBe(true);
  });

  test("a decided approval no longer surfaces on the card", async () => {
    const impactId = impactIdFor("emp-us-04");
    await env.DB.prepare(
      `INSERT INTO approval (id, impact_id, reason, requested_at, decided_at, decision)
       VALUES ('apr-done', ?, 'OVER_THRESHOLD', ?, ?, 'APPROVED')`,
    )
      .bind(impactId, NOW.toISOString(), NOW.toISOString())
      .run();

    expect(byId((await roster()).cards, "emp-us-04").approvalId).toBeNull();
  });

  test("a FAIL verdict is never one-click — it opens the drawer", async () => {
    const impactId = impactIdFor("emp-us-04");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM offer WHERE impact_id = ?`).bind(impactId),
      env.DB.prepare(
        `INSERT INTO offer (id, impact_id, rank, policy_verdict, total_delta, currency, route_summary)
         VALUES ('ofr-fail', ?, 1, 'FAIL', '299.00', 'USD', 'United 805')`,
      ).bind(impactId),
      env.DB.prepare(
        `UPDATE disruption_impact SET state='AWAITING_APPROVAL' WHERE id=?`,
      ).bind(impactId),
      env.DB.prepare(
        `INSERT INTO approval (id, impact_id, reason, requested_at)
         VALUES ('apr-fail', ?, 'POLICY_FAIL', ?)`,
      ).bind(impactId, NOW.toISOString()),
    ]);

    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.status).toBe("NEEDS_YOU");
    expect(elena.approvalId).toBe("apr-fail");
    // A judgement call, not a one-click.
    expect(elena.canApprove).toBe(false);
  });
});

describe("query hygiene", () => {
  test("scoping does not leak another org's employees", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO org (id, name) VALUES ('org-other', 'Someone Else')`),
      env.DB.prepare(
        `INSERT INTO employee (id, org_id, name, status) VALUES ('emp-x', 'org-other', 'Intruder', 'OK')`,
      ),
    ]);
    const { cards } = await roster();
    expect(cards).toHaveLength(26);
    expect(cards.find((c: RosterCard) => c.employeeId === "emp-x")).toBeUndefined();
  });

  test("one row per employee even with multiple itineraries and dispatches", async () => {
    await disrupt(env as any, NOW);
    const impactId = impactIdFor("emp-us-04");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatch (id, kind, impact_id, employee_id, idempotency_key, status, created_at)
         VALUES ('dsp-1','CALL_EMPLOYEE',?, 'emp-us-04','k1','RESOLVED','2026-09-13T10:00:00Z')`,
      ).bind(impactId),
      env.DB.prepare(
        `INSERT INTO dispatch (id, kind, impact_id, employee_id, idempotency_key, status, created_at)
         VALUES ('dsp-2','CALL_EMPLOYEE',?, 'emp-us-04','k2','IN_CALL','2026-09-13T11:00:00Z')`,
      ).bind(impactId),
    ]);

    const { cards } = await roster();
    expect(cards).toHaveLength(26);
    expect(cards.filter((c: RosterCard) => c.employeeId === "emp-us-04")).toHaveLength(1);
    // Most recent dispatch wins.
    expect(byId(cards, "emp-us-04").status).toBe("CALLING");
  });

  test("an unknown event id yields no cards rather than an error", async () => {
    const res = await getRoster(env as any, "evt-nope");
    expect(res.status).toBe(200);
    expect((await res.json()).cards).toHaveLength(0);
  });
});

describe("REGRESSION: a parked card describes what is actually parked", () => {
  // Found by driving it live, not by the suite. The advisory read the
  // top-ranked offer unconditionally, so a card parked on the $200 option
  // rendered "NEEDS_YOU" above a description of the $120 in-policy option and
  // the words "the agent may book it alone" — misdescribing the very charge the
  // coordinator was about to authorise. The earlier tests hid it by deleting
  // rank 1 to force the scenario.
  beforeEach(async () => {
    await disrupt(env as any, NOW);
    const impactId = impactIdFor("emp-us-04");
    const parked = `ofr-${impactId}-2`; // $200, NEEDS_APPROVAL — NOT rank 1
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE disruption_impact SET state='AWAITING_APPROVAL', selected_offer_id=? WHERE id=?`,
      ).bind(parked, impactId),
      env.DB.prepare(
        `INSERT INTO approval (id, impact_id, offer_id, reason, requested_at)
         VALUES ('apr-parked', ?, ?, 'OVER_THRESHOLD', ?)`,
      ).bind(impactId, parked, NOW.toISOString()),
    ]);
  });

  test("the advisory describes the parked offer, not the top-ranked one", async () => {
    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.advisory).toContain("Cathay Pacific"); // the $200 option
    expect(elena.advisory).toContain("$200.00");
    expect(elena.advisory).not.toContain("Asiana"); // rank 1, NOT what is parked
  });

  test("it does not claim the agent may act alone on a gated option", async () => {
    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.advisory).not.toContain("may book it alone");
    expect(elena.policyVerdict).toBe("NEEDS_APPROVAL");
    expect(elena.totalDelta).toBe("200.00");
  });

  test("a card that needs approval can actually be approved", async () => {
    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.status).toBe("NEEDS_YOU");
    expect(elena.approvalId).toBe("apr-parked");
    expect(elena.canApprove).toBe(true);
  });

  test("an unparked card still falls back to the top-ranked offer", async () => {
    const daniel = byId((await roster()).cards, "emp-us-01");
    expect(daniel.advisory).toContain("Asiana 223");
    expect(daniel.totalDelta).toBe("120.00");
  });
});

describe("REGRESSION: structural risk is not 'Agent working'", () => {
  // Reported by the frontend build. bandFor sent every AT_RISK card to WORKING,
  // so on a CALM board Grace and Nora — the only two non-green cards — sat
  // under "Agent working" while no agent was working on them. Telling the
  // coordinator something is in hand when nothing is, on the screen she looks
  // at 95% of the time.
  test("Grace and Nora sit in AT_RISK, not WORKING, on a calm board", async () => {
    const { cards } = await roster();
    for (const id of ["emp-us-07", "emp-us-10"]) {
      const c = byId(cards, id);
      expect(c.status).toBe("AT_RISK");
      expect(c.impactId).toBeNull();
      expect(c.band, `${c.name} has no impact row — nobody is working on them`).toBe("AT_RISK");
    }
  });

  test("a calm board puts nothing in the Agent working band", async () => {
    const { cards } = await roster();
    expect(cards.filter((c: RosterCard) => c.band === "WORKING")).toHaveLength(0);
  });

  test("but a triaged traveller IS agent-working", async () => {
    await disrupt(env as any, NOW);
    const elena = byId((await roster()).cards, "emp-us-04");
    expect(elena.status).toBe("AT_RISK");
    expect(elena.impactId).not.toBeNull();
    expect(elena.band).toBe("WORKING");
  });
});

describe("REGRESSION: a resolved card is a receipt, not a blank", () => {
  // Also from the frontend build. The query filtered `imp.state <> 'RESOLVED'`,
  // so a resolved traveller lost their impact, their offer and their advisory.
  // "Resolved today" is the band that shows the agent actually did the work;
  // rendering it as nameless boxes threw away the evidence.
  beforeEach(async () => {
    await disrupt(env as any, NOW);
    const impactId = impactIdFor("emp-us-03"); // Marcus Bell
    await env.DB.prepare(
      `UPDATE disruption_impact
          SET state='RESOLVED', selected_offer_id=?, state_changed_at=?
        WHERE id=?`,
    )
      .bind(`ofr-${impactId}-1`, NOW.toISOString(), impactId)
      .run();
  });

  test("the advisory says what was booked and what it cost", async () => {
    const marcus = byId((await roster()).cards, "emp-us-03");
    expect(marcus.status).toBe("RESOLVED");
    expect(marcus.band).toBe("RESOLVED");
    expect(marcus.advisory).toContain("Rebooked to");
    expect(marcus.advisory).toContain("Asiana 223");
    expect(marcus.advisory).toContain("$120.00");
  });

  test("it records whether the agent acted alone or a human authorised it", async () => {
    const marcus = byId((await roster()).cards, "emp-us-03");
    // The $120 option was PASS, so the agent booked it unaided.
    expect(marcus.advisory).toContain("agent acted alone");
  });

  test("a live impact still outranks a resolved one", async () => {
    // Marcus gets a second, live impact — the card must follow that, not the
    // stale resolved one.
    await env.DB.prepare(
      `INSERT INTO disruption_impact (id, event_id, employee_id, state, state_changed_at)
       VALUES ('imp-live', 'dsr-ke82-20260914', 'emp-us-03', 'AWAITING_APPROVAL', ?)`,
    )
      .bind("2026-09-13T19:00:00Z")
      .run();

    const marcus = byId((await roster()).cards, "emp-us-03");
    expect(marcus.status).toBe("NEEDS_YOU");
    expect(marcus.impactId).toBe("imp-live");
  });
});
