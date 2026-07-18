import type { Env, Bound } from "./types";

/**
 * Slot -> dispatch resolution. This is the entire correlation mechanism:
 * VocalBridge sends no per-call context and the model corrupts any value it is
 * asked to carry, so the only trustworthy identifier is the one WE put in the
 * URL path and resolve here, server-side.
 */

export const SLOTS = new Set(["slot-a", "slot-b", "slot-c"]);

/** Dispatch statuses past which there is nothing left to discuss. */
export const TERMINAL_DISPATCH = new Set(["RESOLVED", "FAILED", "NO_ANSWER"]);

export function isSlot(s: string | undefined): s is string {
  return !!s && SLOTS.has(s);
}

/**
 * Returns the bound dispatch, or null when the slot is free, leased-expired,
 * dangling, or its dispatch has reached a terminal state. Callers turn null
 * into a speakable exit — never a 500.
 */
export async function resolveSlot(
  env: Env,
  slot: string,
  now: Date = new Date(),
): Promise<Bound | null> {
  if (!isSlot(slot)) return null;

  const row = await env.DB.prepare(
    `SELECT s.slot            AS slot,
            s.status          AS slot_status,
            s.lease_expires_at AS lease_expires_at,
            d.id              AS dispatch_id,
            d.kind            AS kind,
            d.impact_id       AS impact_id,
            d.employee_id     AS employee_id,
            d.activity_id     AS activity_id,
            d.status          AS dispatch_status
       FROM agent_slot s
       LEFT JOIN dispatch d ON d.id = s.dispatch_id
      WHERE s.slot = ?`,
  )
    .bind(slot)
    .first<Record<string, string | null>>();

  if (!row) return null;
  if (row.slot_status !== "BOUND") return null;
  if (!row.dispatch_id) return null;
  // A lease is required. An absent expiry is an orphaned bind, not a permanent
  // one — the reaper may not have run yet, so treat it as unbound.
  if (!row.lease_expires_at) return null;
  if (Date.parse(row.lease_expires_at) <= now.getTime()) return null;
  if (TERMINAL_DISPATCH.has(row.dispatch_status ?? "")) return null;

  return {
    slot,
    dispatch_id: row.dispatch_id,
    kind: row.kind as Bound["kind"],
    impact_id: row.impact_id,
    employee_id: row.employee_id,
    activity_id: row.activity_id,
  };
}
