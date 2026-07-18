/**
 * @chingu/sabre — a pure TypeScript Sabre adapter.
 *
 * No Cloudflare bindings, no D1, no Workers runtime, no `env`. Construct a
 * client with a config object and an injected fetch; get typed domain objects
 * back. Every module is unit-testable with zero network.
 *
 *   const client = createClient({ baseUrl, token, fetch });
 *   const offers = await searchFlights(client, { origin, dest, departureDate });
 *   const best   = rankOffers(offers, policy, event, client.now());
 */

export { SabreError, createClient } from "./client.ts";
export type { SabreClient } from "./client.ts";

export { buildSearchFlightsRequest, reshopFlight, searchFlights } from "./flights.ts";
export type { ReshopParams, SearchFlightsParams } from "./flights.ts";

export { buildSearchHotelsRequest, checkHotelPrice, searchHotels } from "./hotels.ts";
export type { SearchHotelsParams } from "./hotels.ts";

export {
  buildCreateBookingRequest,
  buildFulfillTicketsRequest,
  buildHotelModifyItem,
  createBooking,
  fulfillTickets,
  getBooking,
  modifyBooking,
} from "./booking.ts";
export type {
  CreateBookingParams,
  FulfillResult,
  HotelModifyItemParams,
  ModifyBookingParams,
  PaymentCard,
  Traveler,
} from "./booking.ts";

export { AIRPORT_TZ, isKnownAirport, offsetFor, zoneFor } from "./airports.ts";

export {
  HOTEL_BOOKING_KEY_TTL_MS,
  normalizeBooking,
  normalizeHotelPaymentPolicy,
  normalizeHotelPriceCheck,
  normalizeHotelSearch,
  normalizeReshopOffers,
  normalizeSearchFlightOffers,
  segmentMatchesFlight,
  toInstant,
} from "./normalize.ts";
export type { HotelRateOption, OffsetResolver, SearchFlightOptions } from "./normalize.ts";

export { isExpired, rankOffers, toCents } from "./rank.ts";

export type * from "./types.ts";
