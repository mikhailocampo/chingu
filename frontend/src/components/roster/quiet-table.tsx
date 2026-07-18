/**
 * The on-track band. A table, not cards.
 *
 * Twenty people who are fine must not occupy twenty card-sized boxes. Cards
 * have to earn their existence and "is fine" does not earn one — but these
 * people still have to be *visible*, because a roster that hides the healthy
 * majority is not a roster. Hence: present, countable, clickable, and quiet.
 *
 * Internally square by intent — the container rounds, the rows do not. Uniform
 * radius on every element is the tell of a generated interface.
 *
 * Responsive: home base is dropped at 375. Name and status survive at every
 * width, because those are the two things that make the row worth showing.
 */
import { useState } from "react"

import { cn } from "@/lib/utils"
import type { RosterCard } from "@/lib/roster-types"

const COLLAPSED = 5

export function QuietTable({
  cards,
  onOpen,
  dimmed = false,
}: {
  cards: RosterCard[]
  onOpen: (card: RosterCard) => void
  dimmed?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = Math.max(0, cards.length - COLLAPSED)
  const shown = expanded ? cards : cards.slice(0, COLLAPSED)

  if (cards.length === 0) return null

  return (
    <div
      className={cn(
        "border-border overflow-hidden rounded-[var(--radius)] border",
        dimmed && "opacity-55"
      )}
    >
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Travellers on track — {cards.length} people, no action needed
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Home base</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr
              key={c.employeeId}
              onClick={() => onOpen(c)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onOpen(c)
                }
              }}
              className="border-border hover:bg-muted focus-visible:bg-muted cursor-pointer border-b outline-none last:border-b-0"
            >
              <td className="px-3.5 py-2.5 text-[14px] sm:px-4">{c.name}</td>
              {/* Dropped at 375: at that width the name and the fact that
                  nothing is wrong is the entire useful payload. */}
              <td className="text-muted-foreground hidden px-4 py-2.5 text-[13px] sm:table-cell">
                {c.homeBase ?? "—"}
              </td>
              <td className="text-status-ok px-3.5 py-2.5 text-right text-[11px] tracking-[0.07em] uppercase sm:px-4">
                OK
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="bg-muted text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 min-h-11 w-full px-4 py-2.5 text-center text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-inset"
        >
          {expanded ? "Show fewer" : `Show ${hiddenCount} more on track`}
        </button>
      )}
    </div>
  )
}
