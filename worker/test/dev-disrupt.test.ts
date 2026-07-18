import { beforeEach, describe, expect, test } from "bun:test";
import { boot, scalar, type TestEnv } from "./harness";
import {
  disrupt,
  findAffected,
  impactIdFor,
  reset,
  DISRUPT_EVENT_ID,
} from "../src/dev-disrupt";

let env: TestEnv;
beforeEach(async () => {
  env = await boot();
});

const NOW = new Date("2026-09-13T18:00:00Z");
const run = () => disrupt(env as any, NOW);

describe("CRITICAL: the codeshare match", () => {
  // HACKATHON_CONTEXT.md:53 — "finding the fourth is the whole point."
  // Elena Duarte is ticketed on marketing DL7842, flown as KE82. A query that
  // matches only on marketing carrier strands her while the board reports
  // all-clear.
  test("cancelling KE82 catches exactly four travellers", async () => {
    const affected = await findAffected(env as any);
    expect(affected).toHaveLength(4);
  });

  test("Elena Duarte is among them, via the operating-carrier branch", async () => {
    const affected = await findAffected(env as any);
    const elena = affected.find((a) => a.employee_id === "emp-us-04");

    expect(elena, "emp-us-04 must be caught by the codeshare branch").toBeDefined();
    expect(elena!.employee_name).toBe("Elena Duarte");
    // She is ONLY reachable this way: her marketing identity is not KE82.
    expect(elena!.marketing).toBe("DL7842");
    expect(elena!.operating).toBe("KE82");
  });

  test("the three marketing-KE82 travellers are caught too", async () => {
    const ids = (await findAffected(env as any)).map((a) => a.employee_id).sort();
    expect(ids).toEqual(["emp-us-01", "emp-us-02", "emp-us-03", "emp-us-04"]);
  });

  test("the OTHER codeshare is left alone — no special-casing flight 82", async () => {
    // seed.sql ships DL7861 flown as KE24 (emp-us-06) precisely so a fix that
    // hardcodes flight 82 gets caught here.
    const ids = (await findAffected(env as any)).map((a) => a.employee_id);
    expect(ids).not.toContain("emp-us-06");
  });

  test("unaffected travellers stay unaffected", async () => {
    const ids = (await findAffected(env as any)).map((a) => a.employee_id);
    for (const untouched of ["emp-us-05", "emp-us-07", "emp-us-08", "emp-kr-01"]) {
      expect(ids).not.toContain(untouched);
    }
  });
});

describe("writes the right shape", () => {
  test("one event, four impacts, twelve offers", async () => {
    await run();
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_event`)).toBe(1);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_impact`)).toBe(4);
    // Offers are per impact, not per event: 4 x 3 = 12, not 3.
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM offer`)).toBe(12);
  });

  test("every impact gets its own three offers", async () => {
    await run();
    const { results } = await env.DB.prepare(
      `SELECT impact_id, COUNT(*) AS n FROM offer GROUP BY impact_id`,
    ).all<{ impact_id: string; n: number }>();
    expect(results).toHaveLength(4);
    for (const r of results!) expect(r.n).toBe(3);
  });

  test("impacts start at TRIAGING and carry the staleness guard", async () => {
    await run();
    const row = await env.DB.prepare(
      `SELECT state, matched_segment_id, matched_num_updates
         FROM disruption_impact WHERE employee_id = 'emp-us-04'`,
    ).first<{ state: string; matched_segment_id: string; matched_num_updates: number }>();

    expect(row!.state).toBe("TRIAGING");
    expect(row!.matched_segment_id).toBe("seg-us-04");
    // DATA_MODEL.md:225 — compared before acting so a drifted itinerary
    // re-triages instead of applying a stale decision.
    expect(row!.matched_num_updates).toBe(1);
  });
});

describe("offers: cached economics, never cached IDs", () => {
  test("provider_offer_id and expires_at are NULL", async () => {
    await run();
    // A cached provider_offer_id is guaranteed dead by demo time (offers live
    // ~20 min) and confirm-choice.ts:115 enforces expires_at — it would fail
    // politely and nothing would book.
    const n = await scalar<number>(
      env,
      `SELECT COUNT(*) FROM offer WHERE provider_offer_id IS NOT NULL OR expires_at IS NOT NULL`,
    );
    expect(n).toBe(0);
  });

  test("the policy split is one PASS and two NEEDS_APPROVAL per impact", async () => {
    await run();
    const impactId = impactIdFor("emp-us-04");
    const { results } = await env.DB.prepare(
      `SELECT rank, total_delta, policy_verdict FROM offer
        WHERE impact_id = ? ORDER BY rank`,
    )
      .bind(impactId)
      .all<{ rank: number; total_delta: string; policy_verdict: string }>();

    expect(results).toEqual([
      { rank: 1, total_delta: "120.00", policy_verdict: "PASS" },
      { rank: 2, total_delta: "200.00", policy_verdict: "NEEDS_APPROVAL" },
      { rank: 3, total_delta: "299.00", policy_verdict: "NEEDS_APPROVAL" },
    ]);
  });

  test("verdicts agree with the policy threshold actually in the database", async () => {
    await run();
    // Not hardcoded: read the threshold and check every offer against it, so
    // retuning pol-flight without retuning the offers fails here.
    const threshold = Number(
      await scalar<string>(
        env,
        `SELECT requires_approval_over FROM policy WHERE id = 'pol-flight'`,
      ),
    );
    const { results } = await env.DB.prepare(
      `SELECT total_delta, policy_verdict FROM offer`,
    ).all<{ total_delta: string; policy_verdict: string }>();

    for (const o of results!) {
      const expected = Number(o.total_delta) > threshold ? "NEEDS_APPROVAL" : "PASS";
      expect(o.policy_verdict, `$${o.total_delta} vs threshold $${threshold}`).toBe(expected);
    }
  });

  test("money is stored as decimal strings, never floats", async () => {
    await run();
    const { results } = await env.DB.prepare(`SELECT total_delta FROM offer`).all<{
      total_delta: string;
    }>();
    for (const o of results!) {
      expect(typeof o.total_delta).toBe("string");
      expect(o.total_delta).toMatch(/^\d+\.\d{2}$/);
    }
  });
});

describe("idempotency — pressing the button twice cannot inflate the board", () => {
  // disruption_impact has no UNIQUE on (event_id, employee_id) — only two plain
  // indexes at schema.sql:184-185 — so determinism has to come from the ids.
  test("running twice leaves the same counts", async () => {
    await run();
    await run();
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_event`)).toBe(1);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_impact`)).toBe(4);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM offer`)).toBe(12);
  });

  test("a re-run does NOT rewind an impact that has already progressed", async () => {
    await run();
    await env.DB.prepare(
      `UPDATE disruption_impact SET state = 'AWAITING_APPROVAL' WHERE employee_id = 'emp-us-04'`,
    ).run();

    await run();

    // Re-firing mid-demo must not reset work in flight. Rewinding is what
    // /api/dev/reset is for.
    const state = await scalar<string>(
      env,
      `SELECT state FROM disruption_impact WHERE employee_id = 'emp-us-04'`,
    );
    expect(state).toBe("AWAITING_APPROVAL");
  });
});

describe("reset returns the board to seed state", () => {
  test("removes the event, impacts and offers", async () => {
    await run();
    await reset(env as any);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_event`)).toBe(0);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_impact`)).toBe(0);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM offer`)).toBe(0);
  });

  test("leaves the seed itself intact", async () => {
    await run();
    await reset(env as any);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM employee`)).toBe(26);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM segment`)).toBe(34);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM policy`)).toBe(3);
  });

  test("disrupt -> reset -> disrupt is clean", async () => {
    await run();
    await reset(env as any);
    await run();
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_impact`)).toBe(4);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM offer`)).toBe(12);
  });
});

describe("response payload", () => {
  test("names the codeshare traveller explicitly", async () => {
    const res = await run();
    const body = (await res.json()) as any;

    expect(body.ok).toBe(true);
    expect(body.event_id).toBe(DISRUPT_EVENT_ID);
    expect(body.affected).toHaveLength(4);
    expect(body.total_offers).toBe(12);

    const elena = body.affected.find((a: any) => a.employee_id === "emp-us-04");
    expect(elena.via_codeshare).toBe(true);
    // Everyone else came through the marketing branch.
    const others = body.affected.filter((a: any) => a.employee_id !== "emp-us-04");
    for (const o of others) expect(o.via_codeshare).toBe(false);
  });

  test("refuses politely against an unseeded database", async () => {
    await env.DB.prepare(`DELETE FROM segment`).run();
    const res = await disrupt(env as any, NOW);
    expect(res.status).toBe(409);
  });
});

describe("REGRESSION: reset must not leave a dangling slot binding", () => {
  // Found live. reset deleted the dispatch rows but never freed agent_slot, so
  // the slot still pointed at a dispatch that no longer existed. agent_slot is
  // authoritative for resolution (schema.sql:244), so the next get_brief would
  // have resolved to a ghost — the agent being told to talk to someone who
  // isn't there.
  test("a slot bound to a deleted dispatch is freed", async () => {
    await run();
    const impactId = impactIdFor("emp-us-01");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatch (id, kind, impact_id, employee_id, slot, idempotency_key, status, created_at)
         VALUES ('dsp-x','CALL_EMPLOYEE',?,'emp-us-01','slot-a','k-x','QUEUED',?)`,
      ).bind(impactId, NOW.toISOString()),
      env.DB.prepare(
        `UPDATE agent_slot SET status='BOUND', dispatch_id='dsp-x', bound_at=?, lease_expires_at=?
          WHERE slot='slot-a'`,
      ).bind(NOW.toISOString(), "2026-12-31T00:00:00Z"),
    ]);

    await reset(env as any);

    const slot = await env.DB.prepare(
      `SELECT status, dispatch_id, lease_expires_at FROM agent_slot WHERE slot='slot-a'`,
    ).first<{ status: string; dispatch_id: string | null; lease_expires_at: string | null }>();

    expect(slot!.status).toBe("FREE");
    expect(slot!.dispatch_id).toBeNull();
    // schema.sql:253 only permits a NULL lease when FREE — they move together.
    expect(slot!.lease_expires_at).toBeNull();
  });

  test("a slot bound to a LIVE dispatch is left alone", async () => {
    await run();
    // A venue call has no impact_id, so reset must not disturb it.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatch (id, kind, activity_id, slot, idempotency_key, status, created_at)
         VALUES ('dsp-venue','CALL_VENUE','act-dinner','slot-b','k-v','IN_CALL',?)`,
      ).bind(NOW.toISOString()),
      env.DB.prepare(
        `UPDATE agent_slot SET status='BOUND', dispatch_id='dsp-venue', bound_at=?, lease_expires_at=?
          WHERE slot='slot-b'`,
      ).bind(NOW.toISOString(), "2026-12-31T00:00:00Z"),
    ]);

    await reset(env as any);

    const slot = await env.DB.prepare(
      `SELECT status, dispatch_id FROM agent_slot WHERE slot='slot-b'`,
    ).first<{ status: string; dispatch_id: string | null }>();
    expect(slot!.status).toBe("BOUND");
    expect(slot!.dispatch_id).toBe("dsp-venue");
  });
});
