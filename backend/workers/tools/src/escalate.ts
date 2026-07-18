import type { Env, Bound } from "./types";
import { speak } from "./speak";
import { newId } from "./ids";

/**
 * POST /tools/:slot/escalate — param `reason`.
 *
 * This is the agent's exit hatch, so it NEVER fails. Every write is
 * best-effort and individually guarded: an escalation that 500s leaves the
 * agent stuck on a live call with a confused human, which is strictly worse
 * than an escalation that is acknowledged but under-recorded.
 */

const ACK =
  "Thanks — I've passed this to a colleague who'll follow up shortly. Apologise for not being able to sort it on this call, thank them for their time, and end the call.";

const MAX_REASON = 500;

export async function escalate(
  env: Env,
  bound: Bound | null,
  body: Record<string, unknown>,
  now: Date = new Date(),
): Promise<Response> {
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, MAX_REASON)
      : "Agent escalated without giving a reason.";

  if (bound) {
    await best(() => noteOnDispatch(env, bound, reason, now));
    if (bound.impact_id) {
      await best(() => park(env, bound.impact_id!, bound.slot, reason, now));
    }
  }

  return speak(ACK, { escalated: true });
}

async function park(
  env: Env,
  impactId: string,
  slot: string,
  reason: string,
  now: Date,
) {
  const already = await env.DB.prepare(
    `SELECT id FROM approval
      WHERE impact_id = ? AND reason = 'AGENT_UNSURE' AND decided_at IS NULL LIMIT 1`,
  )
    .bind(impactId)
    .first<{ id: string }>();

  if (!already) {
    await env.DB.prepare(
      `INSERT INTO approval (id, impact_id, reason, requested_at, note)
       VALUES (?, ?, 'AGENT_UNSURE', ?, ?)`,
    )
      .bind(newId("apr", now.getTime()), impactId, now.toISOString(), `[${slot}] ${reason}`)
      .run();
  }

  await env.DB.prepare(
    `UPDATE disruption_impact
        SET previous_state = state,
            state = 'AWAITING_APPROVAL',
            state_changed_at = ?
      WHERE id = ? AND state <> 'AWAITING_APPROVAL'`,
  )
    .bind(now.toISOString(), impactId)
    .run();
}

async function noteOnDispatch(env: Env, bound: Bound, reason: string, now: Date) {
  await env.DB.prepare(
    `UPDATE dispatch SET outcome_summary = ? WHERE id = ?`,
  )
    .bind(`Escalated: ${reason}`, bound.dispatch_id)
    .run();
  void now;
}

/** Swallow and log. Nothing in this file may propagate an error. */
async function best(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    console.error("escalate_write_failed", String(err));
  }
}
