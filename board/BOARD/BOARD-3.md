---
id: BOARD-3
project: BOARD
status: backlog
priority: medium
labels: [product-cycle, analytics]
created_by: debuggingfuture
---

# Product cycles — time-bounded retrospectives with aggregate metrics

Implement product cycles as time-bounded batches of issues with aggregate metrics for retrospectives. A cycle groups issues completed within a date range and computes cost, velocity, and quality metrics.

## Acceptance Criteria

- CLI: `gctl board cycles create --name "Sprint 1" --start 2026-04-01 --end 2026-04-14`
- CLI: `gctl board cycles list` shows all cycles with summary stats
- CLI: `gctl board cycles view <id>` shows issues, cost, velocity, scores
- HTTP: CRUD endpoints under `/api/board/cycles`
- Web UI: cycle selector in header, aggregate dashboard view
- Metrics: total cost, issues completed, avg time-to-done, avg eval score
