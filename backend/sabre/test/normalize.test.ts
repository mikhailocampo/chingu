import { describe, expect, test } from "bun:test";
import { AIRPORT_TZ, isKnownAirport, offsetFor } from "../src/airports.ts";
import {
  HOTEL_BOOKING_KEY_TTL_MS,
  normalizeBooking,
  normalizeHotelPaymentPolicy,
  normalizeHotelPriceCheck,
  normalizeHotelSearch,
  normalizeReshopOffers,
  normalizeSearchFlightOffers,
  toInstant,
} from "../src/normalize.ts";

import SEARCH_FLIGHTS from "../fixtures/search-flights.jfk-icn.json";
import GET_BOOKING from "../fixtures/get-booking.RRQQNS.json";
import SEARCH_HOTELS from "../fixtures/search-hotels.jfk.json";
import CHECK_PRICE from "../fixtures/check-hotel-price.jfk.json";
import RESHOP from "../fixtures/reshop-flight.synthetic.json";

// =========================================================== time resolution

describe("toInstant — Sabre returns local times with NO offset", () => {
  test("resolves a local date+time against an airport offset", () => {
    expect(toInstant("2026-09-14", "13:10", "JFK")).toBe("2026-09-14T17:10:00.000Z");
    expect(toInstant("2026-09-15", "17:50", "ICN")).toBe("2026-09-15T08:50:00.000Z");
  });

  test("tolerates HH:MM:SS as well as HH:MM", () => {
    expect(toInstant("2026-09-15", "10:00:00", "ICN")).toBe("2026-09-15T01:00:00.000Z");
  });

  test("returns null for an airport we have no offset for, rather than guessing", () => {
    expect(toInstant("2026-09-14", "13:10", "ZZZ")).toBeNull();
    expect(toInstant("2026-09-14", "13:10", null)).toBeNull();
    expect(toInstant(null, "13:10", "JFK")).toBeNull();
  });

  test("a custom resolver overrides the built-in table", () => {
    expect(toInstant("2026-09-14", "13:10", "ZZZ", () => "+05:30")).toBe("2026-09-14T07:40:00.000Z");
  });

  /**
   * Self-check on the offset table: Sabre gives us durationInMinutes
   * independently, so dep+duration must equal arr. If the table is wrong this
   * fails loudly instead of silently mis-ranking by whole hours.
   */
  test("offset table agrees with Sabre's own durationInMinutes on every real leg", () => {
    for (const f of SEARCH_FLIGHTS.flights) {
      const dep = toInstant(f.departureDate, f.departureTime, f.departureAirportCode);
      const arr = toInstant(f.arrivalDate, f.arrivalTime, f.arrivalAirportCode);
      expect(dep).not.toBeNull();
      expect(arr).not.toBeNull();
      const actualMinutes = (Date.parse(arr!) - Date.parse(dep!)) / 60000;
      expect(actualMinutes).toBe(f.durationInMinutes);
    }
  });

  test("offsets are resolved per date and survive a DST boundary", () => {
    // September: US on daylight time, Korea never observes DST.
    expect(offsetFor("JFK", "2026-09-14")).toBe("-04:00");
    expect(offsetFor("ICN", "2026-09-14")).toBe("+09:00");
    expect(offsetFor("SFO", "2026-09-14")).toBe("-07:00");
    // December: the case a fixed table gets silently wrong.
    expect(offsetFor("JFK", "2026-12-01")).toBe("-05:00");
    expect(offsetFor("SFO", "2026-12-01")).toBe("-08:00");
    expect(offsetFor("ICN", "2026-12-01")).toBe("+09:00");
  });

  test("an unknown airport resolves to null rather than a guess", () => {
    expect(offsetFor("ZZZ", "2026-09-14")).toBeNull();
    expect(isKnownAirport("ZZZ")).toBe(false);
    expect(isKnownAirport("ICN")).toBe(true);
    expect(AIRPORT_TZ.PUS).toBe("Asia/Seoul");
  });
});

// ============================================================ flight search

describe("normalizeSearchFlightOffers", () => {
  const offers = normalizeSearchFlightOffers(SEARCH_FLIGHTS);

  test("reduces the payload to one small object per offer, never the raw JSON", () => {
    expect(offers).toHaveLength(6);
    for (const o of offers) {
      expect(JSON.stringify(o).length).toBeLessThan(2000);
      expect(JSON.stringify(o)).not.toContain("fareBasisCode");
      expect(JSON.stringify(o)).not.toContain("offerAttributes");
    }
  });

  test("CODESHARE: populates BOTH marketing and operating identity", () => {
    // Offer 8f7c9f26 is the DL-marketed, KE-operated A380.
    const dl = offers.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    const leg = dl.legs[0]!;

    expect(leg.carrier).toBe("DL");
    expect(leg.flightNo).toBe(7842);
    expect(leg.operatingCarrier).toBe("KE");
    expect(leg.operatingFlightNo).toBe(82);
    expect(leg.isCodeshare).toBe(true);
  });

  test("CODESHARE: KE82 and DL7842 resolve to the same metal at the same instant", () => {
    const dl = offers.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    const ke = offers.find((o) => o.providerOfferId === "4241c78e-2888-44fd-9701-2c1db40b8322")!;

    // Different marketing identity...
    expect(dl.legs[0]!.carrier).not.toBe(ke.legs[0]!.carrier);
    // ...identical operating identity and timing. Same aircraft.
    expect(dl.legs[0]!.operatingCarrier).toBe(ke.legs[0]!.operatingCarrier);
    expect(dl.legs[0]!.operatingFlightNo).toBe(ke.legs[0]!.operatingFlightNo);
    expect(dl.legs[0]!.depAt).toBe(ke.legs[0]!.depAt);
    expect(dl.legs[0]!.arrAt).toBe(ke.legs[0]!.arrAt);
  });

  test("a non-codeshare leg is not flagged as one", () => {
    const oz = offers.find((o) => o.providerOfferId === "3ff3f174-e725-40fe-8e39-15035c80f59b")!;
    expect(oz.legs[0]!.carrier).toBe("OZ");
    expect(oz.legs[0]!.operatingCarrier).toBe("OZ");
    expect(oz.legs[0]!.isCodeshare).toBe(false);
  });

  test("EXPIRY: carries validUntil through as expiresAt (~20 min)", () => {
    for (const o of offers) expect(o.expiresAt).toBe("2026-07-18T19:43:54Z");
    const created = Date.parse("2026-07-18T19:23:54Z");
    expect(Date.parse(offers[0]!.expiresAt!) - created).toBe(20 * 60 * 1000);
  });

  test("resolves multi-leg journeys in order and takes arrival from the LAST leg", () => {
    const cx = offers.find((o) => o.providerOfferId === "e4dafcbb-1a58-471e-8101-6feedd255ee9")!;
    expect(cx.legs).toHaveLength(2);
    expect(cx.legs.map((l) => `${l.origin}-${l.dest}`)).toEqual(["JFK-HKG", "HKG-ICN"]);
    expect(cx.arrivesAt).toBe(cx.legs[1]!.arrAt);
    expect(cx.arrivesAt).toBe("2026-09-15T12:10:00.000Z");
  });

  test("CHANGE FEES come back at SEARCH time, resolved via changeRef", () => {
    // Verified in SABRE_LEARNINGS: search maxCharge == reshop totalFee.
    const ke = offers.find((o) => o.providerOfferId === "4241c78e-2888-44fd-9701-2c1db40b8322")!;
    expect(ke.feeDelta).toBe("120.00"); // changeRef 112f4c11, beforeDeparture maxCharge

    const dl = offers.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    expect(dl.feeDelta).toBe("0.00"); // raw fixture says "0" — must normalise to "0.00"

    const cx = offers.find((o) => o.providerOfferId === "e4dafcbb-1a58-471e-8101-6feedd255ee9")!;
    expect(cx.feeDelta).toBe("200.00");
  });

  test("with no baseline, totalDelta is the full cost of a new ticket plus the fee", () => {
    const ke = offers.find((o) => o.providerOfferId === "4241c78e-2888-44fd-9701-2c1db40b8322")!;
    expect(ke.fareDelta).toBe("1071.40");
    expect(ke.totalDelta).toBe("1191.40");
    expect(ke.chargeType).toBe("ADD_COLLECT");
  });

  test("with a baseline fare, computes the real rebooking economics", () => {
    // Traveller currently holds the $1071.40 KE82 fare.
    const priced = normalizeSearchFlightOffers(SEARCH_FLIGHTS, { baselineTotal: "1071.40" });

    const oz = priced.find((o) => o.providerOfferId === "3ff3f174-e725-40fe-8e39-15035c80f59b")!;
    expect(oz.fareDelta).toBe("0.00"); // same price
    expect(oz.feeDelta).toBe("120.00");
    expect(oz.totalDelta).toBe("120.00");
    expect(oz.chargeType).toBe("ADD_COLLECT");

    // The DL codeshare is 90c cheaper and has a $0 change fee -> a net refund.
    const dl = priced.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    expect(dl.fareDelta).toBe("-0.90");
    expect(dl.feeDelta).toBe("0.00");
    expect(dl.totalDelta).toBe("-0.90");
    expect(dl.chargeType).toBe("REFUND");

    // The cheap CX routing: big fare drop, but a $200 change fee.
    const cx = priced.find((o) => o.providerOfferId === "e4dafcbb-1a58-471e-8101-6feedd255ee9")!;
    expect(cx.fareDelta).toBe("-512.10");
    expect(cx.totalDelta).toBe("-312.10");
    expect(cx.chargeType).toBe("REFUND");
  });

  test("an exactly-equal fare with no fee is EVEN, not null", () => {
    const priced = normalizeSearchFlightOffers(SEARCH_FLIGHTS, { baselineTotal: "1070.50" });
    const dl = priced.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    expect(dl.totalDelta).toBe("0.00");
    expect(dl.chargeType).toBe("EVEN");
  });

  test("routeSummary is speakable and names the operating carrier on a codeshare", () => {
    const dl = offers.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    expect(dl.routeSummary).toContain("DL7842");
    expect(dl.routeSummary).toContain("KE82");
    expect(dl.routeSummary!.toLowerCase()).toContain("operated by");
    expect(dl.routeSummary).toContain("JFK");
    expect(dl.routeSummary).toContain("ICN");
  });

  test("survives a response with no offerAttributes at all", () => {
    const stripped = { ...SEARCH_FLIGHTS, offerAttributes: undefined };
    const out = normalizeSearchFlightOffers(stripped as never);
    expect(out).toHaveLength(6);
    expect(out[0]!.feeDelta).toBeNull();
  });

  test("survives an empty response", () => {
    expect(normalizeSearchFlightOffers({} as never)).toEqual([]);
  });
});

// ==================================================================== reshop

describe("normalizeReshopOffers", () => {
  const offers = normalizeReshopOffers(RESHOP);

  test("maps Sabre charge types onto the schema enum", () => {
    const byId = Object.fromEntries(offers.map((o) => [o.providerOfferId, o]));
    expect(byId["rs-even-ke81"]!.chargeType).toBe("EVEN");
    expect(byId["rs-addcollect-ke85"]!.chargeType).toBe("ADD_COLLECT");
    expect(byId["rs-refund-downgrade"]!.chargeType).toBe("REFUND");
  });

  test("an unmapped charge type becomes null, never a wrong guess", () => {
    const unknown = offers.find((o) => o.providerOfferId === "rs-unknown-chargetype")!;
    expect(unknown.chargeType).toBeNull();
  });

  test("A $0.00 EVEN is real and must not be confused with null", () => {
    const even = offers.find((o) => o.providerOfferId === "rs-even-ke81")!;
    expect(even.chargeType).toBe("EVEN");
    expect(even.totalDelta).toBe("0.00");
    expect(even.totalDelta).not.toBeNull();
  });

  test("amounts are signed — a Refund is negative", () => {
    const refund = offers.find((o) => o.providerOfferId === "rs-refund-downgrade")!;
    expect(refund.totalDelta).toBe("-1539.40");
    expect(refund.fareDelta).toBe("-1600.00");
  });

  test("VERIFIED ARITHMETIC: grandTotal === baseFare + totalTax + totalFee", () => {
    for (const raw of RESHOP.reshopOffers) {
      const d = raw.totalPriceDifference;
      if (!d.baseFare || !d.totalTax || !d.totalFee) continue;
      const sum =
        Math.round(Number(d.baseFare.amount) * 100) +
        Math.round(Number(d.totalTax.amount) * 100) +
        Math.round(Number(d.totalFee.amount) * 100);
      expect(sum).toBe(Math.round(Number(d.grandTotal.amount) * 100));
    }
  });

  test("a negative tax component survives normalization", () => {
    const via = offers.find((o) => o.providerOfferId === "rs-addcollect-via-msp")!;
    expect(via.fareDelta).toBe("60.00");
    expect(via.taxDelta).toBe("-7.20");
    expect(via.feeDelta).toBe("101.00");
    expect(via.totalDelta).toBe("153.80");
  });

  test("CODESHARE survives reshop too — KE5033 is DL metal", () => {
    const via = offers.find((o) => o.providerOfferId === "rs-addcollect-via-msp")!;
    expect(via.legs).toHaveLength(2);
    expect(via.legs[0]!.carrier).toBe("KE");
    expect(via.legs[0]!.flightNo).toBe(5033);
    expect(via.legs[0]!.operatingCarrier).toBe("DL");
    expect(via.legs[0]!.operatingFlightNo).toBe(158);
    expect(via.legs[0]!.isCodeshare).toBe(true);
  });

  test("reduces a ~170KB payload to small objects", () => {
    for (const o of offers) expect(JSON.stringify(o).length).toBeLessThan(2000);
  });
});

// =================================================================== booking

describe("normalizeBooking", () => {
  const booking = normalizeBooking(GET_BOOKING);

  test("TWO LOCATORS: the Sabre PNR and the airline locator both survive", () => {
    expect(booking.pnr).toBe("RRQQNS");
    expect(booking.segments[0]!.supplierLocator).toBe("CFVLKC");
    expect(booking.segments[0]!.supplierLocator).not.toBe(booking.pnr);
  });

  test("CODESHARE: get-booking names marketing fields differently — both still land", () => {
    // get-booking uses airlineCode/flightNumber for MARKETING (not
    // marketingAirlineCode/marketingFlightNumber as search-flights does).
    const seg = booking.segments[0]!;
    expect(seg.carrier).toBe("KE");
    expect(seg.flightNo).toBe(81);
    expect(seg.operatingCarrier).toBe("KE");
    expect(seg.operatingFlightNo).toBe(81);
  });

  test("carries ticket numbers and ticketed/cancelable state", () => {
    expect(booking.isTicketed).toBe(true);
    expect(booking.isCancelable).toBe(true);
    expect(booking.ticketNumbers).toEqual(["1807361095425"]);
  });

  test("exposes bookingSignature but the type documents it is not to be stored", () => {
    expect(booking.bookingSignature).toBe(
      "9e3f04a0de15692e6ffeab9e036d20acb3d345af0f6ec360dfe3e77bf0602f7d7d42a9ced2dfec146ac28e663b23656d10443cc98cd0901fd8cbaa8769e26059",
    );
  });

  test("segment maps onto the schema's flight columns", () => {
    const seg = booking.segments[0]!;
    expect(seg.type).toBe("FLIGHT");
    expect(seg.sabreItemId).toBe("10");
    expect(seg.origin).toBe("ICN");
    expect(seg.dest).toBe("JFK");
    expect(seg.depDate).toBe("2026-09-15");
    expect(seg.depTimeLocal).toBe("10:00:00");
    expect(seg.arrDate).toBe("2026-09-15");
    expect(seg.rawStatusCode).toBe("HK");
  });

  test("does not carry the raw payload through", () => {
    expect(JSON.stringify(booking)).not.toContain("M99000123"); // passport number
    expect(JSON.stringify(booking)).not.toContain("aircraftTypeName");
  });

  test("survives a booking with no flights", () => {
    const empty = normalizeBooking({ bookingId: "AAAAAA" } as never);
    expect(empty.pnr).toBe("AAAAAA");
    expect(empty.segments).toEqual([]);
    expect(empty.ticketNumbers).toEqual([]);
    expect(empty.isTicketed).toBe(false);
  });
});

// ===================================================================== hotel

describe("hotel normalization", () => {
  test("GUAR maps to GUARANTEE — the skill asset's value_sources is wrong here", () => {
    // check-hotel-price has NO paymentPolicy field. It returns
    // guarantee.guaranteeType: "GUAR". The create-booking enum wants
    // DEPOSIT | GUARANTEE | LATE, so we map it ourselves.
    expect(normalizeHotelPaymentPolicy("GUAR")).toBe("GUARANTEE");
    expect(normalizeHotelPaymentPolicy("DEPOSIT")).toBe("DEPOSIT");
    expect(normalizeHotelPaymentPolicy("LATE")).toBe("LATE");
    expect(normalizeHotelPaymentPolicy(null)).toBeNull();
    expect(normalizeHotelPaymentPolicy("WHATEVER")).toBeNull();
  });

  test("normalizeHotelSearch pulls the property identity modify-booking demands", () => {
    const [option] = normalizeHotelSearch(SEARCH_HOTELS);
    expect(option!.propertyId).toBe("100105512");
    expect(option!.propertyName).toBe("Hilton Garden Inn Queens Jfk Airport");
    // The voice agent dials this. No lookup needed.
    expect(option!.propertyPhone).toBe("1-718-322-4448");
    expect(option!.productCode).toBe("A01CMK");
    expect(option!.supplierRateCode).toBe("CMK");
    expect(option!.paymentPolicy).toBe("GUARANTEE");
  });

  test("normalizeHotelSearch keeps the rateKey and the free-cancel deadline", () => {
    const [option] = normalizeHotelSearch(SEARCH_HOTELS);
    expect(option!.rateKey).toStartWith("xyTk29fiN+");
    // Only search carries this — check-hotel-price returns deadline: {}.
    expect(option!.freeCancelUntil).toBe("2026-09-11T04:00:00.000Z");
    expect(option!.checkIn).toBe("2026-09-15");
    expect(option!.checkOut).toBe("2026-09-18");
    expect(option!.totalPrice).toBe("935.55");
  });

  test("normalizeHotelSearch reduces the payload", () => {
    const [option] = normalizeHotelSearch(SEARCH_HOTELS);
    expect(JSON.stringify(option).length).toBeLessThan(2000);
    expect(JSON.stringify(option)).not.toContain("BANKAMERICARD");
  });

  test("EXPIRY: hotel bookingKey expiry is DERIVED (~7 min) — Sabre sends no deadline", () => {
    const offer = normalizeHotelPriceCheck(CHECK_PRICE);
    expect(offer.providerOfferId).toBe("e1294771-c356-49fd-acbf-461ce47ee4ab");
    // response timestamp 19:27:37.215Z + 7 min
    expect(offer.expiresAt).toBe("2026-07-18T19:34:37.215Z");
    expect(HOTEL_BOOKING_KEY_TTL_MS).toBe(7 * 60 * 1000);
  });

  test("price check with no change is EVEN at 0.00, not null", () => {
    const offer = normalizeHotelPriceCheck(CHECK_PRICE);
    expect(offer.totalDelta).toBe("0.00");
    expect(offer.chargeType).toBe("EVEN");
    expect(offer.currency).toBe("USD");
    expect(offer.kind).toBe("HOTEL");
  });

  test("a real price rise becomes an ADD_COLLECT", () => {
    const risen = structuredClone(CHECK_PRICE);
    risen.hotelPriceCheckRs.priceCheckInfo.priceChange = true;
    risen.hotelPriceCheckRs.priceCheckInfo.priceDifference = 42.5;
    const offer = normalizeHotelPriceCheck(risen);
    expect(offer.totalDelta).toBe("42.50");
    expect(offer.chargeType).toBe("ADD_COLLECT");
  });

  test("the price check response carries NO property identity — caller must merge", () => {
    const offer = normalizeHotelPriceCheck(CHECK_PRICE);
    expect(offer.routeSummary).toBeTruthy();
    // It genuinely is not in the payload; assert we didn't invent one.
    expect(JSON.stringify(CHECK_PRICE)).not.toContain("100105512");
  });
});
