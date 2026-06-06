import type { InboxMessage, InboxThread } from "../types"

/** Group label for messages whose thread carries no project_key. */
export const UNGROUPED_PROJECT = "(no project)"

export interface ProjectGroup {
  project: string
  messages: InboxMessage[]
}

/**
 * Group messages by their thread's project_key. Messages join threads via
 * thread_id; project_key lives on the thread (inbox_threads.project_key),
 * not the message. Groups sort alphabetically with the ungrouped bucket
 * last; message order within a group is preserved.
 */
export function groupMessagesByProject(
  messages: InboxMessage[],
  threads: InboxThread[],
): ProjectGroup[] {
  const projectByThread = new Map<string, string>()
  for (const t of threads) {
    if (t.project_key) projectByThread.set(t.id, t.project_key)
  }

  const groups = new Map<string, InboxMessage[]>()
  for (const msg of messages) {
    const project = projectByThread.get(msg.thread_id) ?? UNGROUPED_PROJECT
    const bucket = groups.get(project)
    if (bucket) {
      bucket.push(msg)
    } else {
      groups.set(project, [msg])
    }
  }

  return [...groups.entries()]
    .map(([project, msgs]) => ({ project, messages: msgs }))
    .sort((a, b) => {
      if (a.project === UNGROUPED_PROJECT) return 1
      if (b.project === UNGROUPED_PROJECT) return -1
      return a.project.localeCompare(b.project)
    })
}

/** Distinct project keys across threads, sorted, for filter options. */
export function projectOptions(threads: InboxThread[]): string[] {
  const keys = new Set<string>()
  for (const t of threads) {
    if (t.project_key) keys.add(t.project_key)
  }
  return [...keys].sort((a, b) => a.localeCompare(b))
}
