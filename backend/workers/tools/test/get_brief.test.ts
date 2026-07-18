import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, type TestCtx } from "./harness";
import {
  scenarioElena,
  scenarioMarcus,
  makeImpact,
  makeDispatch,
  bindSlot,
  EXPIRED_LEASE,
} from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

describe("GET /tools/:slot/get_brief", () => {
  test("resolves the slot to the bound dispatch and speaks the traveller's own facts", async () => {
    await scenarioElena(ctx.db, "slot-a");

    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");

    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
    expect(res.json.speak).toContain("Elena Duarte");
    expect(res.json.traveller.name).toBe("Elena Duarte");
    expect(res.json.traveller.phone).toBe("+12125550104");
  });

  test("options are numbered 1..3 and the numbers appear in the spoken text", async () => {
    await scenarioElena(ctx.db, "slot-a");

    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");

    expect(res.json.options.map((o: any) => o.number)).toEqual([1, 2, 3]);
    for (const o of res.json.options) {
      expect(typeof o.summary).toBe("string");
      expect(o.summary.length).toBeGreaterThan(0);
    }
    // The model invented "A1" when nothing told it the format. Give it the
    // numbering explicitly in the speakable text so it relays rather than invents.
    expect(res.json.speak).toMatch(/\b1\b/);
    expect(res.json.speak).toMatch(/\b2\b/);
    expect(res.json.speak).toMatch(/\b3\b/);
  });

  test("caps at three options even when more are precomputed", async () => {
    await makeImpact(ctx.db, {
      id: "imp-many",
      employeeId: "emp-us-01",
      offers: [1, 2, 3, 4, 5].map((rank) => ({
        rank,
        route_summary: `Option ${rank} route`,
      })),
    });
    await makeDispatch(ctx.db, {
      id: "disp-many",
      impactId: "imp-many",
      employeeId: "emp-us-01",
      slot: "slot-a",
    });
    await bindSlot(ctx.db, "slot-a", "disp-many");

    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");
    expect(res.json.options).toHaveLength(3);
    expect(res.json.options.map((o: any) => o.number)).toEqual([1, 2, 3]);
  });

  test("two slots served concurrently never cross — this is the whole design", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await scenarioMarcus(ctx.db, "slot-b");

    const [a, b] = await Promise.all([
      call(ctx, "GET", "/tools/slot-a/get_brief"),
      call(ctx, "GET", "/tools/slot-b/get_brief"),
    ]);

    expect(a.json.traveller.name).toBe("Elena Duarte");
    expect(b.json.traveller.name).toBe("Marcus Bell");
    expect(a.json.speak).not.toContain("Marcus");
    expect(b.json.speak).not.toContain("Elena");
    expect(a.json.traveller.phone).not.toBe(b.json.traveller.phone);
  });

  test("interleaved repeat requests stay pinned to their own slot", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await scenarioMarcus(ctx.db, "slot-b");

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call(ctx, "GET", `/tools/${i % 2 === 0 ? "slot-a" : "slot-b"}/get_brief`),
      ),
    );
    results.forEach((r, i) => {
      expect(r.json.traveller.name).toBe(i % 2 === 0 ? "Elena Duarte" : "Marcus Bell");
    });
  });

  test("unbound slot returns a speakable exit, not a 500", async () => {
    const res = await call(ctx, "GET", "/tools/slot-c/get_brief");

    expect(res.status).toBe(200);
    expect(res.json.speak).toContain("end the call");
    expect(res.json.options ?? []).toHaveLength(0);
  });

  test("expired lease is treated as unbound", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await bindSlot(ctx.db, "slot-a", ids.dispatch, EXPIRED_LEASE);

    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");

    expect(res.status).toBe(200);
    expect(res.json.speak).toContain("end the call");
    expect(res.json.traveller).toBeUndefined();
  });

  test("terminal dispatch returns a speakable exit", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    await ctx.db
      .prepare("UPDATE dispatch SET status='RESOLVED' WHERE id=?")
      .bind(ids.dispatch)
      .run();

    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");
    expect(res.status).toBe(200);
    expect(res.json.speak).toContain("end the call");
  });

  test("unknown slot name is a speakable exit, not a crash", async () => {
    const res = await call(ctx, "GET", "/tools/slot-zz/get_brief", { token: "anything" });
    expect(res.json.speak).toBeString();
    expect(res.status).toBeLessThan(500);
  });

  test("the brief mentions the disrupted flight so the agent has an opener", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");
    expect(res.json.speak).toContain("7842");
    expect(res.json.speak.toLowerCase()).toContain("cancelled");
  });

  test("response body stays small enough to be spoken", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "GET", "/tools/slot-a/get_brief");
    expect(JSON.stringify(res.json).length).toBeLessThan(2048);
  });
});
