export type IssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled"

export type Priority = "urgent" | "high" | "medium" | "low" | "none"

export type AssigneeType = "human" | "agent"

export interface Assignee {
  id: string
  name: string
  type: AssigneeType
}

export interface Issue {
  id: string
  project_id: string
  title: string
  description?: string
  status: IssueStatus
  priority: Priority
  assignee_id?: string
  assignee_name?: string
  assignee_type?: AssigneeType
  labels: string[]
  parent_id?: string
  created_at: string
  updated_at: string
  created_by_id: string
  created_by_name: string
  created_by_type: AssigneeType
  session_ids: string[]
  total_cost_usd: number
  total_tokens: number
  pr_numbers: number[]
  blocked_by: string[]
  blocking: string[]
  acceptance_criteria: string[]
  github_issue_number?: number
  github_url?: string
}

export interface Project {
  id: string
  name: string
  key: string
  counter: number
  github_repo?: string
}

export interface IssueEvent {
  id: string
  issue_id: string
  event_type: string
  actor_id: string
  actor_name: string
  actor_type: AssigneeType
  timestamp: string
  data: unknown
}

export interface Comment {
  id: string
  issue_id: string
  author_id: string
  author_name: string
  author_type: AssigneeType
  body: string
  created_at: string
  session_id?: string
}

export const ISSUE_STATUSES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]

export const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Cancelled",
}

export const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low", "none"]

/* ── Team / Dispatch types ── */

export interface PersonaDefinition {
  id: string
  name: string
  focus: string
  prompt_prefix: string
  owns: string
  review_focus: string
  pushes_back: string
  tools: string[]
  key_specs: string[]
}

export interface TeamRecommendation {
  personas: PersonaDefinition[]
  rationale: string
}

export interface RenderedPrompt {
  persona_id: string
  name: string
  prompt: string
}

export interface TeamRenderResult {
  agents: RenderedPrompt[]
}
