/**
 * Five stats, and every one of them is a filter. A stat that cannot be clicked
 * to change what is on screen is decoration, and decoration is what turns a
 * summary strip into a dashboard-card mosaic.
 *
 * aria-live="polite" on the group: without it the roster mutates silently for
 * a screen-reader user every 5 seconds.
 *
 * Responsive intent — different information per width, not a stack:
 *   1440  5 across
 *    768  3 across
 *    375  2 across, exposure dropped (it is the one stat that informs rather
 *         than triages, so it is the one that goes)
 */
import { cn } from "@/lib/utils"
import { formatMoneyCompact } from "@/lib/format"
import type { RosterCounts } from "@/lib/roster-types"

export type RosterFilter = "all" | "needs_you" | "at_risk" | "calling" | "exposure"

const DASH = "—"

export function SummaryStrip({
  counts,
  exposure,
  active,
  onSelect,
  loading = false,
}: {
  counts: RosterCounts | null
  exposure: { amount: string; currency: string } | null
  active: RosterFilter
  onSelect: (f: RosterFilter) => void
  loading?: boolean
}) {
  // While loading, counts render as an em dash — never as 0. "0 need you" is a
  // factual claim the screen is not yet entitled to make.
  const n = (v: number | undefined) => (loading || v === undefined ? DASH : String(v))

  return (
    <div
      aria-live="polite"
      aria-label="Roster summary"
      className="bg-border border-border my-5 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius)] border sm:grid-cols-3 lg:grid-cols-5"
    >
      <Stat
        label="Travelling"
        value={n(counts?.travelling)}
        filter="all"
        active={active}
        onSelect={onSelect}
      />
      <Stat
        label="Need you"
        value={n(counts?.needs_you)}
        filter="needs_you"
        active={active}
        onSelect={onSelect}
        // Red only when there is actually something. A tinted "0 need you" is a
        // false alarm on the screen she looks at 95% of the time, and a screen
        // that cries wolf while calm stops meaning anything when it is not.
        attention={(counts?.needs_you ?? 0) > 0}
      />
      <Stat
        label="At risk"
        value={n(counts?.at_risk)}
        filter="at_risk"
        active={active}
        onSelect={onSelect}
      />
      <Stat
        label="On a call"
        value={n(counts ? counts.calling + counts.booking : undefined)}
        filter="calling"
        active={active}
        onSelect={onSelect}
      />
      <Stat
        label="Exposure"
        value={loading || !exposure ? DASH : formatMoneyCompact(exposure.amount, exposure.currency)}
        filter="exposure"
        active={active}
        onSelect={onSelect}
        // Dropped at 375. Everything else on this strip triages; this one only
        // informs, so it is the one that loses the argument for space.
        className="hidden sm:block"
        mono
      />
    </div>
  )
}

function Stat({
  label,
  value,
  filter,
  active,
  onSelect,
  attention = false,
  mono = false,
  className,
}: {
  label: string
  value: string
  filter: RosterFilter
  active: RosterFilter
  onSelect: (f: RosterFilter) => void
  attention?: boolean
  mono?: boolean
  className?: string
}) {
  const isActive = active === filter
  return (
    <button
      type="button"
      aria-pressed={isActive}
      // Toggling off returns to "all" so a filter is never a trap.
      onClick={() => onSelect(isActive && filter !== "all" ? "all" : filter)}
      className={cn(
        "bg-card hover:bg-muted focus-visible:ring-ring/40 min-h-11 cursor-pointer px-4 py-3 text-left transition-colors outline-none focus-visible:ring-3",
        attention && "bg-status-needs/[0.06] hover:bg-status-needs/[0.1]",
        isActive && "outline-primary -outline-offset-2 outline-2",
        className
      )}
    >
      <div
        className={cn(
          "font-heading text-[26px] leading-[1.1] font-bold tracking-[-0.02em]",
          attention && "text-status-needs",
          mono && "font-mono text-[22px]"
        )}
      >
        {value}
      </div>
      <div className="text-muted-foreground mt-0.5 text-xs tracking-[0.06em] uppercase">
        {label}
      </div>
    </button>
  )
}
