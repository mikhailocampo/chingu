import { describe, expect, test } from "bun:test";
import { SabreError, createClient } from "../src/client.ts";
import type { FetchLike } from "../src/types.ts";

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function stubFetch(
  responder: (call: Call) => { ok?: boolean; status?: number; body: string },
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, ...init };
    calls.push(call);
    const r = responder(call);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body,
    };
  };
  return { fetch, calls };
}

const BASE = { baseUrl: "https://api.cert.platform.sabre.com", token: "secret-token-abc", pcc: "S5OM" };

describe("createClient", () => {
  test("POSTs JSON to baseUrl + path with a bearer token", async () => {
    const { fetch, calls } = stubFetch(() => ({ body: '{"ok":true}' }));
    const client = createClient({ ...BASE, fetch });

    const out = await client.post("/v1/search-flights", { hello: "world" });

    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.cert.platform.sabre.com/v1/search-flights");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers!.Authorization).toBe("Bearer secret-token-abc");
    expect(calls[0]!.headers!["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ hello: "world" });
  });

  test("does not double up slashes when baseUrl has a trailing one", async () => {
    const { fetch, calls } = stubFetch(() => ({ body: "{}" }));
    const client = createClient({ ...BASE, baseUrl: "https://x.test/", fetch });
    await client.post("/v1/thing", {});
    expect(calls[0]!.url).toBe("https://x.test/v1/thing");
  });

  test("uses ONLY the injected fetch — never a global", async () => {
    let injectedCalled = false;
    const fetch: FetchLike = async () => {
      injectedCalled = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const client = createClient({ ...BASE, fetch });
    await client.post("/v1/x", {});
    expect(injectedCalled).toBe(true);
  });

  test("throws SabreError carrying status and Sabre's own error code", async () => {
    const { fetch } = stubFetch(() => ({
      ok: false,
      status: 400,
      body: JSON.stringify({
        errorCode: "UNABLE_TO_BOOK_HOTEL_EXPIRED_BOOKING_KEY",
        message: "Generate the new booking key by means of HotelPriceCheck API.",
      }),
    }));
    const client = createClient({ ...BASE, fetch });

    const err = (await client.post("/v1/create-booking", {}).catch((e) => e)) as SabreError;

    expect(err).toBeInstanceOf(SabreError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("UNABLE_TO_BOOK_HOTEL_EXPIRED_BOOKING_KEY");
    expect(err.message).toContain("HotelPriceCheck");
    expect(err.path).toBe("/v1/create-booking");
  });

  test("SECURITY: the bearer token never appears in a thrown error", async () => {
    const { fetch } = stubFetch(() => ({ ok: false, status: 401, body: "Unauthorized: secret-token-abc" }));
    const client = createClient({ ...BASE, fetch });

    const err = (await client.post("/v1/x", {}).catch((e) => e)) as SabreError;

    const serialised = `${err.message} ${JSON.stringify(err.body)} ${err.stack ?? ""}`;
    expect(serialised).not.toContain("secret-token-abc");
    expect(serialised).toContain("[REDACTED]");
  });

  test("throws SabreError on a non-JSON body rather than leaking a parse error", async () => {
    const { fetch } = stubFetch(() => ({ body: "<html>gateway timeout</html>" }));
    const client = createClient({ ...BASE, fetch });

    const err = (await client.post("/v1/x", {}).catch((e) => e)) as SabreError;
    expect(err).toBeInstanceOf(SabreError);
    expect(err.message).toMatch(/parse|json/i);
  });

  test("an empty 200 body is not an error", async () => {
    const { fetch } = stubFetch(() => ({ body: "" }));
    const client = createClient({ ...BASE, fetch });
    expect(await client.post<Record<string, never>>("/v1/x", {})).toEqual({});
  });

  test("passes an abort signal so a hung Sabre call cannot wedge a worker", async () => {
    const { fetch, calls } = stubFetch(() => ({ body: "{}" }));
    const client = createClient({ ...BASE, fetch, timeoutMs: 5000 });
    await client.post("/v1/x", {});
    expect(calls[0]!.headers).toBeDefined();
    expect((calls[0] as any).signal).toBeDefined();
  });

  test("surfaces a transport failure as SabreError, not a raw TypeError", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("network down");
    };
    const client = createClient({ ...BASE, fetch });
    const err = (await client.post("/v1/x", {}).catch((e) => e)) as SabreError;
    expect(err).toBeInstanceOf(SabreError);
    expect(err.status).toBe(0);
    expect(err.message).toContain("network down");
  });

  test("exposes the injected clock, defaulting to a real one", () => {
    const fixed = new Date("2026-07-18T19:30:00Z");
    const { fetch } = stubFetch(() => ({ body: "{}" }));
    expect(createClient({ ...BASE, fetch, now: () => fixed }).now()).toEqual(fixed);
    expect(createClient({ ...BASE, fetch }).now()).toBeInstanceOf(Date);
  });
});
