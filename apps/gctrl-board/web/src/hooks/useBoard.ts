import { useState, useEffect, useCallback } from "react"
import type { Issue, Project } from "../types"
import { api } from "../api/client"

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.projects.list()
      setProjects(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const create = useCallback(
    async (name: string, key: string) => {
      const project = await api.projects.create(name, key)
      setProjects((prev) => [...prev, project])
      return project
    },
    []
  )

  return { projects, loading, error, refresh, create }
}

export function useIssues(projectId: string | null) {
  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (silent = false) => {
    if (!projectId) {
      setIssues([])
      return
    }
    try {
      if (!silent) setLoading(true)
      const data = await api.issues.list({ project_id: projectId })
      setIssues(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load issues")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const moveIssue = useCallback(
    async (issueId: string, newStatus: string) => {
      try {
        const result = await api.issues.move(issueId, newStatus)
        setIssues((prev) =>
          prev.map((i) => (i.id === issueId ? result.issue : i))
        )
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Move failed"
        setError(msg)
        throw e
      }
    },
    []
  )

  const createIssue = useCallback(
    async (input: {
      title: string
      description?: string
      priority?: string
      labels?: string[]
    }) => {
      if (!projectId) throw new Error("No project selected")
      const issue = await api.issues.create({
        project_id: projectId,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "none",
        labels: input.labels ?? [],
        created_by_id: "web-user",
        created_by_name: "Web UI",
        created_by_type: "human",
      })
      setIssues((prev) => [...prev, issue])
      return issue
    },
    [projectId]
  )

  return { issues, loading, error, refresh, moveIssue, createIssue }
}
