// ── Analytics / Sessions (kernel HTTP API) ──

export type CreatedBy = "scheduler" | "otel_ingest" | "api" | "unknown"

/** UI shorthand for the spec's derived view (analytics §1).
 *  internal = {scheduler, api}, external = {otel_ingest}. */
export type SessionKind = "all" | "internal" | "external"

export interface SessionSummary {
  id: string
  workspace_id: string
  device_id: string
  agent_name: string
  started_at: string
  ended_at: string | null
  status: "active" | "completed" | "failed" | "cancelled"
  total_cost_usd: number
  total_input_tokens: number
  total_output_tokens: number
  /** Provenance — newer kernels populate this; legacy DBs may report
   *  `unknown`. Always present in the wire format thanks to the serde
   *  default on the kernel side. */
  created_by: CreatedBy
}

// Mirrors the kernel's `Analytics` struct (gctrl-core/src/types.rs:213).
// Note: `active_sessions` is NOT part of this response — derive it
// client-side from `sessions.list({ status: "active" })`.
export interface AnalyticsOverview {
  total_sessions: number
  total_spans: number
  total_cost_usd: number
  total_input_tokens: number
  total_output_tokens: number
}

export interface CostByModel {
  model: string
  cost: number
  calls: number
}

export interface CostByAgent {
  agent: string
  cost: number
  sessions: number
}

export interface CostAnalytics {
  by_model: CostByModel[]
  by_agent: CostByAgent[]
}

export interface DailyEntry {
  date: string
  sessions: number
  spans: number
  cost_usd: number
}

export interface LatencyByModel {
  model: string
  p50_ms: number
  p95_ms: number
  p99_ms: number
}

export interface LatencyAnalytics {
  by_model: LatencyByModel[]
}

export interface SpanDistEntry {
  type: string
  count: number
  percentage: number
}

export interface SpanAnalytics {
  distribution: SpanDistEntry[]
}

export interface ScoreSummary {
  name: string
  pass: number
  fail: number
  total: number
  pass_rate: number
  avg_value: number
}

export interface AlertRule {
  id: string
  name: string
  condition_type: string
  threshold: number
  action: string
  enabled: boolean
}

export interface TraceTreeNode {
  span_id: string
  type: string
  operation: string | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  duration_ms: number | null
  status: string
  children?: TraceTreeNode[]
}

export interface TraceTreeResponse {
  session: {
    id: string
    agent_name: string
    status: string
    total_cost_usd: number
    total_input_tokens: number
    total_output_tokens: number
    started_at: string
  }
  spans: TraceTreeNode[]
  span_count: number
  scores?: Array<{ name: string; value: number; source: string }>
  tags?: Array<{ key: string; value: string }>
}

// ── Contributions (analytics §M5) ──

/** A single PR (commits will follow when the route adds them) joined
 *  to a kernel session via its `Session-Id:` trailer. Rows without a
 *  session_id are unattributed but still surfaced — the spec is
 *  loss-tolerant on inference. */
export interface ContributionRow {
  type: "pr" | "commit"
  /** PR number for `type=pr`; `0` for `type=commit` (SHA-keyed). */
  number: number
  /** Commit SHA — present only on `type=commit` rows. */
  sha?: string
  title: string
  url: string
  state: string
  branch: string | null
  author: string
  created_at: string | null
  merged_at: string | null
  /** Trailer-extracted session id; null when no trailer / no match. */
  session_id: string | null
  session_agent: string | null
  /** Provenance of the joined session — null when unattributed. */
  created_by: CreatedBy | null
}

export interface ContributionsResponse {
  contributions: ContributionRow[]
}

// ── Network traffic (analytics §M4) ──

/** Aggregate traffic stats from `/api/net/stats?since=`. Mirrors
 *  `gctrl_core::TrafficStats`. by_host / by_status are tuples to match
 *  the kernel wire format (`Vec<(String, u64)>` → `[host, count][]`). */
export interface NetTrafficStats {
  total_requests: number
  total_request_bytes: number
  total_response_bytes: number
  by_host: Array<[string, number]>
  by_status: Array<[number, number]>
}

export interface NetDomain {
  host: string
  requests: number
  request_bytes: number
  response_bytes: number
}

export interface NetDomainsResponse {
  domains: NetDomain[]
}

export interface NetDailyEntry {
  date: string
  requests: number
  request_bytes: number
  response_bytes: number
}

export interface NetDailyResponse {
  daily: NetDailyEntry[]
}

/** A single proxied request returned by `/api/net/logs`. session_id
 *  stays null until the proxy gains per-session attribution (spec
 *  Kernel Dependencies §2). */
export interface NetTrafficRecord {
  id: string
  timestamp: string
  method: string
  url: string
  host: string
  status_code: number
  request_size_bytes: number
  response_size_bytes: number
  duration_ms: number
  session_id: string | null
}

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
  start_date?: string | null
  due_date?: string | null
}

export interface Project {
  id: string
  name: string
  key: string
  counter: number
  github_repo?: string
}

export interface MoveIssueResult {
  issue: Issue
  task_id: string | null
  dispatched: boolean
}

/** Gantt summary row — narrower shape than Issue (what GET /gantt returns). */
export interface GanttIssue {
  id: string
  project_id: string
  title: string
  status: IssueStatus
  priority: Priority
  assignee_id: string | null
  assignee_name: string | null
  assignee_type: AssigneeType | null
  parent_id: string | null
  start_date: string | null
  due_date: string | null
}

export interface GanttView {
  range: { min: string | null; max: string | null }
  issues: GanttIssue[]
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

/* ── Inbox types ── */

export interface InboxMessage {
  id: string
  thread_id: string
  source: string
  kind: string
  urgency: string
  title: string
  body?: string
  context: Record<string, unknown>
  status: string
  requires_action: boolean
  payload?: Record<string, unknown>
  duplicate_count: number
  snoozed_until?: string
  expires_at?: string
  created_at: string
  updated_at: string
}

export interface InboxThread {
  id: string
  context_type: string
  context_ref: string
  title: string
  project_key?: string
  pending_count: number
  latest_urgency: string
  created_at: string
  updated_at: string
}

export interface InboxAction {
  id: string
  message_id: string
  thread_id: string
  actor_id: string
  actor_name: string
  action_type: string
  reason?: string
  metadata?: Record<string, unknown>
  created_at: string
}

export interface InboxStats {
  total: number
  pending: number
  acted: number
  requires_action: number
  by_urgency: Record<string, number>
  by_kind: Record<string, number>
}

export type AcceptanceKind = "shell" | "test" | "http"
export type AcceptanceStatus = "pending" | "running" | "pass" | "fail"

export interface AcceptanceCheckRow {
  id: string
  issue_id: string
  check_idx: number
  kind: AcceptanceKind
  command: string
  status: AcceptanceStatus
  last_session_id: string | null
  last_run_at: string | null
  output: string | null
  created_at: string
  updated_at: string
}

export interface AcceptanceRollup {
  total: number
  passed: number
  failed: number
  pending: number
  running: number
  checks: AcceptanceCheckRow[]
}
