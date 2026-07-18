import type { Env, Bound } from "./types";
import {
  speak, NO_BOOKING, carrierName, airportName, spokenDate, spokenTime, countWord,
} from "./speak";
import { localWallClock } from "./time";
import { summarise } from "./dietary";

/**
 * GET /tools/:slot/get_brief — zero parameters, by construction.
 *
 * Returns speakable text plus explicitly numbered options. The numbering is
 * load-bearing: given no format the model invented `{"choice":"A1"}` out of
 * nothing, so the numbers appear in the spoken text for it to relay rather
 * than generate.
 *
 * Two briefs, chosen by the binding rather than by anything the model says: a
 * traveller brief for CALL_EMPLOYEE (keyed on `impact_id`) and a venue brief
 * for CALL_VENUE (keyed on `activity_id`). The split mirrors the write half in
 * confirm-venue.ts, which gates on the same `kind` + `activity_id` pair.
 */

export const MAX_OPTIONS = 3;

export async function getBrief(env: Env, bound: Bound | null): Promise<Response> {
  if (!bound) return speak(NO_BOOKING, { options: [] });

  // A venue call carries no impact_id at all, so this must come first.
  if (bound.kind === "CALL_VENUE" && bound.activity_id) {
    return venueBrief(env, bound.activity_id);
  }

  // CALL_NOTIFY, and any binding missing the row it needs, exits speakably.
  if (!bound.impact_id) return speak(NO_BOOKING, { options: [] });

  const brief = await env.DB.prepare(
    `SELECT e.name       AS name,
            e.phone_e164 AS phone,
            de.carrier   AS carrier,
            de.flight_no AS flight_no,
            de.origin    AS origin,
            de.dest      AS dest,
            de.dep_date  AS dep_date,
            de.kind      AS kind
       FROM disruption_impact i
       JOIN employee e         ON e.id = i.employee_id
       JOIN disruption_event de ON de.id = i.event_id
      WHERE i.id = ?`,
  )
    .bind(bound.impact_id)
    .first<{
      name: string; phone: string | null; carrier: string | null;
      flight_no: number | null; origin: string | null; dest: string | null;
      dep_date: string | null; kind: string;
    }>();

  if (!brief) return speak(NO_BOOKING, { options: [] });

  const offers = await env.DB.prepare(
    `SELECT rank, route_summary, arrives_at, total_delta, currency, charge_type, policy_verdict
       FROM offer WHERE impact_id = ? ORDER BY rank ASC LIMIT ?`,
  )
    .bind(bound.impact_id, MAX_OPTIONS)
    .all<{
      rank: number; route_summary: string | null; arrives_at: string | null;
      total_delta: string | null; currency: string | null;
      charge_type: string | null; policy_verdict: string | null;
    }>();

  // Renumber 1..N off the ordered list rather than trusting `rank` to be dense.
  const options = (offers.results ?? []).map((o, i) => ({
    number: i + 1,
    summary: o.route_summary ?? "an alternative flight",
    arrives: o.arrives_at ?? null,
  }));

  return speak(briefSentence(brief, options), {
    traveller: { name: brief.name, phone: brief.phone },
    options,
  });
}

/**
 * The venue half. The agent is on the phone to a restaurant, so it needs the
 * booking as the restaurant holds it: local time, headcount, and only those
 * dietary needs it is permitted to disclose.
 */
async function venueBrief(env: Env, activityId: string): Promise<Response> {
  const activity = await env.DB.prepare(
    `SELECT venue, phone, kind, starts_at, timezone FROM activity WHERE id = ?`,
  )
    .bind(activityId)
    .first<{
      venue: string; phone: string | null; kind: string;
      starts_at: string; timezone: string | null;
    }>();

  if (!activity) return speak(NO_BOOKING, { options: [] });

  const headcount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM attendance
      WHERE activity_id = ? AND attend_state = 'CONFIRMED'`,
  )
    .bind(activityId)
    .first<{ n: number }>();
  const confirmed = headcount?.n ?? 0;

  // Names are deliberately not selected. See dietary.ts — there is no code path
  // from a guest's identity to a medical detail because the identity is never
  // read in the first place.
  const dietaryRows = await env.DB.prepare(
    `SELECT e.dietary_json AS dietary_json
       FROM attendance a
       JOIN employee e ON e.id = a.employee_id
      WHERE a.activity_id = ? AND a.attend_state = 'CONFIRMED'
        AND e.dietary_json IS NOT NULL
      ORDER BY a.employee_id`,
  )
    .bind(activityId)
    .all<{ dietary_json: string | null }>();

  const dietary = summarise((dietaryRows.results ?? []).map((r) => r.dietary_json));

  const tz = activity.timezone ?? "UTC";
  const local = localWallClock(activity.starts_at, tz);
  const when = {
    date: spokenDate(local.date),
    time: spokenTime(local.hour, local.minute),
  };

  return speak(venueSentence(activity, when, confirmed, dietary), {
    venue: { name: activity.venue, phone: activity.phone },
    booking: { date: when.date, time: when.time, timezone: tz },
    headcount: confirmed,
    dietary: { disclosable: dietary.phrases, withheld: dietary.withheld },
    options: [],
  });
}

function venueSentence(
  a: { venue: string; kind: string },
  when: { date: string; time: string },
  confirmed: number,
  dietary: { phrases: string[]; withheld: number; severe: boolean },
): string {
  const meal = a.kind === "DINNER" ? "dinner" : "group";
  const parts = [`You're calling ${a.venue} about the ${meal} booking.`];

  // A missing date would leave a dangling "on at"; both halves are guarded.
  const at = [when.date && `on ${when.date}`, when.time && `at ${when.time}`]
    .filter(Boolean)
    .join(" ");
  // `countWord(0)` is "no", which would read as "for no people" — the zero case
  // gets its own sentence instead, because it means "unknown", not "empty".
  const who = confirmed === 0
    ? ""
    : `, for ${countWord(confirmed)} ${confirmed === 1 ? "person" : "people"}`;

  parts.push(
    at ? `The booking is currently ${at}${who}.` : `I have the booking${who}.`,
  );

  if (confirmed === 0) {
    parts.push("I don't have a confirmed headcount for it yet, so don't quote them a number.");
  }

  if (dietary.phrases.length > 0) {
    parts.push(...dietary.phrases.map((p) => `${p}.`));
    if (dietary.severe) {
      parts.push("Treat the severe allergy as a strict requirement, not a preference.");
    }
  }

  if (dietary.withheld > 0) {
    // What they are is not said, and must not be: the count is the whole point.
    parts.push(
      "Some guests have further dietary needs I'm not able to share with the restaurant.",
      "Ask in general terms whether the kitchen can accommodate additional requirements, and I'll have a colleague follow up on the details.",
    );
  } else if (dietary.phrases.length === 0) {
    parts.push("No dietary needs have been recorded for this booking.");
  }

  parts.push(
    dietary.phrases.length > 0
      ? "Ask whether the kitchen can accommodate those needs, and whether the booking can be moved to a different time."
      : "Ask whether the booking can be moved to a different time.",
    "If they agree to a new time, tell me the new time in hours and minutes.",
  );

  return parts.join(" ");
}

function briefSentence(
  b: {
    name: string; carrier: string | null; flight_no: number | null;
    origin: string | null; dest: string | null; dep_date: string | null; kind: string;
  },
  options: { number: number; summary: string }[],
): string {
  const flight = [
    carrierName(b.carrier),
    b.flight_no != null ? `flight ${b.flight_no}` : "flight",
  ].join(" ");
  const route = b.origin && b.dest
    ? ` from ${airportName(b.origin)} to ${airportName(b.dest)}`
    : "";
  const when = b.dep_date ? ` on ${spokenDate(b.dep_date)}` : "";
  const what = b.kind === "FLIGHT_DELAYED" ? "been delayed" : "been cancelled";

  const parts = [
    `You're calling ${b.name} about their ${flight}${route}${when}, which has ${what}.`,
  ];

  if (options.length === 0) {
    parts.push(
      "There are no alternatives ready yet. Apologise, say a colleague will call back shortly, and end the call.",
    );
  } else {
    parts.push(
      `There ${options.length === 1 ? "is" : "are"} ${countWord(options.length)} alternative${options.length === 1 ? "" : "s"}.`,
      ...options.map((o) => `Option ${o.number}: ${o.summary}.`),
      "Read the options out and ask which number they would like.",
    );
  }
  return parts.join(" ");
}
