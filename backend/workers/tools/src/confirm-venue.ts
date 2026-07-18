import type { Env, Bound } from "./types";
import { speak, NO_BOOKING } from "./speak";
import { newId, venueChangeKey, notifyKey, isUniqueViolation } from "./ids";
import { parseAgreed, parseNewTime } from "./time";

/**
 * POST /tools/:slot/confirm_venue — params `agreed`, `new_time`, `note`.
 *
 * Writes a PENDING VENUE_CHANGE action carrying from/to, then enqueues one
 * NOTIFY_EMAIL action per CONFIRMED attendee. Nothing is sent from here; each
 * notification row is independently idempotent so a partially-failed fan-out
 * is repaired by re-running rather than by re-notifying everyone.
 *
 * `activity.starts_at` is deliberately NOT mutated: it is the `from` value, and
 * rewriting it would make the derived idempotency keys unstable — a second call
 * would compute a different key and duplicate the whole fan-out.
 */
export async function confirmVenue(
  env: Env,
  bound: Bound | null,
  body: Record<string, unknown>,
  now: Date = new Date(),
): Promise<Response> {
  if (!bound) return speak(NO_BOOKING);

  if (bound.kind !== "CALL_VENUE" || !bound.activity_id) {
    return speak(
      "This call isn't about a venue booking, so I can't change one. Please carry on with the traveller.",
    );
  }

  const activity = await env.DB.prepare(
    `SELECT id, venue, starts_at, timezone FROM activity WHERE id = ?`,
  )
    .bind(bound.activity_id)
    .first<{ id: string; venue: string; starts_at: string; timezone: string | null }>();

  if (!activity) return speak(NO_BOOKING);

  const agreed = parseAgreed(body.agreed);
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";

  if (!agreed) {
    // Nothing is written. The venue said no; a coordinator picks it up from the
    // call record.
    return speak(
      `Understood — no change at ${activity.venue}. Thank them for their time and end the call.`,
      { agreed: false },
    );
  }

  const to = parseNewTime(body.new_time, activity.starts_at, activity.timezone ?? "UTC");
  if (!to) {
    return speak(
      "I didn't catch a clear new time. Please ask them for the time in hours and minutes, then tell me again.",
      { agreed: true, recorded: false },
    );
  }

  const from = activity.starts_at;
  const key = venueChangeKey(bound.dispatch_id, activity.id, to);

  await insertIgnoringDuplicate(
    env,
    `INSERT INTO action
       (id, kind, subject_type, subject_id, dispatch_id, actor_kind,
        idempotency_key, state, result_json, created_at)
     VALUES (?, 'VENUE_CHANGE', 'activity', ?, ?, 'AGENT', ?, 'PENDING', ?, ?)`,
    [
      newId("act", now.getTime()),
      activity.id,
      bound.dispatch_id,
      key,
      JSON.stringify({ from, to, venue: activity.venue, note }),
      now.toISOString(),
    ],
  );

  const notified = await fanOutNotifications(env, bound, activity.id, from, to, now);

  return speak(
    `The change is confirmed for ${activity.venue}. Tell them we'll email everyone the new time, thank them, and end the call.`,
    { agreed: true, recorded: true, notified, status: "PENDING" },
  );
}

/**
 * One NOTIFY_EMAIL per CONFIRMED attendee, each with its own derived key.
 * Re-running only fills the gaps — that is the point of per-row keys.
 */
async function fanOutNotifications(
  env: Env,
  bound: Bound,
  activityId: string,
  from: string,
  to: string,
  now: Date,
): Promise<number> {
  const attendees = (
    await env.DB.prepare(
      `SELECT employee_id FROM attendance
        WHERE activity_id = ? AND attend_state = 'CONFIRMED'
        ORDER BY employee_id`,
    )
      .bind(activityId)
      .all<{ employee_id: string }>()
  ).results ?? [];

  for (const a of attendees) {
    await insertIgnoringDuplicate(
      env,
      `INSERT INTO action
         (id, kind, subject_type, subject_id, employee_id, dispatch_id, actor_kind,
          idempotency_key, state, result_json, created_at)
       VALUES (?, 'NOTIFY_EMAIL', 'activity', ?, ?, ?, 'AGENT', ?, 'PENDING', ?, ?)`,
      [
        newId("act", now.getTime()),
        activityId,
        a.employee_id,
        bound.dispatch_id,
        notifyKey(activityId, a.employee_id, to),
        JSON.stringify({ from, to }),
        now.toISOString(),
      ],
    );
  }

  return attendees.length;
}

async function insertIgnoringDuplicate(env: Env, sql: string, args: unknown[]) {
  try {
    await env.DB.prepare(sql).bind(...args).run();
  } catch (err) {
    // A duplicate key means the work is already recorded. That is success.
    if (!isUniqueViolation(err)) throw err;
  }
}
