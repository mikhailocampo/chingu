/**
 * Loading state.
 *
 * Skeletons mirror the real layout — card-shaped skeletons for the loud bands,
 * row-shaped ones for the quiet table. A generic spinner would hide the fact
 * that this screen has two very different densities, and the layout would jump
 * when data arrived.
 *
 * The header counts render as em dashes elsewhere, never as 0: "0 need you" is
 * a claim, and the screen has not earned it yet.
 */
import { Skeleton } from "@/components/ui/skeleton"

export function RosterSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading roster">
      <BandRule />
      {Array.from({ length: 2 }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
      <BandRule />
      {Array.from({ length: 2 }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
      <BandRule />
      <div className="border-border overflow-hidden rounded-[var(--radius)] border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="border-border flex items-center justify-between border-b px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}

function BandRule() {
  return (
    <div className="mt-6 mb-2.5 flex items-center gap-2.5">
      <Skeleton className="h-3 w-28" />
      <div className="bg-border h-px flex-1" />
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="bg-card border-border mb-2.5 rounded-[var(--radius)] border p-4 sm:px-[18px]">
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-4 w-full max-w-[52ch]" />
      <Skeleton className="mt-2 h-4 w-3/5 max-w-[38ch]" />
      <Skeleton className="mt-3 h-3 w-48" />
    </div>
  )
}
