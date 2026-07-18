import { describe, expect, test } from "bun:test";
import { buildSearchFlightsRequest, reshopFlight, searchFlights } from "../src/flights.ts";
import { createClient } from "../src/client.ts";
import type { FetchLike } from "../src/types.ts";
import SEARCH_FLIGHTS from "../fixtures/search-flights.jfk-icn.json";
import RESHOP from "../fixtures/reshop-flight.synthetic.json";

function clientReturning(payload: unknown) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return {
    client: createClient({ baseUrl: "https://x.test", token: "t", pcc: "S5OM", fetch }),
    calls,
  };
}

describe("buildSearchFlightsRequest", () => {
  test("maps a simple one-way onto journeys + travelers", () => {
    const req = buildSearchFlightsRequest({
      origin: "JFK",
      dest: "ICN",
      departureDate: "2026-09-14",
    });

    expect(req.journeys).toEqual([
      {
        departureLocation: { airportCode: "JFK" },
        arrivalLocation: { airportCode: "ICN" },
        departureDate: "2026-09-14",
      },
    ]);
    expect(req.travelers).toEqual([{ passengerTypeCode: "ADT" }]);
  });

  test("CRITICAL: always asks for Flexibility attributes", () => {
    // Without this, offerAttributes.changeItems is absent from the response and
    // search-time change-fee economics silently become impossible.
    const req = buildSearchFlightsRequest({ origin: "JFK", dest: "ICN", departureDate: "2026-09-14" });
    expect(req.retailing.returnOfferAttributes).toContain("Flexibility");
  });

  test("bounds the result set — omitting the limit returns up to 1000 offers", () => {
    const req = buildSearchFlightsRequest({ origin: "JFK", dest: "ICN", departureDate: "2026-09-14" });
    expect(req.processingOptions.limitNumberOfOffers).toBeGreaterThan(0);
    expect(req.processingOptions.limitNumberOfOffers).toBeLessThanOrEqual(50);

    const custom = buildSearchFlightsRequest({
      origin: "JFK",
      dest: "ICN",
      departureDate: "2026-09-14",
      limit: 12,
    });
    expect(custom.processingOptions.limitNumberOfOffers).toBe(12);
  });

  test("carries an arrival deadline through as an arrivalTimeWindow when asked", () => {
    const req = buildSearchFlightsRequest({
      origin: "JFK",
      dest: "ICN",
      departureDate: "2026-09-14",
      arriveBetween: { startTime: "00:00", endTime: "18:00" },
    });
    expect(req.journeys[0]!.arrivalTimeWindow).toEqual({ startTime: "00:00", endTime: "18:00" });
  });

  test("passes cabin and passenger count through", () => {
    const req = buildSearchFlightsRequest({
      origin: "JFK",
      dest: "ICN",
      departureDate: "2026-09-14",
      passengers: 3,
      cabin: "Business",
    });
    expect(req.travelers).toHaveLength(3);
    expect(req.fare?.cabin?.title).toBe("Business");
  });
});

describe("searchFlights", () => {
  test("returns normalized offers, never the raw payload", async () => {
    const { client, calls } = clientReturning(SEARCH_FLIGHTS);
    const offers = await searchFlights(client, {
      origin: "JFK",
      dest: "ICN",
      departureDate: "2026-09-14",
    });

    expect(calls[0]!.url).toContain("/search-flights");
    expect(offers).toHaveLength(6);
    expect(offers[0]).not.toHaveProperty("items");
    expect(offers.every((o) => typeof o.providerOfferId === "string")).toBe(true);
  });

  test("threads the baseline fare into the delta computation", async () => {
    const { client } = clientReturning(SEARCH_FLIGHTS);
    const offers = await searchFlights(client, {
      origin: "JFK",
      dest: "ICN",
      departureDate: "2026-09-14",
      baselineTotal: "1071.40",
    });
    const dl = offers.find((o) => o.providerOfferId === "8f7c9f26-2138-4eb6-b5c9-b7967007682e")!;
    expect(dl.totalDelta).toBe("-0.90");
  });
});

describe("reshopFlight", () => {
  test("posts the ticket number and returns normalized exchange offers", async () => {
    const { client, calls } = clientReturning(RESHOP);
    const offers = await reshopFlight(client, { ticketNumber: "1807361095425" });

    expect(JSON.stringify(calls[0]!.body)).toContain("1807361095425");
    expect(offers).toHaveLength(5);
    expect(offers.find((o) => o.providerOfferId === "rs-even-ke81")!.chargeType).toBe("EVEN");
  });

  test("requires a ticket number — reshop cannot quote without an issued ticket", async () => {
    const { client } = clientReturning(RESHOP);
    await expect(reshopFlight(client, { ticketNumber: "" })).rejects.toThrow(/ticket/i);
  });
});
