# ADR: Prompts live in a dedicated table, not as new SpanType variants

**Status**: accepted
**Scope**: gctrl-otel ingest, gctrl-storage, gctrl-analytics M2b (Prompts tab), gctrl-eval
**Drives**: `vault/specs/architecture/apps/gctrl-analytics.md` Kernel Dependencies §3 + Milestone M2b

## Context

The analytics spec calls for a Prompts tab that answers two operator questions:

1. **Per-session**: "What was this session asked, turn by turn?" — `GET /api/sessions/{id}/prompts` returns an ordered list of user/assistant/tool turns.
2. **Cross-session**: "Which prompts recur, and how do they perform?" — `GET /api/prompts?group_by=fingerprint` aggregates by normalized-text hash with counts, avg cost, avg eval score, top failure modes.

The kernel today stores LLM activity as `SpanType::Generation` rows (`kernel/crates/gctrl-core/src/types.rs:191`), with the prompt and completion text landing in the span's `attributes` JSON column under OpenInference / OTel-GenAI keys (`gen_ai.prompt.<i>.content`, `gen_ai.completion.<i>.content`). The OTLP ingest path already extracts model/tokens/cost from `gen_ai.*` attributes (`kernel/crates/gctrl-otel/src/span_processor.rs:130-147`); the *text* is currently passed through verbatim into `attributes` and never indexed.

There is also a pre-existing `prompt_versions` + `session_prompts` pair (`kernel/crates/gctrl-storage/src/schema.rs:107-123`). These are **template-scoped** (the file the agent loaded, hashed once) — not turn-scoped. They coexist with whatever this ADR decides; nothing here changes them.

The analytics spec's M2 milestone gates on a decision between two storage shapes. Operators want the Prompts tab; the engineering question is which shape doesn't paint future eval work into a corner.

## Decision

Add a dedicated `prompts` table keyed by `(session_id, turn_ordinal)`. Do **not** extend `SpanType` with new variants.

Schema (proposed; final form lands with the M2b implementation PR):

```sql
CREATE TABLE prompts (
  id              VARCHAR PRIMARY KEY,
  session_id      VARCHAR NOT NULL,
  span_id         VARCHAR,                     -- link to the parent Generation span
  turn_ordinal    INTEGER NOT NULL,            -- 0-indexed within the session
  role            VARCHAR NOT NULL,            -- 'user' | 'assistant' | 'system' | 'tool'
  text            TEXT NOT NULL,
  fingerprint     VARCHAR NOT NULL,            -- SHA-256 of normalized text
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  cost_usd        DOUBLE,
  created_at      VARCHAR NOT NULL
);
CREATE INDEX idx_prompts_session ON prompts(session_id, turn_ordinal);
CREATE INDEX idx_prompts_fingerprint ON prompts(fingerprint);
```

The OTLP ingest path (`process_export_request` in `gctrl-otel/src/span_processor.rs`) gains a fan-out step: when a `Generation` span carries `gen_ai.prompt.*` / `gen_ai.completion.*` attributes, ingest writes (a) the span row as today and (b) one `prompts` row per turn, linked back via `span_id`. Span ingest stays canonical; prompts are a derived, indexed projection.

## Why not extend `SpanType`

Extending `SpanType` with `UserTurn` / `AssistantTurn` (or a single `Turn` + `role` attr) was the spec's leaning option and is genuinely cheaper to implement initially. We're not picking it because:

1. **Most LLM SDKs emit one Generation span per inference call**, with the full multi-turn conversation packed into `gen_ai.prompt.<i>.content` attributes. Turning each turn into its own span requires the kernel to **synthesize** child spans on ingest — fabricated `span_id`s (must be deterministic for idempotent re-ingest), parent linkage to the real Generation span, and care to avoid double-counting cost / tokens in the existing analytics rollups (`get_cost_by_model`, `get_latency_by_model` filter on `model IS NOT NULL` and would now see synthetic rows). That's a fragile fan-out path inside a hot loop.
2. **The Prompts tab's primary query is fingerprint-grouped aggregation**: count, avg cost, avg eval score, joined-session list — keyed on a hash of normalized prompt text. Against the span table that becomes `SELECT json_extract(attributes, '$.gen_ai.prompt.0.content'), COUNT(*) FROM spans WHERE span_type IN ('user_turn', ...) GROUP BY ...`. DuckDB can run that query, but **JSON extraction is not indexable**. As soon as the corpus crosses a few thousand sessions every Prompts tab page-load does a full table scan with per-row JSON parse. A dedicated `fingerprint` column with a B-tree index turns the same query into a single index seek.
3. **Eval tooling will reinforce this access pattern.** Eval rules want to filter to "prompts whose text contains X" or "prompts using template Y" — exactly the random-access joins the spec's tipping-point clause names. Building eval queries on top of `json_extract(attributes, ...)` locks us into the slow path.
4. **Span semantics stay clean.** A `Span` is "a unit of OTLP-observed work." Manufacturing `UserTurn`/`AssistantTurn` rows blurs that — they aren't ingested from OTLP, they're materialized projections. A separate table makes the projection explicit.

The "two write paths on ingest" concern that pushed the spec toward Option A is real but bounded: the second write is driven directly off the same span's attributes, in the same transaction, in pure-Rust code with no I/O. Adding a second `INSERT` to a code path that already does `insert_session` + `insert_spans` is not a meaningful complexity bump.

## Consequences

**Good**

- Prompts tab queries are O(log n) on `fingerprint` and `(session_id, turn_ordinal)`, not O(n) JSON scans.
- Eval rules can filter / join on prompt text directly (`WHERE prompts.text LIKE '%pattern%'`).
- Span table semantics stay narrow: one OTLP span = one `spans` row. No synthesized children polluting the trace tree or the cost rollups.
- D1 mirror is straightforward: `analytics_prompts` follows the same pattern as `analytics_sessions` / `analytics_cost_by_*`.

**Cost**

- One more table to migrate, sync, and back-fill. Ingest path gains a fan-out step (~30 LOC, no new I/O).
- Prompt text lives in two places — the span's `attributes` JSON (immutable audit trail) and the `prompts.text` column (queryable projection). They must agree at write time but never need to stay in sync after, because the projection is derived once and never updated.
- Re-ingest of the same span_id must remain idempotent. The `prompts` table uses `id` as primary key; the deterministic id is `sha256(span_id || turn_ordinal || role)` (or similar) so a re-emitted span doesn't double-write turns.

## Non-decisions

- **Tokenization / normalization for fingerprinting** — pick at implementation time. Likely: lowercase, collapse whitespace, strip leading/trailing whitespace, then SHA-256. Don't strip variable substitutions; that's a Prompts-tab concern (template detection), not a fingerprint concern.
- **Whether the Prompts tab also surfaces prompt *templates*** — the existing `prompt_versions` table already covers templates. The Prompts tab will join `prompts.fingerprint` to `prompt_versions.hash` when a match exists; design lands with the M2b PR.
- **D1 mirror schema for `analytics_prompts`** — the kernel→D1 sync layer in `apps/gctrl-board/src/analytics.ts` already mirrors session-keyed tables; this is a same-shape addition, not a new pattern.
- **Whether `text` should be encrypted at rest** — single-operator, local-first, same threat model as the existing span attributes. No.

## Trigger to revisit

Switch to Option A (extend `SpanType`) — or a hybrid — if **any** of the following hold:

1. The `prompts` table grows large enough that the ingest fan-out shows up in span-ingest p95, AND the bulk of the rows are never queried by fingerprint (i.e. write-only data we don't actually use).
2. The trace tree UI grows a need to render turns as first-class nodes and the `span_id` link from `prompts` proves insufficient for that.
3. A second observable workload type (eg. tool-call traces, browsing actions) repeats the same fan-out pattern, suggesting the right primitive is "synthesized child spans" generally and not a turn-specific table.

Document the trigger and the data when revisiting; don't unwind without it.
