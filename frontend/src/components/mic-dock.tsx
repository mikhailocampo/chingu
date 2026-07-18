/**
 * One-shot intent mic. NOT a conversation.
 *
 * The whole shape of this component is one rule: speech never acts. It
 * transcribes, it shows what it understood in full, and then it stops and waits
 * for an explicit tap. A misheard word must not authorise a $400 add-collect,
 * and the only reliable defence against a misheard word is a human confirming
 * the parse before anything is written.
 *
 * Speech is also never the ONLY path to any action here — every intent below
 * has a button somewhere else on the screen. This is an accelerator.
 *
 * Collapsed to a 52px circle by default so the roster keeps the viewport. It
 * expands only when it has something to say or hear.
 */
import { useState } from "react"
import { MicIcon } from "lucide-react"

import { SpeechInput } from "@/components/ai-elements/speech-input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { RosterCard } from "@/lib/roster-types"

/** What the mic can resolve to. Both have a non-voice equivalent on screen. */
type Intent =
  | { kind: "approve"; card: RosterCard; transcript: string }
  | { kind: "venue"; transcript: string }
  | { kind: "unmatched"; transcript: string }

export function MicDock({
  cards,
  onApprove,
  onVenue,
}: {
  cards: RosterCard[]
  onApprove: (card: RosterCard) => void
  onVenue: () => void
}) {
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState<Intent | null>(null)

  const pendingApprovals = cards.filter((c) => c.canApprove).length

  // SpeechInput disables itself with no explanation where the Web Speech API
  // is missing. Since speech is only ever an accelerator here — every action
  // it reaches has a button on the roster — the honest thing is to say so
  // rather than present a button that does nothing when pressed.
  const speechSupported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)

  function handleTranscript(text: string) {
    const t = text.trim()
    if (!t) return
    setIntent(matchIntent(t, cards))
  }

  function confirm() {
    if (!intent) return
    if (intent.kind === "approve") onApprove(intent.card)
    if (intent.kind === "venue") onVenue()
    setIntent(null)
    setOpen(false)
  }

  // Collapsed: a 52px button and a badge that appears only when an approval is
  // actually pending, so it advertises itself exactly when it matters.
  if (!open && !intent) {
    return (
      <div className="fixed right-5 bottom-5 z-40">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Voice command"
          className="bg-card border-border text-foreground hover:bg-muted focus-visible:ring-ring/40 relative grid size-[52px] place-items-center rounded-full border shadow-[0_3px_10px_oklch(0_0_0/10%)] outline-none focus-visible:ring-3"
        >
          <MicIcon className="size-[21px]" />
          {pendingApprovals > 0 && (
            <span className="bg-status-needs border-background absolute -top-1 -right-1 grid size-5 place-items-center rounded-full border-2 text-[11px] font-semibold text-white">
              {pendingApprovals}
            </span>
          )}
        </button>
      </div>
    )
  }

  return (
    <div className="fixed right-4 bottom-5 left-4 z-40 sm:left-auto sm:w-[540px]">
      <div className="bg-card border-border rounded-[var(--radius)] border p-3.5 shadow-[0_3px_14px_oklch(0_0_0/9%)]">
        {!intent ? (
          <div className="flex items-center gap-3.5">
            <SpeechInput
              onTranscriptionChange={handleTranscript}
              className="size-11 shrink-0 rounded-full"
              aria-label="Start or stop listening"
            />
            <div className="min-w-0 flex-1">
              <div className="text-muted-foreground text-[11px] tracking-[0.07em] uppercase">
                Listening
              </div>
              <div className="text-muted-foreground text-[14px] italic">
                {speechSupported
                  ? "Try “approve Elena’s rebooking” or “rebook the restaurant”."
                  : "This browser has no speech recognition. Every action here is also a button on the roster."}
              </div>
            </div>
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => setOpen(false)}
            >
              Close
            </Button>
          </div>
        ) : (
          <div>
            <div className="text-muted-foreground text-[11px] tracking-[0.07em] uppercase">
              Heard you say
            </div>
            <p className="mt-1 text-[15px]">“{intent.transcript}”</p>

            {/* State the match in full, including the money. If this sentence
                is wrong, she can see that it is wrong before it costs $200. */}
            <p className="text-muted-foreground mt-2 text-[13px]">
              {intent.kind === "approve" &&
                `Matched: ${intent.card.name} → ${intent.card.advisory ?? "top-ranked option"} Nothing is booked until you confirm.`}
              {intent.kind === "venue" &&
                "Matched: rebook the offsite dinner venue. This starts an outbound call. Nothing changes until you confirm."}
              {intent.kind === "unmatched" &&
                "No match. Try naming a person with a pending approval, or say “rebook the restaurant”."}
            </p>

            <div className="mt-3.5 flex justify-end gap-2">
              <Button
                variant="outline"
                className="h-11"
                onClick={() => setIntent(null)}
              >
                Discard
              </Button>
              <Button
                className={cn("h-11", intent.kind === "unmatched" && "hidden")}
                onClick={confirm}
              >
                {intent.kind === "approve" ? "Confirm approval" : "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Intent matching, deliberately dumb and deliberately narrow.
 *
 * A name is matched only against people who ALREADY have a one-click approval
 * open. That is the important constraint: voice can only travel a path the
 * screen has already declared safe. It cannot invent an approval, and it
 * cannot reach a card whose decision needs judgement.
 */
function matchIntent(transcript: string, cards: RosterCard[]): Intent {
  const t = transcript.toLowerCase()

  if (/(restaurant|venue|dinner)/.test(t)) {
    return { kind: "venue", transcript }
  }

  if (/(approve|approved|authorise|authorize|sign off)/.test(t)) {
    const approvable = cards.filter((c) => c.canApprove)
    const hit = approvable.find((c) =>
      c.name
        .toLowerCase()
        .split(" ")
        .some((part) => part.length > 2 && t.includes(part))
    )
    if (hit) return { kind: "approve", card: hit, transcript }
    // Exactly one thing is approvable and she said "approve" — still requires
    // the confirm tap, so the inference is safe to make.
    if (approvable.length === 1) {
      return { kind: "approve", card: approvable[0], transcript }
    }
  }

  return { kind: "unmatched", transcript }
}
