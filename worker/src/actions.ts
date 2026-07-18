/**
 * POST /api/actions/drain — execute pending work and close out the impact.
 *
 * The terminal write. Without it nothing ever reaches RESOLVED: confirm_choice
 * (or an approval) leaves the impact at EXECUTING with a PENDING action, and
 * the card reads "Booking" forever. The demo has no ending.
 *
 * WHAT THIS DOES NOT DO IN v1
 * ---------------------------
 * It does not call Sabre. That was a deliberate scope decision: seed.sql ships
 * fake PNRs for everyone except the one traveller with a real ticket, so
 * attempting a reissue across the board would fail on stage at the worst
 * possible moment. The action row is written, is idempotent, and carries the
 * authorisation trail — executing it for real is a later step behind the same
 * seam.
 *
 * So this marks work COMPLETED and records that it was simulated. It never
 * pretends a ticket was issued: `result_json.simulated` is set, and
 * `external_ref` stays NULL because there is no real confirmation to point at.
 *
 * Idempotent by state, not by exception: only PENDING rows are claimed, and
 * the UPDATE carries its own `WHERE state = 'PENDING'` so two concurrent
 * drains cannot both complete the same action.
 */
import type { Env } from "./index";

interface PendingAction {
  id: string;
  kind: string;
  subject_id: string;
  employee_id: string | null;
  result_json: string | null;
}

export async function drainActions(env: Env, now: Date): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, subject_id, employee_id, result_json
       FROM action
      WHERE state = 'PENDING' AND subject_type = 'impact'
      ORDER BY created_at`,
  ).all<PendingAction>();

  const pending = results ?? [];
  if (pending.length === 0) {
    return Response.json({ ok: true, completed: 0, note: "nothing pending" });
  }

  const iso = now.toISOString();
  const completed: string[] = [];

  for (const a of pending) {
    let payload: Record<string, unknown> = {};
    try {
      payload = a.result_json ? JSON.parse(a.result_json) : {};
    } catch {
      // A malformed blob must not stop the drain — record and move on.
      payload = { parse_error: true };
    }

    const res = await env.DB.prepare(
      `UPDATE action
          SET state = 'COMPLETED', completed_at = ?, result_json = ?
        WHERE id = ? AND state = 'PENDING'`,
    )
      .bind(
        iso,
        JSON.stringify({
          ...payload,
          // Never let this be mistaken for a real ticket.
          simulated: true,
          completed_at: iso,
        }),
        a.id,
      )
      .run();

    // Lost the race to another drain. Skip rather than double-resolve.
    if ((res.meta?.changes ?? 0) === 0) continue;
    completed.push(a.id);

    // Only the impact this action belongs to, and only if it is still mid-flight.
    // A REJECTED impact that went back to TRIAGING must not be dragged forward.
    await env.DB.prepare(
      `UPDATE disruption_impact
          SET previous_state = state,
              state = 'RESOLVED',
              state_changed_at = ?,
              resolved_at = ?
        WHERE id = ? AND state IN ('EXECUTING','CONTACTING')`,
    )
      .bind(iso, iso, a.subject_id)
      .run();

    // Close the call out too, so the card stops looking mid-flight.
    await env.DB.prepare(
      `UPDATE dispatch
          SET status = 'RESOLVED', resolved_at = ?, outcome_summary = ?
        WHERE impact_id = ? AND status NOT IN ('RESOLVED','FAILED','NO_ANSWER')`,
    )
      .bind(iso, summarise(payload), a.subject_id)
      .run();
  }

  // Free any slot whose dispatch is now finished, so the pool does not leak.
  await env.DB.prepare(
    `UPDATE agent_slot
        SET status = 'FREE', dispatch_id = NULL, bound_at = NULL, lease_expires_at = NULL
      WHERE dispatch_id IN (
        SELECT id FROM dispatch WHERE status IN ('RESOLVED','FAILED','NO_ANSWER'))`,
  ).run();

  return Response.json({ ok: true, completed: completed.length, actions: completed });
}

/** One line for the dashboard log. Never invents a confirmation number. */
function summarise(payload: Record<string, unknown>): string {
  const route = typeof payload.route_summary === "string" ? payload.route_summary : "the selected option";
  const delta = typeof payload.total_delta === "string" ? payload.total_delta : null;
  return delta && delta !== "0.00"
    ? `Rebooked to ${route}, $${delta}.`
    : `Rebooked to ${route} at no extra cost.`;
}
