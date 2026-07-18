/**
 * Airport -> IANA timezone, and a UTC-offset resolver.
 *
 * WHY THIS EXISTS
 * ---------------
 * Sabre returns LOCAL times with no UTC offset, anywhere:
 *
 *     { "departureDate": "2026-09-14", "departureTime": "13:10", ... }
 *
 * Our schema stores `dep_time_utc` / `arr_time_utc`, and the product thesis
 * ("does this rebooking still land before the dinner?") compares times across
 * Korea and the US. Without a zone per airport those comparisons are wrong by
 * up to 16 hours, and wrong in the dangerous direction: a mis-converted option
 * looks like it arrives EARLY and sorts FIRST.
 *
 * So: resolve the offset or return null. Never guess.
 *
 * WHY IANA ZONES AND NOT FIXED OFFSETS
 * ------------------------------------
 * The demo sits in September 2026. The US is on daylight time then
 * (EDT -04:00, PDT -07:00) but Korea has never observed DST (+09:00 all year).
 * A hardcoded offset table is therefore correct for this demo and silently
 * wrong in November. Mapping to IANA zones and asking `Intl` for the offset on
 * the actual date costs a few lines and is right year-round.
 *
 * THIS TABLE IS DELIBERATELY MINIMAL
 * ----------------------------------
 * It covers only the airports the seeded demo touches. It is meant to be
 * extended by hand — add the IATA code and its IANA zone, nothing else. There
 * is no need for a full IATA database; an unknown code resolves to null and
 * the offer is marked unevaluable rather than mis-sorted.
 */

/** IATA airport code -> IANA timezone. Extend freely; keep sorted by region. */
export const AIRPORT_TZ: Readonly<Record<string, string>> = Object.freeze({
  // --- Korea (no DST, +09:00 year-round) ---
  ICN: "Asia/Seoul", // Seoul Incheon — every US arrival lands here
  GMP: "Asia/Seoul", // Seoul Gimpo
  PUS: "Asia/Seoul", // Busan — the offsite itself

  // --- US east (EST -05:00 / EDT -04:00) ---
  JFK: "America/New_York",
  EWR: "America/New_York",
  BOS: "America/New_York",

  // --- US central (CST -06:00 / CDT -05:00) ---
  ORD: "America/Chicago",
  MSP: "America/Chicago", // appeared as a real reshop routing

  // --- US west (PST -08:00 / PDT -07:00) ---
  SFO: "America/Los_Angeles",
  LAX: "America/Los_Angeles",
  SEA: "America/Los_Angeles",

  // --- Asia connections seen in live CERT results ---
  HKG: "Asia/Hong_Kong", // the CX841 + CX416 routing
  NRT: "Asia/Tokyo",
  HND: "Asia/Tokyo",
  MNL: "Asia/Manila", // the PR routing
});

/** IANA zone for an airport, or null if we do not know it. */
export function zoneFor(airportCode: string | null | undefined): string | null {
  if (!airportCode) return null;
  return AIRPORT_TZ[airportCode.toUpperCase()] ?? null;
}

/**
 * UTC offset for an airport on a given local date, as `+09:00` / `-04:00`.
 * Returns null for unknown airports — callers must treat that as "cannot
 * evaluate", never as UTC.
 *
 * Shape matches the `OffsetResolver` that `backend/sabre/src/normalize.ts`
 * injects into `toInstant`.
 *
 * Caveat: the offset is sampled at midday, so a flight departing within a
 * couple of hours of a DST transition could be off by one hour. Acceptable —
 * the alternative failure (16 hours, silently sorted first) is the one that
 * matters, and this rules it out.
 */
export function offsetFor(
  airportCode: string | null | undefined,
  localDate: string | null | undefined,
): string | null {
  const zone = zoneFor(airportCode);
  if (!zone || !localDate) return null;

  const sample = new Date(`${localDate}T12:00:00Z`);
  if (Number.isNaN(sample.getTime())) return null;

  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    })
      .formatToParts(sample)
      .find((p) => p.type === "timeZoneName")?.value;

    if (!name) return null;
    // "GMT+09:00" -> "+09:00";  bare "GMT" (UTC) -> "+00:00"
    const offset = name.replace(/^GMT/, "");
    return offset === "" ? "+00:00" : offset;
  } catch {
    return null;
  }
}

/** True when we can convert this airport's local times to UTC at all. */
export function isKnownAirport(airportCode: string | null | undefined): boolean {
  return zoneFor(airportCode) !== null;
}
