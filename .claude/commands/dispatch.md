Prepare a dispatch recommendation for agent work on an issue — gather context and suggest an execution plan.

> **Transitional skill**: The board and orchestrator CLI commands are not yet implemented. This skill currently uses available `gctl` commands and spec context to produce dispatch recommendations. Once `gctl board list --ready` and `gctl orchestrate dispatch` exist, this skill MUST be updated to invoke them.

## Instructions

### 1. Load Context

Read these files to understand orchestration and task structure:

- `specs/architecture/os.md` — Orchestrator kernel primitive (dispatch, retry, reconciliation)
- `specs/architecture/tracker.md` — Issue and task lifecycle, dependency graph, state machines
- `specs/principles.md` — Design principles (especially: mechanisms not policy, observability)

### 2. Gather System State

Run these `gctl` commands to understand current state:

1. `gctl sessions --format json` — active and recent sessions (to avoid duplicate work)
2. `gctl status` — system health (ensure kernel is ready for work)
3. `gctl analytics overview` — recent cost and error trends (to inform capacity decisions)

### 3. Analyze the Issue

If `$ARGUMENTS` provides an issue description or ID:
1. Identify the scope of work from the issue
2. Cross-reference with the loaded specs to determine which gctl layers are involved
3. Check active sessions for any overlapping work

If no arguments provided, report current system state and ask the user what work to dispatch.

### 4. Output Format

Present a dispatch recommendation:

```
## Dispatch Recommendation

### Issue
<issue description or ID>

### Layers Involved
- <which os.md layers this work touches: Kernel / Shell / Application / Utility / Adapter / Skill>

### Prerequisites
- [ ] <any preconditions: specs to read, commands to verify, dependencies>

### Suggested Execution Plan
1. <step 1 — specific gctl commands or file changes>
2. <step 2>
3. ...

### Active Sessions (conflict check)
<any sessions doing related work, or "No conflicts detected">

### Context Package
Files the agent should read before starting:
- <spec file paths>
- <source file paths>

### Guardrails
- Cost limit suggestion: $X.XX
- Error threshold: N consecutive errors before pause
- Scope boundary: <what this work should NOT touch>
```

$ARGUMENTS
