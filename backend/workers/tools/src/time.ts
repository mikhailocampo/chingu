/**
 * Time parsing for LLM-supplied values.
 *
 * The model was 0-for-3 on a year (2026 -> 2025) in live testing, so any date
 * component it supplies is untrustworthy. `parseNewTime` therefore prefers a
 * bare wall-clock time anchored to the activity's OWN date and timezone, which
 * the model cannot corrupt because it never sees it. A full ISO timestamp is
 * still accepted, but only when it is well-formed.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;
const HHMM = /^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i;
const HOUR_ONLY = /^(\d{1,2})\s*(am|pm)$/i;

/** Offset in ms between a wall-clock reading in `tz` and the true UTC instant. */
function offsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") % 24, get("minute"), get("second"),
  );
  return asUtc - at.getTime();
}

/** Interpret a wall-clock instant (expressed as a UTC-shaped ms value) in `tz`. */
export function zonedWallToUtc(wallMs: number, tz: string): number {
  let t = wallMs - offsetMs(new Date(wallMs), tz);
  t = wallMs - offsetMs(new Date(t), tz);
  return t;
}

/** Local Y/M/D of an instant, as seen in `tz`. */
export function localDateParts(iso: string, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * Full local wall-clock reading of an instant, as seen in `tz`.
 *
 * `activity.starts_at` is stored UTC. The dinner is 2026-09-16T10:30:00Z, which
 * is 19:30 in Asia/Seoul — reading the stored value out to a Korean restaurant
 * would announce half past ten in the morning. Every spoken rendering of an
 * activity time goes through here first.
 */
export function localWallClock(iso: string, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const pad = (n: number) => String(n).padStart(2, "0");
  const [year, month, day] = [get("year"), get("month"), get("day")];
  return {
    year, month, day,
    hour: get("hour") % 24,
    minute: get("minute"),
    /** `YYYY-MM-DD` in `tz`, for `spokenDate`. */
    date: `${year}-${pad(month)}-${pad(day)}`,
  };
}

/**
 * Returns a canonical `...Z` timestamp, or null when the value is unusable.
 * Never guesses: "later", "banana" and "99:99" are refused, not coerced.
 */
export function parseNewTime(
  raw: unknown,
  anchorIso: string,
  tz: string,
): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  const iso = ISO.exec(s);
  if (iso) {
    const ms = Date.parse(normaliseIso(s));
    return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  }

  const hm = HHMM.exec(s) ?? HOUR_ONLY.exec(s);
  if (!hm) return null;
  const meridiem = (HHMM.test(s) ? hm[3] : hm[2])?.toLowerCase();
  let hour = Number(hm[1]);
  const minute = HHMM.test(s) ? Number(hm[2]) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  const { year, month, day } = localDateParts(anchorIso, tz);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  return new Date(zonedWallToUtc(wall, tz)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normaliseIso(s: string): string {
  const t = s.replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;
}

/**
 * The model is equally unreliable on booleans. Accept the forms it actually
 * produces; treat anything unrecognised as "not agreed" — the safe direction,
 * since a false negative writes nothing.
 */
export function parseAgreed(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw !== "string") return false;
  return ["true", "yes", "y", "1", "agreed", "confirmed", "ok"].includes(
    raw.trim().toLowerCase(),
  );
}
