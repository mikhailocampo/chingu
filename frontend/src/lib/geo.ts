/**
 * Airport and property coordinates, plus great-circle geometry for the map.
 *
 * WHY A LOCAL TABLE
 * -----------------
 * `segment` stores IATA codes and property names and nothing else — there is no
 * lat/lon anywhere in the schema, and no service in the repo resolves one. The
 * seed references exactly three airports and one hotel, so a local table is the
 * whole solution: no extra API call, no key, no network dependency on a screen
 * that already reaches out for a map tile. An unknown code resolves to null and
 * the map is simply not rendered — a missing map is honest, a pin in the wrong
 * ocean is not.
 *
 * WHY GREAT CIRCLES
 * -----------------
 * JFK–ICN drawn as a straight line on a Mercator projection crosses the
 * Pacific. The aircraft flies over the Arctic. Anyone who has taken that route
 * can see the difference at a glance, and a map that draws the wrong path is
 * worse than no map on a screen whose claim is that it knows where people are.
 */

/** [lon, lat]. GeoJSON order, not the lat/lon order humans say out loud. */
export type LonLat = [number, number]

/**
 * Everything the seed references, plus the hub that appears in offer prose
 * (fixtures.ts:126 — CX841 JFK–HKG then CX416 HKG–ICN) and the two Korean
 * airports a domestic leg would use if one is ever seeded.
 */
const AIRPORTS: Record<string, LonLat> = {
  JFK: [-73.7781, 40.6413],
  EWR: [-74.1687, 40.6895],
  SFO: [-122.379, 37.6213],
  ICN: [126.4407, 37.4602],
  GMP: [126.7906, 37.5583],
  PUS: [128.9382, 35.1795],
  HKG: [113.9185, 22.308],
}

export function airport(iata: string): LonLat | null {
  return AIRPORTS[iata.toUpperCase()] ?? null
}

/**
 * Hotels, keyed by the `property_name` the worker sends.
 *
 * Matching on a display string is not how this should work long-term — a rename
 * upstream silently drops the pin. It is what the schema allows today: the
 * `property_id` on `segment` is a Sabre identifier this app cannot resolve
 * without a content API call, and the name is the only field with any meaning
 * on this side of the wire. Whichever key it is, an unknown one returns null
 * and no map is drawn, so drift costs a picture and never a wrong location.
 */
const PROPERTIES: Record<string, LonLat> = {
  // Marine City, Haeundae-gu.
  "park hyatt busan": [129.1424, 35.1553],
}

export function property(name: string | null): LonLat | null {
  if (!name) return null
  return PROPERTIES[name.trim().toLowerCase()] ?? null
}

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** 3dp is ~110m at the equator — far past what a world-scale map resolves. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Points along the great circle from `from` to `to`, inclusive of both ends.
 *
 * Spherical linear interpolation. `steps` trades URL length against smoothness:
 * the static map API caps the URL at 8192 characters and every point costs
 * roughly 20 of them, so this stays deliberately modest.
 */
export function greatCircle(from: LonLat, to: LonLat, steps = 48): LonLat[] {
  const lon1 = from[0] * RAD
  const lat1 = from[1] * RAD
  const lon2 = to[0] * RAD
  const lat2 = to[1] * RAD

  const h =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h)))

  // Coincident points, or so close that sin(d) underflows. There is no arc to
  // draw and dividing by sin(d) would produce NaN coordinates.
  if (d < 1e-9) return [from, to]

  const out: LonLat[] = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const a = Math.sin((1 - f) * d) / Math.sin(d)
    const b = Math.sin(f * d) / Math.sin(d)
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2)
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2)
    const z = a * Math.sin(lat1) + b * Math.sin(lat2)
    out.push([round(Math.atan2(y, x) * DEG), round(Math.atan2(z, Math.hypot(x, y)) * DEG)])
  }
  return out
}

/**
 * Cut a path wherever it crosses the antimeridian.
 *
 * JFK–ICN does cross it. Left as one LineString, the renderer sees longitude
 * jump from +179 to -179 and draws a line straight back across the entire map
 * — a horizontal scar through the middle of the picture. Splitting into parts
 * that stop at ±180 and resume at ∓180 is what makes the arc look continuous.
 */
export function splitAtAntimeridian(points: LonLat[]): LonLat[][] {
  if (points.length < 2) return [points]

  const parts: LonLat[][] = []
  let current: LonLat[] = [points[0]]

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const point = points[i]

    if (Math.abs(point[0] - prev[0]) > 180) {
      // Which edge we ran off. Going +179 -> -179 exits east through +180.
      const edge = prev[0] > 0 ? 180 : -180
      // Unwrap the far point onto the same continuous scale as `prev` so the
      // crossing fraction is a plain linear solve rather than a wrap puzzle.
      const unwrapped = prev[0] > 0 ? point[0] + 360 : point[0] - 360
      const t = (edge - prev[0]) / (unwrapped - prev[0])
      // Linear in latitude: across one step of the arc the error is invisible.
      const lat = round(prev[1] + t * (point[1] - prev[1]))

      current.push([edge, lat])
      parts.push(current)
      current = [[-edge, lat]]
    }

    current.push(point)
  }

  parts.push(current)
  return parts
}

/**
 * The full drawable path for a sequence of legs, already split for the
 * antimeridian. Returns null if any airport is unknown — a partial route is a
 * lie about where someone is going.
 */
export function routePath(
  legs: { origin: string; dest: string }[],
  steps = 48
): LonLat[][] | null {
  if (legs.length === 0) return null

  const parts: LonLat[][] = []
  for (const leg of legs) {
    const from = airport(leg.origin)
    const to = airport(leg.dest)
    if (!from || !to) return null
    parts.push(...splitAtAntimeridian(greatCircle(from, to, steps)))
  }
  return parts
}

/** Every distinct airport across the legs, in the order first encountered. */
export function routeStops(legs: { origin: string; dest: string }[]): string[] {
  const seen: string[] = []
  for (const leg of legs) {
    for (const code of [leg.origin, leg.dest]) {
      if (!seen.includes(code)) seen.push(code)
    }
  }
  return seen
}
