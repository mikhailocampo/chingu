import type { Env, Bound } from "./types";
import {
  speak, NO_BOOKING, carrierName, airportName, spokenDate, countWord,
} from "./speak";

/**
 * GET /tools/:slot/get_brief — zero parameters, by construction.
 *
 * Returns speakable text plus explicitly numbered options. The numbering is
 * load-bearing: given no format the model invented `{"choice":"A1"}` out of
 * nothing, so the numbers appear in the spoken text for it to relay rather
 * than generate.
 */

export const MAX_OPTIONS = 3;

export async function getBrief(env: Env, bound: Bound | null): Promise<Response> {
  if (!bound || !bound.impact_id) return speak(NO_BOOKING, { options: [] });

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
