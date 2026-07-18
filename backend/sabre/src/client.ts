/**
 * HTTP layer.
 *
 * Takes an injected fetch and nothing else — no Workers runtime, no `env`, no
 * global. That is what makes every module above this one unit-testable with
 * zero network.
 */

import type { FetchLike, SabreConfig } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Every failure this library raises.
 *
 * Sabre errors are well-typed and echo the full request back, which is great
 * for debugging and terrible for logs — the echo can include the bearer token.
 * The token is redacted from every field before construction.
 */
export class SabreError extends Error {
  /** HTTP status. 0 means the request never completed (transport failure). */
  readonly status: number;
  /** Sabre's own machine-readable code, e.g. UNABLE_TO_BOOK_HOTEL_EXPIRED_BOOKING_KEY. */
  readonly code: string | null;
  readonly path: string;
  readonly body: unknown;

  constructor(args: { message: string; status: number; code?: string | null; path: string; body?: unknown }) {
    super(args.message);
    this.name = "SabreError";
    this.status = args.status;
    this.code = args.code ?? null;
    this.path = args.path;
    this.body = args.body ?? null;
  }
}

/**
 * Strip the bearer token out of a string.
 *
 * Only ever applied to error text, never to a body we are about to parse — a
 * token that happens to be a substring of the payload would otherwise corrupt
 * valid JSON. Short secrets are left alone for the same reason: blanket
 * replacing a 1-2 character string mangles everything it touches. Real Sabre
 * tokens are long, so this costs nothing in practice.
 */
const MIN_REDACTABLE_SECRET = 8;

function redact(input: string, secret: string): string {
  if (!secret || secret.length < MIN_REDACTABLE_SECRET) return input;
  return input.split(secret).join("[REDACTED]");
}

function redactDeep(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redact(value, secret);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, secret)]),
    );
  }
  return value;
}

export interface SabreClient {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  /** Injected clock. Callers pass this into pure logic rather than reaching
   *  for Date.now(), so a whole triage pass shares one instant. */
  now(): Date;
  readonly pcc: string | undefined;
}

export function createClient(config: SabreConfig): SabreClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = config.fetch;
  const token = config.token;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;

    // A hung Sabre call must not wedge the caller. Reshop and get-hotel-rates
    // are slow enough that this is a real risk, not a theoretical one.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SabreError({
        message: redact(`Sabre request failed: ${message}`, token),
        status: 0,
        path,
      });
    } finally {
      clearTimeout(timer);
    }

    // Parse the body EXACTLY as received. Redaction happens only on the error
    // paths below, where the string is headed for a log rather than a parser.
    const raw = await res.text();

    if (!res.ok) {
      const parsed = safeParse(raw);
      const code =
        (parsed as any)?.errorCode ?? (parsed as any)?.code ?? (parsed as any)?.status ?? null;
      const detail = (parsed as any)?.message ?? raw.slice(0, 500);
      throw new SabreError({
        message: redact(`Sabre ${res.status} on ${path}: ${detail}`, token),
        status: res.status,
        code: typeof code === "string" ? code : null,
        path,
        body: redactDeep(parsed ?? raw, token),
      });
    }

    if (raw.trim() === "") return {} as T;

    const parsed = safeParse(raw);
    if (parsed === undefined) {
      throw new SabreError({
        message: `Could not parse Sabre JSON response from ${path}`,
        status: res.status,
        path,
        body: redact(raw.slice(0, 500), token),
      });
    }
    return parsed as T;
  }

  return {
    post,
    now: config.now ?? (() => new Date()),
    pcc: config.pcc,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
