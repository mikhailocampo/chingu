/**
 * Ids and idempotency keys.
 *
 * Idempotency keys are DERIVED, never random: the whole point is that a repeat
 * of the same logical request produces the same key and collides on
 * `action.idempotency_key`'s UNIQUE index. We already hit real double-execution
 * risk on ticketing — `fulfill-flight-tickets` returned an error while the
 * ticket had in fact issued.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Monotonic-ish, sortable, ULID-shaped. Only ever used for surrogate row ids. */
export function newId(prefix: string, now = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  let tail = "";
  for (const b of rnd) tail += ALPHABET[b % 32];
  return `${prefix}-${ts}${tail}`;
}

/** Deterministic key for a rebooking choice: same slot+dispatch+choice, same key. */
export const reissueKey = (dispatchId: string, impactId: string, choice: number) =>
  `reissue:${dispatchId}:${impactId}:${choice}`;

/** Deterministic key for a venue change. */
export const venueChangeKey = (dispatchId: string, activityId: string, newTime: string) =>
  `venue:${dispatchId}:${activityId}:${newTime}`;

/** Deterministic key for one attendee notification of one venue change. */
export const notifyKey = (activityId: string, employeeId: string, newTime: string) =>
  `notify:${activityId}:${employeeId}:${newTime}`;

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when a D1 write failed on a UNIQUE index rather than for another reason. */
export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(err));
}
