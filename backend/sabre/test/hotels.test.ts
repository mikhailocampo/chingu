import { describe, expect, test } from "bun:test";
import { buildSearchHotelsRequest, checkHotelPrice, searchHotels } from "../src/hotels.ts";
import { createClient } from "../src/client.ts";
import type { FetchLike } from "../src/types.ts";
import SEARCH_HOTELS from "../fixtures/search-hotels.jfk.json";
import CHECK_PRICE from "../fixtures/check-hotel-price.jfk.json";

function clientReturning(payload: unknown) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { client: createClient({ baseUrl: "https://x.test", token: "t", fetch }), calls };
}

describe("buildSearchHotelsRequest", () => {
  test("builds a reference-point search", () => {
    const req = buildSearchHotelsRequest({
      referencePoint: "JFK",
      checkInDate: "2026-09-15",
      checkOutDate: "2026-09-18",
    });
    expect(req.referencePoint).toEqual({ type: "Airport", value: "JFK" });
    expect(req.radiusInMiles).toBeGreaterThan(0);
    expect(req.checkInDate).toBe("2026-09-15");
    expect(req.checkOutDate).toBe("2026-09-18");
  });

  test("builds a coordinate search and does not mix it with a reference point", () => {
    const req = buildSearchHotelsRequest({
      latitude: 40.6657,
      longitude: -73.80589,
      checkInDate: "2026-09-15",
      checkOutDate: "2026-09-18",
    });
    expect(req.latitude).toBe(40.6657);
    expect(req.referencePoint).toBeUndefined();
  });

  test("rejects a checkout that is not after check-in", () => {
    expect(() =>
      buildSearchHotelsRequest({
        referencePoint: "JFK",
        checkInDate: "2026-09-18",
        checkOutDate: "2026-09-15",
      }),
    ).toThrow(/checkOutDate/i);
  });

  test("requires some location", () => {
    expect(() =>
      buildSearchHotelsRequest({ checkInDate: "2026-09-15", checkOutDate: "2026-09-18" } as never),
    ).toThrow(/location/i);
  });
});

describe("searchHotels", () => {
  test("returns small rate options carrying everything modify-booking needs", async () => {
    const { client } = clientReturning(SEARCH_HOTELS);
    const options = await searchHotels(client, {
      referencePoint: "JFK",
      checkInDate: "2026-09-15",
      checkOutDate: "2026-09-18",
    });

    expect(options).toHaveLength(1);
    expect(options[0]!.productCode).toBe("A01CMK");
    expect(options[0]!.supplierRateCode).toBe("CMK");
    expect(options[0]!.paymentPolicy).toBe("GUARANTEE");
    expect(options[0]!.propertyPhone).toBe("1-718-322-4448");
  });
});

describe("checkHotelPrice", () => {
  test("MANDATORY three-level nesting — flattening it is rejected by Sabre", async () => {
    const { client, calls } = clientReturning(CHECK_PRICE);
    await checkHotelPrice(client, { rateKey: "RATEKEY123" });

    expect(calls[0]!.body.hotelPriceCheckRq.rateInfoRef.rateKey).toBe("RATEKEY123");
    // Not flattened:
    expect(calls[0]!.body.rateKey).toBeUndefined();
  });

  test("accepts a rateKey straight from search-hotels — get-hotel-rates is skippable", async () => {
    // Verified live this session: the search rateKey priced successfully.
    const { client } = clientReturning(CHECK_PRICE);
    const searchKey = SEARCH_HOTELS.hotels[0]!.rooms[0]!.ratePlans[0]!.rateKey;
    const offer = await checkHotelPrice(client, { rateKey: searchKey });
    expect(offer.providerOfferId).toBe("e1294771-c356-49fd-acbf-461ce47ee4ab");
  });

  test("returns an offer whose expiry is derived, since Sabre sends none", async () => {
    const { client } = clientReturning(CHECK_PRICE);
    const offer = await checkHotelPrice(client, { rateKey: "K" });
    expect(offer.expiresAt).toBe("2026-07-18T19:34:37.215Z");
    expect(offer.kind).toBe("HOTEL");
  });

  test("refuses an empty rateKey rather than round-tripping a guaranteed failure", async () => {
    const { client } = clientReturning(CHECK_PRICE);
    await expect(checkHotelPrice(client, { rateKey: "" })).rejects.toThrow(/rateKey/i);
  });
});
