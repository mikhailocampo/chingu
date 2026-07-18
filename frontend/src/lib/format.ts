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
