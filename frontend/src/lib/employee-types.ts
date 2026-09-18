/**
 * The wire contract for GET /api/employee/:id — the route PLAN-dashboard.md:124
 * specified and nothing ever built.
 *
 * Deliberately a separate file from roster-types.ts. The roster payload drops
 * segments[] on purpose (PLAN-dashboard.md:576 — carrying them fans 26 rows
 * into 34), and this is the endpoint that was always meant to fetch them.
 * Two files makes it awkward to widen the roster row by accident while
 * editing the detail row, which is the failure mode worth designing against.
 *
 * Money is a decimal STRING here for the same reason it is on the roster:
 * 120.00 + 200.00 through a float is 320.00000000000006, and this screen sits
 * next to a control that authorises charges.
 *
 * Times are ISO-8601 UTC strings, never Date. The wire holds no timezone
 * opinion; the renderer applies the event's.
 */
import type { PolicyVerdict, RosterCard } from "./roster-types"

export interface FlightSegment {
  id: string
  type: "FLIGHT"
  carrier: string
  flightNo: number
  /**
   * The metal. KE82 and DL7842 are the same aircraft, and a traveller ticketed
   * on the codeshare is reachable only through this field — that fourth person
   * is the whole point of the product (HACKATHON_CONTEXT.md:53), so the detail
   * view has to make the distinction legible rather than bury it.
   */
  operatingCarrier: string | null
  operatingFlightNo: number | null
  /** IATA. Resolved to coordinates client-side; unknown codes render no map. */
  origin: string
  dest: string
  depAt: string
  arrAt: string
  status: string | null
}

export interface HotelSegment {
  id: string
  type: "HOTEL"
  /**
   * NOT a column on `segment` today — the table stores property_id and
   * chain_code only. The Sabre normalizer has the name
   * (backend/sabre/src/normalize.ts:461) but it is never persisted, so the
   * worker will need either a new column or a lookup. Nullable until then.
   */
  propertyName: string | null
  propertyPhone: string | null
  /** Date-only, as stored. No time component exists to render. */
  checkIn: string
  checkOut: string
  freeCancelUntil: string | null
  status: string | null
}

export type ItinerarySegment = FlightSegment | HotelSegment

export interface ItineraryRecord {
  id: string
  component: "FLIGHT" | "HOTEL"
  /** Sabre locator. The thing a human reads down the phone. */
  pnr: string
  ticketNumber: string | null
  status: string | null
  segments: ItinerarySegment[]
}

/** No Sabre equivalent — the dinner everyone is flying in for. */
export interface ActivityItem {
  id: string
  kind: string
  venue: string
  address: string | null
  phone: string | null
  startsAt: string
  timezone: string
}

/**
 * One priced option. `rank` is a PRIORITY, not a dense sequence
 * (schema.sql:209) — ranks 1/3/5 are read out as 1, 2, 3. Order by it; never
 * index into it.
 */
export interface OfferOption {
  id: string
  rank: number
  routeSummary: string | null
  arrivesAt: string | null
  chargeType: "ADD_COLLECT" | "EVEN" | "REFUND" | null
  currency: string | null
  totalDelta: string | null
  policyVerdict: PolicyVerdict | null
  policyReason: string | null
  expiresAt: string | null
}

export interface EmployeeDetail {
  /** The same row the roster renders, so the two screens cannot disagree. */
  card: RosterCard
  itineraries: ItineraryRecord[]
  activities: ActivityItem[]
  offers: OfferOption[]
}

/** Every flight leg across every itinerary, in departure order. */
export function flightLegs(detail: EmployeeDetail): FlightSegment[] {
  return detail.itineraries
    .flatMap((i) => i.segments)
    .filter((s): s is FlightSegment => s.type === "FLIGHT")
    .sort((a, b) => a.depAt.localeCompare(b.depAt))
}

/** Every hotel stay across every itinerary, in check-in order. */
export function hotelStays(detail: EmployeeDetail): HotelSegment[] {
  return detail.itineraries
    .flatMap((i) => i.segments)
    .filter((s): s is HotelSegment => s.type === "HOTEL")
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
}

/** True when the marketing carrier is not the operating one. */
export function isCodeshare(s: FlightSegment): boolean {
  if (!s.operatingCarrier || s.operatingFlightNo === null) return false
  return s.operatingCarrier !== s.carrier || s.operatingFlightNo !== s.flightNo
}
