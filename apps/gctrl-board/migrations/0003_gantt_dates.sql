-- Gantt view: optional start/due dates on issues.
-- Both YYYY-MM-DD strings (date-only, project-local, no TZ ambiguity).
-- Null means "unscheduled" — issue appears in the Gantt's Unscheduled tray.

ALTER TABLE issues ADD COLUMN start_date TEXT;
ALTER TABLE issues ADD COLUMN due_date   TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_start_date ON issues(start_date);
CREATE INDEX IF NOT EXISTS idx_issues_due_date   ON issues(due_date);
