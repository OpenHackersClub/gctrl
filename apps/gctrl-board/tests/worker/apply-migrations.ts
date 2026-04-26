/**
 * Setup file for @cloudflare/vitest-pool-workers tests.
 * Applies D1 migrations before any test runs.
 * Runs inside the Workers V8 isolate — no Node.js APIs available.
 *
 * Each statement is exec'd individually because Miniflare's D1
 * splits multi-line SQL on newlines rather than semicolons.
 */
import { env } from "cloudflare:test"

const statements = [
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, counter INTEGER NOT NULL DEFAULT 0, github_repo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'backlog', priority TEXT NOT NULL DEFAULT 'none', assignee_id TEXT, assignee_name TEXT, assignee_type TEXT, labels TEXT NOT NULL DEFAULT '[]', parent_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_by_id TEXT NOT NULL, created_by_name TEXT NOT NULL, created_by_type TEXT NOT NULL DEFAULT 'human', session_ids TEXT NOT NULL DEFAULT '[]', total_cost_usd REAL NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, pr_numbers TEXT NOT NULL DEFAULT '[]', blocked_by TEXT NOT NULL DEFAULT '[]', blocking TEXT NOT NULL DEFAULT '[]', acceptance_criteria TEXT NOT NULL DEFAULT '[]', github_issue_number INTEGER, github_url TEXT, start_date TEXT, due_date TEXT)`,

  `CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id)`,

  `CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`,

  `CREATE INDEX IF NOT EXISTS idx_issues_start_date ON issues(start_date)`,

  `CREATE INDEX IF NOT EXISTS idx_issues_due_date ON issues(due_date)`,

  `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id), author_id TEXT NOT NULL, author_name TEXT NOT NULL, author_type TEXT NOT NULL DEFAULT 'human', body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), session_id TEXT)`,

  `CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id)`,

  `CREATE TABLE IF NOT EXISTS issue_events (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id), event_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_type TEXT NOT NULL DEFAULT 'human', timestamp TEXT NOT NULL DEFAULT (datetime('now')), data TEXT NOT NULL DEFAULT '{}')`,

  `CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id)`,

  // 0004_analytics.sql — analytics mirror tables
  `CREATE TABLE IF NOT EXISTS analytics_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, device_id TEXT NOT NULL, agent_name TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL DEFAULT 'active', total_cost_usd REAL NOT NULL DEFAULT 0, total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT 'unknown', synced_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_started ON analytics_sessions(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_agent ON analytics_sessions(agent_name)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_status ON analytics_sessions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_sessions_creator ON analytics_sessions(created_by)`,

  `CREATE TABLE IF NOT EXISTS analytics_daily (date TEXT NOT NULL, metric TEXT NOT NULL, dimension TEXT NOT NULL DEFAULT 'total', value REAL NOT NULL, synced_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (date, metric, dimension))`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON analytics_daily(date DESC)`,

  `CREATE TABLE IF NOT EXISTS analytics_cost_by_model (model TEXT PRIMARY KEY, cost REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS analytics_cost_by_agent (agent TEXT PRIMARY KEY, cost REAL NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS analytics_span_distribution (span_type TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, percentage REAL NOT NULL DEFAULT 0, synced_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS analytics_scores (name TEXT PRIMARY KEY, pass INTEGER NOT NULL DEFAULT 0, fail INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, pass_rate REAL NOT NULL DEFAULT 0, avg_value REAL NOT NULL DEFAULT 0, synced_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS analytics_alerts (id TEXT PRIMARY KEY, name TEXT NOT NULL, condition_type TEXT NOT NULL, threshold REAL NOT NULL, action TEXT NOT NULL DEFAULT 'warn', enabled INTEGER NOT NULL DEFAULT 1, synced_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS analytics_sync_state (resource TEXT PRIMARY KEY, last_synced_at TEXT NOT NULL, last_status TEXT NOT NULL, last_error TEXT)`,
]

for (const sql of statements) {
  await env.DB.exec(sql)
}
