---
id: BOARD-7
project: BOARD
status: backlog
priority: medium
labels: [context, audit]
created_by: debuggingfuture
---

# Context audit — prompt inspection and gap detection

Add context audit capabilities to issues. Inspect what context (specs, code, docs) was available to the agent during execution. Detect gaps where the agent lacked needed context.

## Acceptance Criteria

- New "Context" tab in issue detail panel
- Shows context entries used during linked sessions (fetched from `/api/context/list`)
- Lists specs, code files, and documents referenced in session spans
- Gap detection: for each acceptance criterion, check if at least one context entry mentions the relevant keyword; flag unmatched criteria as gaps
- Gap score: ratio of matched-criteria to total-criteria (0.0–1.0), displayed as a progress bar
- CLI: `gctl board issues context <id>` shows context inventory with gap score
- HTTP: `GET /api/board/issues/{id}/context-audit` returns inventory + gaps JSON
- Recommendations: for each gap, suggest `gctl context add` command with relevant search terms
