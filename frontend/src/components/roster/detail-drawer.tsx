/**
 * Detail drawer — a STUB, deliberately.
 *
 * Its full design is explicitly out of scope; it is specified only far enough
 * to know that approvals land here. The load-bearing property is negative:
 * when a card has an open approval that is NOT one-click (Grace — no option is
 * both in policy and on time), the action must arrive *here* and find no
 * one-click Approve button. A judgement call must not be one tap away.
 *
 * It is also an overlay, not a route. That cost nothing to honour now and buys
 * back the v2 voice path, where navigating away tears down the live call.
 */
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/roster/status-pill"
import { formatMoney } from "@/lib/format"
import type { RosterCard } from "@/lib/roster-types"

export function DetailDrawer({
  card,
  onOpenChange,
}: {
  card: RosterCard | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={card !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {card && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2.5">
                <DialogTitle className="font-heading text-[19px] font-semibold">
                  {card.name}
                </DialogTitle>
                <StatusPill status={card.status} />
              </div>
              <DialogDescription>
                {card.homeBase ?? "Home base unknown"} · {card.employeeId}
              </DialogDescription>
            </DialogHeader>

            {card.advisory && (
              <p className="text-foreground/80 mt-3 max-w-[60ch] text-[15px] leading-relaxed">
                {card.advisory}
              </p>
            )}

            <dl className="text-muted-foreground mt-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[13px]">
              {card.policyVerdict && (
                <Row k="Policy">pol-flight v1 · {card.policyVerdict}</Row>
              )}
              {card.totalDelta && (
                <Row k="Add-collect">
                  <span className="font-mono">
                    {formatMoney(card.totalDelta, card.currency)}
                  </span>
                </Row>
              )}
              {card.offerCount > 0 && <Row k="Options">{card.offerCount} priced</Row>}
              {card.impactId && <Row k="Impact">{card.impactId}</Row>}
              {card.approvalId && <Row k="Approval">{card.approvalId}</Row>}
            </dl>

            <p className="border-border text-muted-foreground mt-5 border-t pt-4 text-[13px]">
              {card.approvalId && !card.canApprove
                ? "This one needs a judgement call — no option is both in policy and on time. Offer comparison and the override path land here."
                : "Itinerary, segments and offer comparison land here. Not built in v1."}
            </p>

            <div className="mt-5 flex justify-end">
              <DialogClose render={<Button variant="outline" className="h-11" />}>
                Close
              </DialogClose>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="font-mono">{k}</dt>
      <dd className="text-foreground">{children}</dd>
    </>
  )
}
