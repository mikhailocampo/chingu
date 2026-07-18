import type { Env } from "./types";

/**
 * Per-slot bearer token, from env. Mandatory on every endpoint: slot paths are
 * guessable and confirm_choice ultimately reissues tickets.
 *
 * VB delivers `Authorization: Bearer <token>` intact — verified 14/14 live with
 * 0 missing and 0 cross-slot mismatches — so this is a real control, not
 * theatre.
 */

/** 'slot-a' -> 'SLOT_TOKEN_SLOT_A' */
export function envKeyForSlot(slot: string): string {
  return `SLOT_TOKEN_${slot.toUpperCase().replace(/-/g, "_")}`;
}

export function expectedToken(env: Env, slot: string): string | null {
  const v = env[envKeyForSlot(slot)];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Constant-time comparison. Compares over a fixed number of iterations so
 * neither length nor the position of the first differing byte is observable.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length, 1);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * True only when the request carries the bearer token configured for this exact
 * slot. A slot with no configured secret can never be opened — an absent env
 * var must not degrade into "any token works".
 */
export function isAuthorised(request: Request, env: Env, slot: string): boolean {
  const expected = expectedToken(env, slot);
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    // Still burn a comparison so an unauthenticated probe cannot distinguish
    // "malformed header" from "wrong token" by timing.
    timingSafeEqual(expected, "");
    return false;
  }
  return timingSafeEqual(expected, match[1]);
}
