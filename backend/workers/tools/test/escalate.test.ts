import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, type TestCtx } from "./harness";
import { scenarioElena, scenarioVenue, bindSlot, EXPIRED_LEASE } from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

const approvals = async () =>
  (await ctx.db.prepare("SELECT * FROM approval").all<any>()).results ?? [];

describe("POST /tools/:slot/escalate", () => {
  test("parks the impact and acknowledges speakably", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");

    const res = await call(ctx, "POST", "/tools/slot-a/escalate", {
      body: { reason: "She wants to bring her partner on the same booking" },
    });

    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
    expect(res.json.escalated).toBe(true);

    const impact = await ctx.db
      .prepare("SELECT state, previous_state, state_changed_at FROM disruption_impact WHERE id=?")
      .bind(ids.impact)
      .first<any>();
    expect(impact.state).toBe("AWAITING_APPROVAL");
    expect(impact.previous_state).toBe("CONTACTING");
    expect(impact.state_changed_at).toBeTruthy();
  });

  test("records the reason for the human who picks it up", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await call(ctx, "POST", "/tools/slot-a/escalate", {
      body: { reason: "Wants to bring her partner" },
    });

    const rows = await approvals();
    expect(rows).toHaveLength(1);
    expect(rows[0].impact_id).toBe(ids.impact);
    expect(rows[0].reason).toBe("AGENT_UNSURE");
    expect(rows[0].note).toContain("Wants to bring her partner");
    expect(rows[0].decided_at).toBeNull();
  });

  test("escalating twice does not pile up approvals", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "unsure" } });
    await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "still unsure" } });

    expect(await approvals()).toHaveLength(1);
  });

  test("never fails: a missing or junk reason still succeeds", async () => {
    await scenarioElena(ctx.db, "slot-a");

    for (const body of [{}, { reason: "" }, { reason: null }, { reason: 42 }, { reason: [] }]) {
      const res = await call(ctx, "POST", "/tools/slot-a/escalate", { body });
      expect(res.status).toBe(200);
      expect(typeof res.json.speak).toBe("string");
      expect(res.json.escalated).toBe(true);
    }
  });

  test("never fails: a completely absent body still succeeds", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/escalate");
    expect(res.status).toBe(200);
    expect(res.json.escalated).toBe(true);
  });

  test("never fails: an unbound slot still acknowledges", async () => {
    const res = await call(ctx, "POST", "/tools/slot-b/escalate", {
      body: { reason: "confused" },
    });
    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
  });

  test("never fails: an expired lease still acknowledges", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await bindSlot(ctx.db, "slot-a", ids.dispatch, EXPIRED_LEASE);
    const res = await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "x" } });
    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
  });

  test("never fails: a venue call with no impact still acknowledges", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await call(ctx, "POST", "/tools/slot-c/escalate", {
      body: { reason: "manager wants to speak to a person" },
    });
    expect(res.status).toBe(200);
    expect(res.json.escalated).toBe(true);
  });

  test("never fails: it still acknowledges when the write itself blows up", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await ctx.db.prepare("DROP TABLE approval").run();

    const res = await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "x" } });
    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
  });

  test("an over-long reason is truncated rather than rejected", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/escalate", {
      body: { reason: "x".repeat(5000) },
    });
    expect(res.status).toBe(200);
    const rows = await approvals();
    expect(rows[0].note.length).toBeLessThan(1000);
  });

  test("the escalation is visible on the dispatch for the dashboard", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "needs a human" } });

    const d = await ctx.db
      .prepare("SELECT outcome_summary FROM dispatch WHERE id=?")
      .bind(ids.dispatch)
      .first<any>();
    expect(d.outcome_summary).toContain("needs a human");
  });

  test("the response body stays small", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "x" } });
    expect(JSON.stringify(res.json).length).toBeLessThan(512);
  });
});
