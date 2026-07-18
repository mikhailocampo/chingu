import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, type TestCtx } from "./harness";
import { scenarioVenue, scenarioElena, bindSlot, EXPIRED_LEASE } from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

const rows = async (kind: string) =>
  (await ctx.db.prepare("SELECT * FROM action WHERE kind = ?").bind(kind).all<any>()).results ?? [];

const AGREED = {
  agreed: true,
  new_time: "2026-09-16T11:30:00Z",
  note: "Kitchen can do 8:30, shellfish kept off the set menu",
};

describe("POST /tools/:slot/confirm_venue", () => {
  test("an agreed change writes one VENUE_CHANGE action with from/to", async () => {
    await scenarioVenue(ctx.db, "slot-c");

    const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");

    const vc = await rows("VENUE_CHANGE");
    expect(vc).toHaveLength(1);
    expect(vc[0].state).toBe("PENDING");
    expect(vc[0].subject_type).toBe("activity");
    expect(vc[0].subject_id).toBe("act-dinner");
    expect(vc[0].dispatch_id).toBe("disp-venue");

    const result = JSON.parse(vc[0].result_json);
    expect(result.from).toBe("2026-09-16T10:30:00Z");
    expect(result.to).toBe("2026-09-16T11:30:00Z");
    expect(result.note).toContain("shellfish");
  });

  test("fans out exactly one NOTIFY_EMAIL per CONFIRMED attendee — the seed has 26", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    const notifies = await rows("NOTIFY_EMAIL");
    expect(notifies).toHaveLength(26);

    const employees = new Set(notifies.map((n: any) => n.employee_id));
    expect(employees.size).toBe(26);
    expect(employees.has("emp-us-10")).toBe(true); // attends, has no itinerary

    for (const n of notifies) {
      expect(n.state).toBe("PENDING");
      expect(n.subject_type).toBe("activity");
      expect(n.subject_id).toBe("act-dinner");
    }
    // Each independently idempotent => each key distinct.
    expect(new Set(notifies.map((n: any) => n.idempotency_key)).size).toBe(26);
  });

  test("nothing is actually sent — every notify row is left PENDING", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    for (const n of await rows("NOTIFY_EMAIL")) {
      expect(n.state).toBe("PENDING");
      expect(n.completed_at).toBeNull();
      expect(n.external_ref).toBeNull();
    }
  });

  test("only CONFIRMED attendees are notified", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare(
        "UPDATE attendance SET attend_state='DECLINED' WHERE employee_id IN ('emp-kr-01','emp-kr-02')",
      )
      .run();
    await ctx.db
      .prepare("UPDATE attendance SET attend_state='INVITED' WHERE employee_id='emp-kr-03'")
      .run();

    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    const notifies = await rows("NOTIFY_EMAIL");
    expect(notifies).toHaveLength(23);
    const ids = notifies.map((n: any) => n.employee_id);
    expect(ids).not.toContain("emp-kr-01");
    expect(ids).not.toContain("emp-kr-03");
  });

  test("repeating the call creates no duplicate rows", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });
    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });
    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    expect(await rows("VENUE_CHANGE")).toHaveLength(1);
    expect(await rows("NOTIFY_EMAIL")).toHaveLength(26);
  });

  test("concurrent repeats create no duplicate rows", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED }),
      ),
    );
    expect(await rows("VENUE_CHANGE")).toHaveLength(1);
    expect(await rows("NOTIFY_EMAIL")).toHaveLength(26);
  });

  test("a partially-failed fan-out is repaired without re-notifying the rest", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    // Simulate three that never got written, and mark the rest as delivered.
    await ctx.db
      .prepare(
        "DELETE FROM action WHERE kind='NOTIFY_EMAIL' AND employee_id IN ('emp-kr-05','emp-us-01','emp-us-10')",
      )
      .run();
    await ctx.db
      .prepare("UPDATE action SET state='COMPLETED' WHERE kind='NOTIFY_EMAIL'")
      .run();

    await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });

    const notifies = await rows("NOTIFY_EMAIL");
    expect(notifies).toHaveLength(26);
    const pending = notifies.filter((n: any) => n.state === "PENDING");
    expect(pending.map((n: any) => n.employee_id).sort()).toEqual([
      "emp-kr-05",
      "emp-us-01",
      "emp-us-10",
    ]);
  });

  test("a refused change writes nothing but still answers speakably", async () => {
    await scenarioVenue(ctx.db, "slot-c");

    const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
      body: { agreed: false, new_time: "2026-09-16T11:30:00Z", note: "fully booked" },
    });

    expect(res.status).toBe(200);
    expect(typeof res.json.speak).toBe("string");
    expect(res.json.agreed).toBe(false);
    expect(await rows("VENUE_CHANGE")).toHaveLength(0);
    expect(await rows("NOTIFY_EMAIL")).toHaveLength(0);
  });

  test("agreed accepts the string forms the model actually sends", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    for (const agreed of ["no", "false", "No"]) {
      const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
        body: { agreed, new_time: "2026-09-16T11:30:00Z", note: "" },
      });
      expect(res.json.agreed).toBe(false);
    }
    expect(await rows("VENUE_CHANGE")).toHaveLength(0);

    const yes = await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
      body: { agreed: "yes", new_time: "2026-09-16T11:30:00Z", note: "" },
    });
    expect(yes.json.agreed).toBe(true);
    expect(await rows("VENUE_CHANGE")).toHaveLength(1);
  });

  test("a bare local time is anchored to the activity's own date and timezone", async () => {
    // The model was 0-for-3 on a YEAR (2026 -> 2025). Accepting a wall-clock
    // time and supplying the date server-side removes that failure mode.
    await scenarioVenue(ctx.db, "slot-c");

    const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
      body: { agreed: true, new_time: "20:30", note: "" },
    });

    expect(res.status).toBe(200);
    // Dinner is 2026-09-16 in Asia/Seoul; 20:30 KST == 11:30Z.
    expect(JSON.parse((await rows("VENUE_CHANGE"))[0].result_json).to).toBe(
      "2026-09-16T11:30:00Z",
    );
  });

  test("an unusable new_time is refused rather than guessed at", async () => {
    await scenarioVenue(ctx.db, "slot-c");

    for (const new_time of [undefined, "", "later", "banana", "99:99", null, 7]) {
      const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
        body: { agreed: true, new_time, note: "" },
      });
      expect(res.status).toBeLessThan(500);
      expect(typeof res.json.speak).toBe("string");
    }
    expect(await rows("VENUE_CHANGE")).toHaveLength(0);
    expect(await rows("NOTIFY_EMAIL")).toHaveLength(0);
  });

  test("an unbound slot changes nothing", async () => {
    const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });
    expect(res.json.speak).toContain("end the call");
    expect(await rows("VENUE_CHANGE")).toHaveLength(0);
  });

  test("an expired lease changes nothing", async () => {
    const v = await scenarioVenue(ctx.db, "slot-c");
    await bindSlot(ctx.db, "slot-c", v.dispatch, EXPIRED_LEASE);
    const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });
    expect(res.json.speak).toContain("end the call");
    expect(await rows("VENUE_CHANGE")).toHaveLength(0);
  });

  test("a slot bound to an employee call cannot change a venue", async () => {
    await scenarioElena(ctx.db, "slot-a");
    const res = await call(ctx, "POST", "/tools/slot-a/confirm_venue", { body: AGREED });
    expect(typeof res.json.speak).toBe("string");
    expect(await rows("VENUE_CHANGE")).toHaveLength(0);
  });

  test("the response body stays small even with a 26-way fan-out", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await call(ctx, "POST", "/tools/slot-c/confirm_venue", { body: AGREED });
    expect(JSON.stringify(res.json).length).toBeLessThan(1024);
    expect(res.json.notified).toBe(26);
  });
});
