/**
 * POST /api/dev/call — place a REAL VocalBridge call. Dev-gated.
 *
 * The last mile. The queue consumer in index.ts already knows how to dial and
 * already refuses anything off the allowlist, but nothing was enqueueing to it,
 * so it had never run.
 *
 * WHY A SLOT BINDING IS NOT OPTIONAL
 * ----------------------------------
 * VocalBridge has no per-call context channel — `{phone_number,
 * participant_name}` is the entire accepted body of POST /api/v1/calls
 * (VOCALBRIDGE_LEARNINGS.md:19). The agent therefore learns who it called by
 * calling `get_brief` with zero parameters, and the tools worker resolves that
 * from `agent_slot.dispatch_id` (:21).
 *
 * So dialling without binding the slot first produces a call where the agent
 * cheerfully greets nobody in particular and then hangs up. The binding is the
 * whole correlation mechanism, and it has to exist BEFORE the phone rings.
 *
 * `agent_slot` is authoritative for resolution; `dispatch.slot` is only the
 * historical record of which slot a dispatch used (schema.sql:244). Never
 * resolve through the latter.
 */
import type { Env } from "./index";

export interface CallRequest {
  employeeId?: string;
  slot?: string;
  directive?: string;
}

/** Long enough to outlive a demo call; the reaper frees orphans. */
const LEASE_MINUTES = 30;

export async function placeCall(
  env: Env,
  body: CallRequest,
  now: Date,
): Promise<Response> {
  const employeeId = body.employeeId ?? "emp-us-01";
  const slot = body.slot ?? "slot-a";

  const row = await env.DB.prepare(
    `SELECT e.id            AS employee_id,
            e.name          AS name,
            e.phone_e164    AS phone,
            i.id            AS impact_id,
            i.state         AS impact_state
       FROM employee e
       LEFT JOIN disruption_impact i
         ON i.employee_id = e.id AND i.state <> 'RESOLVED'
      WHERE e.id = ?`,
  )
    .bind(employeeId)
    .first<{
      employee_id: string;
      name: string;
      phone: string | null;
      impact_id: string | null;
      impact_state: string | null;
    }>();

  if (!row) {
    return Response.json({ error: `no such employee: ${employeeId}` }, { status: 404 });
  }
  if (!row.impact_id) {
    return Response.json(
      { error: `${row.name} has nothing to call about — fire /api/dev/disrupt first` },
      { status: 409 },
    );
  }
  if (!row.phone) {
    return Response.json({ error: `${row.name} has no phone number on record` }, { status: 409 });
  }

  // Fail early and loudly rather than letting the queue consumer discover it,
  // so the operator sees the refusal instead of a silently dead dispatch.
  // The consumer checks again — this is a nicer error, not the guard itself.
  const allowed = (env.DIAL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(row.phone)) {
    return Response.json(
      {
        error: "refusing to dial: number is not on DIAL_ALLOWLIST",
        hint: "seed.sql ships 16 Korean numbers in a non-reserved range; dialling is deny-by-default",
      },
      { status: 403 },
    );
  }

  const slotRow = await env.DB.prepare(`SELECT slot, vb_agent_id, status FROM agent_slot WHERE slot = ?`)
    .bind(slot)
    .first<{ slot: string; vb_agent_id: string; status: string }>();
  if (!slotRow) {
    return Response.json({ error: `no such slot: ${slot}` }, { status: 404 });
  }

  const dispatchId = `dsp-${row.impact_id}-${slot}`;
  const iso = now.toISOString();
  const lease = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO dispatch
         (id, kind, impact_id, employee_id, slot, directive, idempotency_key,
          actor_kind, status, created_at)
       VALUES (?, 'CALL_EMPLOYEE', ?, ?, ?, ?, ?, 'COORDINATOR', 'QUEUED', ?)
       ON CONFLICT(id) DO UPDATE SET status = 'QUEUED', created_at = excluded.created_at`,
    ).bind(
      dispatchId,
      row.impact_id,
      row.employee_id,
      slot,
      body.directive ?? "Flight cancelled — read the priced options and capture a choice.",
      `call:${row.impact_id}:${slot}`,
      iso,
    ),

    // The binding get_brief resolves through. schema.sql:253 enforces that a
    // BOUND slot carries a lease — a NULL lease reads as unbound, so binding
    // without one is a silent no-op.
    env.DB.prepare(
      `UPDATE agent_slot
          SET status = 'BOUND', dispatch_id = ?, bound_at = ?, lease_expires_at = ?
        WHERE slot = ?`,
    ).bind(dispatchId, iso, lease, slot),

    env.DB.prepare(
      `UPDATE disruption_impact
          SET previous_state = state, state = 'CONTACTING', state_changed_at = ?
        WHERE id = ?`,
    ).bind(iso, row.impact_id),
  ]);

  await env.DISPATCH_Q.send({
    dispatchId,
    employeeId: row.employee_id,
    phone: row.phone,
    directive: body.directive ?? "Flight cancelled — read the priced options.",
  });

  return Response.json({
    ok: true,
    dispatchId,
    slot,
    employee: { id: row.employee_id, name: row.name },
    impactId: row.impact_id,
    // Never echo the number back — this response ends up in logs and demos.
    phone: "on allowlist",
    note: "queued; the consumer dials and binds room_name for the debug stream",
  });
}

/** Free the slot and drop the dispatch, so the demo can be re-run. */
export async function releaseCall(env: Env, slot = "slot-a"): Promise<Response> {
  const bound = await env.DB.prepare(`SELECT dispatch_id FROM agent_slot WHERE slot = ?`)
    .bind(slot)
    .first<{ dispatch_id: string | null }>();

  await env.DB.batch([
    env.DB.prepare(
      // status FREE and a NULL lease must move together — the CHECK constraint
      // at schema.sql:253 only permits a NULL lease when FREE.
      `UPDATE agent_slot
          SET status = 'FREE', dispatch_id = NULL, bound_at = NULL, lease_expires_at = NULL
        WHERE slot = ?`,
    ).bind(slot),
    env.DB.prepare(`DELETE FROM dispatch WHERE slot = ? AND kind = 'CALL_EMPLOYEE'`).bind(slot),
  ]);

  return Response.json({ ok: true, released: slot, was: bound?.dispatch_id ?? null });
}
