/**
 * Screen 2 — one traveller's trip.
 *
 * A ROUTE, not the drawer the plan called for. PLAN-dashboard.md:318 says the
 * detail view must not be a route change, because the v2 voice dock puts the
 * dispatcher in the call room as a participant and navigating away drops them.
 * That constraint is real and this page knowingly spends it — recorded here
 * rather than in a commit message so whoever picks up the voice work finds it
 * at the point of impact. If voice returns, this becomes a sheet.
 *
 * The map sits right of the timeline at desktop and above it on narrow screens.
 * Above, not below: on a phone the picture orients you in one glance and the
 * timeline is the thing you then scroll through, so making the reader scroll
 * past the detail to reach the overview gets the order backwards.
 *
 * No Approve button. The roster owns that control, it moves money, and it has
 * an idempotency key behind it (api.ts:99). A second path to the same action is
 * a second path to double-ticketing, and the layout for comparing priced
 * options is deferred design work (TODOS.md:91) rather than something to
 * improvise beneath an itinerary.
 */
import { ArrowLeft } from "lucide-react"
import { useEffect, useState } from "react"

import { RouteMap, StayMap } from "@/components/employee/trip-map"
import { TripTimeline } from "@/components/employee/trip-timeline"
import { StatusPill } from "@/components/roster/status-pill"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { fetchEmployeeDetail } from "@/lib/api"
import {
  flightLegs,
  hotelStays,
  type EmployeeDetail,
} from "@/lib/employee-types"
import { property } from "@/lib/geo"
import { formatMoney } from "@/lib/format"
import { Skeleton } from "@/components/ui/skeleton"

type Phase = "loading" | "ready" | "missing" | "error"

export function EmployeePage({ employeeId }: { employeeId: string }) {
  const [detail, setDetail] = useState<EmployeeDetail | null>(null)
  const [phase, setPhase] = useState<Phase>("loading")

  useEffect(() => {
    // No reset to "loading" here: App.tsx keys this page by employeeId, so a
    // link from one traveller to another remounts and the initial state is
    // already loading/null.
    const controller = new AbortController()

    fetchEmployeeDetail(employeeId, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return
        if (!d) {
          setPhase("missing")
          return
        }
        setDetail(d)
        setPhase("ready")
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === "AbortError") return
        setPhase("error")
      })

    return () => controller.abort()
  }, [employeeId])

  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-24 sm:px-6">
      <a
        href="/"
        className="-ml-1 inline-flex h-11 items-center gap-1.5 rounded-md px-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <ArrowLeft className="size-4" />
        Employees
      </a>

      {phase === "loading" && <DetailSkeleton />}

      {phase === "missing" && (
        <Empty
          title="No such traveller."
          body={`Nobody with id ${employeeId} is on this event. The link may be stale, or the roster may have moved on.`}
        />
      )}

      {phase === "error" && (
        <Empty
          title="Can’t reach dispatch."
          body="This traveller’s itinerary has not loaded, so nothing here is known — this is not an all-clear."
        />
      )}

      {phase === "ready" && detail && <Detail detail={detail} />}
    </div>
  )
}

function Detail({ detail }: { detail: EmployeeDetail }) {
  const { card } = detail
  const legs = flightLegs(detail)
  // A flyer gets the arc. Someone already in Korea gets the hotel, which is the
  // only place their itinerary names — and is the majority case on this roster.
  // Gated on the coordinates resolving, not merely on a stay existing: an aside
  // holding a caption and no picture is worse than no aside.
  const stay =
    legs.length === 0
      ? (hotelStays(detail).find((s) => property(s.propertyName)) ?? null)
      : null

  return (
    <>
      <header className="mt-2 border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={card.name} seed={card.employeeId} size={44} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 className="font-heading text-xl font-bold tracking-[-0.01em]">
                {card.name}
              </h1>
              <StatusPill status={card.status} />
            </div>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {card.homeBase ?? "Home base unknown"} ·{" "}
              <span className="font-mono">{card.employeeId}</span>
            </p>
          </div>
        </div>

        {/* Rendered as-is. Rebuilding it here would fork the sentence the agent
            speaks on the phone from the one the coordinator reads. */}
        {card.advisory && (
          <p className="mt-4 max-w-[66ch] text-[15px] leading-relaxed text-foreground/80">
            {card.advisory}
          </p>
        )}

        <MetaRow detail={detail} />
      </header>

      <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        {/* order-first on mobile, last at desktop: one element, both layouts,
            no duplicate markup to keep in sync. */}
        {(legs.length > 0 || stay) && (
          <aside className="order-first lg:sticky lg:top-6 lg:order-last lg:w-[380px] lg:shrink-0">
            {legs.length > 0 ? (
              <RouteMap legs={legs} />
            ) : (
              stay && <StayMap stay={stay} />
            )}
            <p className="mt-2 text-[13px] text-muted-foreground">
              {legs.length > 0
                ? legs.map((l) => `${l.origin} → ${l.dest}`).join(" · ")
                : stay?.propertyName}
            </p>
          </aside>
        )}

        <section aria-label="Trip" className="min-w-0 flex-1">
          <TripTimeline detail={detail} />
        </section>
      </div>

      {detail.offers.length > 0 && <Offers detail={detail} />}
    </>
  )
}

function MetaRow({ detail }: { detail: EmployeeDetail }) {
  const { card } = detail
  const bits: React.ReactNode[] = []

  if (card.policyVerdict) {
    bits.push(
      <span key="policy">
        <span className="font-mono">Policy</span> pol-flight v1 ·{" "}
        {card.policyVerdict}
      </span>
    )
  }
  if (card.totalDelta && card.totalDelta !== "0.00") {
    bits.push(
      <span key="delta" className="font-mono">
        {formatMoney(card.totalDelta, card.currency)}
      </span>
    )
  }
  if (card.impactId) {
    bits.push(
      <span key="impact">
        Impact <span className="font-mono">{card.impactId}</span>
      </span>
    )
  }

  if (bits.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground">
      {bits}
    </div>
  )
}

/**
 * Read-only. Comparing a $120 in-policy option against a $200 one that arrives
 * sooner is the actual decision (TODOS.md:93) and it deserves its own design
 * pass — this lists what was priced without pretending to be that screen.
 */
function Offers({ detail }: { detail: EmployeeDetail }) {
  return (
    <section aria-label="Priced options" className="mt-8">
      <h2 className="font-heading text-[15px] font-semibold">
        {detail.offers.length} option{detail.offers.length === 1 ? "" : "s"}{" "}
        priced
      </h2>
      <ul className="mt-3 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-border">
        {detail.offers.map((offer) => (
          <li
            key={offer.id}
            className="flex flex-wrap gap-x-4 gap-y-1.5 bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">
                {offer.routeSummary ?? "Option"}
              </p>
              {offer.policyReason && (
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {offer.policyReason}
                </p>
              )}
            </div>
            <div className="text-right">
              {offer.totalDelta && (
                <p className="font-mono text-[14px]">
                  {formatMoney(offer.totalDelta, offer.currency)}
                </p>
              )}
              {offer.policyVerdict && (
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {offer.policyVerdict}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[13px] text-muted-foreground">
        Approval stays on the roster — this page does not move money.
      </p>
    </section>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-6 rounded-[var(--radius)] border border-border px-5 py-12 text-center">
      <p className="font-heading text-[17px] font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-[52ch] text-[14px] text-muted-foreground">
        {body}
      </p>
      <Button variant="outline" className="mt-5 h-11" render={<a href="/" />}>
        Back to employees
      </Button>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="mt-2 animate-pulse">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </div>
      <Skeleton className="mt-6 h-4 w-full max-w-[52ch]" />
      <div className="mt-8 flex flex-col gap-6 lg:flex-row">
        <Skeleton className="order-first aspect-[3/2] w-full rounded-[var(--radius)] lg:order-last lg:w-[380px]" />
        <div className="flex-1 space-y-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-44" />
                <Skeleton className="h-4 w-56" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
