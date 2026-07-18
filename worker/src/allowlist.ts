/**
 * Outbound dial allowlist. FAIL CLOSED.
 *
 * Why this exists: `worker/seed.sql` ships 26 employees with phone numbers.
 * The US ones are +1...555.... — the reserved fictional range, safe to dial.
 * The Korean ones are +821020000001..16, which is NOT a reserved range. Enable
 * PSTN outbound, run a fan-out against seed data, and the agent calls sixteen
 * real strangers in Korea.
 *
 * So dialing is deny-by-default. A number must be on an explicit allowlist or
 * the dispatch fails loudly before it reaches VocalBridge.
 *
 *   env.DIAL_ALLOWLIST = "+12125550199"        // set in .dev.vars, never here
 *
 *   assertDialable("+12125550199", env)   -> ok
 *   assertDialable("+821020000001", env)  -> throws NotAllowlisted
 *
 * The real allowlisted number lives ONLY in worker/.dev.vars (gitignored).
 * This repo is public — never inline a personal number in source or tests.
 *
 * Deliberately NOT doing:
 *   - Pattern matching on "555" to auto-allow. Fictional-range detection is a
 *     heuristic, and a heuristic that decides whether to phone a stranger is
 *     the wrong shape. Enumerate what you mean to call.
 *   - Falling open when the list is unset. An unset list means "not configured
 *     yet", which is exactly when you least want to be dialing.
 */

export class NotAllowlisted extends Error {
  readonly phone: string;
  constructor(phone: string, reason: string) {
    super(`refusing to dial ${redactPhone(phone)}: ${reason}`);
    this.name = "NotAllowlisted";
    this.phone = phone;
  }
}

/** VocalBridge enforces this too, but we reject early with a clearer message. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Log-safe rendering: keeps the country code and last two digits.
 * `+12125550199` -> `+1********99`. Enough to correlate, not enough to redial.
 */
export function redactPhone(phone: string): string {
  if (phone.length < 5) return "***";
  const cc = phone.slice(0, 2);
  const tail = phone.slice(-2);
  return `${cc}${"*".repeat(Math.max(0, phone.length - 4))}${tail}`;
}

/** Parse a comma-separated env var into a set. Blank entries are dropped. */
export function parseAllowlist(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Throws unless `phone` is explicitly allowlisted.
 *
 * Order matters: shape is checked before membership so a malformed number
 * reports "not E.164" rather than the misleading "not on the allowlist".
 */
export function assertDialable(
  phone: string | null | undefined,
  env: { DIAL_ALLOWLIST?: string },
): asserts phone is string {
  if (!phone) throw new NotAllowlisted("", "no phone number on the record");
  if (!E164.test(phone)) throw new NotAllowlisted(phone, "not a valid E.164 number");

  const allowed = parseAllowlist(env.DIAL_ALLOWLIST);
  if (allowed.size === 0) {
    throw new NotAllowlisted(
      phone,
      "DIAL_ALLOWLIST is empty — outbound dialing is disabled until it is set",
    );
  }
  if (!allowed.has(phone)) {
    throw new NotAllowlisted(phone, "number is not on DIAL_ALLOWLIST");
  }
}

/** Non-throwing form, for filtering a fan-out before enqueueing it. */
export function isDialable(
  phone: string | null | undefined,
  env: { DIAL_ALLOWLIST?: string },
): boolean {
  try {
    assertDialable(phone, env);
    return true;
  } catch {
    return false;
  }
}
