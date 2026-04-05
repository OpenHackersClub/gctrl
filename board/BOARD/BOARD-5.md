---
id: BOARD-5
project: BOARD
status: backlog
priority: medium
labels: [eval, scoring]
created_by: debuggingfuture
---

# Eval scoring — human, auto, and model-based evaluation

Add multi-dimensional eval scoring to issues. Three scoring sources: human (manual), auto (test pass rate, coverage), model-based (LLM judge). Scores stored per-issue and aggregated per-cycle.

## Acceptance Criteria

- CLI: `gctl board issues score <id> --dimension correctness --value 4 --source human`
- Auto-scoring: on issue `done`, compute test pass rate and coverage delta
- Model-based: optional LLM judge evaluates code diff against acceptance criteria
- Issue detail panel shows score breakdown by dimension
- Dimensions: correctness, completeness, code-quality, test-coverage, security
- Scores are 1-5 scale with optional text rationale
- HTTP: `POST /api/board/issues/{id}/score`, `GET /api/board/issues/{id}/scores`
