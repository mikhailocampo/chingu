/**
 * Money formatting by STRING MANIPULATION ONLY.
 *
 * The wire sends decimal strings because schema.sql:9 is explicit that money is
 * never a float. Parsing one here to display it would reintroduce exactly the
 * class of error the schema went out of its way to avoid, one layer later.
 */

/** "1159.40" -> "$1,159.40". Never touches Number for the value itself. */
export function formatMoney(amount: string, currency: string | null = "USD"): string {
  const negative = amount.startsWith("-")
  const bare = negative ? amount.slice(1) : amount
  const [wholeRaw, fracRaw] = bare.split(".")
  const whole = groupThousands(wholeRaw || "0")
  const frac = (fracRaw ?? "").padEnd(2, "0").slice(0, 2)
  const symbol = currency === "USD" || currency === null ? "$" : ""
  const suffix = symbol ? "" : ` ${currency}`
  return `${negative ? "-" : ""}${symbol}${whole}.${frac}${suffix}`
}

/** Compact form for the summary strip: "$1,159" — cents dropped, not rounded. */
export function formatMoneyCompact(amount: string, currency: string | null = "USD"): string {
  const negative = amount.startsWith("-")
  const bare = negative ? amount.slice(1) : amount
  const whole = groupThousands(bare.split(".")[0] || "0")
  const symbol = currency === "USD" || currency === null ? "$" : ""
  const suffix = symbol ? "" : ` ${currency}`
  return `${negative ? "-" : ""}${symbol}${whole}${suffix}`
}

function groupThousands(digits: string): string {
  let out = ""
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i
    out += digits[i]
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ","
  }
  return out
}

/** "Synced 14s ago". Coarse on purpose — precision here is noise. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  return `${Math.round(mins / 60)}h`
}

/** "19:41" — the wall clock the stale banner quotes back at her. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/**
 * Itinerary times render in the timezone the ROW declares, never the viewer's.
 *
 * Segments carry dep_time_utc/arr_time_utc (schema.sql:123-125) and are shown
 * in UTC. Activities carry their own `timezone` column (schema.sql:331) and are
 * shown in it. Both are labelled at the point of use.
 *
 * Converting flights to Busan time is the obvious-looking improvement and it is
 * wrong: the advisories are pre-composed by the worker and quote the UTC value
 * ("UA805 lands 19:20" for an arr_time_utc of 19:20Z). Rendering 04:20 KST
 * directly beneath a sentence saying 19:20 would put the screen in visible
 * disagreement with itself, and the advisory is the half that must not be
 * rebuilt client-side.
 */
const DATE_PARTS = {
  weekday: "short",
  day: "numeric",
  month: "short",
} as const

const TIME_PARTS = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
} as const

const cache = new Map<string, Intl.DateTimeFormat>()

function fmt(tz: string, parts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${Object.keys(parts).join(",")}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...parts })
    cache.set(key, f)
  }
  return f
}

/**
 * "Mon 14 Sep". A date-only string is midnight UTC and stays the same day.
 *
 * Assembled from parts rather than taken whole: en-GB abbreviates September to
 * "Sept", which sits badly next to the roster header's "15–18 Sep 2026". Three
 * letters, everywhere.
 */
export function tzDate(iso: string, tz = "UTC"): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  const parts = fmt(tz, DATE_PARTS).formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ""
  return `${get("weekday")} ${get("day")} ${get("month").slice(0, 3)}`
}

/** "17:10". */
export function tzTime(iso: string, tz = "UTC"): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return fmt(tz, TIME_PARTS).format(d)
}

/**
 * Calendar days between two instants in `tz` — the "+1" that turns an 08:50
 * arrival from "same morning" into "the next morning". Red-eyes are the norm
 * on this route, so omitting it would misread every JFK–ICN leg on the board.
 */
export function dayOffset(fromIso: string, toIso: string, tz = "UTC"): number {
  const a = ymd(fromIso, tz)
  const b = ymd(toIso, tz)
  if (!a || !b || a === b) return 0
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/**
 * The zone abbreviation for that instant — "PDT", "KST". Derived rather than
 * hardcoded so it stays right across a DST boundary, and so the same helper
 * works for the viewer's zone and a venue's.
 */
export function tzLabel(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")
  return part?.value ?? ""
}

/** Whatever zone this browser is in. The viewer reads times in their own. */
export const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

/** "2026-09-15" in the given zone. en-CA is ISO-ordered by locale definition. */
function ymd(iso: string, tz: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}
