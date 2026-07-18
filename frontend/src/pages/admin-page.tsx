/**
 * Admin — two buttons.
 *
 * No free-text fields and no new visual vocabulary: same tokens, same
 * typography, same button component as the roster. Deliberate enough to show
 * on stage, cheap enough not to compete with the roster for build time. The
 * hotel and dinner scenarios were cut because neither changes anything visible
 * on a flight roster.
 *
 * Both routes are gated behind the worker's ENABLE_DEV_ROUTES flag, so a 404
 * here means the seam is off, not that the button is broken — the copy says so.
 */
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { disrupt, fixtureMode, resetSeed } from "@/lib/api"

type Result = { kind: "ok" | "err"; text: string } | null

export function AdminPage() {
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<Result>(null)

  async function run(name: string, fn: () => Promise<void>, okText: string) {
    setBusy(name)
    setResult(null)
    try {
      await fn()
      setResult({ kind: "ok", text: okText })
    } catch (e) {
      setResult({
        kind: "err",
        text:
          e instanceof Error && e.message.includes("404")
            ? "Dev routes are disabled on the worker (ENABLE_DEV_ROUTES)."
            : "The worker did not accept that. Is it running on :8787?",
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-[680px] px-5 pt-6 pb-16 sm:px-6">
      <header className="border-border flex flex-wrap items-baseline justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="font-heading text-xl font-bold tracking-[-0.01em]">Admin</h1>
          <p className="text-muted-foreground mt-0.5 text-[13px]">
            Demo seams · <span className="font-mono">evt-busan</span>
            {fixtureMode() && " · fixtures"}
          </p>
        </div>
        <a
          href="/"
          className="text-muted-foreground hover:text-foreground text-[13px] underline underline-offset-4"
        >
          Back to roster
        </a>
      </header>

      <div className="mt-6 flex flex-col gap-2.5">
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            run("disrupt", disrupt, "KE82 cancelled. The roster will pick it up within 5s.")
          }
          className="h-14 justify-start rounded-[var(--radius)] px-4 text-[15px]"
        >
          {busy === "disrupt" ? "Cancelling…" : "Cancel KE82 · 14 Sep"}
        </Button>
        <p className="text-muted-foreground -mt-1 mb-2 px-1 text-[13px]">
          One disruption event, four impacts through the codeshare index, twelve
          priced offers. Deterministic ids, so pressing it twice is safe.
        </p>

        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => run("reset", resetSeed, "Seed state restored.")}
          className="h-14 justify-start rounded-[var(--radius)] px-4 text-[15px]"
        >
          {busy === "reset" ? "Resetting…" : "Reset to seed"}
        </Button>
        <p className="text-muted-foreground -mt-1 px-1 text-[13px]">
          Back to 24 on track, Grace and Nora at risk.
        </p>
      </div>

      {result && (
        <div
          role="status"
          className={
            result.kind === "ok"
              ? "border-status-ok/40 bg-status-ok/[0.07] mt-6 rounded-[var(--radius)] border px-4 py-3 text-[14px]"
              : "border-status-needs/40 bg-status-needs/[0.07] mt-6 rounded-[var(--radius)] border px-4 py-3 text-[14px]"
          }
        >
          {result.text}
        </div>
      )}
    </div>
  )
}
