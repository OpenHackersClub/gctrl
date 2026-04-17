Summarize cost and token usage across sessions — totals, breakdowns, daily trends.

## Instructions

### 1. Load Context

Read these files to understand cost attribution:

- `specs/architecture/domain-model.md` — Session and span cost fields, token accounting

### 2. Gather Data

Run these `gctrl` commands to collect cost data:

1. `gctrl analytics cost` — aggregate cost summary (total spend, avg per session)
2. `gctrl analytics cost-breakdown` — cost breakdown by agent, model, session
3. `gctrl analytics daily` — daily cost and token trends

### 3. Output Format

Present a cost report:

```
## Cost Report

### Summary
- Total cost: $X.XX
- Total tokens: N (input: N, output: N)
- Sessions analyzed: N
- Average cost per session: $X.XX

### Breakdown by Agent
| Agent | Sessions | Cost | Tokens | Avg Cost/Session |
|-------|----------|------|--------|-----------------|
| ...   | ...      | ...  | ...    | ...             |

### Daily Trend (last 7 days)
| Date       | Sessions | Cost   | Tokens |
|------------|----------|--------|--------|
| YYYY-MM-DD | ...      | ...    | ...    |

### Top Sessions by Cost
| Session | Agent | Cost | Tokens | Duration |
|---------|-------|------|--------|----------|
| ...     | ...   | ...  | ...    | ...      |

### Observations
- <trend analysis: cost increasing/decreasing, anomalies, expensive sessions>
```

If a time range is provided via $ARGUMENTS, pass it to the `gctrl` commands (e.g., `--since 7d`). Default to all available data.

$ARGUMENTS
