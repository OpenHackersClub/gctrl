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
- Shows context entries used during linked sessions
- Lists specs, code files, and documents referenced
- Gap detection: compare acceptance criteria against available context
- CLI: `gctl board issues context <id>` shows context inventory
- Recommendations for missing context entries
- Integration with gctl-context for context quality metrics
