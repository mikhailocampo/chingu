/**
 * Booking lifecycle: create, fulfil, retrieve, modify.
 *
 * ⚠️  EXECUTION OF THE WRITE PATHS IS UNVERIFIED.
 *
 * `createBooking`, `fulfillTickets` and `modifyBooking` were built against
 * hand-written fixtures and the API schemas; they were NOT executed, because
 * doing so mutates real CERT records. Request construction and response
 * parsing are tested. The round trip is not.
 *
 * The rules encoded here all come from live-verified findings:
 *   - flights ticket with FOP CASH; hotels always need a card
 *   - modify requires a FRESH bookingSignature, fetched here, never passed in
 *   - hotel modify restates itemId/productCode/paymentPolicy/guests/leadIndex
 */

import type { SabreClient } from "./client.ts";
import { SabreError } from "./client.ts";
import { normalizeBooking } from "./normalize.ts";
import type { HotelPaymentPolicy, NormalizedBooking } from "./types.ts";

function fail(message: string, path: string): never {
  throw new SabreError({ message, status: 0, path });
}

// ================================================================ get-booking

/**
 * Fetch a booking by locator.
 *
 * A locator is the ONLY input Sabre accepts — there is no list or search
 * endpoint, which is precisely why the local index exists.
 */
export async function getBooking(
  client: SabreClient,
  confirmationId: string,
  returnOnly?: string[],
): Promise<NormalizedBooking> {
  if (!confirmationId) {
    fail("getBooking requires a confirmation locator; Sabre has no list or search endpoint.", "/get-booking");
  }

  const raw = await client.post("/get-booking", {
    confirmationId,
    ...(returnOnly?.length ? { returnOnly } : {}),
  });

  return normalizeBooking(raw);
}

// ============================================================= create-booking

export interface Traveler {
  givenName: string;
  surname: string;
  passengerCode?: "ADT" | "CNN" | "INF";
  birthDate?: string;
}

export interface PaymentCard {
  cardNumber: string;
  cardTypeCode: string;
  expiryDate: string;
  cardSecurityCode: string;
  cardHolderName: string;
}

export interface CreateBookingParams {
  travelers: Traveler[];
  contact: { email: string; phone: string };
  flightOfferId?: string;
  hotel?: {
    /** From check-hotel-price. NEVER a rateKey. */
    bookingKey: string;
    paymentPolicy: HotelPaymentPolicy;
    numberOfGuests: number;
    leadTravelerIndex: number;
  };
  /** Required for hotels. Must never be sent outside CERT unless real. */
  card?: PaymentCard;
}

/** A bookingKey is a plain UUID; a rateKey is a long opaque base64 blob.
 *  Substituting one for the other is a documented, well-typed failure. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildCreateBookingRequest(params: CreateBookingParams) {
  const { travelers, contact, flightOfferId, hotel, card } = params;

  if (!travelers?.length) fail("createBooking requires at least one traveler.", "/create-booking");
  if (!flightOfferId && !hotel) fail("createBooking requires a flight offer, a hotel, or both.", "/create-booking");

  const req: any = {
    travelers: travelers.map((t, i) => ({
      givenName: t.givenName,
      surname: t.surname,
      passengerCode: t.passengerCode ?? "ADT",
      nameAssociationId: String(i + 1),
      ...(t.birthDate ? { birthDate: t.birthDate } : {}),
    })),
    contactInfo: { email: contact.email, phone: contact.phone },
  };

  if (flightOfferId) {
    // Air settles via BSP through the validating carrier, so CASH needs no
    // card and no billingAddress. Verified end-to-end: PNR RRQQNS, ticket
    // 1807361095425 issued with FOP CASH.
    req.flightDetails = {
      offerId: flightOfferId,
      formOfPayment: { type: "CASH" },
    };
  }

  if (hotel) {
    if (!UUID.test(hotel.bookingKey)) {
      fail(
        "hotel.bookingKey must be the UUID returned by check-hotel-price — never substitute a rateKey here.",
        "/create-booking",
      );
    }
    if (!card) {
      // Tested live and rejected by the property: FOP AGENCY_NAME returned
      // UNABLE_TO_BOOK_HOTEL_INVALID_FORM_OF_PAYMENT and paymentPolicy LATE
      // returned UNABLE_TO_BOOK_HOTEL_LATE_PAYMENT_NOT_SUPPORTED. There is no
      // card-free hotel path on GDS chain inventory.
      fail(
        "Hotel bookings require a payment card. Card-free forms of payment (AGENCY_NAME, LATE) are rejected by the property.",
        "/create-booking",
      );
    }

    req.hotelDetails = {
      bookingKey: hotel.bookingKey,
      paymentPolicy: hotel.paymentPolicy,
      numberOfGuests: hotel.numberOfGuests,
      leadTravelerIndex: hotel.leadTravelerIndex,
      formOfPayment: {
        type: "PAYMENTCARD",
        paymentCard: {
          cardNumber: card.cardNumber,
          cardTypeCode: card.cardTypeCode,
          expiryDate: card.expiryDate,
          cardSecurityCode: card.cardSecurityCode,
          cardHolder: { name: card.cardHolderName, email: contact.email, phone: contact.phone },
        },
      },
    };
  }

  return req;
}

/** ⚠️ UNVERIFIED EXECUTION — never run against CERT during development. */
export async function createBooking(
  client: SabreClient,
  params: CreateBookingParams,
): Promise<NormalizedBooking> {
  const raw = await client.post("/create-booking", buildCreateBookingRequest(params));
  return normalizeBooking(raw);
}

// ============================================================ fulfil tickets

export function buildFulfillTicketsRequest(params: {
  confirmationId: string;
  commitTicketToBookingWaitTime?: number;
}) {
  if (!params.confirmationId) fail("fulfillTickets requires a confirmation locator.", "/fulfill-flight-tickets");
  return {
    confirmationId: params.confirmationId,
    formOfPayment: { type: "CASH" },
    commitTicketToBookingWaitTime: params.commitTicketToBookingWaitTime ?? 6000,
  };
}

export interface FulfillResult {
  /** True when the only problem was the known cosmetic timing warning. */
  shouldVerifyWithGetBooking: boolean;
  /** True when Sabre reported an error that is NOT the cosmetic warning. */
  isConfirmedFailure: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Issue tickets.
 *
 * `UNABLE_TO_RETRIEVE_TICKETS` is COSMETIC. It was observed live while the
 * ticket had in fact been issued (`get-booking` showed `isTicketed: true`).
 * Retrying on it risks double-ticketing, so it is reported as "go verify",
 * never as a failure.
 *
 * ⚠️ UNVERIFIED EXECUTION in this library.
 */
export async function fulfillTickets(
  client: SabreClient,
  params: { confirmationId: string; commitTicketToBookingWaitTime?: number },
): Promise<FulfillResult> {
  const raw: any = await client.post("/fulfill-flight-tickets", buildFulfillTicketsRequest(params));

  const warnings: string[] = (raw?.warnings ?? []).map((w: any) => w.code ?? String(w));
  const errors: string[] = (raw?.errors ?? []).map((e: any) => e.code ?? String(e));

  const onlyCosmetic =
    errors.length === 0 && warnings.every((w) => w === "UNABLE_TO_RETRIEVE_TICKETS");

  return {
    shouldVerifyWithGetBooking: warnings.length > 0 || errors.length === 0,
    isConfirmedFailure: errors.length > 0 || (warnings.length > 0 && !onlyCosmetic),
    warnings,
    errors,
  };
}

// ============================================================ modify-booking

export interface HotelModifyItemParams {
  itemId: string;
  productCode: string;
  paymentPolicy: HotelPaymentPolicy;
  numberOfGuests: number;
  leadTravelerIndex: number;
  checkIn: string;
  checkOut: string;
  /** Supply the originals so we can tell a free in-window move from one that
   *  needs a re-price. */
  originalCheckIn?: string;
  originalCheckOut?: string;
  originalNumberOfGuests?: number;
  /** From a fresh check-hotel-price. Required when moving outside the original
   *  window or changing occupancy. */
  bookingKey?: string;
}

/**
 * Build the `after.hotels[]` entry for a modify.
 *
 * Every one of these five fields is required on EVERY hotel modify, even when
 * only shifting dates — which is why the segment table persists them all.
 *
 * A `bookingKey` is only needed when changing room type, guest count, or dates
 * outside the original range. Moving a stay *within* its existing window needs
 * no re-price round trip; extending it needs a full search → price-check first.
 */
export function buildHotelModifyItem(params: HotelModifyItemParams) {
  const required = [
    "itemId",
    "productCode",
    "paymentPolicy",
    "numberOfGuests",
    "leadTravelerIndex",
  ] as const;

  for (const field of required) {
    if (params[field] === undefined || params[field] === null || params[field] === "") {
      fail(`Hotel modify requires ${field} on every call.`, "/modify-booking");
    }
  }

  const movedOutsideWindow =
    (params.originalCheckIn !== undefined && params.checkIn < params.originalCheckIn) ||
    (params.originalCheckOut !== undefined && params.checkOut > params.originalCheckOut);

  const occupancyChanged =
    params.originalNumberOfGuests !== undefined &&
    params.originalNumberOfGuests !== params.numberOfGuests;

  if ((movedOutsideWindow || occupancyChanged) && !params.bookingKey) {
    fail(
      "This modify changes dates outside the original range or the guest count, so it requires a fresh bookingKey from check-hotel-price.",
      "/modify-booking",
    );
  }

  return {
    itemId: params.itemId,
    productCode: params.productCode,
    paymentPolicy: params.paymentPolicy,
    numberOfGuests: params.numberOfGuests,
    leadTravelerIndex: params.leadTravelerIndex,
    room: { checkInDate: params.checkIn, checkOutDate: params.checkOut },
    ...(params.bookingKey ? { bookingKey: params.bookingKey } : {}),
  };
}

export interface ModifyBookingParams {
  confirmationId: string;
  hotel?: ReturnType<typeof buildHotelModifyItem>;
  /** Accepted and IGNORED. Present only so callers holding a cached signature
   *  cannot accidentally get it used. */
  staleSignature?: string;
}

/**
 * Modify a booking.
 *
 * The signature is fetched here, immediately before the write, and any value
 * the caller passes in is discarded. A signature "cannot be reused after other
 * operations modify the booking", so a cached one is a silent lost update.
 *
 * Concurrency: because the signature is per-booking, concurrent modifies
 * against one PNR WILL collide. Serialize per PNR, or fan out across PNRs.
 *
 * ⚠️ UNVERIFIED EXECUTION in this library.
 */
export async function modifyBooking(
  client: SabreClient,
  params: ModifyBookingParams,
): Promise<NormalizedBooking> {
  if (!params.confirmationId) fail("modifyBooking requires a confirmation locator.", "/modify-booking");

  // ALWAYS fresh. Never params.staleSignature.
  const current = await getBooking(client, params.confirmationId);
  if (!current.bookingSignature) {
    fail("get-booking returned no bookingSignature; refusing to modify without one.", "/modify-booking");
  }

  const raw = await client.post("/modify-booking", {
    confirmationId: params.confirmationId,
    bookingSignature: current.bookingSignature,
    ...(params.hotel ? { after: { hotels: [params.hotel] } } : {}),
  });

  return normalizeBooking(raw);
}
