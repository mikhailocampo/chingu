/**
 * One traveller, in priority order:
 *   1. Name + status pill + home base
 *   2. The advisory sentence — THIS IS THE PRODUCT. Capped at 66ch so it reads
 *      as prose rather than spanning a 1440px viewport.
 *   3. Meta row (13px floor)
 *   4. Actions, right-aligned, with the chevron into detail
 *
 * The advisory arrives pre-composed from the worker and is rendered as-is.
 * Rebuilding it client-side would fork the sentence the agent speaks on the
 * phone from the one the coordinator reads, and those must not drift.
 */
import { ChevronRight } from "lucide-react"
import { useState } from "react"

import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/roster/status-pill"
import { formatMoney } from "@/lib/format"
import type { RosterCard as Card } from "@/lib/roster-types"
import { cn } from "@/lib/utils"

/**
 * A RESOLVED card comes back with advisory === null: the roster query excludes
 * resolved impacts, so there is no offer left to describe. This is a static
 * fallback for that hole, not a client-side reconstruction of an advisory.
 */
const FALLBACK: Partial<Record<Card["status"], string>> = {
  RESOLVED: "Rebooked and confirmed. The agent handled this within policy.",
  GREEN: "On track. Nothing outstanding.",
}

export function RosterCardItem({
  card,
  onOpen,
  onApprove,
  approving = false,
  dimmed = false,
}: {
  card: Card
  onOpen: (card: Card) => void
  onApprove: (card: Card) => void
  approving?: boolean
  dimmed?: boolean
}) {
  const [hover, setHover] = useState(false)
  const advisory = card.advisory ?? FALLBACK[card.status] ?? null
  const live = card.status === "CALLING" || card.status === "BOOKING"

  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "bg-card border-border mb-2.5 rounded-[var(--radius)] border p-4 shadow-[0_1px_2px_oklch(0_0_0/4%)] transition-colors sm:px-[18px]",
        hover && "border-foreground/20",
        live && "border-status-calling/30",
        dimmed && "opacity-55"
      )}
    >
      {/* 1440/768: content left, actions right. 375: actions drop below. */}
      <div className="flex flex-col gap-3.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <Avatar name={card.name} seed={card.employeeId} size={28} />
            <h3 className="font-heading text-[17px] font-semibold">{card.name}</h3>
            <StatusPill status={card.status} />
            {card.homeBase && (
              <span className="text-muted-foreground text-[13px]">{card.homeBase}</span>
            )}
          </div>

          {advisory && (
            <p
              className={cn(
                "mt-2 max-w-[66ch] text-[15px] leading-relaxed",
                card.advisory ? "text-foreground/80" : "text-muted-foreground"
              )}
            >
              {advisory}
            </p>
          )}

          <MetaRow card={card} />
        </div>

        <Actions
          card={card}
          approving={approving}
          onOpen={onOpen}
          onApprove={onApprove}
        />
      </div>
    </article>
  )
}

/** 13px is the floor. Metadata may shrink to it; body text may not. */
function MetaRow({ card }: { card: Card }) {
  const bits: React.ReactNode[] = []

  if (card.policyVerdict) {
    bits.push(
      <span key="policy">
        <span className="font-mono">Policy</span> pol-flight v1 · {card.policyVerdict}
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
  if (card.offerCount > 0) {
    bits.push(
      <span key="offers">
        {card.offerCount} option{card.offerCount === 1 ? "" : "s"} priced
      </span>
    )
  }

  if (bits.length === 0) return null
  return (
    <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px]">
      {bits}
    </div>
  )
}

function Actions({
  card,
  approving,
  onOpen,
  onApprove,
}: {
  card: Card
  approving: boolean
  onOpen: (c: Card) => void
  onApprove: (c: Card) => void
}) {
  // Approve appears ONLY when the worker says the decision is unambiguous.
  // An open approval that is NOT one-click (Grace: no option is both in policy
  // and on time) routes to the drawer instead — a judgement call must not be
  // reachable by one tap.
  const canApprove = card.canApprove
  const needsReview = card.approvalId !== null && !canApprove
  const showReview = card.offerCount > 0 || needsReview

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 sm:flex-col sm:items-end sm:justify-start sm:gap-2.5">
      <div className="flex flex-1 gap-2 sm:flex-none">
        {showReview && (
          // 44px minimum touch target. The mockup's 31px button fails and grew.
          <Button
            variant="outline"
            onClick={() => onOpen(card)}
            className="h-11 min-w-11 flex-1 rounded-[calc(var(--radius)*0.8)] text-[13.5px] sm:flex-none"
          >
            {needsReview ? "Review" : `Review ${card.offerCount}`}
          </Button>
        )}
        {canApprove && (
          <Button
            onClick={() => onApprove(card)}
            disabled={approving}
            className="h-11 min-w-11 flex-1 rounded-[calc(var(--radius)*0.8)] text-[13.5px] sm:flex-none"
          >
            {approving ? "Approving…" : "Approve"}
          </Button>
        )}
        {!showReview && !canApprove && (
          <Button
            variant="ghost"
            onClick={() => onOpen(card)}
            className="text-muted-foreground h-11 min-w-11 flex-1 rounded-[calc(var(--radius)*0.8)] text-[13.5px] sm:flex-none"
          >
            Details
          </Button>
        )}
      </div>
      <button
        type="button"
        aria-label={`Open ${card.name}'s detail`}
        onClick={() => onOpen(card)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 grid size-11 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-3"
      >
        <ChevronRight className="size-5" />
      </button>
    </div>
  )
}
