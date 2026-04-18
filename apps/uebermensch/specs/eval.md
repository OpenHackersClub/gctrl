# Uebermensch — Eval

> How we measure and monitor brief + scrape quality, catch prompt regressions, enforce budgets, and close the loop back to prompt and profile edits.
>
> See [briefing-pipeline.md](briefing-pipeline.md) for what gets evaluated; [domain-model.md § 2.4](domain-model.md#24-alert) + [§ 5](domain-model.md#5-alert-payload-shapes) for `Alert` shapes; [architecture.md § 9](architecture.md#9-failure-modes--degradation) for failure modes.

## Design Goals

1. **Every brief gets scored** — no manual opt-in. Automated evaluators run on every `rendered` brief.
2. **Regressions are alerts, not dashboards** — a 7-day rolling baseline lets us surface drift as an inbox message the moment it happens.
3. **Prompts are first-class subjects** — scores attach to `prompt_hash`, not just brief id, so we can A/B versions.
4. **Humans score in one tap** — the bar for "user participation" must be trivially low or humans won't participate at all.
5. **Scraping is evaluated, too** — a brief is only as good as its input wiki pages.

## What We Measure

Five dimensions, stored as rows in the kernel `scores` table with `target_type + target_id`:

| Dimension | target_type | Range | Auto / Human | Cadence |
|-----------|-------------|-------|--------------|---------|
| `citation_coverage` | `uber_brief` | 0..1 | Auto | Every brief |
| `hype_ratio` | `uber_brief` | 0..1 (lower is better) | Auto (heuristic + LLM judge) | Every brief |
| `length_score` | `uber_brief` | 0..1 | Auto | Every brief |
| `cost_efficiency` | `uber_brief` | USD / cited-claim | Auto | Every brief |
| `quality` | `uber_brief` | 0..1 (human) | Human | User-initiated |
| `accuracy` | `uber_brief_item` | 0..1 | Auto (LLM-as-judge, M4+) | Post-brief, sampled |
| `rank_order` | `prompt_version` | Spearman vs baseline | Auto (A/B harness, M4+) | Per A/B run |
| `scrape_success` | `domain` (string) | 0..1 rolling | Auto | Continuous |

The kernel `scores` schema is `(target_type, target_id, name, value, metadata JSON, created_at)` — Uebermensch writes all rows with `name` set to the dimension; `metadata` holds dimension-specific detail (e.g. `{baseline7d: 0.92, threshold: 0.85}` for a regression event).

## Automated Evaluators

Every evaluator reads the brief markdown from the vault file at `uber_briefs.vault_path`. SQLite holds the index row (vault_path, cost, prompt_hash, per-item metadata) — never the body text. Evaluators open the vault file read-only and hash its content before scoring so that mid-eval vault edits don't produce inconsistent scores.

### Citation Coverage

**Definition:** `cited_claims / total_claims` over the brief's vault markdown.

- **Source:** `read_file(uber_briefs.vault_path)` — strip YAML frontmatter, then run the splitter.
- **Total claims:** sentences ending in `.`, `?`, or `!`, excluding bullet headers and titles. Rough — tokenise via sentence splitter; ignore < 5 word sentences.
- **Cited claims:** sentences that contain ≥ 1 bare `[[slug]]` link. Typed prefixes are forbidden ([knowledge-base.md § Wikilink Conventions](knowledge-base.md#wikilink-conventions)); a `[[type:slug]]` in a brief is a render-time bug and fails the brief, not an eval concern.

**Implementation:** pure function, no LLM. Runs synchronously in `EvaluatorService.scoreBriefAuto(brief)` immediately after render, against the vault file already written by the renderer.

**Target:** ≥ 0.90. Below 0.75 → `eval_regression` alert.

### Hype Ratio

**Definition:** Fraction of item summaries flagged as hype.

**Tier 1 (heuristic):** Regex + keyword set — flag sentences containing any of: `revolutionary`, `game-changing`, `disrupt(s|ed|ing)`, `paradigm shift`, `unicorn`, `skyrocket(ed|ing)`, `10x`, `TAM.*(trillion|infinite)`, `to the moon`, all-caps words ≥ 4 chars in sequence, multiple exclamation marks. Count flagged sentences / total sentences.

**Tier 2 (LLM-as-judge):** If heuristic ratio > 0.10 OR on a 20% sample, run `uber-evaluator` persona against the brief with prompt: "rate each item on hype scale 0..1 where 0 = factual and 1 = marketing copy". Report mean.

**Target:** ≤ 0.05. Above 0.15 → `eval_regression` alert.

**Why two tiers:** the heuristic is free and catches the obvious cases; the LLM catches subtler forms like "positioned for explosive growth" without keyword triggers. Running LLM judge on every brief is wasteful; sampling is enough to catch drift.

### Length Score

**Definition:** How close to the target length `profile.delivery.brief.format` implies.

- `long`: target ≈ 1500 tokens. Score = `1 - min(1, |actual - target| / target)`.
- `short`: target ≈ 600 tokens. Same formula.
- `digest`: target ≈ 250 tokens. Same formula.

**Target:** ≥ 0.80. A persistent trend towards longer briefs (despite `format: short`) is a useful signal — below 0.60 for 3 days → alert.

### Cost Efficiency

**Definition:** `cost_usd / cited_claims_count`. Lower is better. Aim: stable over time.

**Detection:** week-over-week increase > 30% on fixed `profile.budgets` → `eval_regression` alert with dimension `cost`. The alert payload includes `baseline7d`, `current`, and `prompt_hash` so the user can see which prompt version inflated cost.

### Accuracy (LLM-as-judge, M4+)

**Definition:** For a sampled brief item, run `uber-evaluator` with:
- The item's `title` + `summary_md`
- The actual source pages referenced
- Prompt: "Does the summary accurately reflect the source? Rate 0..1."

Sampled at 10% of items. Batched into one evaluator call per brief for cost.

**Target:** ≥ 0.90. Drift < 0.80 → alert.

### Rank-Order (A/B harness, M4+)

Compare two prompt versions' rankings of the same candidate set. Spearman rank correlation between brief item orderings.

Triggered via `gctrl uber eval ab --candidate-set <id> --prompt-a <hash> --prompt-b <hash>`.

## Human Scoring

### UX Principle

One tap. Every delivered brief has a **score strip** attached:

- **App:** emoji row `👍 👌 👎` below the brief; click → writes a score, no modal.
- **Telegram / Discord:** inline buttons `Score: good | meh | bad`.

Mapping:

| Label | Value |
|-------|-------|
| good / 👍 | 1.0 |
| meh / 👌 | 0.5 |
| bad / 👎 | 0.0 |

### Write Path

```sh
gctrl uber score <brief_id> --name quality --value 0.9
```

Internally:

1. `POST /api/scores` with `target_type=uber_brief, target_id=<brief_id>, name=quality, value=<0..1>, metadata={channel, actor}`.
2. If a score row already exists for this (target, name) → `UPDATE ON CONFLICT` — human may re-score.
3. Emit `uber.score.recorded` event.

### Optional Prose Feedback

One free-form field: `--note "..."` — stored in `scores.metadata.note`. Feeds the weekly review.

### Weekly Review Prompt

Every Monday 06:00, `uber-evaluator` produces a weekly review:
- Highest-scored briefs + what they had in common
- Lowest-scored briefs + dominant failure modes from `note`s
- Recommendations (prompt tweaks, topic weight changes, source additions)

Delivered via normal channels; persisted as a synthesis page `wiki/synthesis/eval-review-<week>.md`.

## Regression Detection

A **regression** is: current score on a dimension is worse than its 7-day rolling mean by more than the dimension's threshold.

```
baseline7d = mean(scores where target_type=uber_brief AND name=<dim> AND created_at IN [now-7d, now))
delta      = current - baseline7d                     // signed; direction depends on dimension
if |delta| > threshold[dim]:
    insert into uber_alerts(kind='eval_regression', urgency='warn', payload=<EvalRegressionPayload>)
```

**Thresholds** (tuneable per profile):

| Dimension | Direction | Default threshold |
|-----------|-----------|-------------------|
| `citation_coverage` | lower is worse | 0.10 |
| `hype_ratio` | higher is worse | 0.08 |
| `length_score` | lower is worse | 0.15 |
| `cost_efficiency` | higher is worse | 30% relative |
| `accuracy` | lower is worse | 0.10 |

Alerts include `prompt_hash` → the app eval dashboard shows the prompt diff between the baseline-dominant hash and the current hash. Diff-view is the killer feature — it tells the user *exactly* what changed when quality dropped.

**Debouncing:** An alert for a (dimension, prompt_hash) fires at most once per 24h. If a new prompt_hash appears mid-window, that counts as a new subject — new alert allowed.

## Scrape Health

### Per-Domain Success

`uber_scrape_health` is a view over kernel `traffic` joined with `context_entries`:

```sql
CREATE VIEW uber_scrape_health AS
SELECT
  domain,
  COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 299) * 1.0 / COUNT(*) AS success_rate,
  COUNT(*) FILTER (WHERE status_code >= 400) AS fails_7d,
  MAX(created_at) AS last_seen
FROM traffic
WHERE created_at >= NOW() - INTERVAL 7 DAYS
GROUP BY domain;
```

Updated on query; no backing table.

### Alerting

- Domain success rate drops below 50% for 24h AND > 5 fails → `scrape_health` alert with `ScrapeHealthPayload` (see [domain-model.md § 5](domain-model.md#5-alert-payload-shapes)).
- Alert urgency: `warn` by default; `page` if the domain is tagged `critical: true` in profile sources (`sources[].critical`).

### Repair Hints

The alert payload includes `last_error` + suggests:

- Proxy reconfig (if many 403s from same IP)
- User-agent rotation (if 403s with `cloudflare` in body)
- Manual ingest fallback (`gctrl uber ingest --url ...`)

### CLI

```sh
gctrl uber scrape-health                     # table of domain -> success_rate, fails, last_seen
gctrl uber scrape-health --domain foo.com    # focus; show last 20 requests
```

## Budget Enforcement

Tied to Guardrails. `DailyBudgetPolicy` (Uebermensch-contributed):

```rust
impl GuardrailPolicy for DailyBudgetPolicy {
    fn evaluate(&self, ctx: &GuardCtx) -> PolicyDecision {
        let spent = total_cost_today(ctx.workspace);
        if spent >= self.limit_usd { return PolicyDecision::Deny("daily budget exceeded".into()); }
        if spent >= self.limit_usd * 0.8 { return PolicyDecision::Warn("daily budget at 80%".into()); }
        PolicyDecision::Allow
    }
}
```

Registered at daemon start from `profile.budgets.daily_usd`.

**Behaviour:**

- `Warn` at 80% → `budget_exceeded` alert (urgency=`info`), brief still produced.
- `Deny` at 100% → next LLM call blocked; if no brief produced today → scheduled brief skipped (alert fires). If brief already produced → deepdives + ingest-Q&A refuse until next day.
- Manual override: `gctrl uber budget bypass --hours 2` — tracked in `scores` table as `name=budget_bypass` for audit.

Per-brief budget (`budgets.per_brief_usd`) enforced as `LlmRequest.budget_hint_usd` — a soft cap the driver respects (backs off after hitting it).

## Eval Storage

All scores land in the kernel `scores` table. No app-owned eval tables.

```sql
-- kernel-owned (already exists)
CREATE TABLE scores (
    target_type  VARCHAR NOT NULL,
    target_id    VARCHAR NOT NULL,
    name         VARCHAR NOT NULL,
    value        DOUBLE NOT NULL,
    metadata     JSON,
    actor        VARCHAR,              -- 'auto' | 'human:<user_id>' | 'llm-judge:<persona>'
    created_at   VARCHAR NOT NULL,
    device_id    VARCHAR NOT NULL,
    PRIMARY KEY (target_type, target_id, name, created_at)
);
```

Uebermensch writes `target_type IN ('uber_brief', 'uber_brief_item', 'prompt_version')`. Per [principles.md invariant #4](../../../specs/principles.md#architectural-invariants), apps do not introduce new cross-cutting kernel tables — they reuse the existing ones.

## Eval Pipeline

```
┌──────────┐   ┌────────────┐   ┌────────────┐   ┌─────────────┐
│Brief     │──▶│Run auto    │──▶│Baseline vs │──▶│Alert if     │
│rendered  │   │evaluators  │   │current     │   │regression   │
└──────────┘   └────────────┘   └────────────┘   └─────────────┘
                     │
                     ▼
              ┌────────────┐
              │Write scores│
              │rows        │
              └────────────┘
```

Trigger: immediately after `uber_briefs.status = rendered`. Executed as `SchedPort.triggerOnce("uber.eval.brief." + briefId)` so it doesn't block delivery.

## Prompt A/B Harness (M4+)

Run two prompts against the same candidate set. Prompt-hashes compared side-by-side in the app.

```sh
gctrl uber eval ab \
  --candidate-set cs_01H... \   # captured from a past brief run
  --prompt-a hash-a \
  --prompt-b hash-b \
  --judge uber-evaluator
```

Pipeline:
1. Load candidates.
2. Run curator twice with the two prompt hashes.
3. Run judge over each result.
4. Write scores with `target_type=prompt_version, target_id=<hash>, name=<dimension>`.
5. Produce a comparison report (`wiki/synthesis/prompt-ab-<date>.md`) — stores the setup, scores, and winner.

A winning prompt gets promoted via `gctrl uber prompt promote <hash>` → writes the prompt to `prompts/<persona>.md` in the profile. This is the one place prompts move from hashes to files automatically — and it's user-initiated.

## Delivery Health

Derived from `uber_deliveries`:

| Metric | Query |
|--------|-------|
| `delivery_success_rate{channel}` | `COUNT(status='sent') / COUNT(*) over last 7d` |
| `delivery_latency_p95{channel}` | span `uber.delivery.driver_call` p95 |
| `delivery_fail_streak{channel}` | consecutive failures at tail |

Surface in the eval dashboard. Alert if `delivery_success_rate < 0.8` over 24h for any enabled channel.

## CLI

| Command | Description |
|---------|-------------|
| `gctrl uber eval run` | Score all briefs from the last 7d that lack scores |
| `gctrl uber eval show <brief-id>` | All scores for a brief |
| `gctrl uber eval regression` | Recent regression alerts |
| `gctrl uber eval prompts` | Per-prompt-hash rolling scores |
| `gctrl uber eval ab ...` | A/B harness (M4+) |
| `gctrl uber budget status` | Today's spend + remaining + last 7d trend |
| `gctrl uber budget bypass --hours N` | Temporary budget override |
| `gctrl uber scrape-health` | Per-domain scrape stats |
| `gctrl uber score <brief> --name quality --value <0..1>` | Record human score |

## HTTP Routes

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/uber/briefs/{id}/score` | Human score submit (`{name, value, note?}`) |
| GET | `/api/uber/eval/summary` | Rollup: dimensions × 7/30-day trends |
| GET | `/api/uber/eval/prompts` | Per-prompt-hash score table |
| GET | `/api/uber/eval/regressions` | Recent `eval_regression` alerts |
| GET | `/api/uber/scrape-health` | Per-domain stats |
| GET | `/api/uber/budget` | Budget window + spend |
| POST | `/api/uber/budget/bypass` | Temporary override |

## Observability

Spans:

| Span | Attributes |
|------|------------|
| `uber.eval.brief` | brief_id, dimensions, regression_count |
| `uber.eval.llm_judge` | persona, cost_usd, sample_size |
| `uber.eval.baseline` | dimension, baseline7d, current, threshold |

Eval is part of the brief's total cost — the cost of the judge call rolls up into `uber_briefs.cost_usd` via a `derived_from_brief_id` metadata hint on the judge session.

## Invariants

1. **Every `rendered` brief has auto-eval rows within 60s** — enforced by a Scheduler watchdog that re-enqueues the eval job if missing.
2. **Human scores are never overwritten by auto scores** — they write to different `name` values (`quality` is human-only).
3. **Prompt hash is always recorded** — a score row with no linkable `prompt_hash` metadata is a bug (missing curator hash propagation).
4. **No eval runs on a brief whose status is `failed`** — failed briefs don't have usable content to measure.

## Open Questions

1. Should accuracy (LLM-judge) run on every brief or 10% sample? — depends on judge cost; start sampled.
2. Is Spearman the right A/B comparator, or should we weight by item position? — defer to M4 harness design.
3. How do we evaluate the deepdive pipeline? It has 1 item — citation-coverage still applies, but rank-order doesn't. — M3 follow-up.
4. Do we alert on *improvements*? "Your briefs got 20% better" is valuable context for prompt promotion. — M4 backlog.

## Related

- [briefing-pipeline.md § Persist + Score](briefing-pipeline.md#5-persist--score) — upstream handoff
- [delivery.md § Delivery Health](delivery.md#observability) — delivery metrics
- [domain-model.md § 2.4](domain-model.md#24-alert) — alert shape
- [domain-model.md § 5](domain-model.md#5-alert-payload-shapes) — alert payload schemas
- [kernel guardrails spec](../../../specs/architecture/kernel/guardrails.md) — policy engine
