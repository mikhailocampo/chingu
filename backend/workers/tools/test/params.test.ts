import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, SLOT_TOKENS, type TestCtx } from "./harness";
import { scenarioElena, scenarioVenue } from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => { ctx = await boot(); });
afterEach(async () => { await ctx.dispose(); });

const post = async (path: string, init: RequestInit = {}) => {
  const worker = (await import("../src/index")).default;
  const res: Response = await worker.fetch(
    new Request(`https://t.example${path}`, {
      method: "POST",
      ...init,
      headers: {
        Authorization: `Bearer ${SLOT_TOKENS[path.split("/")[2] as "slot-a"]}`,
        ...(init.headers ?? {}),
      },
    }),
    ctx.env as any,
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

const rows = async (kind: string) =>
  (await ctx.db.prepare("SELECT * FROM action WHERE kind=?").bind(kind).all<any>()).results ?? [];

/**
 * VB's `parameters[].location` enum is undocumented and only "query" has ever
 * been verified live. A tool configured with location:"query" sends its
 * arguments in the query string, not a JSON body — so every POST endpoint must
 * accept both, or the first real call silently does nothing.
 */
describe("parameters arrive by query string as well as JSON body", () => {
  test("confirm_choice accepts choice as a query parameter", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await post("/tools/slot-a/confirm_choice?choice=1");
    expect(res.json.booked?.number).toBe(1);
    expect(await rows("REISSUE")).toHaveLength(1);
  });

  test("confirm_venue accepts agreed/new_time/note as query parameters", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await post(
      "/tools/slot-c/confirm_venue?agreed=true&new_time=20%3A30&note=kitchen%20agreed",
    );
    expect(res.json.recorded).toBe(true);
    const vc = await rows("VENUE_CHANGE");
    expect(vc).toHaveLength(1);
    expect(JSON.parse(vc[0].result_json).to).toBe("2026-09-16T11:30:00Z");
    expect(JSON.parse(vc[0].result_json).note).toBe("kitchen agreed");
    expect(await rows("NOTIFY_EMAIL")).toHaveLength(26);
  });

  test("escalate accepts reason as a query parameter", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await post("/tools/slot-a/escalate?reason=wants%20a%20human");
    const a = (await ctx.db.prepare("SELECT * FROM approval").all<any>()).results!;
    expect(a[0].note).toContain("wants a human");
  });

  test("a JSON body still wins when both are present", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await post("/tools/slot-a/confirm_choice?choice=3", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: 1 }),
    });
    expect(res.json.booked?.number).toBe(1);
  });

  test("query-supplied idempotency matches body-supplied idempotency", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await post("/tools/slot-a/confirm_choice?choice=2");
    await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 2 } });
    expect(await rows("REISSUE")).toHaveLength(1);
  });

  test("form-encoded bodies are also accepted", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await post("/tools/slot-a/confirm_choice", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "choice=2",
    });
    expect(res.json.booked?.number).toBe(2);
  });
});
