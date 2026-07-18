/**
 * Hotel shopping and price validation.
 *
 * `get-hotel-rates` is deliberately not wrapped: `search-hotels` already
 * returns a usable `rateKey` per rate plan (verified live — a search rateKey
 * priced successfully), and the rates call returns ~187KB for no extra value
 * in this flow. Add it only if a rate absent from search is ever needed.
 */

import type { SabreClient } from "./client.ts";
import { SabreError } from "./client.ts";
import { normalizeHotelPriceCheck, normalizeHotelSearch } from "./normalize.ts";
import type { HotelRateOption } from "./normalize.ts";
import type { Offer } from "./types.ts";

export interface SearchHotelsParams {
  /** IATA code for a reference-point search. */
  referencePoint?: string;
  latitude?: number;
  longitude?: number;
  checkInDate: string;
  checkOutDate: string;
  radiusInMiles?: number;
  numberOfAdults?: number;
  maxResults?: number;
}

export function buildSearchHotelsRequest(params: SearchHotelsParams) {
  const {
    referencePoint,
    latitude,
    longitude,
    checkInDate,
    checkOutDate,
    radiusInMiles = 10,
    numberOfAdults = 1,
    maxResults = 10,
  } = params;

  if (checkOutDate <= checkInDate) {
    throw new SabreError({
      message: `checkOutDate (${checkOutDate}) must be after checkInDate (${checkInDate}).`,
      status: 0,
      path: "/search-hotels",
    });
  }

  const hasCoords = latitude !== undefined && longitude !== undefined;
  if (!referencePoint && !hasCoords) {
    throw new SabreError({
      message: "searchHotels requires a location: either a referencePoint or latitude/longitude.",
      status: 0,
      path: "/search-hotels",
    });
  }

  const req: any = {
    checkInDate,
    checkOutDate,
    radiusInMiles,
    numberOfAdults,
    maxResults,
  };

  // Never send both — Sabre resolves one location, not a union.
  if (hasCoords) {
    req.latitude = latitude;
    req.longitude = longitude;
  } else {
    req.referencePoint = { type: "Airport", value: referencePoint };
  }

  return req;
}

export async function searchHotels(
  client: SabreClient,
  params: SearchHotelsParams,
): Promise<HotelRateOption[]> {
  const raw = await client.post("/search-hotels", buildSearchHotelsRequest(params));
  return normalizeHotelSearch(raw);
}

/**
 * Validate a rate and mint a `bookingKey`.
 *
 * The returned key lives ~7 minutes. Gather every piece of guest data BEFORE
 * calling this — price-checking early and holding the key while collecting
 * details is the documented way to get UNABLE_TO_BOOK_HOTEL_EXPIRED_BOOKING_KEY.
 */
export async function checkHotelPrice(
  client: SabreClient,
  params: { rateKey: string; checkInDate?: string; checkOutDate?: string },
): Promise<Offer> {
  if (!params.rateKey) {
    throw new SabreError({
      message: "checkHotelPrice requires a rateKey from search-hotels or get-hotel-rates.",
      status: 0,
      path: "/check-hotel-price",
    });
  }

  const rateInfoRef: any = { rateKey: params.rateKey };
  if (params.checkInDate && params.checkOutDate) {
    rateInfoRef.stayDateTimeRange = {
      checkInDate: params.checkInDate,
      checkOutDate: params.checkOutDate,
    };
  }

  // The three-level nesting is mandatory. Flattening to { rateKey } is rejected.
  const raw = await client.post("/check-hotel-price", {
    hotelPriceCheckRq: { rateInfoRef },
  });

  return normalizeHotelPriceCheck(raw);
}
