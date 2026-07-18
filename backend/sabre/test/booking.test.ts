import { describe, expect, test } from "bun:test";
import {
  buildCreateBookingRequest,
  buildFulfillTicketsRequest,
  buildHotelModifyItem,
  createBooking,
  fulfillTickets,
  getBooking,
  modifyBooking,
} from "../src/booking.ts";
import { createClient } from "../src/client.ts";
import type { FetchLike } from "../src/types.ts";
import GET_BOOKING from "../fixtures/get-booking.RRQQNS.json";

function scriptedClient(responses: unknown[]) {
  const calls: Array<{ url: string; body: any }> = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    const payload = responses[Math.min(i++, responses.length - 1)];
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { client: createClient({ baseUrl: "https://x.test", token: "t", fetch }), calls };
}

const TRAVELER = {
  givenName: "MINJUN",
  surname: "TESTPARK",
  passengerCode: "ADT" as const,
};

// ================================================================ get-booking

describe("getBooking", () => {
  test("takes a locator and nothing else — there is no list or search endpoint", async () => {
    const { client, calls } = scriptedClient([GET_BOOKING]);
    const booking = await getBooking(client, "RRQQNS");

    expect(calls[0]!.url).toContain("/get-booking");
    expect(calls[0]!.body.confirmationId).toBe("RRQQNS");
    expect(booking.pnr).toBe("RRQQNS");
    expect(booking.segments[0]!.supplierLocator).toBe("CFVLKC");
  });

  test("rejects an empty locator", async () => {
    const { client } = scriptedClient([GET_BOOKING]);
    await expect(getBooking(client, "")).rejects.toThrow(/locator|confirmation/i);
  });
});

// ============================================================= create-booking

describe("buildCreateBookingRequest — flights", () => {
  test("FLIGHTS TICKET WITH CASH: no card fields anywhere", () => {
    const req = buildCreateBookingRequest({
      travelers: [TRAVELER],
      flightOfferId: "4241c78e-2888-44fd-9701-2c1db40b8322",
      contact: { email: "a@b.test", phone: "+12125550100" },
    });

    expect(req.flightDetails?.formOfPayment?.type).toBe("CASH");
    const serialised = JSON.stringify(req);
    expect(serialised).not.toMatch(/cardNumber|cardSecurityCode|billingAddress/);
  });

  test("never emits a fabricated PAN for a flight", () => {
    const req = buildCreateBookingRequest({
      travelers: [TRAVELER],
      flightOfferId: "x",
      contact: { email: "a@b.test", phone: "+1" },
    });
    expect(JSON.stringify(req)).not.toContain("4111111111111111");
  });
});

describe("buildCreateBookingRequest — hotels", () => {
  const CARD = {
    cardNumber: "4111111111111111",
    cardTypeCode: "VI",
    expiryDate: "2029-12",
    cardSecurityCode: "123",
    cardHolderName: "MINJUN TESTPARK",
  };

  test("HOTELS REQUIRE A CARD — there is no card-free hotel path", () => {
    const req = buildCreateBookingRequest({
      travelers: [TRAVELER],
      hotel: {
        bookingKey: "e1294771-c356-49fd-acbf-461ce47ee4ab",
        paymentPolicy: "GUARANTEE",
        numberOfGuests: 1,
        leadTravelerIndex: 1,
      },
      contact: { email: "a@b.test", phone: "+12125550100" },
      card: CARD,
    });

    expect(req.hotelDetails?.formOfPayment?.type).toBe("PAYMENTCARD");
    expect(req.hotelDetails?.formOfPayment?.paymentCard?.cardNumber).toBe("4111111111111111");
    expect(req.hotelDetails?.paymentPolicy).toBe("GUARANTEE");
  });

  test("throws rather than attempting a card-free hotel booking", () => {
    // Both card-free candidates were tested live and rejected by the property:
    // AGENCY_NAME -> INVALID_FORM_OF_PAYMENT, LATE -> LATE_PAYMENT_NOT_SUPPORTED.
    expect(() =>
      buildCreateBookingRequest({
        travelers: [TRAVELER],
        hotel: {
          // a valid bookingKey, so the ONLY thing wrong is the missing card
          bookingKey: "e1294771-c356-49fd-acbf-461ce47ee4ab",
          paymentPolicy: "GUARANTEE",
          numberOfGuests: 1,
          leadTravelerIndex: 1,
        },
        contact: { email: "a@b.test", phone: "+1" },
      }),
    ).toThrow(/card/i);
  });

  test("refuses a rateKey where a bookingKey belongs", () => {
    expect(() =>
      buildCreateBookingRequest({
        travelers: [TRAVELER],
        hotel: {
          // a rateKey is a long opaque base64 blob; a bookingKey is a UUID
          bookingKey: "xyTk29fiN+CTTZjaN4Bu4ekBsQtJWVCYQ0HNoalx/ysxpy4U7lw7QC4jDjNVwn74",
          paymentPolicy: "GUARANTEE",
          numberOfGuests: 1,
          leadTravelerIndex: 1,
        },
        contact: { email: "a@b.test", phone: "+1" },
        card: CARD,
      }),
    ).toThrow(/bookingKey/i);
  });
});

describe("createBooking", () => {
  test("posts to create-booking and returns the normalized result", async () => {
    const { client, calls } = scriptedClient([{ bookingId: "NEWPNR", isTicketed: false }]);
    const out = await createBooking(client, {
      travelers: [TRAVELER],
      flightOfferId: "x",
      contact: { email: "a@b.test", phone: "+1" },
    });
    expect(calls[0]!.url).toContain("/create-booking");
    expect(out.pnr).toBe("NEWPNR");
  });
});

// ============================================================ fulfil tickets

describe("fulfillTickets", () => {
  test("issues with CASH and no card", () => {
    const req = buildFulfillTicketsRequest({ confirmationId: "RRQQNS" });
    expect(req.formOfPayment?.type).toBe("CASH");
    expect(JSON.stringify(req)).not.toMatch(/cardNumber/);
  });

  test("UNABLE_TO_RETRIEVE_TICKETS is a cosmetic warning, not a failure", async () => {
    // Verified live: fulfillment returned this warning while get-booking showed
    // isTicketed: true. Retrying on it risks double-ticketing.
    const { client } = scriptedClient([
      { warnings: [{ code: "UNABLE_TO_RETRIEVE_TICKETS", message: "not completed in the requested time" }] },
    ]);
    const out = await fulfillTickets(client, { confirmationId: "RRQQNS" });
    expect(out.shouldVerifyWithGetBooking).toBe(true);
    expect(out.isConfirmedFailure).toBe(false);
  });

  test("a real error is not swallowed", async () => {
    const { client } = scriptedClient([{ errors: [{ code: "SOMETHING_REAL" }] }]);
    const out = await fulfillTickets(client, { confirmationId: "RRQQNS" });
    expect(out.isConfirmedFailure).toBe(true);
  });
});

// ============================================================ modify-booking

describe("modifyBooking", () => {
  test("ALWAYS fetches a FRESH bookingSignature — never accepts a cached one", async () => {
    const { client, calls } = scriptedClient([GET_BOOKING, { bookingId: "RRQQNS" }]);

    await modifyBooking(client, {
      confirmationId: "RRQQNS",
      // deliberately passing a stale signature; it must be ignored
      staleSignature: "DEADBEEF-do-not-use",
      hotel: buildHotelModifyItem({
        itemId: "25",
        productCode: "A01CMK",
        paymentPolicy: "GUARANTEE",
        numberOfGuests: 1,
        leadTravelerIndex: 1,
        checkIn: "2026-09-16",
        checkOut: "2026-09-19",
      }),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/get-booking");
    expect(calls[1]!.url).toContain("/modify-booking");
    expect(calls[1]!.body.bookingSignature).toBe(GET_BOOKING.bookingSignature);
    expect(JSON.stringify(calls[1]!.body)).not.toContain("DEADBEEF");
  });

  test("HOTEL MODIFY demands itemId, productCode, paymentPolicy, guests and lead index", () => {
    const item = buildHotelModifyItem({
      itemId: "25",
      productCode: "A01CMK",
      paymentPolicy: "GUARANTEE",
      numberOfGuests: 2,
      leadTravelerIndex: 1,
      checkIn: "2026-09-16",
      checkOut: "2026-09-19",
    });

    expect(item.itemId).toBe("25");
    expect(item.productCode).toBe("A01CMK");
    expect(item.paymentPolicy).toBe("GUARANTEE");
    expect(item.numberOfGuests).toBe(2);
    expect(item.leadTravelerIndex).toBe(1);
  });

  test("each required hotel field is individually enforced", () => {
    const base = {
      itemId: "25",
      productCode: "A01CMK",
      paymentPolicy: "GUARANTEE" as const,
      numberOfGuests: 1,
      leadTravelerIndex: 1,
      checkIn: "2026-09-16",
      checkOut: "2026-09-19",
    };
    for (const field of ["itemId", "productCode", "paymentPolicy", "numberOfGuests", "leadTravelerIndex"]) {
      const broken = { ...base, [field]: undefined };
      expect(() => buildHotelModifyItem(broken as never)).toThrow(new RegExp(field, "i"));
    }
  });

  test("moving dates WITHIN the original range needs no bookingKey", () => {
    const item = buildHotelModifyItem({
      itemId: "25",
      productCode: "A01CMK",
      paymentPolicy: "GUARANTEE",
      numberOfGuests: 1,
      leadTravelerIndex: 1,
      checkIn: "2026-09-16",
      checkOut: "2026-09-17",
      originalCheckIn: "2026-09-15",
      originalCheckOut: "2026-09-18",
    });
    expect(item.bookingKey).toBeUndefined();
  });

  test("EXTENDING beyond the original range requires a re-priced bookingKey", () => {
    expect(() =>
      buildHotelModifyItem({
        itemId: "25",
        productCode: "A01CMK",
        paymentPolicy: "GUARANTEE",
        numberOfGuests: 1,
        leadTravelerIndex: 1,
        checkIn: "2026-09-15",
        checkOut: "2026-09-20", // beyond the original 09-18
        originalCheckIn: "2026-09-15",
        originalCheckOut: "2026-09-18",
      }),
    ).toThrow(/bookingKey/i);
  });

  test("changing guest count also requires a bookingKey", () => {
    expect(() =>
      buildHotelModifyItem({
        itemId: "25",
        productCode: "A01CMK",
        paymentPolicy: "GUARANTEE",
        numberOfGuests: 2,
        originalNumberOfGuests: 1,
        leadTravelerIndex: 1,
        checkIn: "2026-09-15",
        checkOut: "2026-09-18",
        originalCheckIn: "2026-09-15",
        originalCheckOut: "2026-09-18",
      }),
    ).toThrow(/bookingKey/i);
  });
});
