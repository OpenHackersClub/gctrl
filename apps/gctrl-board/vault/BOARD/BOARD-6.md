---
id: BOARD-6
project: BOARD
status: backlog
priority: medium
labels: [observability, web-ui]
created_by: debuggingfuture
---

# Per-issue trace explorer in web UI

Add a trace explorer tab to the issue detail panel. Shows all linked sessions with their span trees, tool calls, LLM interactions, errors, and timing. Powered by kernel telemetry API.

## Acceptance Criteria

- New "Traces" tab in issue detail panel
- Shows linked sessions with expandable span trees
- Each span shows: name, duration, status, attributes
- LLM spans show input/output token counts and model
- Tool call spans show tool name and result status
- Error spans highlighted in red with error message
- Latency distribution chart across all spans
- Data fetched from `/api/sessions` and `/api/spans` filtered by issue's session_ids
