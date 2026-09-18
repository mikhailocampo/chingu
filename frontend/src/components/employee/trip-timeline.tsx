/**
 * One traveller's trip, in order.
 *
 * NOT A FLIGHT LIST. Sixteen of the twenty-six travellers are already in Korea
 * and have never had a flight (fixtures.ts:16) — for them the trip is a hotel
 * and a dinner, and a screen titled "Itinerary" that renders empty for the
 * majority of the roster would read as broken rather than as accurate. A hotel
 * and a dinner is a real itinerary; it just is not an air itinerary.
 *
 * TIMES render in the VIEWER's zone, labelled. Activities additionally show
 * their venue-local time, because a dinner happens where it happens and "19:30
 * in Busan" is the fact a coordinator actually holds in their head.
 *
 * The hotel is ONE row anchored at check-in, not a check-in row and a check-out
 * row. Splitting it interleaves the dinner between two halves of the same
 * booking, which reads as two separate stays.
 */
import { BedDouble, Plane, UtensilsCrossed } from "lucide-react"

import type { ActivityItem, EmployeeDetail, HotelSegment } from "@/lib/employee-types"
import { isCodeshare } from "@/lib/employee-types"
import type { FlightSegment } from "@/lib/employee-types"
import { VIEWER_TZ, dayOffset, tzDate, tzLabel, tzTime } from "@/lib/format"

type Entry =
  | { sortAt: string; kind: "FLIGHT"; segment: FlightSegment; pnr: string; ticket: string | null }
  | { sortAt: string; kind: "HOTEL"; segment: HotelSegment; pnr: string }
  | { sortAt: string; kind: "ACTIVITY"; activity: ActivityItem }

function entries(detail: EmployeeDetail): Entry[] {
  const out: Entry[] = []

  for (const itinerary of detail.itineraries) {
    for (const segment of itinerary.segments) {
      if (segment.type === "FLIGHT") {
        out.push({
          sortAt: segment.depAt,
          kind: "FLIGHT",
          segment,
          pnr: itinerary.pnr,
          ticket: itinerary.ticketNumber,
        })
      } else {
        out.push({
          // Midday is an ORDERING HINT, not a claim about check-in time — the
          // schema stores a date with no time. It places the room after a
          // morning arrival and before an evening one, which is the only
          // same-day ordering question that comes up.
          sortAt: `${segment.checkIn}T12:00:00Z`,
          kind: "HOTEL",
          segment,
          pnr: itinerary.pnr,
        })
      }
    }
  }

  for (const activity of detail.activities) {
    out.push({ sortAt: activity.startsAt, kind: "ACTIVITY", activity })
  }

  return out.sort((a, b) => a.sortAt.localeCompare(b.sortAt))
}

export function TripTimeline({ detail }: { detail: EmployeeDetail }) {
  const rows = entries(detail)

  if (rows.length === 0) {
    return (
      <div className="border-border rounded-[var(--radius)] border border-dashed px-5 py-10 text-center">
        <p className="font-heading text-[16px] font-semibold">No booking at all.</p>
        <p className="text-muted-foreground mx-auto mt-2 max-w-[46ch] text-[14px]">
          No flight, no room, nothing to show. This is not a loading state — there
          is genuinely nothing booked for this traveller.
        </p>
      </div>
    )
  }

  return (
    <ol className="relative">
      {rows.map((row, i) => (
        <li key={key(row)} className="relative flex gap-3.5 pb-5 last:pb-0 sm:gap-4">
          {/* The rail. Drawn per-row rather than as one absolute line so the
              last row stops at its own icon instead of trailing into space. */}
          {i < rows.length - 1 && (
            <span
              aria-hidden
              className="bg-border absolute top-9 left-[15px] h-[calc(100%-1.75rem)] w-px sm:left-[17px]"
            />
          )}
          <Marker kind={row.kind} />
          <div className="min-w-0 flex-1 pt-0.5">
            {row.kind === "FLIGHT" && <FlightRow row={row} />}
            {row.kind === "HOTEL" && <HotelRow row={row} />}
            {row.kind === "ACTIVITY" && <ActivityRow row={row} />}
          </div>
        </li>
      ))}
    </ol>
  )
}

function key(row: Entry): string {
  if (row.kind === "ACTIVITY") return row.activity.id
  return row.segment.id
}

function Marker({ kind }: { kind: Entry["kind"] }) {
  const Icon = kind === "FLIGHT" ? Plane : kind === "HOTEL" ? BedDouble : UtensilsCrossed
  return (
    <span
      aria-hidden
      className="border-border bg-card text-muted-foreground relative z-[1] grid size-8 shrink-0 place-items-center rounded-full border sm:size-9"
    >
      <Icon className="size-4" />
    </span>
  )
}

/** 13px is the metadata floor. Body text does not shrink to it. */
function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-[13px]">
      {children}
    </p>
  )
}

function Headline({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-[13px]">{children}</p>
}

function FlightRow({ row: { segment, pnr, ticket } }: { row: Extract<Entry, { kind: "FLIGHT" }> }) {
  const plus = dayOffset(segment.depAt, segment.arrAt, VIEWER_TZ)

  return (
    <>
      <Headline>
        {tzDate(segment.depAt, VIEWER_TZ)} ·{" "}
        <span className="font-mono">{tzTime(segment.depAt, VIEWER_TZ)}</span>
        {" → "}
        <span className="font-mono">{tzTime(segment.arrAt, VIEWER_TZ)}</span>
        {plus > 0 && <span className="font-mono">+{plus}</span>} {tzLabel(segment.arrAt, VIEWER_TZ)}
      </Headline>

      <p className="mt-0.5 text-[15px] font-medium">
        <span className="font-mono">
          {segment.carrier}
          {segment.flightNo}
        </span>{" "}
        <span className="text-muted-foreground mx-0.5 font-normal">·</span> {segment.origin} →{" "}
        {segment.dest}
      </p>

      <Meta>
        {/* The codeshare, said out loud. KE82 and DL7842 are the same aircraft,
            and a traveller on the marketing number is invisible to any triage
            that matches on carrier alone — finding that person is the product's
            whole thesis, so this is the one place it must not be a footnote. */}
        {isCodeshare(segment) && (
          <span className="text-foreground bg-muted rounded px-1.5 py-0.5 font-medium">
            Operated by {segment.operatingCarrier}
            {segment.operatingFlightNo}
          </span>
        )}
        <span>
          PNR <span className="font-mono">{pnr}</span>
        </span>
        {ticket && (
          <span>
            Ticket <span className="font-mono">{ticket}</span>
          </span>
        )}
        {segment.status && <span>{titleCase(segment.status)}</span>}
      </Meta>
    </>
  )
}

function HotelRow({ row: { segment, pnr } }: { row: Extract<Entry, { kind: "HOTEL" }> }) {
  return (
    <>
      <Headline>
        {tzDate(segment.checkIn, "UTC")} → {tzDate(segment.checkOut, "UTC")}
      </Headline>

      <p className="mt-0.5 text-[15px] font-medium">
        {segment.propertyName ?? "Hotel booking"}
      </p>

      <Meta>
        <span>
          PNR <span className="font-mono">{pnr}</span>
        </span>
        {segment.freeCancelUntil && (
          <span>Free cancellation until {tzDate(segment.freeCancelUntil, VIEWER_TZ)}</span>
        )}
        {segment.propertyPhone && <span className="font-mono">{segment.propertyPhone}</span>}
      </Meta>
    </>
  )
}

function ActivityRow({ row: { activity } }: { row: Extract<Entry, { kind: "ACTIVITY" }> }) {
  const venueZone = activity.timezone || "UTC"
  // Only worth printing twice when the two zones actually differ. For a
  // coordinator sitting in Busan the second copy would be noise.
  const showVenueTime = venueZone !== VIEWER_TZ

  return (
    <>
      <Headline>
        {tzDate(activity.startsAt, VIEWER_TZ)} ·{" "}
        <span className="font-mono">{tzTime(activity.startsAt, VIEWER_TZ)}</span>{" "}
        {tzLabel(activity.startsAt, VIEWER_TZ)}
      </Headline>

      <p className="mt-0.5 text-[15px] font-medium">{activity.venue}</p>

      <Meta>
        {/* "at the venue", not an abbreviation: Intl renders Asia/Seoul as
            "GMT+9" in English, which is both ugly and less informative than
            saying plainly where that clock is hanging. */}
        {showVenueTime && (
          <span>
            <span className="font-mono">{tzTime(activity.startsAt, venueZone)}</span> at the venue
          </span>
        )}
        {activity.address && <span>{activity.address}</span>}
        {activity.phone && <span className="font-mono">{activity.phone}</span>}
      </Meta>
    </>
  )
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase()
}
