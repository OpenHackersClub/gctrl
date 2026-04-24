import { useState, useCallback, useEffect } from "react"

export type BoardView = "kanban" | "gantt"

export type Route =
  | { page: "board"; projectKey: string | null; view: BoardView }
  | { page: "inbox"; threadId: string | null }

function parseRoute(pathname: string): Route {
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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))

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
