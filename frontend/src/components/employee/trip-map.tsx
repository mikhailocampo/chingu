/**
 * Where this trip happens, as a static Mapbox image.
 *
 * TWO SHAPES, ONE PICTURE
 * -----------------------
 * A flyer gets an arc between airports. Sixteen of the twenty-six travellers
 * are already in Korea and never board anything (fixtures.ts:16) — for them the
 * only place on the itinerary is the hotel, so they get a pin on it. Rendering
 * nothing for the majority of the roster would make the map read as a feature
 * that is broken rather than one that is precise.
 *
 * WHY STATIC, NOT mapbox-gl
 * -------------------------
 * This map does not pan and does not zoom. It answers one question — where is
 * this person — and a single <img> answers it for ~2KB of code instead of
 * ~250KB gzipped of WebGL. It also degrades the way the rest of this app
 * already degrades: alt text and a caption, like Avatar and Favicon, rather
 * than a blank canvas and a console error.
 *
 * WHY GREAT CIRCLES
 * -----------------
 * See geo.ts. A straight JFK–ICN line crosses the Pacific; the aircraft goes
 * over the Arctic. Drawing the wrong path on a screen whose entire claim is
 * that it knows where people are would be a strange corner to cut.
 *
 * THE TOKEN
 * ---------
 * `pk.` public token, exposed to the client by design (vite.config.ts). It must
 * be URL-restricted in the Mapbox dashboard — a public token is safe to *show*,
 * not safe to leave *unscoped*.
 */
import { useEffect, useState } from "react"

import {
  airport,
  property,
  routePath,
  routeStops,
  type LonLat,
} from "@/lib/geo"
import type { FlightSegment, HotelSegment } from "@/lib/employee-types"
import { cn } from "@/lib/utils"

const TOKEN = import.meta.env.MAPBOX_API_KEY as string | undefined

/** 3:2. Matches the CSS box exactly, so nothing is cropped at any width. */
const WIDTH = 640
const HEIGHT = 426

/** Mapbox rejects static URLs past 8192 chars. Stay clear of the cliff. */
const URL_LIMIT = 7600

/**
 * City scale. Close enough that the coastline and the district around the hotel
 * are legible, wide enough that the pin lands somewhere recognisable rather
 * than over an unlabelled rooftop.
 */
const STAY_ZOOM = 12

function styleFor(dark: boolean) {
  return dark ? "dark-v11" : "light-v11"
}

function accent(dark: boolean) {
  return dark ? "#6aa9ff" : "#1f63d6"
}

function build(
  dark: boolean,
  overlay: string,
  viewport: string,
  extra = ""
): string | null {
  if (!TOKEN) return null
  return (
    `https://api.mapbox.com/styles/v1/mapbox/${styleFor(dark)}/static/` +
    `${overlay}/${viewport}/${WIDTH}x${HEIGHT}@2x` +
    `?${extra}access_token=${TOKEN}`
  )
}

function routeUrl(
  legs: FlightSegment[],
  dark: boolean,
  steps: number
): string | null {
  const parts = routePath(legs, steps)
  if (!parts) return null

  const stroke = accent(dark)
  const features = [
    ...parts.map((coordinates) => ({
      type: "Feature" as const,
      properties: { stroke, "stroke-width": 2.5, "stroke-opacity": 0.95 },
      geometry: { type: "LineString" as const, coordinates },
    })),
    ...routeStops(legs)
      .map((code) => {
        const point = airport(code)
        if (!point) return null
        return {
          type: "Feature" as const,
          properties: {
            "marker-size": "small" as const,
            "marker-color": stroke,
            "marker-symbol": "airport",
          },
          geometry: { type: "Point" as const, coordinates: point },
        }
      })
      .filter((f) => f !== null),
  ]

  const overlay = encodeURIComponent(
    JSON.stringify({ type: "FeatureCollection", features })
  )
  // `auto` frames the whole arc; padding keeps the endpoint pins off the edge.
  return build(dark, `geojson(${overlay})`, "auto", "padding=44&")
}

/**
 * Fewer interpolation points until the URL fits. A two-leg route at full
 * resolution can exceed the cap, and a coarser arc is a far better outcome than
 * a 400 from the tile server.
 */
function fitRouteUrl(legs: FlightSegment[], dark: boolean): string | null {
  for (const steps of [48, 32, 20, 12]) {
    const url = routeUrl(legs, dark, steps)
    if (!url) return null
    if (url.length <= URL_LIMIT) return url
  }
  return null
}

/**
 * A single pin. `auto` is deliberately not used: with one feature it zooms to
 * maximum and produces a rooftop with no context, which tells a coordinator
 * nothing about where their traveller actually is.
 */
function stayUrl([lon, lat]: LonLat, dark: boolean): string | null {
  const color = accent(dark).replace("#", "")
  return build(
    dark,
    `pin-l-lodging+${color}(${lon},${lat})`,
    `${lon},${lat},${STAY_ZOOM},0`
  )
}

/**
 * The provider writes `light`/`dark` onto <html> and is the only writer, so
 * watching the class is exact — and avoids re-deriving the system preference
 * that "system" resolves to.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark")
  )

  useEffect(() => {
    const root = document.documentElement
    // Subscribe only. The provider writes the class from its own effect, which
    // as a parent runs after this one, so reading eagerly here would sample the
    // value before it is written — the observer is what actually catches it.
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark"))
    )
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return dark
}

function MapImage({
  url,
  alt,
  className,
}: {
  url: string | null
  alt: string
  className?: string
}) {
  // Which URL failed, not whether one did. A theme switch or a new traveller
  // produces a different URL, and that one has not failed yet — storing the url
  // makes recovery fall out of the comparison instead of needing an effect to
  // reset a boolean.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  // No token configured, or the tile server refused. The caption and the
  // timeline still carry the places, so nothing is lost but the picture.
  if (!url || failedUrl === url) return null

  return (
    <img
      src={url}
      alt={alt}
      width={WIDTH}
      height={HEIGHT}
      loading="lazy"
      onError={() => setFailedUrl(url)}
      className={cn(
        "aspect-[3/2] w-full rounded-[var(--radius)] border border-border bg-muted object-cover",
        className
      )}
    />
  )
}

export function RouteMap({
  legs,
  className,
}: {
  legs: FlightSegment[]
  className?: string
}) {
  const dark = useIsDark()
  if (legs.length === 0) return null

  return (
    <MapImage
      url={fitRouteUrl(legs, dark)}
      alt={`Flight route, ${routeStops(legs).join(" to ")}`}
      className={className}
    />
  )
}

/**
 * The hotel, for a traveller with no flight. One stay only: the seed books
 * everyone into the same property, and two pins at this zoom would either
 * overlap or force the frame out to a scale where neither is readable.
 */
export function StayMap({
  stay,
  className,
}: {
  stay: HotelSegment
  className?: string
}) {
  const dark = useIsDark()
  const point = property(stay.propertyName)
  if (!point) return null

  return (
    <MapImage
      url={stayUrl(point, dark)}
      alt={`Map of ${stay.propertyName}`}
      className={className}
    />
  )
}
