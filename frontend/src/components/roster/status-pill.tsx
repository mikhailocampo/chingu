/**
 * Status is never colour-only. Every pill carries its text label, so the
 * meaning survives greyscale, colour-blindness and a projector with the
 * saturation cranked down.
 *
 * The dot is decorative and marked aria-hidden; the label is the content.
 */
import { cn } from "@/lib/utils"
import { STATUS_LABEL, type DisplayStatus } from "@/lib/roster-types"

const TONE: Record<DisplayStatus, string> = {
  GREEN: "text-status-ok border-status-ok/30 bg-status-ok/[0.07]",
  RESOLVED: "text-status-ok border-status-ok/30 bg-status-ok/[0.07]",
  AT_RISK: "text-status-risk border-status-risk/30 bg-status-risk/[0.07]",
  BOOKING: "text-status-calling border-status-calling/30 bg-status-calling/[0.07]",
  CALLING: "text-status-calling border-status-calling/30 bg-status-calling/[0.07]",
  NEEDS_YOU: "text-status-needs border-status-needs/35 bg-status-needs/[0.08]",
  FAILED: "text-status-needs border-status-needs/35 bg-status-needs/[0.08]",
}

/** Only a live call pulses. If everything pulses, nothing reads as live. */
const PULSES: Partial<Record<DisplayStatus, boolean>> = {
  CALLING: true,
  BOOKING: true,
}

export function StatusPill({
  status,
  className,
}: {
  status: DisplayStatus
  className?: string
}) {
  return (
    <span
      className={cn(
        // Pills are fully round by intent — radius varies by element class here,
        // it is not one value applied everywhere.
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
        "text-[11px] leading-none font-semibold tracking-[0.07em] uppercase whitespace-nowrap",
        TONE[status],
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          PULSES[status] && "motion-safe:animate-pulse"
        )}
      />
      {STATUS_LABEL[status]}
    </span>
  )
}
