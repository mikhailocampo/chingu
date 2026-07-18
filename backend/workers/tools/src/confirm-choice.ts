import type { Env, Bound } from "./types";
import { speak, NO_BOOKING } from "./speak";
import { MAX_OPTIONS } from "./brief";
import { newId, reissueKey, sha256Hex, isUniqueViolation } from "./ids";

/**
 * POST /tools/:slot/confirm_choice — one parameter, `choice`.
 *
 * `choice` is the ONLY LLM-supplied value in the whole design, and it is
 * deliberately low-entropy and heard directly ("the second one"). It is still
 * never trusted: it is validated against the offers actually attached to this
 * slot's dispatch, so a slip books a different pre-approved option for the
 * right traveller rather than someone else's trip.
 *
 * This endpoint does NOT call Sabre. It writes a PENDING `action` row and
 * returns — a human is waiting on the line.
 */

type OfferRow = {
  id: string;
  rank: number;
  provider_offer_id: string | null;
  expires_at: string | null;
  charge_type: string | null;
  currency: string | null;
  total_delta: string | null;
  route_summary: string | null;
  arrives_at: string | null;
  policy_verdict: string | null;
};

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

/**
 * Accepts an integer, a numeric string, or the spoken word forms the model is
 * likely to relay. Everything else — floats, booleans, objects, "A1" — is
 * rejected outright rather than coerced.
 */
export function parseChoice(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    return WORD_NUMBERS[s] ?? null;
  }
  return null;
}

export async function confirmChoice(
  env: Env,
  bound: Bound | null,
  body: Record<string, unknown>,
  now: Date = new Date(),
): Promise<Response> {
  if (!bound || !bound.impact_id) return speak(NO_BOOKING);
  const impactId = bound.impact_id;

  // Offers are renumbered 1..N off the ordered list so the numbers match
  // exactly what get_brief read out, regardless of gaps in `rank`.
  const offers = (
    await env.DB.prepare(
      `SELECT id, rank, provider_offer_id, expires_at, charge_type, currency,
              total_delta, route_summary, arrives_at, policy_verdict
         FROM offer WHERE impact_id = ? ORDER BY rank ASC LIMIT ?`,
    )
      .bind(impactId, MAX_OPTIONS)
      .all<OfferRow>()
  ).results ?? [];

  if (offers.length === 0) {
    return speak(
      "I don't have any options to book right now. Let the traveller know a colleague will call them back.",
    );
  }

  // Any existing rebooking for this impact wins. A traveller changing their
  // mind mid-call must not produce a second ticket.
  const existing = await env.DB.prepare(
    `SELECT id, result_json FROM action
      WHERE kind = 'REISSUE' AND subject_type = 'impact' AND subject_id = ?
      LIMIT 1`,
  )
    .bind(impactId)
    .first<{ id: string; result_json: string | null }>();

  if (existing) {
    const booked = safeParse(existing.result_json);
    const which = booked?.number ? `Option ${booked.number}` : "Their choice";
    return speak(
      `${which} is already recorded for this booking${booked?.summary ? `: ${booked.summary}` : ""}. Tell them it's confirmed and that they'll get an email shortly.`,
      { booked, status: "PENDING", duplicate: true },
    );
  }

  const choice = parseChoice(body.choice);
  // Position in the ordered list, not `offer.rank` — this is the number
  // get_brief read out.
  const chosen = choice === null ? undefined : offers[choice - 1];

  if (!chosen) {
    const valid = offers.map((_, i) => i + 1).join(", ");
    return speak(
      `I didn't catch a valid option. Please ask them to choose ${offers.length === 1 ? "option 1" : `one of options ${valid}`}, and say the number.`,
      { valid_options: offers.map((_, i) => i + 1) },
    );
  }

  if (chosen.expires_at && Date.parse(chosen.expires_at) <= now.getTime()) {
    return speak(
      "I'm sorry, that option is no longer available — the fare has expired. Offer them one of the other options, or say a colleague will call back with fresh alternatives.",
    );
  }

  if (chosen.policy_verdict === "NEEDS_APPROVAL" || chosen.policy_verdict === "FAIL") {
    return parkForApproval(env, bound, impactId, chosen, choice!, now);
  }

  return writeReissue(env, bound, impactId, chosen, choice!, now);
}

/** Above policy: record the intent, never execute it. */
async function parkForApproval(
  env: Env,
  bound: Bound,
  impactId: string,
  offer: OfferRow,
  number: number,
  now: Date,
): Promise<Response> {
  const already = await env.DB.prepare(
    `SELECT id FROM approval WHERE impact_id = ? AND offer_id = ? AND decided_at IS NULL LIMIT 1`,
  )
    .bind(impactId, offer.id)
    .first<{ id: string }>();

  if (!already) {
    await env.DB.prepare(
      `INSERT INTO approval (id, impact_id, offer_id, reason, requested_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId("apr", now.getTime()),
        impactId,
        offer.id,
        offer.policy_verdict === "FAIL" ? "POLICY_FAIL" : "OVER_THRESHOLD",
        now.toISOString(),
        `Chosen on call via ${bound.slot}: ${offer.route_summary ?? offer.id}`,
      )
      .run();
  }

  await env.DB.prepare(
    `UPDATE disruption_impact
        SET previous_state = state,
            state = 'AWAITING_APPROVAL',
            state_changed_at = ?,
            selected_offer_id = ?
      WHERE id = ?`,
  )
    .bind(now.toISOString(), offer.id, impactId)
    .run();

  return speak(
    `That option needs a quick sign-off from their travel coordinator, so I can't confirm it on this call. Tell them it's been noted and a human will confirm it shortly, then thank them and end the call.`,
    { parked: true, awaiting_approval: true },
  );
}

/** Within policy: one PENDING action row, keyed so a retry can never double it. */
async function writeReissue(
  env: Env,
  bound: Bound,
  impactId: string,
  offer: OfferRow,
  number: number,
  now: Date,
): Promise<Response> {
  const key = reissueKey(bound.dispatch_id, impactId, number);
  const booked = {
    number,
    summary: offer.route_summary ?? "the selected flight",
    arrives: offer.arrives_at,
    total_delta: offer.total_delta,
    currency: offer.currency,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO action
         (id, kind, subject_type, subject_id, employee_id, dispatch_id,
          actor_kind, idempotency_key, request_hash, state, result_json, created_at)
       VALUES (?, 'REISSUE', 'impact', ?, ?, ?, 'AGENT', ?, ?, 'PENDING', ?, ?)`,
    )
      .bind(
        newId("act", now.getTime()),
        impactId,
        bound.employee_id,
        bound.dispatch_id,
        key,
        await sha256Hex(`${key}|${offer.id}|${offer.provider_offer_id ?? ""}`),
        JSON.stringify({ ...booked, offer_id: offer.id, provider_offer_id: offer.provider_offer_id }),
        now.toISOString(),
      )
      .run();
  } catch (err) {
    // Lost a race against a concurrent identical confirm. That is exactly what
    // the UNIQUE index is for — treat it as success, not an error.
    if (!isUniqueViolation(err)) throw err;
  }

  // EXECUTING, not just selected_offer_id.
  //
  // Commit 7dd6ba5 added this state describing exactly this moment: the
  // traveller has chosen and an `action` row is pending, which is distinct from
  // "ticket reissued". Nothing wrote it, so a dashboard polling state could not
  // tell the two apart and a card sat at CONTACTING -> CALLING forever, looking
  // like the agent was still on the phone after the call had ended.
  await env.DB.prepare(
    `UPDATE disruption_impact
        SET previous_state = state,
            state = 'EXECUTING',
            state_changed_at = ?,
            selected_offer_id = ?
      WHERE id = ?`,
  )
    .bind(now.toISOString(), offer.id, impactId)
    .run();

  return speak(
    `Confirmed: ${booked.summary}. Read that back to them, let them know they'll get an email with the new details, and thank them.`,
    { booked, status: "PENDING" },
  );
}

function safeParse(s: string | null): any {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return { number: v.number, summary: v.summary, arrives: v.arrives };
  } catch {
    return undefined;
  }
}
