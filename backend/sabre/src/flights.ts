/**
 * Flight shopping and exchange quoting.
 *
 * Paths follow the skill assets (`path: /search-flights`, and the single
 * `POST /flightReshop` documented in the Reshop spec). If the deployment sits
 * behind a different gateway prefix, set it on `SabreConfig.baseUrl`.
 */

import type { SabreClient } from "./client.ts";
import { SabreError } from "./client.ts";
import { normalizeReshopOffers, normalizeSearchFlightOffers } from "./normalize.ts";
import type { Decimal, FlightOffer } from "./types.ts";

export interface SearchFlightsParams {
  origin: string;
  dest: string;
  departureDate: string;
  /** Number of ADT travellers. */
  passengers?: number;
  cabin?: "Economy" | "Premium Economy" | "Business" | "First" | "Premium Business" | "Premium First";
  /** Bounded on purpose — see below. */
  limit?: number;
  /** Local HH:MM window the traveller must land inside. */
  arriveBetween?: { startTime: string; endTime: string };
  /** The fare they already hold, so deltas are real deltas. */
  baselineTotal?: Decimal | null;
  maxStops?: number;
}

/**
 * Build the shop request.
 *
 * Two non-obvious requirements are encoded here:
 *
 *  - `retailing.returnOfferAttributes` MUST include "Flexibility". Without it
 *    the response has no `offerAttributes.changeItems[]`, and change fees —
 *    the entire basis of search-time rebooking economics — silently vanish.
 *  - `processingOptions.limitNumberOfOffers` MUST be set. Omitting it returns
 *    up to 1000 offers.
 */
export function buildSearchFlightsRequest(params: SearchFlightsParams) {
  const {
    origin,
    dest,
    departureDate,
    passengers = 1,
    cabin,
    limit = 20,
    arriveBetween,
    maxStops,
  } = params;

  const journey: Record<string, unknown> = {
    departureLocation: { airportCode: origin },
    arrivalLocation: { airportCode: dest },
    departureDate,
  };
  if (arriveBetween) journey.arrivalTimeWindow = arriveBetween;

  const req: any = {
    journeys: [journey],
    travelers: Array.from({ length: passengers }, () => ({ passengerTypeCode: "ADT" })),
    processingOptions: { limitNumberOfOffers: limit },
    sources: { distributionModels: ["ATPCO"] },
    retailing: { returnOfferAttributes: ["Flexibility", "Baggage"] },
  };

  if (cabin) req.fare = { cabin: { title: cabin } };
  if (maxStops !== undefined) req.route = { maximumNumberOfStops: maxStops };

  return req;
}

/** Search and return small, ranked-ready offers. */
export async function searchFlights(
  client: SabreClient,
  params: SearchFlightsParams,
): Promise<FlightOffer[]> {
  const raw = await client.post("/search-flights", buildSearchFlightsRequest(params));
  return normalizeSearchFlightOffers(raw, { baselineTotal: params.baselineTotal ?? null });
}

export interface ReshopParams {
  /** Reshop quotes against an ISSUED ticket — `fulfillFlightTickets` must have
   *  run first. `bookingId` alone is ignored for ATPCO content. */
  ticketNumber: string;
  confirmationId?: string;
}

/**
 * Quote an exchange. Quote-only and payment-free: the API has one path and no
 * commit endpoint, so it structurally cannot execute the exchange.
 *
 * Responses run ~170KB; normalization is not optional here.
 */
export async function reshopFlight(
  client: SabreClient,
  params: ReshopParams,
): Promise<FlightOffer[]> {
  if (!params.ticketNumber) {
    throw new SabreError({
      message: "reshopFlight requires an issued ticket number; reshop cannot quote without one.",
      status: 0,
      path: "/flightReshop",
    });
  }

  const raw = await client.post("/flightReshop", {
    tickets: [{ number: params.ticketNumber }],
    ...(params.confirmationId ? { bookingId: params.confirmationId } : {}),
  });

  return normalizeReshopOffers(raw);
}
