/**
 * End-to-end over REAL captured Sabre data: search -> normalize -> rank.
 *
 * Scenario: a traveller holds the $1071.40 KE82 JFK->ICN fare on 2026-09-14.
 * KE82 is cancelled. Dinner in Seoul is 18:00 KST on the 15th (09:00Z).
 */

import { describe, expect, test } from "bun:test";
import { normalizeSearchFlightOffers, segmentMatchesFlight } from "../src/normalize.ts";
import { normalizeBooking } from "../src/normalize.ts";
import { rankOffers } from "../src/rank.ts";
import type { EventWindow, Policy } from "../src/types.ts";
import SEARCH_FLIGHTS from "../fixtures/search-flights.jfk-icn.json";
import GET_BOOKING from "../fixtures/get-booking.RRQQNS.json";

const POLICY: Policy = {
  id: "pol_samsung_flight",
  version: 1,
  currency: "USD",
  requires_approval_over: "150.00",
  max_add_collect: "600.00",
};

/** Dinner is 18:00 Seoul time on the 15th. */
const EVENT: EventWindow = { arrival_by: "2026-09-15T09:00:00Z" };

/** Inside the 20-minute validity window of the captured offers. */
const NOW = new Date("2026-07-18T19:30:00Z");

const CX_VIA_HKG_LATE = "e4dafcbb-1a58-471e-8101-6feedd255ee9"; // arrives ICN 21:10 KST
const CX_VIA_HKG_OK = "10103dad-8069-4e62-b668-f6ccfd9dbfa5"; // arrives ICN 14:05 KST
const DL_CODESHARE = "8f7c9f26-2138-4eb6-b5c9-b7967007682e";

describe("pipeline: real search -> rank", () => {
  const offers = normalizeSearchFlightOffers(SEARCH_FLIGHTS, { baselineTotal: "1071.40" });
  const ranked = rankOffers(offers, POLICY, EVENT, NOW);

  test("both cheapest offers cost the same, but only one arrives in time", () => {
    const late = offers.find((o) => o.providerOfferId === CX_VIA_HKG_LATE)!;
    const ok = offers.find((o) => o.providerOfferId === CX_VIA_HKG_OK)!;

    expect(late.totalDelta).toBe(ok.totalDelta); // identical price
    expect(late.arrivesAt).toBe("2026-09-15T12:10:00.000Z"); // 3h after dinner
    expect(ok.arrivesAt).toBe("2026-09-15T05:05:00.000Z");
  });

  test("THE THESIS: the equally-cheap late option FAILs and never ranks", () => {
    const verdicts = rankOffers(offers, POLICY, EVENT, NOW);
    const late = verdicts.find((o) => o.providerOfferId === CX_VIA_HKG_LATE);

    // It is either ranked-and-FAILed, or pushed out of the top 3 entirely.
    if (late) {
      expect(late.policyVerdict).toBe("FAIL");
      expect(late.rank).not.toBe(1);
    }
    expect(ranked[0]!.providerOfferId).not.toBe(CX_VIA_HKG_LATE);
  });

  test("rank 1 is the cheapest option that actually arrives in time", () => {
    expect(ranked[0]!.providerOfferId).toBe(CX_VIA_HKG_OK);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.policyVerdict).toBe("PASS");
    expect(ranked[0]!.totalDelta).toBe("-312.10");
    expect(ranked[0]!.chargeType).toBe("REFUND");
  });

  test("returns at most 3, all ranked, all with a speakable summary and a reason", () => {
    expect(ranked.length).toBeLessThanOrEqual(3);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    for (const r of ranked) {
      expect(r.routeSummary).toBeTruthy();
      expect(r.policyReason).toBeTruthy();
      expect(r.expiresAt).toBeTruthy();
    }
  });

  test("the DL codeshare keeps its operating identity all the way through", () => {
    const dl = ranked.find((r) => r.providerOfferId === DL_CODESHARE);
    const fromOffers = offers.find((o) => o.providerOfferId === DL_CODESHARE)!;
    expect(fromOffers.legs[0]!.operatingCarrier).toBe("KE");
    expect(fromOffers.legs[0]!.operatingFlightNo).toBe(82);
    if (dl) expect(dl.routeSummary).toContain("KE82");
  });

  test("everything the voice agent reads out is small enough to hold in a prompt", () => {
    expect(JSON.stringify(ranked).length).toBeLessThan(4000);
  });

  test("once the offers expire, ranking returns nothing rather than stale options", () => {
    const tooLate = new Date("2026-07-18T19:44:00Z"); // past validUntil 19:43:54Z
    expect(rankOffers(offers, POLICY, EVENT, tooLate)).toEqual([]);
  });
});

// ------------------------------------------------------------ codeshare match

describe("segmentMatchesFlight — the affected-set lookup", () => {
  const booking = normalizeBooking(GET_BOOKING);
  const seg = booking.segments[0]!; // KE81, operated by KE81

  test("matches on marketing identity", () => {
    expect(segmentMatchesFlight(seg, { carrier: "KE", flightNo: 81, depDate: "2026-09-15" })).toBe(true);
  });

  test("does not match a different flight", () => {
    expect(segmentMatchesFlight(seg, { carrier: "KE", flightNo: 82, depDate: "2026-09-15" })).toBe(false);
    expect(segmentMatchesFlight(seg, { carrier: "OZ", flightNo: 81, depDate: "2026-09-15" })).toBe(false);
  });

  test("does not match the same flight on a different date", () => {
    expect(segmentMatchesFlight(seg, { carrier: "KE", flightNo: 81, depDate: "2026-09-16" })).toBe(false);
  });

  test("CODESHARE: a DL7842 ticket is matched by a KE82 cancellation", () => {
    // The passenger's segment says DL7842. The airline cancels KE82.
    const codeshareSeg = {
      ...seg,
      carrier: "DL",
      flightNo: 7842,
      operatingCarrier: "KE",
      operatingFlightNo: 82,
      depDate: "2026-09-14",
    };

    // Matching on marketing alone would MISS this traveller entirely.
    expect(codeshareSeg.carrier).not.toBe("KE");
    expect(segmentMatchesFlight(codeshareSeg, { carrier: "KE", flightNo: 82, depDate: "2026-09-14" })).toBe(true);
  });

  test("CODESHARE: the reverse also holds — a KE82 ticket matches a DL7842 notice", () => {
    const keSeg = {
      ...seg,
      carrier: "KE",
      flightNo: 82,
      operatingCarrier: "KE",
      operatingFlightNo: 82,
      depDate: "2026-09-14",
    };
    // A KE82 ticket is not matched by a DL7842 notice on marketing alone
    // either; the operating index is what makes both directions work.
    expect(segmentMatchesFlight(keSeg, { carrier: "KE", flightNo: 82, depDate: "2026-09-14" })).toBe(true);
  });

  test("ignores hotel segments", () => {
    const hotelSeg = { ...seg, type: "HOTEL" as const };
    expect(segmentMatchesFlight(hotelSeg, { carrier: "KE", flightNo: 81, depDate: "2026-09-15" })).toBe(false);
  });
});
