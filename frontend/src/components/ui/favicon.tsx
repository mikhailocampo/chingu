/**
 * A site icon for a domain, at any pixel size.
 *
 * Google's endpoint only serves powers of two (16/32/64/128/256), so asking it
 * for `sz=22` silently returns 16px and the browser upscales it to mush. We
 * request the next power of two at or above 2x the rendered size and let CSS
 * scale it down, which is crisp on retina and merely correct elsewhere.
 *
 * Two fallbacks behind it. A broken-image glyph in the header during a demo is
 * the failure mode worth spending twenty lines to avoid, and both hops are
 * plain <img> loads, so no CORS and no key.
 */
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/** Google tops out at 256; beyond that we'd upscale regardless. */
function bucket(px: number) {
  const target = Math.min(px * 2, 256)
  return [16, 32, 64, 128, 256].find((n) => n >= target) ?? 256
}

const SOURCES = [
  (domain: string, px: number) =>
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${bucket(px)}`,
  (domain: string) =>
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
]

export function Favicon({
  domain,
  size = 16,
  alt = "",
  className,
}: {
  domain: string
  /** Rendered CSS size in px. Any value — the request is bucketed for you. */
  size?: number
  /** Empty by default: usually adjacent to the org name, so it's decorative. */
  alt?: string
  className?: string
}) {
  const [attempt, setAttempt] = useState(0)

  // A new domain has to re-enter the chain at the top, or it inherits the
  // previous domain's exhausted state and renders the letter tile forever.
  useEffect(() => setAttempt(0), [domain])

  const box = { width: size, height: size }

  if (attempt >= SOURCES.length) {
    return (
      <span
        aria-hidden={alt ? undefined : true}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        style={{ ...box, fontSize: Math.max(9, size * 0.5) }}
        className={cn(
          "bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center rounded-[3px] font-semibold uppercase",
          className
        )}
      >
        {domain.replace(/^www\./, "").charAt(0)}
      </span>
    )
  }

  return (
    <img
      src={SOURCES[attempt](domain, size)}
      alt={alt}
      style={box}
      loading="lazy"
      onError={() => setAttempt((n) => n + 1)}
      className={cn("inline-block shrink-0 rounded-[3px] object-contain", className)}
    />
  )
}
