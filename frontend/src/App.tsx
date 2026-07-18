/**
 * Two routes, so no router dependency. `/admin` is the only branch, and the
 * roster deliberately opens detail in an overlay rather than a route — that
 * costs nothing now and keeps the v2 voice path open, where navigating away
 * would tear down a live call.
 */
import { useEffect, useState } from "react"

import { AdminPage } from "@/pages/admin-page"
import { RosterPage } from "@/pages/roster-page"

export function App() {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener("popstate", onPop)

    // Intercept same-origin link clicks so the two pages swap without a reload.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return
      const anchor = (e.target as HTMLElement | null)?.closest("a")
      if (!anchor) return
      const href = anchor.getAttribute("href")
      if (!href?.startsWith("/")) return
      e.preventDefault()
      window.history.pushState({}, "", href)
      setPath(href)
    }
    document.addEventListener("click", onClick)

    return () => {
      window.removeEventListener("popstate", onPop)
      document.removeEventListener("click", onClick)
    }
  }, [])

  return path.startsWith("/admin") ? <AdminPage /> : <RosterPage />
}

export default App
