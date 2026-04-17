-- gctrl-board D1 schema
-- Tables match the frontend's expected JSON shape (snake_case)

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  counter INTEGER NOT NULL DEFAULT 0,
  github_repo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'none',
  assignee_id TEXT,
  assignee_name TEXT,
  assignee_type TEXT,
  labels TEXT NOT NULL DEFAULT '[]',           -- JSON array
  parent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_by_type TEXT NOT NULL DEFAULT 'human',
  session_ids TEXT NOT NULL DEFAULT '[]',       -- JSON array
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  pr_numbers TEXT NOT NULL DEFAULT '[]',        -- JSON array
  blocked_by TEXT NOT NULL DEFAULT '[]',        -- JSON array
  blocking TEXT NOT NULL DEFAULT '[]',          -- JSON array
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', -- JSON array
  github_issue_number INTEGER,
  github_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'human',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

CREATE TABLE IF NOT EXISTS issue_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'human',
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  data TEXT NOT NULL DEFAULT '{}'              -- JSON object
);

CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id);
