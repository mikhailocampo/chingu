/**
 * The fixture switch. The dashboard must be demonstrable with no worker
 * running — a demo that depends on two processes being up is a demo that
 * fails on stage.
 *
 *   VITE_USE_FIXTURES=1        build/dev-wide
 *   ?fixtures=calm             per-URL, wins over the env flag
 *   ?fixtures=disrupted
 *   ?fixtures=off              force live even when the env flag is on
 */
import { fixtureFor, type FixtureScenario } from "./fixtures"
import type { RosterResponse } from "./roster-types"

export const EVENT_ID = "evt-busan"

function urlFixture(): FixtureScenario | "off" | null {
  if (typeof window === "undefined") return null
  const v = new URLSearchParams(window.location.search).get("fixtures")
  if (v === "off") return "off"
  if (v === "calm" || v === "disrupted") return v
  if (v !== null) return "calm"
  return null
}

export function fixtureMode(): FixtureScenario | null {
  const fromUrl = urlFixture()
  if (fromUrl === "off") return null
  if (fromUrl) return fromUrl
  return import.meta.env.VITE_USE_FIXTURES ? "calm" : null
}

/**
 * Fixture scenario is module state, not a URL round-trip, so the admin page's
 * buttons can move the demo between calm and disrupted with the poll picking
 * it up on its next tick — exactly as the real dev seams behave.
 */
let scenario: FixtureScenario = fixtureMode() ?? "calm"

export function setFixtureScenario(next: FixtureScenario) {
  scenario = next
}

export function currentFixtureScenario(): FixtureScenario {
  return scenario
}

export async function fetchRoster(signal?: AbortSignal): Promise<RosterResponse> {
  if (fixtureMode()) {
    // A touch of latency so skeletons and the stale path are actually reachable
    // in a fixture demo instead of being dead code.
    await new Promise((r) => setTimeout(r, 220))
    return fixtureFor(scenario)
  }
  const res = await fetch(`/api/roster?event_id=${encodeURIComponent(EVENT_ID)}`, { signal })
  if (!res.ok) throw new Error(`roster ${res.status}`)
  return (await res.json()) as RosterResponse
}

/** POST with no body — the dev seams and the approve path both look like this. */
async function post(path: string): Promise<void> {
  const res = await fetch(path, { method: "POST" })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
}

export async function disrupt(): Promise<void> {
  if (fixtureMode()) {
    setFixtureScenario("disrupted")
    return
  }
  await post("/api/dev/disrupt")
}

export async function resetSeed(): Promise<void> {
  if (fixtureMode()) {
    setFixtureScenario("calm")
    return
  }
  await post("/api/dev/reset")
}

/**
 * Close an approval.
 *
 * CONTRACT GAP: worker/src/index.ts routes /api/roster, /api/dev/*,
 * /api/dispatch/* and /api/test/* — there is no approval-decision route yet,
 * and nothing in the codebase writes approval.decided_at. This is the assumed
 * shape; if the worker track lands a different path, only this function moves.
 * `decided_by` is deliberately NOT sent: it is server-side only, never an
 * operator id from the browser.
 */
export async function approve(approvalId: string): Promise<void> {
  if (fixtureMode()) {
    await new Promise((r) => setTimeout(r, 400))
    return
  }
  const res = await fetch(`/api/approval/${encodeURIComponent(approvalId)}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Idempotency key so a double-click cannot double-ticket, mirroring
    // confirm-choice.ts:213-217.
    body: JSON.stringify({ decision: "APPROVED", idempotency_key: `apr:${approvalId}` }),
  })
  if (!res.ok) throw new Error(`approve ${res.status}`)
}
