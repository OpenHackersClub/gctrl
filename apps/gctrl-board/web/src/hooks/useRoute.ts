import { useState, useCallback, useEffect } from "react"

import { resolveInitialPath, type DesktopShim } from "../lib/desktop-env"

export type BoardView = "kanban" | "gantt"

export type AnalyticsTab =
  | "overview"
  | "sessions"
  | "usage"
  | "evals"
  | "contributions"

export type Route =
  | { page: "board"; projectKey: string | null; view: BoardView }
  | { page: "inbox"; threadId: string | null }
  | { page: "analytics"; tab: AnalyticsTab; sessionId: string | null }
  | { page: "settings"; section: "macos-spaces" }
  | { page: "schedule"; name: string | null; runId: string | null }

export function parseRoute(pathname: string): Route {
  // /analytics/sessions/:sessionId
  const analyticsSession = pathname.match(/^\/analytics\/sessions\/([^/]+)/)
  if (analyticsSession) {
    return { page: "analytics", tab: "sessions", sessionId: analyticsSession[1] }
  }

  // /analytics/:tab
  const analyticsTab = pathname.match(
    /^\/analytics\/(overview|sessions|usage|evals|contributions)\/?$/,
  )
  if (analyticsTab) {
    return { page: "analytics", tab: analyticsTab[1] as AnalyticsTab, sessionId: null }
  }

  // /analytics
  if (pathname === "/analytics" || pathname === "/analytics/") {
    return { page: "analytics", tab: "overview", sessionId: null }
  }

  // /settings/macos-spaces
  if (pathname === "/settings/macos-spaces" || pathname === "/settings/macos-spaces/") {
    return { page: "settings", section: "macos-spaces" }
  }

  // /schedule/:name/runs/:run_id — most-specific first
  const scheduleRun = pathname.match(/^\/schedule\/([^/]+)\/runs\/([^/]+)\/?$/)
  if (scheduleRun) {
    return { page: "schedule", name: scheduleRun[1], runId: scheduleRun[2] }
  }

  // /schedule/:name
  const scheduleName = pathname.match(/^\/schedule\/([^/]+)\/?$/)
  if (scheduleName) {
    return { page: "schedule", name: scheduleName[1], runId: null }
  }

  // /schedule
  if (pathname === "/schedule" || pathname === "/schedule/") {
    return { page: "schedule", name: null, runId: null }
  }

  // /inbox/:threadId
  const inboxThread = pathname.match(/^\/inbox\/([^/]+)/)
  if (inboxThread) {
    return { page: "inbox", threadId: inboxThread[1] }
  }

  // /inbox
  if (pathname === "/inbox" || pathname === "/inbox/") {
    return { page: "inbox", threadId: null }
  }

  // /projects/:key(/gantt)?
  const projectMatch = pathname.match(/^\/projects\/([^/]+?)(?:\/(gantt))?\/?$/)
  if (projectMatch) {
    return {
      page: "board",
      projectKey: projectMatch[1],
      view: projectMatch[2] === "gantt" ? "gantt" : "kanban",
    }
  }

  // / or anything else — board with no project selected
  return { page: "board", projectKey: null, view: "kanban" }
}

export function useRoute(): { route: Route; navigate: (path: string) => void } {
  // Desktop windows opened onto a specific view boot from the preload
  // bridge's initialRoute — packaged Electron loads from `file://`, where
  // the document pathname is the bundle path, not an app route.
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(
      resolveInitialPath(globalThis as { desktop?: DesktopShim }, window.location.pathname),
    ),
  )

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path)
    setRoute(parseRoute(path))
  }, [])

  useEffect(() => {
    const onPopState = () => {
      setRoute(parseRoute(window.location.pathname))
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  return { route, navigate }
}
