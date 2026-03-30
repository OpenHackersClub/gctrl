System health overview — active sessions, recent errors, cost summary.

## Instructions

### 1. Load Context

Read these files to understand the system model:

- `specs/architecture/os.md` — Kernel layer (telemetry, storage, guardrails)
- `specs/architecture/domain-model.md` — Session, span, and cost field definitions

### 2. Gather Data

Run these `gctl` commands to collect system state:

1. `gctl status` — kernel health (DuckDB, OTLP receiver, guardrails)
2. `gctl sessions --format json` — recent sessions with cost/token totals
3. `gctl analytics overview` — aggregate metrics (total cost, session count, error rate)

### 3. Output Format

Present a health dashboard:

```
## System Health

### Kernel Status
- Storage: <ok/error>
- OTLP Receiver: <ok/error>
- Guardrails: <ok/error>

### Active Sessions (last 24h)
| Session | Agent | Status | Cost | Tokens |
|---------|-------|--------|------|--------|
| ...     | ...   | ...    | ...  | ...    |

### Aggregate Metrics
- Total sessions: N
- Total cost: $X.XX
- Error rate: N%
- Top agent by cost: <agent>

### Alerts
- <any anomalies: high error rate, cost spikes, stuck sessions>
```

If any `gctl` command fails (e.g., server not running), report the failure clearly and continue with available data. Suggest `gctl serve` if the HTTP API is required.

$ARGUMENTS
