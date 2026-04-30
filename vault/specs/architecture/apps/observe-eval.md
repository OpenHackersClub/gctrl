# Application: Observe & Eval

Observe & Eval is the gctrl native application for **lifecycle evaluation of agent-built and agent-using products**. It owns both the **substrate** (metric registry, prompt registry, judges, score store, trends) and the **harness** (runner, suites, regression gates) over a single set of primitives.

A metric named `faithfulness` defined once in Observe & Eval is the same metric whether it runs in local development, in CI, in staging, or against live production sessions. That continuity — one metric name, one chart, one query, dev → prod — is the differentiator. It is not a pytest plugin and not a single-phase test framework.

## Architectural Position

Observe & Eval is a **native application** in the Unix layer model. Like `gctrl-board`, it depends on the shell and kernel; nothing in the kernel depends on it.

```
App (Observe & Eval) → Shell (HTTP API :4318) → Kernel (Storage, Telemetry, Model Router)
```

- **Depends on the shell** — reads/writes via the kernel HTTP API and CLI. MUST NOT import kernel crates from app code (Rust app components compiled into the binary may, per OS § 3).
- **Never depended on by the shell or kernel** — the kernel knows nothing about metrics, judges, datasets, or runs. Removing the app breaks nothing below it.
- **Reuses the kernel's `scores` table** — per [domain-model § 5.3](../domain-model.md#53-eval-application-tables), scores are kernel-owned and shared. Observe & Eval adds its own namespaced tables (`eval_*`) for the primitives the kernel does not own.

See [os.md — Dependency Direction](../os.md) for the full invariant.

## Why Both Harness and Substrate

A pure substrate (metrics + score store, no runner) forces every consuming app to write its own loop. A pure harness (a runner, no shared store) forces every consuming app to adopt the runner's opinions and gives up dev→prod continuity. gctrl owns both because the same primitives — metrics, prompts, judges, scores — must be reachable from either entry point and produce identical results.

| Mode | Loop owner | Entry point | Use cases |
|---|---|---|---|
| **Harness** | Observe & Eval | `gctrl eval run <suite>` | CI gates, "just run my evals" path, baseline comparisons |
| **Substrate** | Application | `POST /api/eval/score` and SDK | Embedded eval (dev test loop, prod sampler), custom flows, apps with their own runner |

Both modes hit the same internals: metric registry → judge prompt → model router → `Score` row. The harness is a built-in client of the substrate API. There is no private path the runner can take that an application cannot.

## Lifecycle Coverage

Observe & Eval is scoped to the full product-development lifecycle. Each phase uses the same metrics and judges with phase-specific framing:

| Phase | How Observe & Eval is used | What gets stored |
|---|---|---|
| **Spec/design** | Author judges and acceptance criteria as named metrics | `eval_metrics`, `eval_prompts` |
| **Local dev** | App calls substrate API while iterating; or `gctrl eval run --watch` | `eval_runs`, `scores` |
| **Pre-merge CI** | Harness mode: `gctrl eval run <suite> --baseline <run-id>`, exits non-zero on regression | `eval_runs`, `scores` |
| **Pre-deploy / staging** | A/B prompts and models against the same suite | `eval_runs`, `scores` (with prompt/model tags) |
| **Post-deploy** | App samples live sessions via substrate API; auto-scoring runs on session end | `scores` (with `target_type='session'`) |

A query like `SELECT date_trunc('day', created_at), avg(value) FROM scores WHERE name='faithfulness'` answers "Faithfulness over time" across every phase in one chart.

## Primitives

### Metric
A named scoring function. Resolves to either an in-process evaluator (deterministic check, statistical metric) or a judge prompt (LLM-as-judge) referenced by `prompt_id`. Has a threshold for pass/fail when used as a gate. Examples: `faithfulness`, `tool_correctness`, `json_correctness`, `cost_per_generation`. Custom metrics are first-class — apps register them via the API.

### Prompt (Judge Prompt)
A versioned text artifact stored in the kernel's existing `prompt_versions` table (content-addressed by hash). Reused for both agent prompts and judge prompts; the difference is purpose, not storage. A judge prompt is referenced by metric definitions.

### Dataset / Case
A dataset is a named collection of cases. A case is `{ input, expected?, context? }` — schema is intentionally permissive. Datasets are not required for substrate-mode evals; apps may pass cases inline. They become important in harness mode and for replayable baselines.

### Eval Run
A grouping row that ties a batch of `Score`s together — one row per `gctrl eval run` invocation, or per app-initiated batch. Carries metadata (suite name, model, prompt version, baseline run-id, git sha, environment). Enables baseline diffs and "show me runs of suite X over the last 30 days."

### Score
The kernel-owned `scores` table (see [domain-model § 5.3](../domain-model.md#53-eval-application-tables)) carries every score from every mode. `target_type` extends to include `eval_case` and `eval_run` alongside the existing `session`, `span`, `task`. The metric continuity property depends on this table being the single sink.

## Tables

Per the namespacing invariant, Observe & Eval owns the `eval_*` prefix. The kernel-owned `scores` table is shared.

| Table | Owner | Purpose |
|---|---|---|
| `scores` | Kernel | Every score from every mode (substrate + harness, dev + prod). Existing. |
| `eval_metrics` | Observe & Eval | Metric definitions: name, kind (deterministic / judge), prompt_id, threshold, schema |
| `eval_datasets` | Observe & Eval | Named dataset metadata |
| `eval_cases` | Observe & Eval | Cases belonging to datasets — `input`, `expected`, `context`, all JSON-typed |
| `eval_runs` | Observe & Eval | Run-level metadata that groups scores: suite name, baseline_run_id, git_sha, env, model |

`prompt_versions` (kernel) is reused for judge prompts; no new table is needed for them.

## API Surface

The substrate API is the load-bearing surface. The harness CLI is a thin client of it.

### Substrate (HTTP + SDK)

| Endpoint | Purpose |
|---|---|
| `POST /api/eval/score` | Score one output against a named metric. Body: `{ metric, input, output, context?, target_type?, target_id?, run_id? }`. Returns `{ score, pass, judge_trace_id }` and persists a `scores` row. |
| `POST /api/eval/metrics` | Register or update a metric definition. |
| `GET /api/eval/metrics` | List metric definitions. |
| `POST /api/eval/datasets` / `POST /api/eval/cases` | Manage datasets and cases. |
| `POST /api/eval/runs` | Open a new run; returns `run_id` for grouping subsequent scores. |
| `GET /api/eval/runs/{id}` | Run summary: pass/fail counts, score distributions, baseline diff. |
| `GET /api/analytics/scores?name=...` | Existing endpoint, unchanged. The substrate writes here. |

The SDK is a thin language-specific wrapper (TypeScript first, matching `gctrl-board`) around these endpoints.

### Harness (CLI)

| Command | Purpose |
|---|---|
| `gctrl eval run <suite>` | Load suite (dataset + metrics), iterate cases, score each, persist a run, print summary. |
| `gctrl eval run <suite> --baseline <run-id>` | Compare against a prior run; exit non-zero on regression. |
| `gctrl eval run <suite> --watch` | Re-run on file change for local dev. |
| `gctrl eval metrics list/show <name>` | Inspect the registry. |
| `gctrl eval runs list` | Browse historical runs. |

The runner calls the substrate `POST /api/eval/score` for every case. There is no internal shortcut.

## Integration with the Kernel

| Kernel piece | Role for Observe & Eval |
|---|---|
| **Telemetry** | Every eval run is itself a Session. Judge LLM calls become Spans like any other generation. Cost and latency of evals are first-class. |
| **Storage** | DuckDB `scores` is shared; `eval_*` tables are app-namespaced. Indexes follow [domain-model § 5.4](../domain-model.md#54-indexes). |
| **Model Router** | Judges call the same model router as agents. The recent Workers AI / AI Gateway routing for `@cf/*` (commit `63c50fc`) applies to judge calls without modification. |
| **Sync** | `eval_*` tables are exported via the same Parquet/R2 pipeline as kernel telemetry. No special sync path. |
| **Event Bus** | `SessionEnded` continues to trigger the existing `auto_score_session` post-hoc metrics. New event `EvalRunCompleted` lets the board surface regressions. |
| **Guardrails** | Cost budgets and loop detection apply to eval runs without change. Judges are LLM calls; they are governed. |

## Integration with Other Applications

- **gctrl-board** — Surfaces eval run summaries on Issue cards (e.g., "this branch's run #422 regressed `faithfulness` 0.78 → 0.61"). Subscribes to `EvalRunCompleted`.
- **gctrl-inbox** — `eval_request` items (already defined in [gctrl-inbox.md](gctrl-inbox.md)) trigger harness runs.
- **Observability drivers** — `ObservabilityExportPort` exports `scores` and `eval_runs` to Phoenix / Langfuse / SigNoz for teams that want them mirrored.

## Status

| Capability | Status |
|---|---|
| `scores` table, manual scoring API, daily aggregates | Implemented (kernel) |
| `auto_score_session` (span_count, error_count, generation_count, cost_per_generation, error_loops) | Implemented (kernel) |
| `eval_metrics` / `eval_datasets` / `eval_cases` / `eval_runs` tables | **Planned (M4)** |
| Substrate API (`POST /api/eval/*`) | **Planned (M4)** |
| Harness CLI (`gctrl eval run`) | **Planned (M4)** |
| Built-in judge metrics (faithfulness, tool_correctness, json_correctness, hallucination, etc.) | **Planned (M4)** |
| Baseline diff and CI gating | **Planned (M4)** |
| `EvalRunCompleted` event and gctrl-board surface | **Planned (M4)** |

## Non-goals

- **Not a pytest plugin.** Observe & Eval has no pytest collector, no fixture, no `assert_test`. Apps that already use pytest call the substrate API from inside their tests.
- **Not an exhaustive metric catalog.** The built-in metric set is curated for product-dev needs; specialised families (RAG composites, multimodal, MCP) are not core deliverables. Apps register the metrics they need.
- **No mandatory test-case schema.** The substrate accepts whatever shape the app has. `LLMTestCase`-style rigidity is rejected.
- **Not a separate process.** Observe & Eval ships as Rust app components compiled into the gctrl binary (per [os.md § 3](../os.md), Status row), not a sidecar. The boundary is logical, not OS-level.

## References

- [PRD § Native Applications](../../gctrl/PRD.md) — product positioning
- [ROADMAP § M4](../../gctrl/ROADMAP.md) — delivery milestones
- [domain-model § 5.3](../domain-model.md#53-eval-application-tables) — table DDL and ownership
- [implementation/kernel/eval-storage.md](../../implementation/kernel/eval-storage.md) — column-level DDL, JSON shapes, indexes, migration order
- [os.md § 3](../os.md) — application invariants
- [glossary](../../glossary.md) — Metric, Judge, Eval Run, Eval Score
