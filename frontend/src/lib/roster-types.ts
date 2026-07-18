/**
 * The wire contract for GET /api/roster, mirroring worker/src/roster.ts and
 * worker/src/status.ts. Declared here rather than shared through a workspace —
 * that split was taken deliberately (PLAN-dashboard.md, cross-model tensions).
 *
 * Money is a decimal STRING everywhere. Never parseFloat it: 120.00 + 200.00
 * through a float is 320.00000000000006, and this screen authorises charges.
 */

export type DisplayStatus =
  | "GREEN"
  | "AT_RISK"
  | "NEEDS_YOU"
  | "CALLING"
  | "BOOKING"
  | "FAILED"
  | "RESOLVED"

export type Band =
  | "NEEDS_YOU"
  | "FAILED"
  | "WORKING"
  | "AT_RISK"
  | "RESOLVED"
  | "ON_TRACK"

export type PolicyVerdict = "PASS" | "NEEDS_APPROVAL" | "FAIL"

export interface RosterCard {
  employeeId: string
  name: string
  homeBase: string | null
  status: DisplayStatus
  band: Band
  /** Pre-composed by the worker. RENDER AS-IS — never rebuild it client-side. */
  advisory: string | null
  policyVerdict: PolicyVerdict | null
  /** Decimal string. */
  totalDelta: string | null
  currency: string | null
  offerCount: number
  approvalId: string | null
  impactId: string | null
  /** True = one-click Approve is allowed straight from the card. */
  canApprove: boolean
}

export interface RosterCounts {
  travelling: number
  needs_you: number
  at_risk: number
  calling: number
  booking: number
  failed: number
  resolved: number
  on_track: number
}

export interface RosterResponse {
  event_id: string
  synced_at: string
  counts: RosterCounts
  /** Decimal string + currency. Not a number. */
  exposure: { amount: string; currency: string }
  cards: RosterCard[]
}

/** Band render order. The worker sends `band`; this file owns the sequence. */
export const BAND_ORDER: Band[] = [
  "NEEDS_YOU",
  "FAILED",
  "WORKING",
  // Structural risk: real, but nobody is acting on it. Distinct from WORKING,
  // which claims the agent is on the case. On a calm board these are the only
  // two non-green cards, so mislabelling them is the worst place to be wrong.
  "AT_RISK",
  "RESOLVED",
  "ON_TRACK",
]

export const BAND_LABEL: Record<Band, string> = {
  NEEDS_YOU: "Waiting on you",
  FAILED: "Needs attention",
  WORKING: "Agent working",
  AT_RISK: "At risk — not yet actioned",
  RESOLVED: "Resolved today",
  ON_TRACK: "On track",
}

/**
 * Every pill carries a text label — status is never colour-only.
 * Exhaustive by construction: a new DisplayStatus is a compile error here.
 */
export const STATUS_LABEL: Record<DisplayStatus, string> = {
  GREEN: "On track",
  AT_RISK: "At risk",
  NEEDS_YOU: "Needs you",
  CALLING: "Calling",
  BOOKING: "Booking",
  FAILED: "Failed",
  RESOLVED: "Resolved",
}
