/**
 * The venue half of get_brief. The employee half lives in get_brief.test.ts.
 *
 * Two properties here are not ordinary assertions but the reason the feature
 * exists: the time must be spoken in the venue's own timezone, and a dietary
 * need without `disclose_ok` must never reach the restaurant.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { boot, call, type TestCtx } from "./harness";
import { scenarioVenue, scenarioElena, makeDispatch, bindSlot } from "./fixtures";

let ctx: TestCtx;
beforeEach(async () => {
  ctx = await boot();
});
afterEach(async () => {
  await ctx.dispose();
});

const brief = () => call(ctx, "GET", "/tools/slot-c/get_brief");

describe("GET /tools/:slot/get_brief — venue calls", () => {
  test("a venue binding gets a brief, not the hang-up", async () => {
    await scenarioVenue(ctx.db, "slot-c");

    const res = await brief();

    expect(res.status).toBe(200);
    // The bug: impact_id is null on a venue call, so the agent was told to end
    // the call on a restaurant it had just dialled.
    expect(res.json.speak).not.toContain("I don't have a booking to discuss");
    expect(res.json.speak).toContain("Jagalchi Hoetjip");
  });

  test("carries the venue's name and phone as structured fields", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();

    expect(res.json.venue.name).toBe("Jagalchi Hoetjip");
    expect(res.json.venue.phone).toBe("+82-51-245-2723");
  });

  test("headcount is the CONFIRMED attendees — the seed has 26", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();

    expect(res.json.headcount).toBe(26);
    expect(res.json.speak).toContain("26 people");
  });

  test("headcount ignores everyone who is not CONFIRMED", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare(
        "UPDATE attendance SET attend_state='DECLINED' WHERE employee_id IN ('emp-kr-01','emp-kr-02')",
      )
      .run();

    const res = await brief();
    expect(res.json.headcount).toBe(24);
  });

  test("the time is spoken in the venue's timezone, not UTC", async () => {
    // starts_at is 2026-09-16T10:30:00Z. That is 19:30 in Asia/Seoul. Reading
    // the stored value out would tell a Korean restaurant "half past ten in the
    // morning" — a demo-ending bug, and the whole reason for localWallClock.
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();

    expect(res.json.booking.time).toBe("seven thirty in the evening");
    expect(res.json.booking.date).toBe("September 16th");
    expect(res.json.booking.timezone).toBe("Asia/Seoul");
    expect(res.json.speak).toContain("seven thirty in the evening");
    expect(res.json.speak).not.toContain("in the morning");
    expect(res.json.speak).not.toContain("ten thirty");
  });

  test("a timezone that shifts the local DATE shifts the spoken date too", async () => {
    // 2026-09-16T22:00:00Z is already the 17th in Seoul.
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare("UPDATE activity SET starts_at='2026-09-16T22:00:00Z' WHERE id='act-dinner'")
      .run();

    const res = await brief();
    expect(res.json.booking.date).toBe("September 17th");
    expect(res.json.booking.time).toBe("seven o'clock in the morning");
  });

  test("nothing spoken is an ISO timestamp, an id, or JSON", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();

    expect(res.json.speak).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(res.json.speak).not.toMatch(/\d{2}:\d{2}/);
    expect(res.json.speak).not.toContain("act-dinner");
    expect(res.json.speak).not.toContain("emp-");
    expect(res.json.speak).not.toContain("{");
  });

  test("discloses only the needs marked disclose_ok", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();

    // Three seeded needs, all disclose_ok: 1.
    expect(res.json.speak).toContain("severe shellfish allergy");
    expect(res.json.speak).toContain("gluten intolerance");
    expect(res.json.speak).toContain("vegetarian");
    expect(res.json.dietary.withheld).toBe(0);
    // The venue is a seafood restaurant. The agent must not treat it as a whim.
    expect(res.json.speak).toContain("strict requirement");
  });

  test("a disclose_ok:0 need NEVER appears in the output", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare(
        `UPDATE employee SET dietary_json =
           '[{"kind":"SHELLFISH","severity":"ALLERGY_SEVERE","notes":"anaphylaxis; carries epipen","disclose_ok":0}]'
         WHERE id='emp-us-02'`,
      )
      .run();

    const res = await brief();
    const body = JSON.stringify(res.json).toLowerCase();

    expect(body).not.toContain("shellfish");
    expect(body).not.toContain("anaphylaxis");
    expect(body).not.toContain("epipen");
    expect(res.json.dietary.withheld).toBe(1);
    // Withheld, but still actionable.
    expect(res.json.speak).toContain("not able to share");
    expect(res.json.speak).toContain("follow up");
  });

  test("needs that ALL fail disclose_ok leak nothing but still direct the agent", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare(
        `UPDATE employee SET dietary_json = REPLACE(dietary_json, '"disclose_ok":1', '"disclose_ok":0')
          WHERE dietary_json IS NOT NULL`,
      )
      .run();

    const res = await brief();
    const body = JSON.stringify(res.json).toLowerCase();

    expect(res.json.dietary.disclosable).toEqual([]);
    expect(res.json.dietary.withheld).toBe(3);
    for (const leak of ["shellfish", "gluten", "vegetarian", "coeliac", "epipen"]) {
      expect(body).not.toContain(leak);
    }
    expect(res.json.speak).toContain("not able to share");
  });

  test("no guest name ever appears beside a medical detail", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();
    const body = JSON.stringify(res.json);

    // Every attendee, not just the ones with needs.
    const names = (
      await ctx.db.prepare("SELECT name FROM employee").all<{ name: string }>()
    ).results!.map((r) => r.name);

    expect(names.length).toBe(26);
    for (const name of names) {
      expect(body).not.toContain(name);
      expect(body).not.toContain(name.split(" ")[0]!);
    }
    // And the free-text notes, which are the richest leak, are never rendered.
    expect(body).not.toContain("anaphylaxis");
    expect(body).not.toContain("epipen");
    expect(body).not.toContain("coeliac");
    expect(body).not.toContain("no red meat");
  });

  test("a need with no disclose_ok key at all is withheld, not disclosed", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare(
        `UPDATE employee SET dietary_json = '[{"kind":"PEANUT","severity":"ALLERGY_SEVERE"}]'
          WHERE id='emp-kr-01'`,
      )
      .run();

    const res = await brief();
    expect(JSON.stringify(res.json).toLowerCase()).not.toContain("peanut");
    expect(res.json.dietary.withheld).toBe(1);
  });

  test("identical needs are grouped and counted rather than repeated", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare(
        `UPDATE employee SET dietary_json =
           '[{"kind":"SHELLFISH","severity":"ALLERGY_SEVERE","disclose_ok":1}]'
         WHERE id IN ('emp-kr-01','emp-kr-02')`,
      )
      .run();

    const res = await brief();
    expect(res.json.speak).toContain("Three guests have a severe shellfish allergy");
  });

  test("no dietary needs at all says so plainly", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db.prepare("UPDATE employee SET dietary_json = NULL").run();

    const res = await brief();
    expect(res.json.dietary.disclosable).toEqual([]);
    expect(res.json.dietary.withheld).toBe(0);
    expect(res.json.speak).toContain("No dietary needs have been recorded");
    expect(res.json.speak).not.toContain("not able to share");
  });

  test("malformed dietary_json is ignored, not a 500", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db
      .prepare("UPDATE employee SET dietary_json = 'not json at all' WHERE id='emp-kr-01'")
      .run();

    const res = await brief();
    expect(res.status).toBe(200);
    expect(res.json.headcount).toBe(26);
  });

  test("zero confirmed attendees does not invent a headcount", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    await ctx.db.prepare("UPDATE attendance SET attend_state='INVITED'").run();

    const res = await brief();
    expect(res.status).toBe(200);
    expect(res.json.headcount).toBe(0);
    expect(res.json.speak).toContain("don't have a confirmed headcount");
    expect(res.json.speak).not.toContain("no people");
  });

  test("a venue dispatch whose activity is missing exits speakably", async () => {
    await makeDispatch(ctx.db, {
      id: "disp-ghost",
      kind: "CALL_VENUE",
      activityId: "act-does-not-exist",
      slot: "slot-c",
    });
    await bindSlot(ctx.db, "slot-c", "disp-ghost");

    const res = await brief();
    expect(res.status).toBe(200);
    expect(res.json.speak).toContain("end the call");
    expect(res.json.venue).toBeUndefined();
  });

  test("a venue dispatch with no activity_id exits speakably", async () => {
    await makeDispatch(ctx.db, {
      id: "disp-bare",
      kind: "CALL_VENUE",
      activityId: null,
      slot: "slot-c",
    });
    await bindSlot(ctx.db, "slot-c", "disp-bare");

    const res = await brief();
    expect(res.status).toBe(200);
    expect(res.json.speak).toContain("end the call");
  });

  test("a CALL_NOTIFY binding degrades gracefully", async () => {
    await makeDispatch(ctx.db, {
      id: "disp-notify",
      kind: "CALL_NOTIFY",
      employeeId: "emp-us-02",
      activityId: "act-dinner",
      slot: "slot-c",
    });
    await bindSlot(ctx.db, "slot-c", "disp-notify");

    const res = await brief();
    expect(res.status).toBeLessThan(500);
    expect(typeof res.json.speak).toBe("string");
    expect(res.json.speak).toContain("end the call");
  });

  test("the brief hands the agent what confirm_venue needs next", async () => {
    // confirm_venue takes a bare wall-clock time and anchors the date itself,
    // because the model was 0-for-3 on a year. The brief must ask for exactly
    // that shape, and the two must agree end to end.
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();
    expect(res.json.speak).toContain("hours and minutes");

    const confirmed = await call(ctx, "POST", "/tools/slot-c/confirm_venue", {
      body: { agreed: true, new_time: "20:30", note: "" },
    });
    expect(confirmed.status).toBe(200);

    const vc = (
      await ctx.db.prepare("SELECT * FROM action WHERE kind='VENUE_CHANGE'").all<any>()
    ).results!;
    expect(vc).toHaveLength(1);
    expect(JSON.parse(vc[0].result_json).from).toBe("2026-09-16T10:30:00Z");
  });

  test("an employee brief on another slot is unaffected by all of this", async () => {
    await scenarioElena(ctx.db, "slot-a");
    await scenarioVenue(ctx.db, "slot-c");

    const [emp, ven] = await Promise.all([
      call(ctx, "GET", "/tools/slot-a/get_brief"),
      brief(),
    ]);

    expect(emp.json.traveller.name).toBe("Elena Duarte");
    expect(emp.json.options).toHaveLength(3);
    expect(emp.json.venue).toBeUndefined();
    expect(ven.json.venue.name).toBe("Jagalchi Hoetjip");
    expect(ven.json.traveller).toBeUndefined();
    expect(ven.json.speak).not.toContain("Elena");
  });

  test("the venue brief stays small enough to be spoken", async () => {
    await scenarioVenue(ctx.db, "slot-c");
    const res = await brief();
    expect(JSON.stringify(res.json).length).toBeLessThan(2048);
  });
});
