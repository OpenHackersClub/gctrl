import { useState, useEffect, useCallback } from "react"
import type { Project } from "../types"

/**
 * SPA routing for projects: syncs URL <-> selected project.
 *
 *   /                  -> no project selected
 *   /projects/:key     -> select project by key
 *
 * Uses history.pushState -- no router dependency needed.
 */
export function useProjectRoute(projects: Project[]) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [initialKey] = useState(() => parseProjectKey(window.location.pathname))

  // Resolve initial URL -> project ID once projects load
  useEffect(() => {
    if (!initialKey || projects.length === 0) return
    const match = projects.find((p) => p.key === initialKey)
    if (match) setSelectedProjectId(match.id)
  }, [initialKey, projects])

  // Listen for browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const key = parseProjectKey(window.location.pathname)
      if (key) {
        const match = projects.find((p) => p.key === key)
        setSelectedProjectId(match?.id ?? null)
      } else {
        setSelectedProjectId(null)
      }
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [projects])

  const selectProject = useCallback(
    (projectId: string | null) => {
      setSelectedProjectId(projectId)
      if (projectId) {
        const project = projects.find((p) => p.id === projectId)
        if (project) {
          history.pushState(null, "", `/projects/${project.key}`)
        }
      } else {
        history.pushState(null, "", "/")
      }
    },
    [projects]
  )

  return { selectedProjectId, selectProject }
}

function parseProjectKey(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match ? match[1] : null
}