/**
 * Raw Sabre JSON -> our Segment / Offer shapes.
 *
 * Sabre responses are enormous: reshop and get-hotel-rates run 170-190KB. This
 * module's job is to throw almost all of it away and keep the handful of fields
 * the schema actually indexes on. Nothing here ever returns a raw payload.
 *
 * Two structural facts drive most of the code:
 *
 *  1. `search-flights` is a GRAPH, not a list. `offers[]` point at
 *     `journeys[]` by ref, which point at `flights[]` by ref, and change fees
 *     live in a fourth array (`offerAttributes.changeItems[]`) keyed by the
 *     fare's `changeRef`. All four have to be joined to produce one option.
 *
 *  2. Sabre returns LOCAL times with NO UTC offset, anywhere. See `toInstant`.
 */

import { offsetFor } from "./airports.ts";
import type {
  ChargeType,
  Decimal,
  FlightLeg,
  FlightOffer,
  HotelPaymentPolicy,
  Instant,
  LocalDate,
  LocalTime,
  NormalizedBooking,
  Offer,
  Segment,
} from "./types.ts";

// ============================================================= money helpers

/** Parse a decimal string to integer cents. Mirrors `rank.toCents` but accepts
 *  JSON numbers too, because hotel payloads use floats where flight payloads
 *  use strings. */
function cents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, whole, frac] = m;
  const n = Number(whole) * 100 + Number((frac ?? "").padEnd(2, "0"));
  return sign === "-" ? -n : n;
}

/**
 * Format integer cents back to a 2dp decimal string.
 *
 * Sabre is inconsistent — the same response carries change fees as both `"0"`
 * and `"200.00"`. Everything we emit is `"0.00"` shaped so downstream string
 * comparisons and SQL never see two spellings of the same number.
 */
function money(c: number | null): Decimal | null {
  if (c === null) return null;
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Normalize a raw Sabre amount straight to our canonical decimal string. */
function amount(value: string | number | null | undefined): Decimal | null {
  return money(cents(value));
}

/** Derive the schema charge type from a signed total. A 0 is EVEN — real, and
 *  distinct from "we don't know", which is null. */
function chargeTypeFromCents(c: number | null): ChargeType | null {
  if (c === null) return null;
  if (c > 0) return "ADD_COLLECT";
  if (c < 0) return "REFUND";
  return "EVEN";
}

// ============================================================ time resolution

/**
 * Airport -> UTC offset, resolved per date.
 *
 * Sabre returns local wall-clock times with no offset and no timezone id, so a
 * rebooking's arrival cannot be compared to an event's `arrival_by` without
 * one. Backed by `./airports.ts`, which maps IATA -> IANA zone and asks `Intl`
 * for the offset on the actual date — so it stays correct across DST rather
 * than only during the September window this demo happens to use.
 *
 * Unknown airport -> null -> the offer is unevaluable and sorts last. Never
 * guessed: a wrong offset would sort it FIRST and be silently hours early.
 */
export type OffsetResolver = (airportCode: string, localDate: LocalDate) => string | null;

const defaultResolver: OffsetResolver = (code, date) => offsetFor(code, date);

/**
 * Turn a Sabre local date + local time + airport into a real UTC instant.
 *
 * Returns null rather than guessing when the offset is unknown. A null arrival
 * makes an offer sort last and read as unevaluable; a guessed one would make it
 * sort *first* and be silently 13 hours wrong. Fail loud, not cheap.
 */
export function toInstant(
  date: LocalDate | null | undefined,
  time: LocalTime | null | undefined,
  airportCode: string | null | undefined,
  resolve: OffsetResolver = defaultResolver,
): Instant | null {
  if (!date || !time || !airportCode) return null;
  const offset = resolve(airportCode, date);
  if (!offset) return null;

  const hhmmss = time.length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${date}T${hhmmss}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ================================================================ flight legs

function leg(
  raw: Record<string, unknown>,
  marketingCarrierKey: string,
  marketingNumberKey: string,
  resolve: OffsetResolver,
): FlightLeg {
  const carrier = (raw[marketingCarrierKey] as string) ?? null;
  const flightNo = (raw[marketingNumberKey] as number) ?? null;
  // Sabre omits operating identity when it equals marketing. Default it rather
  // than leaving null, so the operating index is never sparse.
  const operatingCarrier = (raw.operatingAirlineCode as string) ?? carrier;
  const operatingFlightNo = (raw.operatingFlightNumber as number) ?? flightNo;

  const origin = (raw.departureAirportCode ?? raw.fromAirportCode ?? null) as string | null;
  const dest = (raw.arrivalAirportCode ?? raw.toAirportCode ?? null) as string | null;
  const depDate = (raw.departureDate ?? null) as LocalDate | null;
  const depTimeLocal = (raw.departureTime ?? null) as LocalTime | null;
  const arrDate = (raw.arrivalDate ?? null) as LocalDate | null;
  const arrTimeLocal = (raw.arrivalTime ?? null) as LocalTime | null;

  return {
    carrier,
    flightNo,
    operatingCarrier,
    operatingFlightNo,
    isCodeshare: carrier !== operatingCarrier || flightNo !== operatingFlightNo,
    origin,
    dest,
    depDate,
    depTimeLocal,
    arrDate,
    arrTimeLocal,
    depAt: toInstant(depDate, depTimeLocal, origin, resolve),
    arrAt: toInstant(arrDate, arrTimeLocal, dest, resolve),
  };
}

/** Speakable one-liner for the voice agent. Names the operating carrier on a
 *  codeshare, because that is what is painted on the aircraft the traveller is
 *  standing in front of. */
function routeSummary(legs: FlightLeg[]): string | null {
  if (legs.length === 0) return null;
  return legs
    .map((l) => {
      const marketing = `${l.carrier ?? "??"}${l.flightNo ?? ""}`;
      const operated = l.isCodeshare
        ? ` (operated by ${l.operatingCarrier ?? "??"}${l.operatingFlightNo ?? ""})`
        : "";
      const dayShift = l.depDate && l.arrDate && l.depDate !== l.arrDate ? " (+1)" : "";
      return `${marketing}${operated} ${l.origin ?? "???"} ${l.depTimeLocal ?? ""} to ${l.dest ?? "???"} ${l.arrTimeLocal ?? ""}${dayShift}`.replace(
        /\s+/g,
        " ",
      );
    })
    .join(" / ");
}

// ============================================================= flight search

export interface SearchFlightOptions {
  /** The fare the traveller already holds. When supplied, `fareDelta` becomes
   *  the true difference rather than the full new ticket price — this is what
   *  makes search-time rebooking economics work with no ticket and no PNR. */
  baselineTotal?: Decimal | null;
  resolveOffset?: OffsetResolver;
}

interface ChangeCharge {
  maxCharge: Decimal | null;
  currency: string | null;
}

function indexChangeItems(raw: any): Map<string, ChangeCharge> {
  const out = new Map<string, ChangeCharge>();
  for (const item of raw?.offerAttributes?.changeItems ?? []) {
    const before = item?.beforeDeparture;
    if (!item?.id || !before?.isPermitted) continue;
    out.set(item.id, {
      maxCharge: amount(before.maxCharge),
      currency: before.currencyCode ?? null,
    });
  }
  return out;
}

/**
 * `search-flights` response -> small, ranked-ready offers.
 *
 * Change fees are read from `offerAttributes.changeItems[]` at SEARCH time.
 * Verified in SABRE_LEARNINGS: the search `maxCharge` is exactly equal to the
 * reshop `totalFee`, so quoting a rebooking needs no ticket, no PNR and no
 * card.
 */
export function normalizeSearchFlightOffers(raw: any, opts: SearchFlightOptions = {}): FlightOffer[] {
  const resolve = opts.resolveOffset ?? defaultResolver;

  const flightsById = new Map<string, any>((raw?.flights ?? []).map((f: any) => [f.id, f]));
  const journeysById = new Map<string, any>((raw?.journeys ?? []).map((j: any) => [j.id, j]));
  const changeById = indexChangeItems(raw);
  const baseline = cents(opts.baselineTotal);

  return (raw?.offers ?? []).map((offer: any): FlightOffer => {
    // offers -> journeys -> flights. Three hops, order preserved.
    const legs: FlightLeg[] = (offer.journeyRefs ?? [])
      .flatMap((jr: string) => journeysById.get(jr)?.flightRefs ?? [])
      .map((fr: string) => flightsById.get(fr))
      .filter(Boolean)
      .map((f: any) => leg(f, "marketingAirlineCode", "marketingFlightNumber", resolve));

    const fare = offer.items?.[0]?.fares?.[0];
    const change = fare?.changeRef ? changeById.get(fare.changeRef) : undefined;

    const totalCents = cents(offer.totalPrice?.amount);
    const fareDeltaCents =
      totalCents === null ? null : baseline === null ? totalCents : totalCents - baseline;
    const feeCents = cents(change?.maxCharge);
    const totalDeltaCents =
      fareDeltaCents === null ? null : fareDeltaCents + (feeCents ?? 0);

    return {
      providerOfferId: offer.id,
      kind: "FLIGHT",
      expiresAt: offer.validUntil ?? null,
      chargeType: chargeTypeFromCents(totalDeltaCents),
      currency: offer.totalPrice?.currencyCode ?? change?.currency ?? null,
      fareDelta: money(fareDeltaCents),
      taxDelta: null, // search gives a lump tax on the new fare, not a delta
      feeDelta: money(feeCents),
      totalDelta: money(totalDeltaCents),
      routeSummary: routeSummary(legs),
      arrivesAt: legs.at(-1)?.arrAt ?? null,
      legs,
    };
  });
}

// ==================================================================== reshop

const RESHOP_CHARGE_TYPES: Record<string, ChargeType> = {
  "Add collect": "ADD_COLLECT",
  Even: "EVEN",
  Refund: "REFUND",
};

/**
 * `reshop-flight` response -> small offers.
 *
 * Verified: `grandTotal = baseFare + totalTax + totalFee`, amounts are signed,
 * and `Unknown` is a real fourth enum value which we map to null rather than
 * guessing.
 */
export function normalizeReshopOffers(
  raw: any,
  opts: { resolveOffset?: OffsetResolver } = {},
): FlightOffer[] {
  const resolve = opts.resolveOffset ?? defaultResolver;

  return (raw?.reshopOffers ?? []).map((o: any): FlightOffer => {
    const d = o.totalPriceDifference ?? {};
    const legs: FlightLeg[] = (o.flights ?? []).map((f: any) =>
      leg(f, "airlineCode", "flightNumber", resolve),
    );
    const total = amount(d.grandTotal?.amount);

    return {
      providerOfferId: o.id,
      kind: "FLIGHT",
      expiresAt: o.validUntil ?? null,
      // Trust Sabre's own label; fall back to the sign of the total.
      chargeType: RESHOP_CHARGE_TYPES[d.chargeType] ?? null,
      currency: d.grandTotal?.currencyCode ?? null,
      fareDelta: amount(d.baseFare?.amount),
      taxDelta: amount(d.totalTax?.amount),
      feeDelta: amount(d.totalFee?.amount),
      totalDelta: total,
      routeSummary: routeSummary(legs),
      arrivesAt: legs.at(-1)?.arrAt ?? null,
      legs,
    };
  });
}

// =================================================================== booking

function emptySegment(type: Segment["type"]): Segment {
  return {
    type,
    sabreItemId: null,
    supplierLocator: null,
    carrier: null,
    flightNo: null,
    operatingCarrier: null,
    operatingFlightNo: null,
    origin: null,
    dest: null,
    depDate: null,
    depTimeLocal: null,
    arrDate: null,
    arrTimeLocal: null,
    propertyId: null,
    chainCode: null,
    propertyPhone: null,
    productCode: null,
    supplierRateCode: null,
    paymentPolicy: null,
    numGuests: null,
    leadTravelerIndex: null,
    checkIn: null,
    checkOut: null,
    freeCancelUntil: null,
    rawStatusCode: null,
    status: null,
  };
}

/**
 * `get-booking` response -> the index rows we keep.
 *
 * NOTE the field-name trap: `get-booking` uses `airlineCode`/`flightNumber`
 * for the MARKETING identity, whereas `search-flights` uses
 * `marketingAirlineCode`/`marketingFlightNumber` for the same thing. Reading
 * the search names here yields a segment with a null carrier and an index that
 * matches nothing.
 */
export function normalizeBooking(raw: any): NormalizedBooking {
  const segments: Segment[] = [];

  for (const f of raw?.flights ?? []) {
    const s = emptySegment("FLIGHT");
    s.sabreItemId = f.itemId ?? null;
    s.supplierLocator = f.confirmationId ?? null; // airline locator, NOT the PNR
    s.carrier = f.airlineCode ?? null;
    s.flightNo = f.flightNumber ?? null;
    s.operatingCarrier = f.operatingAirlineCode ?? f.airlineCode ?? null;
    s.operatingFlightNo = f.operatingFlightNumber ?? f.flightNumber ?? null;
    s.origin = f.fromAirportCode ?? null;
    s.dest = f.toAirportCode ?? null;
    s.depDate = f.departureDate ?? null;
    s.depTimeLocal = f.departureTime ?? null;
    s.arrDate = f.arrivalDate ?? null;
    s.arrTimeLocal = f.arrivalTime ?? null;
    s.rawStatusCode = f.flightStatusCode ?? null;
    s.status = f.flightStatusName ?? null;
    segments.push(s);
  }

  for (const h of raw?.hotels ?? []) {
    const s = emptySegment("HOTEL");
    s.sabreItemId = h.itemId ?? null;
    s.supplierLocator = h.confirmationId ?? null; // the property's own locator
    s.propertyId = h.propertyId ?? h.sabrePropertyId ?? null;
    s.chainCode = h.chainCode ?? null;
    s.propertyPhone = h.contact?.phone ?? h.phone ?? null;
    s.productCode = h.productCode ?? null;
    s.supplierRateCode = h.supplierRateCode ?? null;
    s.paymentPolicy = normalizeHotelPaymentPolicy(h.paymentPolicy);
    s.numGuests = h.numberOfGuests ?? null;
    s.leadTravelerIndex = h.leadTravelerIndex ?? null;
    s.checkIn = h.checkInDate ?? h.startDate ?? null;
    s.checkOut = h.checkOutDate ?? h.endDate ?? null;
    s.freeCancelUntil = firstFreeCancelDeadline(h.refundPenalties);
    s.rawStatusCode = h.hotelStatusCode ?? null;
    s.status = h.hotelStatusName ?? null;
    segments.push(s);
  }

  return {
    pnr: raw?.bookingId ?? "",
    isTicketed: raw?.isTicketed === true,
    isCancelable: raw?.isCancelable === true,
    ticketNumbers: (raw?.flightTickets ?? []).map((t: any) => t.number).filter(Boolean),
    bookingSignature: raw?.bookingSignature ?? null,
    segments,
  };
}

/**
 * Does this segment refer to the flight a disruption notice is about?
 *
 * Checks BOTH identities. This is the single most load-bearing rule in the
 * codebase: KE82 and DL7842 are one A380, and a traveller ticketed on the
 * DL codeshare is in the AFFECTED set when KE82 cancels. Matching on the
 * marketing carrier alone strands them silently while the dashboard reports
 * all-clear — the failure is invisible, which is what makes it dangerous.
 *
 * Mirrors the two indexes the schema defines: `idx_seg_marketing` and
 * `idx_seg_operating`.
 */
export function segmentMatchesFlight(
  segment: Pick<
    Segment,
    "type" | "carrier" | "flightNo" | "operatingCarrier" | "operatingFlightNo" | "depDate"
  >,
  notice: { carrier: string; flightNo: number; depDate: string },
): boolean {
  if (segment.type !== "FLIGHT") return false;
  if (segment.depDate !== notice.depDate) return false;

  const marketingHit =
    segment.carrier === notice.carrier && segment.flightNo === notice.flightNo;
  const operatingHit =
    segment.operatingCarrier === notice.carrier && segment.operatingFlightNo === notice.flightNo;

  return marketingHit || operatingHit;
}

function firstFreeCancelDeadline(penalties: any): Instant | null {
  for (const p of penalties ?? []) {
    const deadline = p?.deadline?.absoluteDeadline ?? p?.absoluteDeadline;
    if (deadline) {
      const d = new Date(deadline);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

// ===================================================================== hotel

/**
 * `GUAR` -> `GUARANTEE`.
 *
 * The create-booking skill asset claims `paymentPolicy` is copied from the
 * check-hotel-price response. There is no such field. What comes back is
 * `guarantee.guaranteeType: "GUAR"`, and the request enum wants
 * DEPOSIT | GUARANTEE | LATE, so the mapping is ours to do.
 */
export function normalizeHotelPaymentPolicy(value: unknown): HotelPaymentPolicy | null {
  switch (value) {
    case "GUAR":
    case "GUARANTEE":
      return "GUARANTEE";
    case "DEPOSIT":
      return "DEPOSIT";
    case "LATE":
      return "LATE";
    default:
      return null;
  }
}

export interface HotelRateOption {
  propertyId: string | null;
  propertyName: string | null;
  propertyPhone: string | null;
  chainCode: string | null;
  /** Feeds check-hotel-price directly — get-hotel-rates is skippable. */
  rateKey: string | null;
  ratePlanName: string | null;
  productCode: string | null;
  supplierRateCode: string | null;
  paymentPolicy: HotelPaymentPolicy | null;
  checkIn: LocalDate | null;
  checkOut: LocalDate | null;
  totalPrice: Decimal | null;
  currency: string | null;
  isRefundable: boolean | null;
  /**
   * ONLY search carries this. check-hotel-price returns `deadline: {}`, so if
   * you drop it here it is gone for good and the "is this move free?" question
   * becomes unanswerable.
   */
  freeCancelUntil: Instant | null;
}

/** `search-hotels` response -> one small option per rate plan. */
export function normalizeHotelSearch(raw: any): HotelRateOption[] {
  const out: HotelRateOption[] = [];

  for (const entry of raw?.hotels ?? []) {
    const h = entry?.hotel ?? {};
    for (const room of entry?.rooms ?? []) {
      for (const plan of room?.ratePlans ?? []) {
        const rd = plan?.rateDetails ?? {};
        out.push({
          propertyId: h.hotelCode ?? null,
          propertyName: h.hotelName ?? null,
          propertyPhone: h.contact?.phone ?? null,
          chainCode: h.chainCode ?? null,
          rateKey: plan.rateKey ?? null,
          ratePlanName: plan.ratePlanName ?? null,
          productCode: plan.productCode ?? null,
          supplierRateCode: plan.ratePlanCode ?? null,
          paymentPolicy: normalizeHotelPaymentPolicy(rd.guarantee?.guaranteeType),
          checkIn: rd.startDate ?? null,
          checkOut: rd.endDate ?? null,
          totalPrice: amount(rd.approxTotalPrice),
          currency: rd.currencyCode ?? null,
          isRefundable: rd.cancelPenalties?.[0]?.refundable ?? null,
          freeCancelUntil: firstFreeCancelDeadline(rd.cancelPenalties),
        });
      }
    }
  }

  return out;
}

/**
 * How long a hotel `bookingKey` lives.
 *
 * Sabre sends NO expiry field for it — this is derived from an observed
 * failure: a key minted at 17:01:18Z was already dead at 17:08:47Z with
 * UNABLE_TO_BOOK_HOTEL_EXPIRED_BOOKING_KEY. Treat it as a floor, not a promise.
 */
export const HOTEL_BOOKING_KEY_TTL_MS = 7 * 60 * 1000;

/**
 * `check-hotel-price` response -> an Offer carrying the bookingKey.
 *
 * This response contains NO property identity — no hotelCode, no name, no
 * phone. The caller must merge it with the search result it came from.
 */
export function normalizeHotelPriceCheck(raw: any): Offer {
  const info = raw?.hotelPriceCheckRs?.priceCheckInfo ?? {};
  const rate = info.hotelRateInfo?.rateInfos?.rateInfo?.[0] ?? {};

  const issued = Date.parse(raw?.timestamp ?? "");
  const expiresAt = Number.isNaN(issued)
    ? null
    : new Date(issued + HOTEL_BOOKING_KEY_TTL_MS).toISOString();

  const deltaCents = cents(info.priceDifference ?? 0);

  return {
    providerOfferId: info.bookingKey ?? "",
    kind: "HOTEL",
    expiresAt,
    chargeType: chargeTypeFromCents(deltaCents),
    currency: info.currencyCode ?? rate.currencyCode ?? null,
    fareDelta: money(deltaCents),
    taxDelta: null,
    feeDelta: null,
    totalDelta: money(deltaCents),
    routeSummary: hotelSummary(rate, info),
    arrivesAt: null,
  };
}

function hotelSummary(rate: any, info: any): string | null {
  const name =
    info?.hotelRateInfo?.rooms?.[0]?.ratePlans?.[0]?.ratePlanName ??
    info?.hotelRateInfo?.rooms?.[0]?.roomDescription?.name ??
    null;
  if (!rate?.checkInDate) return name;
  const total = amount(rate.approxTotalPrice ?? rate.amountAfterTax);
  return `${name ?? "Hotel"}, ${rate.checkInDate} to ${rate.checkOutDate}, ${total ?? "?"} ${rate.currencyCode ?? ""}`.trim();
}
