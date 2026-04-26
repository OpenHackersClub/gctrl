-- Analytics mirror tables.
-- Kernel DuckDB is source of truth; the Worker's scheduled handler pulls from
-- KERNEL_URL/api/analytics/* and /api/sessions periodically and upserts here.
-- Read endpoints (/api/analytics, /api/analytics/cost, etc.) serve from these
-- tables, so analytics works even when the kernel is offline.

-- Sessions mirror — full row mirror for list + detail reads.
CREATE TABLE IF NOT EXISTS analytics_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'unknown',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_started ON analytics_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_agent   ON analytics_sessions(agent_name);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_status  ON analytics_sessions(status);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_creator ON analytics_sessions(created_by);

-- Daily aggregates — long-form rows from kernel; Worker pivots into DailyEntry shape.
CREATE TABLE IF NOT EXISTS analytics_daily (
  date TEXT NOT NULL,
  metric TEXT NOT NULL,        -- 'cost' | 'sessions' | 'tokens' | 'spans'
  dimension TEXT NOT NULL DEFAULT 'total',
  value REAL NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (date, metric, dimension)
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON analytics_daily(date DESC);

-- Cost rollups — denormalized snapshots refreshed on every sync (small).
CREATE TABLE IF NOT EXISTS analytics_cost_by_model (
  model TEXT PRIMARY KEY,
  cost REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_cost_by_agent (
  agent TEXT PRIMARY KEY,
  cost REAL NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Span type distribution rollup.
CREATE TABLE IF NOT EXISTS analytics_span_distribution (
  span_type TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  percentage REAL NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Score summaries keyed by score name.
CREATE TABLE IF NOT EXISTS analytics_scores (
  name TEXT PRIMARY KEY,
  pass INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  pass_rate REAL NOT NULL DEFAULT 0,
  avg_value REAL NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Alert rules mirror.
CREATE TABLE IF NOT EXISTS analytics_alerts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  condition_type TEXT NOT NULL,
  threshold REAL NOT NULL,
  action TEXT NOT NULL DEFAULT 'warn',
  enabled INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sync metadata — last successful kernel pull, for status display + debugging.
CREATE TABLE IF NOT EXISTS analytics_sync_state (
  resource TEXT PRIMARY KEY,    -- 'overview' | 'cost' | 'spans' | 'daily' | 'alerts' | 'sessions' | 'scores'
  last_synced_at TEXT NOT NULL,
  last_status TEXT NOT NULL,    -- 'ok' | 'error'
  last_error TEXT
);
