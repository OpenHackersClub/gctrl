-- Add multi-device sync support to existing tables.
-- Adds device_id, updated_at, synced columns so the D1 sync engine can
-- track which device last wrote a row and pull deltas across devices.

ALTER TABLE projects ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE projects ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;

ALTER TABLE issues ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE issues ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;

ALTER TABLE comments ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE comments ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;

ALTER TABLE issue_events ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE issue_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE issue_events ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;

-- Per-device pull watermarks for D1 sync.
-- Stores the timestamp of the last successful pull for each device,
-- so query_since can fetch only rows newer than the watermark.
CREATE TABLE IF NOT EXISTS sync_manifest (
  device_id TEXT PRIMARY KEY,
  last_pull_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for delta pulls: SELECT * WHERE updated_at > ? AND device_id != ?
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);
CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);
CREATE INDEX IF NOT EXISTS idx_comments_updated ON comments(updated_at);
CREATE INDEX IF NOT EXISTS idx_issue_events_updated ON issue_events(updated_at);
