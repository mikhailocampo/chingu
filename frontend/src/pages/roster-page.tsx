/**
 * Screen 1 — Employees.
 *
 * The calm state is what she sees 95% of the time, and it is the state this
 * page is really designed for. Twenty-six people, nothing broken. It still has
 * to read as *watching*: the sync clock keeps counting, and the two people who
 * are structurally at risk with no disruption in play — Grace lands past the
 * cut-off, Nora has no booking at all — surface on their own. A grey page
 * saying "All 26 on track" would be a failure, because the product's entire
 * claim is that something is paying attention.
 */
import { useMemo, useState } from "react"

import { BandHeader } from "@/components/roster/band-header"
import { DetailDrawer } from "@/components/roster/detail-drawer"
import { MicDock } from "@/components/mic-dock"
import { QuietTable } from "@/components/roster/quiet-table"
import { RosterCardItem } from "@/components/roster/roster-card"
import { RosterSkeleton } from "@/components/roster/skeletons"
import { SummaryStrip, type RosterFilter } from "@/components/roster/summary-strip"
import { Button } from "@/components/ui/button"
import { useRoster, useTicker } from "@/hooks/use-roster"
import { approve as approveApi } from "@/lib/api"
import { clockTime, relativeTime } from "@/lib/format"
import { BAND_LABEL, BAND_ORDER, type Band, type RosterCard } from "@/lib/roster-types"
import { cn } from "@/lib/utils"

export function RosterPage() {
  const { data, phase, lastGoodAt, refresh } = useRoster()
  const now = useTicker()

  const [filter, setFilter] = useState<RosterFilter>("all")
  const [detail, setDetail] = useState<RosterCard | null>(null)
  const [approving, setApproving] = useState<string | null>(null)

  const visible = useMemo(() => applyFilter(data?.cards ?? [], filter), [data, filter])

  const byBand = useMemo(() => {
    const m = new Map<Band, RosterCard[]>()
    for (const b of BAND_ORDER) m.set(b, [])
    for (const c of visible) m.get(c.band)?.push(c)
    return m
  }, [visible])

  async function handleApprove(card: RosterCard) {
    if (!card.approvalId || approving) return
    setApproving(card.employeeId)
    try {
      await approveApi(card.approvalId)
      refresh()
    } finally {
      setApproving(null)
    }
  }

  // Stale means the last fetch failed but a good payload is still on screen.
  // It gets dimmed, never removed: a blank crisis dashboard and "everyone is
  // fine" are indistinguishable to someone glancing at it.
  const dimmed = phase === "stale"

  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-6 pb-32 sm:px-6">
      <header className="border-border flex flex-wrap items-baseline justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="font-heading text-xl font-bold tracking-[-0.01em]">Employees</h1>
          <p className="text-muted-foreground mt-0.5 text-[13px]">
            Samsung Global Offsite · Busan ·{" "}
            <b className="text-foreground font-medium">15–18 Sep 2026</b>
          </p>
        </div>
        <div className="text-muted-foreground flex items-center gap-3 text-[13px]">
          <span aria-live="polite">
            {lastGoodAt ? (
              <>
                Synced <span className="font-mono">{relativeTime(lastGoodAt, now)}</span> ago
              </>
            ) : (
              "Connecting…"
            )}
          </span>
          <a
            href="/admin"
            className="hover:text-foreground underline underline-offset-4"
          >
            Admin
          </a>
        </div>
      </header>

      {phase === "stale" && (
        <div
          role="status"
          className="border-status-risk/40 bg-status-risk/[0.07] mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border px-4 py-3 text-[14px]"
        >
          <span>
            Can’t reach dispatch. Showing data from{" "}
            <span className="font-mono">{lastGoodAt ? clockTime(lastGoodAt) : "—"}</span>.
          </span>
          <Button variant="outline" className="h-11" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      <SummaryStrip
        counts={data?.counts ?? null}
        exposure={data?.exposure ?? null}
        active={filter}
        onSelect={setFilter}
        loading={phase === "loading" || phase === "error"}
      />

      {phase === "loading" && <RosterSkeleton />}

      {phase === "error" && (
        <div className="border-border mt-2 rounded-[var(--radius)] border px-5 py-10 text-center">
          <p className="font-heading text-[17px] font-semibold">Can’t reach dispatch.</p>
          <p className="text-muted-foreground mx-auto mt-2 max-w-[52ch] text-[14px]">
            The roster has not loaded yet, so nothing here is known — this is not
            an all-clear. Retrying every 5 seconds.
          </p>
          <Button variant="outline" className="mt-5 h-11" onClick={refresh}>
            Retry now
          </Button>
        </div>
      )}

      {data && (
        <>
          {BAND_ORDER.map((band) => {
            const cards = byBand.get(band) ?? []
            if (cards.length === 0) return null

            return (
              <section key={band} aria-label={BAND_LABEL[band]}>
                <BandHeader label={BAND_LABEL[band]} count={cards.length} />
                {band === "ON_TRACK" ? (
                  // Twenty people who are fine are a table. Cards have to earn
                  // their existence and "is fine" does not earn one.
                  <QuietTable cards={cards} onOpen={setDetail} dimmed={dimmed} />
                ) : (
                  cards.map((c) => (
                    <RosterCardItem
                      key={c.employeeId}
                      card={c}
                      onOpen={setDetail}
                      onApprove={handleApprove}
                      approving={approving === c.employeeId}
                      dimmed={dimmed}
                    />
                  ))
                )}
              </section>
            )
          })}

          {visible.length === 0 && (
            <div
              className={cn(
                "border-border mt-6 rounded-[var(--radius)] border px-5 py-10 text-center",
                dimmed && "opacity-55"
              )}
            >
              <p className="font-heading text-[17px] font-semibold">
                Nothing matches that filter.
              </p>
              <p className="text-muted-foreground mt-2 text-[14px]">
                {data.counts.travelling} travellers are still being watched.
              </p>
              <Button variant="outline" className="mt-5 h-11" onClick={() => setFilter("all")}>
                Show everyone
              </Button>
            </div>
          )}
        </>
      )}

      <DetailDrawer card={detail} onOpenChange={(o) => !o && setDetail(null)} />

      <MicDock
        cards={data?.cards ?? []}
        onApprove={handleApprove}
        onVenue={() => {
          // Scenario 2 dispatches CALL_VENUE. Not wired in this track.
          window.alert("Venue rebooking dispatched. (Not wired in v1.)")
        }}
      />
    </div>
  )
}

function applyFilter(cards: RosterCard[], filter: RosterFilter): RosterCard[] {
  switch (filter) {
    case "all":
      return cards
    case "needs_you":
      return cards.filter((c) => c.status === "NEEDS_YOU")
    case "at_risk":
      return cards.filter((c) => c.status === "AT_RISK")
    case "calling":
      return cards.filter((c) => c.status === "CALLING" || c.status === "BOOKING")
    case "exposure":
      // Everyone contributing money to the exposure figure. Clicking a number
      // should show you what makes it up.
      return cards.filter((c) => c.totalDelta !== null && c.totalDelta !== "0.00")
  }
}
