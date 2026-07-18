import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, type TestCtx } from "./harness";
import {
  scenarioElena, scenarioMarcus, makeImpact, makeDispatch, bindSlot,
  EXPIRED_OFFER, EXPIRED_LEASE,
} from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

const actions = async (kind?: string) => {
  const sql = kind
    ? "SELECT * FROM action WHERE kind = ? ORDER BY created_at"
    : "SELECT * FROM action ORDER BY created_at";
  const st = kind ? ctx.db.prepare(sql).bind(kind) : ctx.db.prepare(sql);
  return (await st.all<any>()).results ?? [];
};

describe("POST /tools/:slot/confirm_choice", () => {
  test("a valid choice writes exactly one PENDING REISSUE action and reads back what was chosen", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");

    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", {
      body: { choice: 1 },
    });

    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
    expect(res.json.booked.number).toBe(1);
    expect(res.json.booked.summary).toContain("Asiana 223");
    // The agent must be able to read the choice back to the traveller.
    expect(res.json.speak).toContain("Asiana 223");

    const rows = await actions();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("REISSUE");
    expect(rows[0].state).toBe("PENDING");
    expect(rows[0].subject_type).toBe("impact");
    expect(rows[0].subject_id).toBe(ids.impact);
    expect(rows[0].employee_id).toBe("emp-us-04");
    expect(rows[0].dispatch_id).toBe(ids.dispatch);
    expect(rows[0].idempotency_key).toBeTruthy();
  });

  test("does not execute against Sabre — the row is left PENDING for an executor", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 2 } });

    const rows = await actions();
    expect(rows[0].state).toBe("PENDING");
    expect(rows[0].external_ref).toBeNull();
    expect(rows[0].completed_at).toBeNull();
    expect(res.json.status).toBe("PENDING");
  });

  test("records the selected offer on the impact", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 2 } });

    const impact = await ctx.db
      .prepare("SELECT selected_offer_id FROM disruption_impact WHERE id=?")
      .bind(ids.impact)
      .first<any>();
    expect(impact.selected_offer_id).toBe(`off-${ids.impact}-2`);
  });

  test("duplicate confirm_choice creates exactly one action row", async () => {
    await scenarioElena(ctx.db, "slot-a");

    const first = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });
    const second = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });
    const third = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: "1" } });

    expect(await actions()).toHaveLength(1);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.json.booked.number).toBe(1);
    expect(second.json.speak).toBeString();
    expect(first.json.booked.summary).toBe(second.json.booked.summary);
  });

  test("concurrent duplicate confirms still create exactly one action row", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await Promise.all(
      Array.from({ length: 5 }, () =>
        call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } }),
      ),
    );
    expect(await actions()).toHaveLength(1);
  });

  test("a second, different choice does not double-ticket", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });
    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 2 } });

    const rows = await actions("REISSUE");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].result_json).number).toBe(1);
    expect(res.json.speak).toBeString();
  });

  test("choice outside the offer set is rejected with no action row", async () => {
    await scenarioElena(ctx.db, "slot-a");

    for (const choice of [0, 4, 99, -1, "A1", "banana", null, "", 1.5, true, {}, []]) {
      const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", {
        body: { choice },
      });
      expect(res.status).toBe(200);
      expect(typeof res.json.speak).toBe("string");
      expect(res.json.booked).toBeUndefined();
    }
    expect(await actions()).toHaveLength(0);
  });

  test("a missing body or missing choice is rejected, not crashed", async () => {
    await scenarioElena(ctx.db, "slot-a");

    const noBody = await call(ctx, "POST", "/tools/slot-a/confirm_choice");
    const noChoice = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: {} });

    for (const res of [noBody, noChoice]) {
      expect(res.status).toBeLessThan(500);
      expect(typeof res.json.speak).toBe("string");
    }
    expect(await actions()).toHaveLength(0);
  });

  test("rejects a rank that exists for a DIFFERENT impact", async () => {
    // Marcus has only two offers. Asking slot-b for choice 3 must not reach
    // across to Elena's third option.
    await scenarioElena(ctx.db, "slot-a");
    await scenarioMarcus(ctx.db, "slot-b");

    const res = await call(ctx, "POST", "/tools/slot-b/confirm_choice", { body: { choice: 3 } });
    expect(res.json.booked).toBeUndefined();
    expect(await actions()).toHaveLength(0);
  });

  test("two slots confirming at once write to their own impacts only", async () => {
    const elena = await scenarioElena(ctx.db, "slot-a");
    const marcus = await scenarioMarcus(ctx.db, "slot-b");

    await Promise.all([
      call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } }),
      call(ctx, "POST", "/tools/slot-b/confirm_choice", { body: { choice: 2 } }),
    ]);

    const rows = await actions("REISSUE");
    expect(rows).toHaveLength(2);
    const byEmployee = Object.fromEntries(rows.map((r: any) => [r.employee_id, r]));
    expect(byEmployee["emp-us-04"].subject_id).toBe(elena.impact);
    expect(byEmployee["emp-us-03"].subject_id).toBe(marcus.impact);
    expect(JSON.parse(byEmployee["emp-us-04"].result_json).summary).toContain("Asiana");
    expect(JSON.parse(byEmployee["emp-us-03"].result_json).summary).toContain("Air Premia");
  });

  test("an expired offer is refused with a speakable message", async () => {
    await makeImpact(ctx.db, {
      id: "imp-exp",
      employeeId: "emp-us-01",
      offers: [
        { rank: 1, route_summary: "Asiana 223", expires_at: EXPIRED_OFFER },
        { rank: 2, route_summary: "Korean Air 82" },
      ],
    });
    await makeDispatch(ctx.db, {
      id: "disp-exp", impactId: "imp-exp", employeeId: "emp-us-01", slot: "slot-a",
    });
    await bindSlot(ctx.db, "slot-a", "disp-exp");

    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });

    expect(res.status).toBe(200);
    expect(res.json.speak.toLowerCase()).toContain("no longer available");
    expect(res.json.booked).toBeUndefined();
    expect(await actions()).toHaveLength(0);

    // The unexpired sibling still works.
    const ok = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 2 } });
    expect(ok.json.booked.number).toBe(2);
  });

  test("a NEEDS_APPROVAL offer is parked — no REISSUE action is written", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");

    // Option 3 in the Elena scenario is NEEDS_APPROVAL ($200 > $150 threshold).
    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 3 } });

    expect(res.status).toBe(200);
    expect(res.json.speak.toLowerCase()).toContain("confirm");
    expect(res.json.parked).toBe(true);
    expect(res.json.booked).toBeUndefined();

    expect(await actions("REISSUE")).toHaveLength(0);

    const impact = await ctx.db
      .prepare("SELECT state, selected_offer_id FROM disruption_impact WHERE id=?")
      .bind(ids.impact).first<any>();
    expect(impact.state).toBe("AWAITING_APPROVAL");
    expect(impact.selected_offer_id).toBe(`off-${ids.impact}-3`);

    const approvals = (await ctx.db.prepare("SELECT * FROM approval").all<any>()).results!;
    expect(approvals).toHaveLength(1);
    expect(approvals[0].impact_id).toBe(ids.impact);
    expect(approvals[0].offer_id).toBe(`off-${ids.impact}-3`);
    expect(approvals[0].decided_at).toBeNull();
  });

  test("a FAIL offer is parked, never executed", async () => {
    await makeImpact(ctx.db, {
      id: "imp-fail",
      employeeId: "emp-us-01",
      offers: [{ rank: 1, route_summary: "Business class via Tokyo", policy_verdict: "FAIL" }],
    });
    await makeDispatch(ctx.db, {
      id: "disp-fail", impactId: "imp-fail", employeeId: "emp-us-01", slot: "slot-a",
    });
    await bindSlot(ctx.db, "slot-a", "disp-fail");

    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });
    expect(res.json.parked).toBe(true);
    expect(await actions("REISSUE")).toHaveLength(0);
  });

  test("parking twice does not create a second approval", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 3 } });
    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 3 } });

    const approvals = (await ctx.db.prepare("SELECT * FROM approval").all<any>()).results!;
    expect(approvals).toHaveLength(1);
  });

  test("an unbound slot cannot confirm anything", async () => {
    const res = await call(ctx, "POST", "/tools/slot-c/confirm_choice", { body: { choice: 1 } });
    expect(res.status).toBe(200);
    expect(res.json.speak).toContain("end the call");
    expect(await actions()).toHaveLength(0);
  });

  test("an expired lease cannot confirm anything", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await bindSlot(ctx.db, "slot-a", ids.dispatch, EXPIRED_LEASE);

    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });
    expect(res.json.speak).toContain("end the call");
    expect(await actions()).toHaveLength(0);
  });

  test("spoken-word numbers the model may relay are accepted", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: "two" } });
    expect(res.json.booked.number).toBe(2);
  });

  test("the response body stays small", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });
    expect(JSON.stringify(res.json).length).toBeLessThan(1024);
  });
});

describe("REGRESSION: an in-policy booking moves the impact to EXECUTING", () => {
  // Commit 7dd6ba5 added EXECUTING for exactly this moment — chosen, action
  // pending, not yet reissued — and nothing wrote it. After a REAL call
  // completed, the card sat at CONTACTING and rendered CALLING forever, looking
  // like the agent was still on the phone. Found by driving it, not by review.
  test("state becomes EXECUTING and the chosen offer is recorded", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");

    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } });

    const row = await ctx.db
      .prepare(`SELECT state, previous_state, selected_offer_id FROM disruption_impact WHERE id = ?`)
      .bind(ids.impact)
      .first<{ state: string; previous_state: string | null; selected_offer_id: string | null }>();

    expect(row!.state).toBe("EXECUTING");
    expect(row!.selected_offer_id).not.toBeNull();
    // The transition is traceable, so a dashboard can show where it came from.
    expect(row!.previous_state).not.toBe("EXECUTING");
  });

  test("an over-policy choice still parks at AWAITING_APPROVAL, not EXECUTING", async () => {
    // The gate must keep winning. Nothing executes above policy.
    // Option 3 in this scenario is the NEEDS_APPROVAL one.
    const ids = await scenarioElena(ctx.db, "slot-a");

    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 3 } });

    const state = await ctx.db
      .prepare(`SELECT state FROM disruption_impact WHERE id = ?`)
      .bind(ids.impact)
      .first<{ state: string }>();
    expect(state!.state).toBe("AWAITING_APPROVAL");
  });
});
