/**
 * Domain types for the Chingu Sabre adapter.
 *
 * These map onto `worker/schema.sql` (`segment`, `offer`). Money is ALWAYS a
 * decimal string plus a separate currency — never a float — per the schema
 * conventions block. Timestamps are ISO-8601 strings.
 *
 * Declarations only. No logic lives here.
 */

// ----------------------------------------------------------------- primitives

/** A decimal money string, e.g. "935.55", "0.00", "-7.20". Never a number. */
export type Decimal = string;

/** ISO-4217, e.g. "USD". */
export type Currency = string;

/** ISO-8601 UTC instant, e.g. "2026-09-14T17:50:00Z". */
export type Instant = string;

/** Local calendar date, "YYYY-MM-DD". */
export type LocalDate = string;

/** Local wall-clock time, "HH:MM" or "HH:MM:SS". Sabre returns these WITHOUT
 *  an offset, so they cannot be converted to UTC without an airport timezone
 *  table. See `Segment.depTimeLocal` / `arrTimeLocal`. */
export type LocalTime = string;

// ------------------------------------------------------------------- segments

export type SegmentType = "FLIGHT" | "HOTEL";

/**
 * Flattened booking segment. Mirrors the `segment` table.
 *
 * Codeshare note: `carrier`/`flightNo` are the MARKETING identity (what the
 * ticket says) and `operatingCarrier`/`operatingFlightNo` are the OPERATING
 * identity (the actual metal). Both are always populated for flights — a
 * cancellation matched on marketing alone silently strands codeshare
 * passengers.
 */
export interface Segment {
  type: SegmentType;
  sabreItemId: string | null;
  /** Airline or hotel locator. NOT the Sabre PNR. */
  supplierLocator: string | null;

  // flight
  carrier: string | null;
  flightNo: number | null;
  operatingCarrier: string | null;
  operatingFlightNo: number | null;
  origin: string | null;
  dest: string | null;
  depDate: LocalDate | null;
  depTimeLocal: LocalTime | null;
  arrDate: LocalDate | null;
  arrTimeLocal: LocalTime | null;

  // hotel — every field modify-booking demands
  propertyId: string | null;
  chainCode: string | null;
  propertyPhone: string | null;
  productCode: string | null;
  supplierRateCode: string | null;
  paymentPolicy: HotelPaymentPolicy | null;
  numGuests: number | null;
  leadTravelerIndex: number | null;
  checkIn: LocalDate | null;
  checkOut: LocalDate | null;
  freeCancelUntil: Instant | null;

  rawStatusCode: string | null;
  status: string | null;
}

/** `create-booking` / `modify-booking` hotel payment policy enum. Sabre's
 *  shopping responses report `guarantee.guaranteeType: "GUAR"` instead, which
 *  must be mapped — see `normalizeHotelPaymentPolicy`. */
export type HotelPaymentPolicy = "DEPOSIT" | "GUARANTEE" | "LATE";

// --------------------------------------------------------------------- offers

/** Per schema `offer.charge_type`. Sabre spells these
 *  `Add collect` | `Even` | `Refund` | `Unknown`. */
export type ChargeType = "ADD_COLLECT" | "EVEN" | "REFUND";

/** Per schema `offer.policy_verdict`. */
export type PolicyVerdict = "PASS" | "NEEDS_APPROVAL" | "FAIL";

/**
 * A normalized, small rebooking option. Mirrors the `offer` table.
 *
 * NEVER holds the raw Sabre payload — reshop and get-hotel-rates responses are
 * 170-190KB. `rawRef` is a caller-owned pointer (e.g. a snapshot row id), not
 * the payload itself.
 */
export interface Offer {
  providerOfferId: string;
  kind: SegmentType;
  /** Flight offers ~20 min (`validUntil`); hotel bookingKey ~7 min. */
  expiresAt: Instant | null;
  chargeType: ChargeType | null;
  currency: Currency | null;
  fareDelta: Decimal | null;
  taxDelta: Decimal | null;
  feeDelta: Decimal | null;
  /** The number policy is evaluated against. Signed. */
  totalDelta: Decimal | null;
  /** Speakable, for the voice agent. */
  routeSummary: string | null;
  arrivesAt: Instant | null;
  rawRef?: string | null;
}

/**
 * One flight leg, carrying BOTH identities.
 *
 * `isCodeshare` is true when marketing and operating differ — KE82 and DL7842
 * are the same A380. Any index that matches a cancellation on marketing alone
 * silently strands the codeshare passengers.
 */
export interface FlightLeg {
  carrier: string | null;
  flightNo: number | null;
  operatingCarrier: string | null;
  operatingFlightNo: number | null;
  isCodeshare: boolean;
  origin: string | null;
  dest: string | null;
  depDate: LocalDate | null;
  depTimeLocal: LocalTime | null;
  arrDate: LocalDate | null;
  arrTimeLocal: LocalTime | null;
  /** Resolved to UTC via an offset resolver. Null when the airport's offset is
   *  unknown — Sabre returns NO offset of its own. */
  depAt: Instant | null;
  arrAt: Instant | null;
}

/** A flight `Offer` plus the legs it is made of. */
export interface FlightOffer extends Offer {
  legs: FlightLeg[];
}

/** What `normalizeBooking` reduces a `get-booking` payload to. */
export interface NormalizedBooking {
  /** The Sabre PNR. Distinct from each segment's supplier locator. */
  pnr: string;
  isTicketed: boolean;
  isCancelable: boolean;
  ticketNumbers: string[];
  /** Operation-scoped. NEVER persist this — refetch before every modify. */
  bookingSignature: string | null;
  segments: Segment[];
}

/** An `Offer` after policy evaluation and ranking. */
export interface RankedOffer extends Offer {
  /** 1..3 — what the voice agent reads out. */
  rank: number;
  policyVerdict: PolicyVerdict;
  policyReason: string;
}

// --------------------------------------------------------------------- policy

/** The machine-enforced slice of the `policy` table. `rules_json` is agent
 *  context and is deliberately not modelled here. */
export interface Policy {
  id?: string;
  version?: number;
  currency: Currency;
  /** Hard ceiling. Above this the offer FAILs. */
  max_add_collect: Decimal | null;
  /** Gate threshold. Above this the offer NEEDS_APPROVAL. */
  requires_approval_over: Decimal | null;
}

/** The travel window from the `event` table. */
export interface EventWindow {
  /** Traveller must be on the ground by this instant. */
  arrival_by: Instant | null;
  depart_after?: Instant | null;
}

// --------------------------------------------------------------------- client

/** The subset of `fetch` this library needs. Injected — the library never
 *  reaches for a global. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface SabreConfig {
  /** e.g. "https://api.cert.platform.sabre.com" */
  baseUrl: string;
  /** Bearer token. 7-day lifetime, no refresh token, environment-bound. */
  token: string;
  /** Pseudo city code, e.g. "S5OM". */
  pcc?: string;
  fetch: FetchLike;
  /** Injected clock. Never `Date.now()` inside logic. */
  now?: () => Date;
  timeoutMs?: number;
}
