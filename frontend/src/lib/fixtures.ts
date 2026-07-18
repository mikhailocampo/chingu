/**
 * Standalone fixtures, so the dashboard is demonstrable without the worker
 * running. Real seed people (worker/seed.sql), real priced offers
 * (HACKATHON_CONTEXT.md:59-61), advisories composed the way
 * worker/src/roster.ts composeAdvisory() composes them.
 *
 * Enable with VITE_USE_FIXTURES=1, or ?fixtures=calm / ?fixtures=disrupted.
 * The fixture layer never guesses counts or exposure — both are derived from
 * the cards by the same rules the worker uses, so a hand-edited fixture cannot
 * silently disagree with its own header.
 */
import type { Band, RosterCard, RosterCounts, RosterResponse } from "./roster-types"

type Seed = Pick<RosterCard, "employeeId" | "name" | "homeBase">

// The 16 Korea-based staff are already in-country: no flights, always GREEN.
const KR: Seed[] = [
  ["emp-kr-01", "Minjun Park", "Seoul"],
  ["emp-kr-02", "Seoyeon Kim", "Seoul"],
  ["emp-kr-03", "Jihoon Lee", "Suwon"],
  ["emp-kr-04", "Hyewon Jang", "Seoul"],
  ["emp-kr-05", "Doyun Choi", "Busan"],
  ["emp-kr-06", "Chaewon Yoon", "Seoul"],
  ["emp-kr-07", "Siwoo Kang", "Daegu"],
  ["emp-kr-08", "Yuna Lim", "Seoul"],
  ["emp-kr-09", "Jiwoo Han", "Incheon"],
  ["emp-kr-10", "Eunseo Shin", "Seoul"],
  ["emp-kr-11", "Taeyang Oh", "Ulsan"],
  ["emp-kr-12", "Sohee Bae", "Seoul"],
  ["emp-kr-13", "Junseo Nam", "Busan"],
  ["emp-kr-14", "Arin Seo", "Seoul"],
  ["emp-kr-15", "Hyunwoo Moon", "Seoul"],
  ["emp-kr-16", "Nayeon Gwak", "Gwangju"],
].map(toSeed)

const US_QUIET: Seed[] = [
  ["emp-us-05", "Tom Okafor", "Boston"],
  ["emp-us-06", "Alex Rivera", "San Francisco"],
  ["emp-us-08", "Devon Clarke", "Oakland"],
  ["emp-us-09", "Sofia Marchetti", "San Jose"],
].map(toSeed)

function toSeed(t: (string | null)[]): Seed {
  return { employeeId: t[0]!, name: t[1]!, homeBase: t[2] }
}

function green(s: Seed): RosterCard {
  return {
    ...s,
    status: "GREEN",
    band: "ON_TRACK",
    advisory: null,
    policyVerdict: null,
    totalDelta: null,
    currency: null,
    offerCount: 0,
    approvalId: null,
    impactId: null,
    canApprove: false,
  }
}

/** Grace lands past event.arrival_by. Structural — no disruption in play. */
const GRACE_CALM: RosterCard = {
  employeeId: "emp-us-07",
  name: "Grace Lombardi",
  homeBase: "San Francisco",
  status: "AT_RISK",
  band: "WORKING",
  advisory: "Their flight lands after the arrival cut-off for this offsite.",
  policyVerdict: null,
  totalDelta: null,
  currency: null,
  offerCount: 0,
  approvalId: null,
  impactId: null,
  canApprove: false,
}

/** Nora has no itinerary at all. Also structural. */
const NORA: RosterCard = {
  employeeId: "emp-us-10",
  name: "Nora Feldman",
  homeBase: "Seattle",
  status: "AT_RISK",
  band: "WORKING",
  advisory:
    "No booking at all. The agent needs a date of birth and passport before it can ticket them.",
  policyVerdict: null,
  totalDelta: null,
  currency: null,
  offerCount: 0,
  approvalId: null,
  impactId: null,
  canApprove: false,
}

/** Seed state: 24 on track, 2 structurally at risk. Never an empty screen. */
export function calmRoster(): RosterResponse {
  const cards = [
    ...KR.map(green),
    green(toSeed(["emp-us-01", "Daniel Whitfield", "New York"])),
    green(toSeed(["emp-us-02", "Priya Natarajan", "New York"])),
    green(toSeed(["emp-us-03", "Marcus Bell", "New York"])),
    green(toSeed(["emp-us-04", "Elena Duarte", "Newark"])),
    ...US_QUIET.map(green),
    GRACE_CALM,
    NORA,
  ].sort(byName)
  return envelope(cards)
}

/**
 * After POST /api/dev/disrupt. Four impacted travellers — including Elena on
 * marketing DL7842, who a naive `WHERE carrier = 'KE'` never finds. That
 * fourth person is the whole point of the product.
 */
export function disruptedRoster(): RosterResponse {
  const elena: RosterCard = {
    employeeId: "emp-us-04",
    name: "Elena Duarte",
    homeBase: "Newark",
    status: "NEEDS_YOU",
    band: "NEEDS_YOU",
    advisory:
      "Was on DL7842 — the same aircraft as cancelled KE82. Best option CX841 JFK–HKG then CX416 HKG–ICN, arrives 08:40, add-collect $200.00. Over the $150.00 approval threshold.",
    policyVerdict: "NEEDS_APPROVAL",
    totalDelta: "200.00",
    currency: "USD",
    offerCount: 3,
    approvalId: "apr_elena_01",
    impactId: "imp_elena_01",
    canApprove: true,
  }

  // FAIL verdict: no option is both in policy and on time. That is a judgement
  // call, so there is no one-click path — the action opens the drawer.
  const grace: RosterCard = {
    employeeId: "emp-us-07",
    name: "Grace Lombardi",
    homeBase: "San Francisco",
    status: "NEEDS_YOU",
    band: "NEEDS_YOU",
    advisory:
      "UA805 lands 19:20, four hours after the arrival cut-off. Cheapest fix is $299.00 and non-refundable. No option is both in policy and on time.",
    policyVerdict: "FAIL",
    totalDelta: "299.00",
    currency: "USD",
    offerCount: 2,
    approvalId: "apr_grace_01",
    impactId: "imp_grace_01",
    canApprove: false,
  }

  const daniel: RosterCard = {
    employeeId: "emp-us-01",
    name: "Daniel Whitfield",
    homeBase: "New York",
    status: "FAILED",
    band: "FAILED",
    advisory:
      "KE82 was cancelled. Best option OZ223 JFK 01:30 → ICN 06:05+1, add-collect $120.00. Within policy — the agent may book it alone.",
    policyVerdict: "PASS",
    totalDelta: "120.00",
    currency: "USD",
    offerCount: 3,
    approvalId: null,
    impactId: "imp_daniel_01",
    canApprove: false,
  }

  const priya: RosterCard = {
    employeeId: "emp-us-02",
    name: "Priya Natarajan",
    homeBase: "New York",
    status: "CALLING",
    band: "WORKING",
    advisory:
      "KE82 was cancelled. Best option OZ223 JFK 01:30 → ICN 06:05+1, add-collect $120.00. Within policy — the agent may book it alone.",
    policyVerdict: "PASS",
    totalDelta: "120.00",
    currency: "USD",
    offerCount: 3,
    approvalId: null,
    impactId: "imp_priya_01",
    canApprove: false,
  }

  // NOTE: the roster query excludes RESOLVED impacts, so a resolved card
  // arrives from the worker with advisory === null. Faithful here on purpose —
  // the card must survive it. See the report.
  const marcus: RosterCard = {
    employeeId: "emp-us-03",
    name: "Marcus Bell",
    homeBase: "New York",
    status: "RESOLVED",
    band: "RESOLVED",
    advisory: null,
    policyVerdict: null,
    totalDelta: null,
    currency: null,
    offerCount: 0,
    approvalId: null,
    impactId: null,
    canApprove: false,
  }

  const cards = [
    ...KR.map(green),
    ...US_QUIET.map(green),
    elena,
    grace,
    daniel,
    priya,
    marcus,
    NORA,
  ].sort(byName)
  return envelope(cards)
}

function byName(a: RosterCard, b: RosterCard) {
  return a.name.localeCompare(b.name)
}

function envelope(cards: RosterCard[]): RosterResponse {
  return {
    event_id: "evt-busan",
    synced_at: new Date().toISOString(),
    counts: countBands(cards),
    exposure: totalExposure(cards),
    cards,
  }
}

function countBands(cards: RosterCard[]): RosterCounts {
  const n = (s: RosterCard["status"]) => cards.filter((c) => c.status === s).length
  return {
    travelling: cards.length,
    needs_you: n("NEEDS_YOU"),
    at_risk: n("AT_RISK"),
    calling: n("CALLING"),
    booking: n("BOOKING"),
    failed: n("FAILED"),
    resolved: n("RESOLVED"),
    on_track: n("GREEN"),
  }
}

/** Cents arithmetic on strings, mirroring worker/src/roster.ts. No floats. */
function totalExposure(cards: RosterCard[]): { amount: string; currency: string } {
  const cents = cards.reduce((sum, c) => {
    if (!c.totalDelta) return sum
    const [whole, frac = "0"] = c.totalDelta.split(".")
    return sum + Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2))
  }, 0)
  return {
    amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    currency: "USD",
  }
}

export type FixtureScenario = "calm" | "disrupted"

export function fixtureFor(scenario: FixtureScenario): RosterResponse {
  return scenario === "disrupted" ? disruptedRoster() : calmRoster()
}

/** Bands present in a fixture, for a quick sanity check in dev. */
export function bandsOf(r: RosterResponse): Band[] {
  return [...new Set(r.cards.map((c) => c.band))]
}
