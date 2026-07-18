import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, SLOT_TOKENS, type TestCtx } from "./harness";
import { scenarioElena, scenarioMarcus, scenarioVenue } from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

const raw = async (
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: any }> => {
  const worker = (await import("../src/index")).default;
  const res: Response = await worker.fetch(
    new Request(`https://t.example${path}`, init),
    ctx.env as any,
  );
  return { status: res.status, json: await res.json().catch(() => null) };
};

describe("response contract", () => {
  test("every response body contains a speak string and stays small", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await scenarioVenue(ctx.db, "slot-c");

    const responses = [
      await call(ctx, "GET", "/tools/slot-a/get_brief"),
      await call(ctx, "GET", "/tools/slot-b/get_brief"), // unbound
      await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } }),
      await call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: "A1" } }),
      await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
        body: { agreed: true, new_time: "21:00", note: "ok" },
      }),
      await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: { agreed: false } }),
      await call(ctx, "POST", "/tools/slot-a/escalate", { body: { reason: "help" } }),
      await call(ctx, "GET", "/tools/slot-a/get_brief", { token: "wrong" }), // 401
      await raw("/tools/slot-a/no_such_tool", {
        headers: { Authorization: `Bearer ${SLOT_TOKENS["slot-a"]}` },
      }),
      await raw("/tools/slot-a/get_brief", {
        method: "POST", // wrong method
        headers: { Authorization: `Bearer ${SLOT_TOKENS["slot-a"]}` },
      }),
      await raw("/"),
      await raw("/tools"),
    ];

    for (const res of responses) {
      expect(res.json).not.toBeNull();
      expect(typeof res.json.speak).toBe("string");
      expect(res.json.speak.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.json).length).toBeLessThan(2048);
    }
  });

  test("no response is ever a 5xx", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const paths = [
      "/tools/slot-a/get_brief",
      "/tools/slot-a/confirm_choice",
      "/tools/slot-a/confirm_venue",
      "/tools/slot-a/escalate",
      "/tools/slot-a/../../etc/passwd",
      "/tools//get_brief",
      "/tools/slot-a/",
      "/tools/%00/get_brief",
    ];
    for (const p of paths) {
      for (const method of ["GET", "POST"] as const) {
        const res = await raw(p, {
          method,
          headers: { Authorization: `Bearer ${SLOT_TOKENS["slot-a"]}` },
        });
        expect(res.status).toBeLessThan(500);
      }
    }
  });

  test("get_brief ignores anything the model tries to smuggle in", async () => {
    // VB drops undeclared arguments before egress, but never rely on that alone.
    await scenarioElena(ctx.db, "slot-a");
    await scenarioMarcus(ctx.db, "slot-b");

    const res = await raw(
      "/tools/slot-a/get_brief?employee_id=Z1234&dispatch_id=disp-marcus&slot=slot-b",
      { headers: { Authorization: `Bearer ${SLOT_TOKENS["slot-a"]}` } },
    );
    expect(res.json.traveller.name).toBe("Elena Duarte");
  });

  test("a zero-length POST body — VB's observed behaviour — is handled", async () => {
    // Live: the model called a zero-parameter tool with {"choice":"A1"} and VB
    // emitted Content-Length: 0. That exact request must not crash us.
    await scenarioElena(ctx.db, "slot-a");

    const res = await raw("/tools/slot-a/confirm_choice", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLOT_TOKENS["slot-a"]}`,
        "Content-Type": "application/json",
      },
      body: "",
    });

    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
    const rows = (await ctx.db.prepare("SELECT * FROM action").all<any>()).results ?? [];
    expect(rows).toHaveLength(0);
  });

  test("malformed JSON is handled as an empty body", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await raw("/tools/slot-a/confirm_choice", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLOT_TOKENS["slot-a"]}`,
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
  });

  test("three slots exercised concurrently across all four tools never cross", async () => {
    const elena = await scenarioElena(ctx.db, "slot-a");
    const marcus = await scenarioMarcus(ctx.db, "slot-b");
    await scenarioVenue(ctx.db, "slot-c");

    await Promise.all([
      call(ctx, "GET", "/tools/slot-a/get_brief"),
      call(ctx, "GET", "/tools/slot-b/get_brief"),
      call(ctx, "POST", "/tools/slot-a/confirm_choice", { body: { choice: 1 } }),
      call(ctx, "POST", "/tools/slot-b/confirm_choice", { body: { choice: 1 } }),
      call(ctx, "POST", "/tools/slot-c/confirm_venue", {
        body: { agreed: true, new_time: "20:30", note: "" },
      }),
    ]);

    const reissues =
      (await ctx.db.prepare("SELECT * FROM action WHERE kind='REISSUE'").all<any>()).results ?? [];
    expect(reissues).toHaveLength(2);
    expect(new Set(reissues.map((r: any) => r.subject_id))).toEqual(
      new Set([elena.impact, marcus.impact]),
    );
    for (const r of reissues) {
      const expected = r.subject_id === elena.impact ? "emp-us-04" : "emp-us-03";
      expect(r.employee_id).toBe(expected);
    }

    const venue =
      (await ctx.db.prepare("SELECT * FROM action WHERE kind='VENUE_CHANGE'").all<any>()).results ?? [];
    expect(venue).toHaveLength(1);
    expect(venue[0].subject_id).toBe("act-dinner");
  });

  test("no response leaks an internal identifier the agent might read aloud", async () => {
    const ids = await scenarioElena(ctx.db, "slot-a");
    const brief = await call(ctx, "GET", "/tools/slot-a/get_brief");
    const confirm = await call(ctx, "POST", "/tools/slot-a/confirm_choice", {
      body: { choice: 1 },
    });

    for (const spoken of [brief.json.speak, confirm.json.speak]) {
      expect(spoken).not.toContain(ids.impact);
      expect(spoken).not.toContain(ids.dispatch);
      expect(spoken).not.toContain("emp-us-04");
      expect(spoken).not.toContain("off-");
    }
  });
});
