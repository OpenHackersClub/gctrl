---
id: BOARD-11
project: BOARD
status: backlog
priority: medium
labels: [observability, web-ui, otel]
created_by: debuggingfuture
---

# Agent OTel dashboard — cost charts, session timeline, score trends

Add an observability dashboard surface to gctrl-board web UI showing aggregate agent metrics: cost over time, session timeline, latency distribution, and eval score trends.

## Acceptance Criteria

- Dashboard tab or view accessible from board header
- Cost chart: line graph of daily spend across all linked sessions
- Session timeline: horizontal bars showing session durations, color-coded by status
- Latency distribution: histogram of span durations for the project
- Score trend: line chart of average eval scores per cycle/week
- Data fetched from kernel analytics endpoints (`/api/analytics/*`)
- Filterable by project and date range
