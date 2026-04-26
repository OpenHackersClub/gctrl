# Eval Primitives Storage — Implementation Details

Implementation details for the eval primitives defined in [vault/specs/architecture/apps/observe-eval.md](../../architecture/apps/observe-eval.md). This file specifies the kernel-storage-level DDL, JSON column shapes, indexes, and migration order for the M4 deliverable **Eval primitives schema**.

It is the foundation every other M4 deliverable depends on:

- **Substrate API** (`POST /api/eval/*`) writes rows defined here.
- **Harness runner** (`gctrl eval run`) reads `eval_datasets`/`eval_cases`, opens `eval_runs`, posts to the substrate.
- **Baseline & CI gating** diffs `scores` rows joined on `eval_runs.baseline_run_id`.
- **gctrl-board surface** subscribes to `EvalRunCompleted` and reads `eval_runs` summaries.

## Ownership and Layering

Per [domain-model § 5.3](../../architecture/domain-model.md#53-eval-application-tables) and the namespacing invariant in [os.md § 3](../../architecture/os.md):

| Table | Owner | Layer | Why |
|---|---|---|---|
| `scores` | Kernel (existing) | `gctrl-storage` | Single sink for substrate + harness, dev + prod. The metric-continuity property depends on this. |
| `prompt_versions` | Kernel (existing) | `gctrl-storage` | Reused for judge prompts; content-addressed by hash. |
| `eval_metrics` | Observe & Eval app | `gctrl-storage` | Metric-name resolution must be available to *any* writer (substrate API or harness), so DDL lives in the kernel storage crate even though the table is app-namespaced. |
| `eval_datasets` | Observe & Eval app | `gctrl-storage` | Same rationale. |
| `eval_cases` | Observe & Eval app | `gctrl-storage` | Same rationale. |
| `eval_runs` | Observe & Eval app | `gctrl-storage` | Same rationale. |

The `eval_*` tables are **app-namespaced** (Invariant #3) but their DDL is co-located with kernel schema — same pattern as `board_*` tables, which the kernel does not interpret but does host.

## DDL

DDL lands in `kernel/crates/gctrl-storage/src/schema.rs` under `CREATE_EVAL_*_TABLE` constants and is appended to `all_migrations()` in the order shown below.

### `eval_metrics`

```sql
CREATE TABLE IF NOT EXISTS eval_metrics (
    name VARCHAR PRIMARY KEY,
    kind VARCHAR NOT NULL,                        -- 'deterministic' | 'judge' | 'composite'
    prompt_hash VARCHAR,                          -- FK → prompt_versions.hash; required when kind='judge'
    threshold DOUBLE,                             -- pass/fail cutoff; NULL means "score-only, no gate"
    higher_is_better BOOLEAN NOT NULL DEFAULT TRUE,
    schema_json VARCHAR,                          -- optional JSON Schema for the case shape this metric expects
    description VARCHAR,
    created_at VARCHAR NOT NULL,
    updated_at VARCHAR NOT NULL
)
```

`name` is the primary key — the same string an app passes to `POST /api/eval/score` and the same string written to `scores.name`. This is the load-bearing identifier: register `faithfulness` once, reference it everywhere.

`kind` invariants:
- `deterministic` — pure function (regex match, JSON-validity, latency threshold). No `prompt_hash`.
- `judge` — LLM-as-judge. `prompt_hash` MUST resolve in `prompt_versions`.
- `composite` — combines other metrics (e.g., weighted average). `prompt_hash` NULL; the composition graph lives in `schema_json`.

`schema_json` is **advisory**, not enforced. The substrate API never rejects a case for failing the schema; the metric's evaluator decides what to do with malformed input.

### `eval_datasets`

```sql
CREATE TABLE IF NOT EXISTS eval_datasets (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL UNIQUE,
    description VARCHAR,
    created_at VARCHAR NOT NULL,
    updated_at VARCHAR NOT NULL
)
```

Datasets are optional — the substrate accepts inline cases without registration. They become important in harness mode and for replayable baselines.

### `eval_cases`

```sql
CREATE TABLE IF NOT EXISTS eval_cases (
    id VARCHAR PRIMARY KEY,
    dataset_id VARCHAR NOT NULL,                  -- FK → eval_datasets.id
    input VARCHAR NOT NULL,                       -- JSON
    expected VARCHAR,                             -- JSON, optional (some metrics are reference-free)
    context VARCHAR,                              -- JSON, optional (e.g., RAG retrieved docs)
    tags VARCHAR,                                 -- JSON array of strings, optional
    created_at VARCHAR NOT NULL
)
```

JSON columns store DuckDB `VARCHAR` (not `JSON`) for portability with the existing schema style — the storage layer treats them as opaque strings; the substrate API decodes/validates.

`input`/`expected`/`context` shapes are **permissive** (per spec non-goal: "no mandatory test-case schema"). Apps pass whatever shape their metric understands.

### `eval_runs`

```sql
CREATE TABLE IF NOT EXISTS eval_runs (
    id VARCHAR PRIMARY KEY,
    suite_name VARCHAR NOT NULL,                  -- harness suite name OR app-supplied label for substrate batches
    status VARCHAR NOT NULL,                      -- 'open' | 'completed' | 'aborted'
    baseline_run_id VARCHAR,                      -- FK → eval_runs.id; for diff/regression
    git_sha VARCHAR,
    env VARCHAR,                                  -- 'dev' | 'ci' | 'staging' | 'prod' | <custom>
    model VARCHAR,                                -- model under test (not the judge model)
    prompt_hash VARCHAR,                          -- prompt under test; FK → prompt_versions.hash
    judge_model VARCHAR,                          -- model used by judge metrics in this run
    metadata VARCHAR,                             -- JSON, free-form
    started_at VARCHAR NOT NULL,
    completed_at VARCHAR,
    pass_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0
)
```

`pass_count` / `fail_count` / `error_count` are denormalised counters maintained by the substrate as scores are written, so run summaries don't require aggregation over `scores` for the common case.

`status` transitions: `open → completed` (normal), `open → aborted` (cancelled). Once non-`open`, the row is immutable except for trailing telemetry.

### `scores` extension

The existing `scores` table requires no schema change. The `target_type` enum-by-convention extends:

| `target_type` | `target_id` references | Set by |
|---|---|---|
| `session` (existing) | `sessions.id` | Auto-scoring + manual scoring |
| `span` (existing) | `spans.span_id` | Manual scoring |
| `task` (existing) | `tasks.id` | Manual scoring |
| `eval_case` *(new)* | `eval_cases.id` | Substrate + harness |
| `eval_run` *(new)* | `eval_runs.id` | Aggregate scores (composite metrics, run-level rollups) |

Score writes from eval runs MUST set `scores.source = 'eval_substrate'` or `'eval_harness'` so analytics can attribute origin without joining `eval_runs`. The kernel does not enforce this string — it is an Observe & Eval convention, documented here so writers stay consistent.

Eval scores additionally need to join back to their parent run. `scores.target_id` already references `eval_cases.id` (or `eval_runs.id` for run-level aggregates), but cases are templates — many runs can score the same case — so the parent run is not derivable from `target_id` alone. Add an explicit FK column:

```sql
ALTER TABLE scores ADD COLUMN IF NOT EXISTS eval_run_id VARCHAR;
```

NULL for non-eval scores (sessions, spans, tasks). When set, it joins to `eval_runs.id`. This is the only structural change to `scores`; everything else is enum-by-convention on `target_type`.

## Indexes

Append to `CREATE_INDEXES`:

```sql
CREATE INDEX IF NOT EXISTS idx_eval_cases_dataset ON eval_cases(dataset_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_baseline ON eval_runs(baseline_run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs(status);
CREATE INDEX IF NOT EXISTS idx_scores_eval_run ON scores(eval_run_id);
CREATE INDEX IF NOT EXISTS idx_eval_metrics_kind ON eval_metrics(kind);
```

`idx_eval_runs_suite` is the hot path for the board's "show me runs of suite X over the last 30 days" query — descending `started_at` matches the access pattern.

`idx_scores_eval_run` is the hot path for run summary queries (`SELECT name, avg(value) FROM scores WHERE eval_run_id = ? GROUP BY name`).

## Migration Order

In `all_migrations()`, append after the persona/inbox/schedule blocks:

```rust
CREATE_EVAL_METRICS_TABLE,
CREATE_EVAL_DATASETS_TABLE,
CREATE_EVAL_CASES_TABLE,
CREATE_EVAL_RUNS_TABLE,
ADD_SCORES_EVAL_RUN_ID,    // ALTER TABLE — idempotent column add
```

Datasets must precede cases (FK). Runs come last so baseline_run_id self-FK is well-defined at every point in a fresh-schema build.

## JSON Column Shapes (advisory)

Recommended canonical shapes for app interop. The kernel does not enforce these; the substrate API and built-in metrics rely on them.

### `eval_cases.input`

```json
{ "prompt": "<user message>", "history": [{"role": "...", "content": "..."}] }
```

For non-LLM metrics (e.g., a deterministic check on a function), `input` is whatever the function takes:

```json
{ "args": [1, 2, 3], "kwargs": {"flag": true} }
```

### `eval_cases.expected`

```json
{ "answer": "<reference>", "tool_calls": [...], "rubric": "<judge guidance>" }
```

Reference-free metrics (e.g., `faithfulness` against retrieved context) leave `expected` NULL.

### `eval_cases.context`

```json
{ "retrieved_docs": ["..."], "tools_available": [...], "system_state": {...} }
```

### `eval_runs.metadata`

```json
{
  "ci_run_url": "https://github.com/.../actions/runs/12345",
  "branch": "feature/x",
  "triggered_by": "user@example.com",
  "extra": {}
}
```

Keep it small — large blobs belong in the linked CI run, not here.

## Tests

In `kernel/crates/gctrl-storage/tests/`:

| Test | What it asserts |
|---|---|
| `eval_schema.rs::creates_all_tables` | Fresh DB build creates all five eval objects (4 tables + 1 column) |
| `eval_schema.rs::scores_eval_run_id_column_added_idempotently` | Running migrations twice doesn't error |
| `eval_schema.rs::eval_run_baseline_self_fk_resolves` | A run with `baseline_run_id` pointing at another run inserts cleanly |
| `eval_schema.rs::scores_join_eval_runs` | `SELECT … FROM scores JOIN eval_runs ON scores.eval_run_id = eval_runs.id` returns expected rows |
| `eval_schema.rs::indexes_present` | All `idx_eval_*` indexes appear in `SHOW INDEXES` |

Use `DuckDbStore::open(":memory:")` per the existing test convention.

## Out of Scope (deferred to other M4 specs)

- **Substrate API request/response schemas** — covered in a separate spec under `vault/specs/architecture/apps/eval-substrate-api.md`.
- **Harness runner CLI surface** — covered in `vault/specs/architecture/apps/eval-harness.md`.
- **Built-in judge metric prompts** — content of judge prompts (faithfulness, tool_correctness, etc.) is content, not schema; lives in a metric catalog doc.
- **`EvalRunCompleted` event payload** — covered in event-bus spec under kernel.

## References

- [vault/specs/architecture/apps/observe-eval.md](../../architecture/apps/observe-eval.md) — architectural position, primitives, lifecycle
- [vault/specs/architecture/domain-model.md § 5.3](../../architecture/domain-model.md#53-eval-application-tables) — table ownership, kernel-shared vs app-namespaced
- [vault/specs/gctrl/ROADMAP.md § M4](../../gctrl/ROADMAP.md#m4-eval-capacity--intelligence--planned) — milestone delivery
- [`kernel/crates/gctrl-storage/src/schema.rs`](../../../../kernel/crates/gctrl-storage/src/schema.rs) — where `CREATE_EVAL_*_TABLE` constants land
