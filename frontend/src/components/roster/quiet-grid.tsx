/**
 * The on-track band. A grid of faces, not cards and no longer a table.
 *
 * The constraint that produced the old table still holds: twenty people who
 * are fine must not occupy twenty card-sized boxes, and cards have to earn
 * their existence. A face, a name, and a city earn it at a fraction of the
 * height, and the grid reads as *a team* in a way stacked rows never did.
 *
 * Everyone renders up to CAP. The old five-row preview was a compression that
 * cost more than it saved: "Show 21 more on track" made the healthy majority
 * something you had to ask for, when the whole claim of the screen is that
 * every traveller is being watched. Seeing all 26 is the point.
 *
 * Internally square by intent — the container rounds, the cells do not.
 * Uniform radius on every element is the tell of a generated interface.
 *
 * Responsive: 3 up at desktop, 2 at tablet, 1 at 375. The city drops out of
 * nothing — at every width the name and face are the useful payload, and the
 * city is what makes two people with the same first name distinguishable.
 */
import { Avatar } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import type { RosterCard } from "@/lib/roster-types"

/**
 * A ceiling, not a preview. Past this many on-track travellers the grid stops
 * being scannable and the count in the band header is the honest summary, so
 * we say plainly how many are not shown rather than silently truncating.
 */
const CAP = 50

export function QuietGrid({
  cards,
  onOpen,
  dimmed = false,
}: {
  cards: RosterCard[]
  onOpen: (card: RosterCard) => void
  dimmed?: boolean
}) {
  if (cards.length === 0) return null

  const shown = cards.slice(0, CAP)
  const overflow = cards.length - shown.length

  return (
    <div className={cn(dimmed && "opacity-55")}>
      <ul
        aria-label={`Travellers on track — ${cards.length} people, no action needed`}
        className="border-border grid grid-cols-1 gap-px overflow-hidden rounded-[var(--radius)] border sm:grid-cols-2 md:grid-cols-3"
      >
        {shown.map((c) => (
          <li key={c.employeeId} className="bg-card">
            <button
              type="button"
              onClick={() => onOpen(c)}
              className="hover:bg-muted focus-visible:bg-muted focus-visible:ring-ring/40 flex w-full items-center gap-3 px-3.5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset sm:px-4"
            >
              <Avatar name={c.name} seed={c.employeeId} size={36} />
              <span className="min-w-0">
                {/* Truncated rather than wrapped: a two-line name would make
                    one cell taller than its neighbours and break the row. */}
                <span className="block truncate text-[14px] font-medium">{c.name}</span>
                <span className="text-muted-foreground block truncate text-[13px]">
                  {c.homeBase ?? "—"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {overflow > 0 && (
        <p className="text-muted-foreground mt-2 text-[13px]">
          + {overflow} more on track, not shown
        </p>
      )}
    </div>
  )
}
