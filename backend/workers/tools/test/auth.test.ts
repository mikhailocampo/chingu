import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, SLOT_TOKENS, type TestCtx } from "./harness";
import { scenarioElena, scenarioMarcus } from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

/**
 * Slot paths are guessable and confirm_choice ultimately reissues tickets, so
 * bearer auth is mandatory on every endpoint. VB delivers the header intact
 * (verified 14/14 live, 0 missing, 0 mismatched).
 */
describe("bearer auth", () => {
  const endpoints: [string, "GET" | "POST", unknown][] = [
    ["get_brief", "GET", undefined],
    ["confirm_choice", "POST", { choice: 1 }],
    ["confirm_venue", "POST", { agreed: true, new_time: "2026-09-16T11:30:00Z", note: "ok" }],
    ["escalate", "POST", { reason: "traveller confused" }],
  ];

  for (const [tool, method, body] of endpoints) {
    test(`${tool} rejects a missing bearer with 401`, async () => {
      await scenarioElena(ctx.db, "slot-a");
      const res = await call(ctx, method, `/tools/slot-a/${tool}`, { token: null, body });
      expect(res.status).toBe(401);
      // A 401 body can still reach the agent, so it must be speakable.
      expect(typeof res.json.speak).toBe("string");
      expect(res.json.speak.length).toBeGreaterThan(0);
    });

    test(`${tool} rejects a wrong bearer with 401`, async () => {
      await scenarioElena(ctx.db, "slot-a");
      const res = await call(ctx, method, `/tools/slot-a/${tool}`, {
        token: "tok_totally_wrong_value",
        body,
      });
      expect(res.status).toBe(401);
      expect(typeof res.json.speak).toBe("string");
    });
  }

  test("another slot's token does not open this slot", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await scenarioMarcus(ctx.db, "slot-b");

    const res = await call(ctx, "GET", "/tools/slot-a/get_brief", {
      token: SLOT_TOKENS["slot-b"],
    });
    expect(res.status).toBe(401);
    expect(res.json.traveller).toBeUndefined();
  });

  test("a token that is a prefix of the real one is rejected", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "GET", "/tools/slot-a/get_brief", {
      token: SLOT_TOKENS["slot-a"].slice(0, -1),
    });
    expect(res.status).toBe(401);
  });

  test("a non-Bearer authorization scheme is rejected", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const worker = (await import("../src/index")).default;
    const res = await worker.fetch(
      new Request("https://t.example/tools/slot-a/get_brief", {
        headers: { Authorization: `Basic ${SLOT_TOKENS["slot-a"]}` },
      }),
      ctx.env as any,
    );
    expect(res.status).toBe(401);
  });

  test("a slot with no configured token can never be opened", async () => {
    // slot-z has no SLOT_TOKEN_SLOT_Z in env; an empty/undefined secret must
    // not degrade into "any token works".
    for (const token of ["", "undefined", "null", "anything"]) {
      const res = await call(ctx, "GET", "/tools/slot-z/get_brief", { token });
      expect(res.status).toBe(401);
    }
  });

  test("auth is checked before the slot is resolved", async () => {
    // Unbound slot + bad token must be 401, not the speakable 200 exit —
    // otherwise the endpoint leaks which slots are live to an unauthenticated
    // caller.
    const res = await call(ctx, "GET", "/tools/slot-c/get_brief", { token: "nope" });
    expect(res.status).toBe(401);
  });

  test("the correct token is accepted", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "GET", "/tools/slot-a/get_brief", {
      token: SLOT_TOKENS["slot-a"],
    });
    expect(res.status).toBe(200);
  });
});
