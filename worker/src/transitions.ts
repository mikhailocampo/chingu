/**
 * The approval → action state machine. One writer, one truth.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two callers drive the same transitions: the voice agent (a traveller picks an
 * option on the phone) and this dashboard (a coordinator approves a parked
 * plan). Money moves at the end of both. Two hand-maintained copies of that is
 * how you get a double-ticket six weeks from now.
 *
 * `backend/workers/tools/src/confirm-choice.ts` currently owns its own copy of
 * the writeReissue half. This module is the canonical version and that package
 * should migrate onto it — see TODOS.md. It is deliberately NOT edited from
 * here: it belongs to a concurrent track and its 84 tests are the gate.
 *
 * WHAT THE DASHBOARD UNIQUELY OWNS
 * --------------------------------
 * Nothing else in the codebase can CLOSE an approval. `decided_at`,
 * `decided_by`, `decision` and `decided_offer_id` are read in four places
 * (confirm-choice.ts:139, escalate.ts:49, and the roster query) and written in
 * zero. The voice agent only ever opens the gate; this is the other half.
 *
 * DATA_MODEL.md:154 calls `decision = MODIFIED` "the most interesting row in
 * the table" — a coordinator rarely just approves, they pick a different
 * option. That is captured here, not flattened into APPROVED.
 */
import type { Env } from "./index";

export type Decision = "APPROVED" | "REJECTED" | "MODIFIED";

export class TransitionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
    this.status = status;
  }
}

interface ApprovalRow {
  id: string;
  impact_id: string;
  offer_id: string | null;
  decided_at: string | null;
  impact_state: string;
  matched_num_updates: number | null;
  live_num_updates: number | null;
  itinerary_id: string | null;
  employee_id: string;
}

interface OfferRow {
  id: string;
  rank: number;
  expires_at: string | null;
  total_delta: string | null;
  route_summary: string | null;
  provider_offer_id: string | null;
  policy_verdict: string | null;
}

export interface DecideInput {
  approvalId: string;
  decision: Decision;
  /** Set only when the coordinator overrode the agent's pick. */
  offerId?: string | null;
  note?: string | null;
  /**
   * Operator id. Resolved SERVER-SIDE by the caller and never accepted from the
   * browser — a client-supplied decided_by is fake accountability. With no auth
   * layer in v1 this is a constant.
   */
  decidedBy: string;
}

/**
 * Close an approval and, if approved, queue the work.
 *
 * Order is deliberate: every refusal happens before the first write, so a
 * rejected attempt leaves nothing behind.
 */
export async function decideApproval(
  env: Env,
  input: DecideInput,
  now: Date,
): Promise<{ approvalId: string; decision: Decision; offerId: string | null; actionId: string | null }> {
  const apr = await env.DB.prepare(
    `SELECT a.id, a.impact_id, a.offer_id, a.decided_at,
            i.state               AS impact_state,
            i.matched_num_updates AS matched_num_updates,
            i.itinerary_id        AS itinerary_id,
            i.employee_id         AS employee_id,
            it.last_num_updates   AS live_num_updates
       FROM approval a
       JOIN disruption_impact i ON i.id = a.impact_id
       LEFT JOIN itinerary it    ON it.id = i.itinerary_id
      WHERE a.id = ?`,
  )
    .bind(input.approvalId)
    .first<ApprovalRow>();

  if (!apr) throw new TransitionError("NOT_FOUND", "no such approval", 404);

  // Idempotent by precondition, not by exception. Two coordinators clicking at
  // once, or one double-clicking, must not produce two decisions.
  if (apr.decided_at !== null) {
    throw new TransitionError("ALREADY_DECIDED", "this approval has already been decided");
  }

  if (input.decision === "REJECTED") {
    await rejectImpact(env, apr, input, now);
    return { approvalId: apr.id, decision: "REJECTED", offerId: null, actionId: null };
  }

  // MODIFIED means the human overrode the agent. Fall back to whatever the
  // approval was opened against when no override is supplied.
  const targetOfferId = input.offerId ?? apr.offer_id;
  if (!targetOfferId) {
    throw new TransitionError("NO_OFFER", "approving requires an offer to approve");
  }

  const offer = await env.DB.prepare(
    `SELECT id, rank, expires_at, total_delta, route_summary, provider_offer_id, policy_verdict
       FROM offer WHERE id = ? AND impact_id = ?`,
  )
    .bind(targetOfferId, apr.impact_id)
    .first<OfferRow>();

  if (!offer) {
    throw new TransitionError("BAD_OFFER", "that offer does not belong to this impact");
  }

  // Same guard the voice path applies at confirm-choice.ts:115. An expired
  // offer must not be reissued against.
  if (offer.expires_at && Date.parse(offer.expires_at) <= now.getTime()) {
    throw new TransitionError("OFFER_EXPIRED", "that option has expired — re-price before approving");
  }

  // Staleness. DATA_MODEL.md:225 — if the itinerary moved underneath us the
  // decision was made against a segment that no longer exists, so re-triage
  // rather than apply it. Without this the dashboard can authorise a change to
  // a booking that already changed.
  if (
    apr.matched_num_updates !== null &&
    apr.live_num_updates !== null &&
    apr.live_num_updates !== apr.matched_num_updates
  ) {
    throw new TransitionError(
      "STALE_ITINERARY",
      `itinerary changed underneath this decision (saw ${apr.matched_num_updates}, now ${apr.live_num_updates}) — re-triage`,
    );
  }

  const decision: Decision =
    input.offerId && input.offerId !== apr.offer_id ? "MODIFIED" : input.decision;

  const actionId = `act-${apr.impact_id}-${offer.id}`;
  // Stable across retries, so a double-click collides on the UNIQUE index
  // instead of issuing a second ticket.
  const idempotencyKey = `approve:${apr.impact_id}:${offer.id}`;

  // Compare-and-swap. The read of `decided_at` above is a fast path for a nice
  // error message, NOT the concurrency guard — two callers can both pass it.
  // The guard is `WHERE decided_at IS NULL` on this UPDATE: exactly one caller
  // can flip it, and we check `changes` to find out whether it was us.
  //
  // It runs FIRST in the batch so the ordering is unambiguous. The two writes
  // after it are idempotent by construction (the impact UPDATE sets the same
  // values, the action INSERT collides on its UNIQUE key), so a caller that
  // loses the race writes nothing new before being told it lost.
  const [approvalWrite] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE approval
          SET decided_at = ?, decided_by = ?, decision = ?, decided_offer_id = ?, note = ?
        WHERE id = ? AND decided_at IS NULL`,
    ).bind(
      now.toISOString(),
      input.decidedBy,
      decision,
      decision === "MODIFIED" ? offer.id : null,
      input.note ?? null,
      apr.id,
    ),

    // EXECUTING is the state commit 7dd6ba5 added for exactly this: the choice
    // is made and an action row is pending, which is distinct from "ticket
    // reissued". Without it a dashboard polling state cannot tell them apart.
    env.DB.prepare(
      `UPDATE disruption_impact
          SET previous_state = state, state = 'EXECUTING', state_changed_at = ?,
              selected_offer_id = ?
        WHERE id = ?`,
    ).bind(now.toISOString(), offer.id, apr.impact_id),

    // OR IGNORE, mirroring confirm-choice.ts:213-217: losing a race against an
    // identical concurrent approval is exactly what the UNIQUE index is for.
    // Treat the collision as success, not an error.
    env.DB.prepare(
      `INSERT OR IGNORE INTO action
         (id, kind, subject_type, subject_id, employee_id, approval_id,
          actor_kind, actor_id, idempotency_key, state, result_json, created_at)
       VALUES (?, 'REISSUE', 'impact', ?, ?, ?, 'COORDINATOR', ?, ?, 'PENDING', ?, ?)`,
    ).bind(
      actionId,
      apr.impact_id,
      apr.employee_id,
      apr.id,
      input.decidedBy,
      idempotencyKey,
      JSON.stringify({
        offer_id: offer.id,
        provider_offer_id: offer.provider_offer_id,
        route_summary: offer.route_summary,
        total_delta: offer.total_delta,
        // Recorded so "the agent followed policy" is falsifiable later.
        policy_verdict: offer.policy_verdict,
        authorised_by: input.decidedBy,
      }),
      now.toISOString(),
    ),
  ]);

  // We lost. Someone else decided this approval between our read and our write.
  if ((approvalWrite?.meta?.changes ?? 0) === 0) {
    throw new TransitionError("ALREADY_DECIDED", "this approval has already been decided");
  }

  return { approvalId: apr.id, decision, offerId: offer.id, actionId };
}

async function rejectImpact(env: Env, apr: ApprovalRow, input: DecideInput, now: Date) {
  const [approvalWrite] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE approval
          SET decided_at = ?, decided_by = ?, decision = 'REJECTED', note = ?
        WHERE id = ? AND decided_at IS NULL`,
    ).bind(now.toISOString(), input.decidedBy, input.note ?? null, apr.id),
    // Back to TRIAGING, not FAILED: a rejection means "not this option", and
    // there may be others worth offering. FAILED would strand the traveller.
    env.DB.prepare(
      `UPDATE disruption_impact
          SET previous_state = state, state = 'TRIAGING', state_changed_at = ?,
              selected_offer_id = NULL
        WHERE id = ?`,
    ).bind(now.toISOString(), apr.impact_id),
  ]);

  // Same compare-and-swap as the approve path.
  if ((approvalWrite?.meta?.changes ?? 0) === 0) {
    throw new TransitionError("ALREADY_DECIDED", "this approval has already been decided");
  }
}
