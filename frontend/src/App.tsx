/**
 * Three routes, still no router dependency.
 *
 * `/employee/:id` was added deliberately against the advice in
 * PLAN-dashboard.md:318, which says the detail view must not be a route because
 * the v2 voice dock puts the dispatcher in the call room and navigating away
 * removes them from it. That cost is accepted and written down; if voice
 * returns, this branch becomes a sheet.
 */
import { useEffect, useState } from "react"

import { AdminPage } from "@/pages/admin-page"
import { EmployeePage } from "@/pages/employee-page"
import { RosterPage } from "@/pages/roster-page"

/**
 * "/employee/emp-us-04" -> "emp-us-04". Null for anything else.
 *
 * Splits the query and hash off first. `[^/]+` happily captures
 * "emp-kr-14?fixtures=calm" otherwise, and the id then matches nobody.
 */
function employeeIdFrom(path: string): string | null {
  const m = /^\/employee\/([^/?#]+)\/?$/.exec(path)
  return m ? decodeURIComponent(m[1]) : null
}

/** An href may carry a query string; routing decisions are on the path alone. */
function pathOf(href: string): string {
  return new URL(href, window.location.origin).pathname
}

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
      // The full href (with its query) goes into history so the URL stays
      // shareable; only the path drives routing.
      window.history.pushState({}, "", href)
      setPath(pathOf(href))
      // A route swap that keeps the previous page's scroll offset drops you
      // into the middle of the new one. Browsers do this for real navigations;
      // a hand-rolled router has to do it itself.
      window.scrollTo(0, 0)
    }
    document.addEventListener("click", onClick)

    return () => {
      window.removeEventListener("popstate", onPop)
      document.removeEventListener("click", onClick)
    }
  }, [])

  if (path.startsWith("/admin")) return <AdminPage />

  const employeeId = employeeIdFrom(path)
  // Keyed so a link from one traveller to another remounts rather than showing
  // the previous person's itinerary while the next one loads.
  if (employeeId) return <EmployeePage key={employeeId} employeeId={employeeId} />

  return <RosterPage />
}

export default App
