Investigate a session's trace tree — visualize span hierarchy, identify errors and latency bottlenecks.

## Instructions

### 1. Load Context

Read these files to understand trace structure:

- `specs/architecture/domain-model.md` — Span types (Generation, Span, Event), parent-child relationships, session model

### 2. Identify the Session

If `$ARGUMENTS` provides a session ID, use it directly.

If no session ID is provided, run `gctrl sessions --format json` and ask the user which session to investigate. Show the most recent 10 sessions with their IDs, agents, and statuses.

### 3. Gather Trace Data

Run these `gctrl` commands for the target session:

1. `gctrl tree <session_id>` — render the trace tree (span hierarchy with timing)
2. `gctrl spans --session <session_id>` — list all spans with details (type, duration, status, cost)

### 4. Output Format

Present the trace investigation:

```
## Trace: <session_id>

### Session Summary
- Agent: <agent name>
- Status: <active/completed/error>
- Duration: <total time>
- Cost: $X.XX
- Spans: N total (N generations, N tools, N events)

### Trace Tree
<paste gctrl tree output — the visual span hierarchy>

### Error Analysis
<if errors exist>
| Span | Error | Duration | Context |
|------|-------|----------|---------|
| ...  | ...   | ...      | ...     |

<if no errors: "No errors detected.">

### Latency Bottlenecks
- Slowest span: <name> (<duration>)
- Slowest generation: <name> (<duration>)
- <any spans taking disproportionate time>

### Observations
- <patterns: retry loops, repeated tool calls, long generations, error cascades>
```

$ARGUMENTS
