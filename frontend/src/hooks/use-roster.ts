/**
 * Roster polling.
 *
 * Three properties that are not negotiable:
 *
 * 1. A failed fetch NEVER blanks the screen. The previous payload is kept, the
 *    UI dims it, and a banner quotes the last good synced_at. On a crisis
 *    dashboard, an empty screen and "everyone is fine" look identical.
 * 2. The poll pauses on document.hidden. 26 rows every 5s is ~17k requests a
 *    day per abandoned tab, against per-row read billing.
 * 3. A refresh in flight is aborted when the component unmounts or a manual
 *    refresh supersedes it, so a slow response cannot overwrite a newer one.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { fetchRoster } from "@/lib/api"
import type { RosterResponse } from "@/lib/roster-types"

const POLL_MS = 5000

/**
 * "error" is the cold-start failure — nothing has ever loaded, so there is no
 * previous good data to dim. "stale" is the warm one, and it is the common
 * case: keep showing the board, dim it, say when it was last true.
 */
export type RosterPhase = "loading" | "ready" | "stale" | "error"

export interface UseRoster {
  data: RosterResponse | null
  phase: RosterPhase
  /** Set only while phase === "stale". */
  error: string | null
  /** synced_at of the last SUCCESSFUL fetch — what the stale banner quotes. */
  lastGoodAt: string | null
  refresh: () => void
}

export function useRoster(): UseRoster {
  const [data, setData] = useState<RosterResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(null)

  const inFlight = useRef<AbortController | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    inFlight.current?.abort()
    const ctl = new AbortController()
    inFlight.current = ctl
    try {
      const next = await fetchRoster(ctl.signal)
      if (!alive.current || ctl.signal.aborted) return
      setData(next)
      setLastGoodAt(next.synced_at)
      setError(null)
    } catch (e) {
      if (!alive.current || ctl.signal.aborted) return
      // Deliberately does NOT clear `data`.
      setError(e instanceof Error ? e.message : "unreachable")
    }
  }, [])

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer !== null) return
      timer = setInterval(load, POLL_MS)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        // Catch up immediately: the board was frozen while she was away.
        void load()
        start()
      }
    }

    // load() is async and every setState inside it happens after an await, so
    // this is not the synchronous cascade the rule targets. Subscribing to an
    // external data source on mount is exactly what an effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      alive.current = false
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
      inFlight.current?.abort()
    }
  }, [load])

  const phase: RosterPhase =
    data === null ? (error ? "error" : "loading") : error ? "stale" : "ready"

  return { data, phase, error, lastGoodAt, refresh: () => void load() }
}

/** Re-renders once a second so "Synced 14s ago" actually counts. */
export function useTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) setNow(Date.now())
    }, intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
