# Uebermensch — Profile & Vault

> The profile directory is also the **Obsidian vault** — a single markdown-first root with exactly four top-level folders organised around the user's relationship with their Chief of Staff:
>
> - `directives/` — standing orders **for CoS** (config, theses, research interests, prompts)
> - `input/` — material **for me to read**; CoS digests and surfaces it (raw fetches, wiki, briefs, reports)
> - `output/` — **my own writing**; CoS reviews and suggests (drafts, memos, position papers)
> - `action/` — things awaiting **my greenlight** (strategies, plans, calendar events, executive tasks)
>
> The user opens this directory in Obsidian; the app reads it; R2 syncs it.

## Location & Identity

- Default path: `~/uebermensch-vault` — overridable via `UBER_VAULT_DIR` (alias `UBER_PROFILE_DIR` retained for continuity).
- The directory is a **git repository** the user owns *and* an **Obsidian vault** the user opens — one location, two hats.
- `gctrl uber vault init` scaffolds an empty vault at `$UBER_VAULT_DIR` from the template (`directives/`, `input/`, `output/`, `action/`, `.gitignore`, `README.md`).

The identity (`identity.slug` × machine fingerprint) gates sync: each vault is keyed to one user identity; vault content MUST NOT leak between identities in shared storage. `identity.slug` is the canonical machine id — lowercase, `[a-z0-9-]+`, derived from `identity.name` at vault-init time (user may override). `identity.name` is the display name used in UI + generated markdown; it MAY contain spaces, mixed case, and non-ASCII.

### Four root folders, role-oriented

The vault always has exactly four top-level folders. Each one captures one direction of the human↔CoS relationship:

| Root | Whose desk | Purpose |
|------|-----------|---------|
| `directives/` | CoS reads | Standing orders the user gives CoS — identity, topics, sources, theses, avoid list, personas, research interests, ad-hoc prompts. CoS treats this folder as authoritative config. |
| `input/` | User reads | Material CoS surfaces for the user — raw URL fetches, the LLM-maintained wiki, daily briefs, weekly + per-prompt reports. CoS digests source material so the user can scan it efficiently. |
| `output/` | User writes | The user's own drafts, memos, essays, position papers. CoS reviews, critiques, and suggests improvements; CoS does not author here. |
| `action/` | User decides | Time-bound and decision-bound items awaiting human greenlight — active strategies, execution plans, calendar events, executive-level tasks. CoS proposes, the user dispositions. |

The two-tier (authored vs. generated) split determines git and sync behaviour. It cuts across the four roots because some roots mix user authorship and CoS generation:

| Tier | Path glob | Authored by | Git | R2 sync |
|------|-----------|-------------|-----|---------|
| **Authored** (source of truth = user) | `directives/**`, `output/**`, `action/strategies/**`, `action/plans/**`, `action/events/**` (excluding `action/events/generated/**`), `action/tasks/**`, `README.md` | User | ✅ tracked | ✅ |
| **Generated** (source of truth = LLM / app / drivers) | `input/**` (raw, wiki, briefs, reports), `action/events/generated/**`, `.gctrl-uber/**`, `.obsidian/workspace*.json` | `uber-ingest`, `uber-curator`, `uber-deepdive`, app, drivers | ❌ gitignored | ✅ |

R2 syncs both tiers — git is for the authored tier only, so the user can `git diff` meaningful changes without generated noise.

## Vault Layout

```
$UBER_VAULT_DIR/
├── .obsidian/                          # Obsidian workspace (mostly gitignored; see § Obsidian)
│   ├── app.json
│   ├── appearance.json
│   ├── graph.json
│   └── workspace.json                  # gitignored (per-machine)
├── .gitignore                          # excludes input/, action/events/generated/, .gctrl-uber/, .obsidian/workspace*.json
├── .gctrl-uber/                        # app metadata (gitignored; R2-synced)
│   ├── lock.json                       # schema version + last-validated timestamp
│   ├── migrations.log
│   └── vault.index.json                # fast-open manifest: paths → (mtime, hash)
│
├── README.md                           # vault-level readme (rendered in Obsidian home)
│
│  ─── 1. directives/ — standing orders FOR CoS (authored; git-tracked) ───
├── directives/
│   ├── profile.md                      # identity, budgets, delivery, brief cadence (YAML frontmatter)
│   ├── topics.md                       # topics of interest (rank prior + watchlists; YAML frontmatter)
│   ├── sources.md                      # configured feeds: RSS, SEC, markets, manual (YAML frontmatter)
│   ├── avoid.md                        # style / topic negatives in natural language
│   ├── personas.md                     # persona → model + prompt path map (optional; YAML frontmatter)
│   ├── me.md                           # free-form self-description; fed as system context
│   ├── projects.md                     # active projects + commitments; fed as system context
│   ├── personas/                       # per-persona prompt overrides (optional)
│   │   ├── uber-curator.md
│   │   ├── uber-ingest.md
│   │   ├── uber-deepdive.md
│   │   └── uber-evaluator.md
│   ├── theses/                         # one file per open thesis (analytical frame)
│   │   ├── llm-tooling-consolidation.md
│   │   └── prediction-market-liquidity.md
│   ├── research/                       # weekly research-interest configs (drive `gctrl uber report`)
│   │   ├── japan-macro.md
│   │   └── us-midterms-2026.md
│   └── prompts/                        # one-shot research questions (drive `gctrl uber prompts process`)
│       └── what-is-claudes-real-moat.md
│
│  ─── 2. input/ — material FOR me to read (generated; gitignored, R2-synced) ───
├── input/
│   ├── raw/                            # driver-fetched + manually-pulled URL summaries
│   │   ├── 2026-04-18--anthropic-news-claude-opus-4-7.md
│   │   └── 2026-04-17--sec-10k-msft-q3.md
│   ├── wiki/                           # LLM-maintained knowledge graph
│   │   ├── index.md
│   │   ├── log.md
│   │   ├── entities/
│   │   │   ├── companies/
│   │   │   ├── people/
│   │   │   └── orgs/
│   │   ├── topics/
│   │   │   ├── sectors/
│   │   │   ├── macro/
│   │   │   └── markets/
│   │   ├── synthesis/
│   │   └── questions/
│   ├── briefs/                         # one markdown file per brief
│   │   ├── 2026-04-18.md
│   │   ├── 2026-04-19.md
│   │   └── deepdive/
│   │       └── thesis-llm-tooling-consolidation-2026-04-15.md
│   └── reports/                        # weekly indexes + per-prompt consolidated answers
│       ├── 2026-W17.md
│       └── what-is-claudes-real-moat.md
│
│  ─── 3. output/ — MY writing; CoS reviews + suggests (authored; git-tracked) ───
├── output/
│   └── drafts/                         # WIP essays, memos, position papers, emails (user-organised)
│       └── 2026-04--essay-on-japan-macro.md
│
│  ─── 4. action/ — things awaiting MY greenlight (mostly authored; git-tracked) ───
└── action/
    ├── strategies/                     # active positioning decisions ("I'm long X because thesis Y")
    │   └── long-anthropic-secondary.md
    ├── plans/                          # execution plans (multi-step, dated)
    │   └── 2026-q2-rebalance.md
    ├── events/                         # calendar — authored top-level + driver under generated/
    │   ├── 2026-05-08--board-meeting.md           # authored (source: user)
    │   ├── recurring/                              # optional RRULE files (authored)
    │   │   └── weekly-team-standup.md
    │   └── generated/                              # driver-pulled (gitignored, R2-synced)
    │       ├── 2026-05-21--nvda-q1-2026-earnings.md
    │       └── 2026-06-12--fomc-statement.md
    └── tasks/                          # executive-level todos (NOT issue-tracker level)
        └── review-portfolio-allocation.md
```

The four roots correspond to four directions of attention:

```
        directives/  ───┐                              ┌──▶  input/briefs/
                        │                              │
        input/raw/  ────┤                              │
                        ├──▶  CoS digestion ───────────┼──▶  input/reports/
   directives/prompts/ ─┤                              │
   directives/research/─┘                              └──▶  input/wiki/   (updates)

   output/        ◀── user writes ──▶  CoS reviews + suggests   (future M4+)

   action/events/ ───▶ surfaces in input/briefs/ + reminders
   action/strategies/, plans/, tasks/  ◀── user authors ──▶  CoS proposes + tracks
```

### What lives here vs. kernel SQLite

| Lives in vault (markdown) | Lives in SQLite (index / event log) |
|---------------------------|--------------------------------------|
| Profile config (`directives/profile.md` YAML + markdown) | — |
| Theses (`directives/theses/`), `directives/me.md`, `directives/projects.md`, `directives/avoid.md` | — |
| Research interest configs (`directives/research/`), prompts (`directives/prompts/`) | — |
| Raw fetched sources (`input/raw/<date>--<slug>.md`) | `context_entries` row (one per file) |
| Wiki entities, topics, synthesis, questions, index, log (`input/wiki/**`) | `context_entries` + `kb_pages` rows |
| Brief bodies (`input/briefs/<date>.md`) | `uber_briefs` index row (vault_path, cost, prompt_hash) |
| Deepdive synthesis (`input/wiki/synthesis/...md`) | `uber_briefs` index row with `kind=deepdive` |
| Reports (`input/reports/<slug>.md`) | `uber_briefs` index row with `kind=report` |
| Calendar events (`action/events/**/*.md`) | `uber_calendar` index row (vault_path, starts_at, kind, source) — see [calendar.md](calendar.md) |
| User drafts (`output/**/*.md`), strategies/plans/tasks (`action/{strategies,plans,tasks}/**`) | — (future: `uber_artifacts` index) |
| — | `uber_brief_items` (per-item search index; rebuild-able from markdown) |
| — | `uber_deliveries` (per-channel send receipts; reused by calendar reminders) |
| — | `uber_calendar_reminders` (pending/sent reminder fan-out) |
| — | `uber_alerts` (eval/scrape/budget alerts) |
| — | `uber_sources_cfg` (last-seen timestamps) |
| — | `scores`, `sessions`, `spans`, `traffic`, `prompt_versions` (kernel tables) |

**Policy:** the vault is authoritative for any content a human might read or edit. SQLite is an index + event log — rebuildable from vault + kernel sessions.

Rule of thumb: if it renders as a page in Obsidian, it lives in the vault. If it's a row of metadata, it lives in SQLite.

## Obsidian Integration

- **Opening:** point Obsidian at `$UBER_VAULT_DIR`. The vault works out of the box with zero plugins.
- **Graph view:** frontmatter + `[[wikilinks]]` light up Obsidian's native graph. Thesis pages act as hubs.
- **Shipped `.obsidian/` defaults** (emitted by `gctrl uber vault init`):
  - `graph.json` — groups coloured by page_type (thesis=gold, source=grey, synthesis=blue, entity=green, topic=purple)
  - `appearance.json` — "Show frontmatter" on
  - `app.json` — `newFileLocation: folder, newFileFolderPath: directives/prompts/`
  - `hotkeys.json` — no custom bindings (respect user preference)
- **Workspace state** (`workspace.json`, `workspace-mobile.json`) is per-machine — gitignored, **not** R2-synced (would cause split-brain between devices).
- **Plugins:** none required. If user installs community plugins (e.g. Dataview), plugin data under `.obsidian/plugins/*/data.json` follows the same workspace-state rule — gitignored, not R2-synced.

### Obsidian-friendliness invariants

1. Every markdown file is valid CommonMark + YAML frontmatter parseable by Obsidian.
2. Every `[[slug]]` resolves to exactly one file by filename stem — no typed prefixes (`[[thesis:slug]]` is forbidden; see [knowledge-base.md § Wikilink Conventions](knowledge-base.md#wikilink-conventions)).
3. Filenames are Obsidian-safe — no `:`, `?`, `*`, `<`, `>`, `|`, `"`, `\`, `/` in stems.
4. The LLM ingest persona writes frontmatter at the top (between `---` lines) — Obsidian reads it natively.
5. Generated content is self-contained — deleting `input/` and `action/events/generated/` does not corrupt the authored tier (`directives/`, `output/`, the rest of `action/`).

## Sync (R2)

The whole vault syncs to R2 — not just the wiki. Configured via kernel `SyncConfig` pointing at `$UBER_VAULT_DIR`:

```toml
[sync.vault.uber]
root = "$UBER_VAULT_DIR"
r2_bucket = "gctrl-uber-vault"
r2_prefix = "vault/{identity.slug}/"          # expands once at daemon start; slug is immutable thereafter
include = ["**/*.md"]
exclude = [".obsidian/workspace*.json", ".obsidian/plugins/*/data.json", ".git/**", ".gctrl-uber/lock.json"]
conflict_policy = "local-wins-with-warning"
```

### Object key layout

Every synced file maps 1:1 to an R2 object:

```
s3://<r2_bucket>/vault/<identity.slug>/<vault_relative_path>
```

Examples for `identity.slug = "vincent"`:
- `$UBER_VAULT_DIR/input/briefs/2026-04-18.md`                  → `vault/vincent/input/briefs/2026-04-18.md`
- `$UBER_VAULT_DIR/input/wiki/entities/companies/nvidia.md`     → `vault/vincent/input/wiki/entities/companies/nvidia.md`
- `$UBER_VAULT_DIR/directives/theses/ai-infra-capex.md`         → `vault/vincent/directives/theses/ai-infra-capex.md`
- `$UBER_VAULT_DIR/directives/prompts/what-is-claudes-real-moat.md` → `vault/vincent/directives/prompts/what-is-claudes-real-moat.md`
- `$UBER_VAULT_DIR/action/events/2026-05-08--board-meeting.md`  → `vault/vincent/action/events/2026-05-08--board-meeting.md`

Per-object metadata: `content-sha256`, `device-id`, `updated-at` (ISO8601). These are written into R2 object user metadata so the sync can detect changes without downloading the body.

### Push protocol (local → R2)

1. `VaultWatcher` emits `PathChanged(path)` on `fs.watch`.
2. Sync debounces 30s then batches per-file:
   - Compute `local_sha = sha256(file_bytes)`.
   - `HEAD s3://<key>` → `remote_sha = metadata.content-sha256` (absent = new file).
   - If `local_sha == remote_sha` → no-op.
   - If `remote_sha` is set AND `remote.device-id != self.device-id` AND `remote.updated-at > last_pulled_at` → **conflict** (see below).
   - Else `PUT s3://<key>` with metadata + content.
3. On `DELETE` fs event: append `{path, sha_at_delete, device_id, deleted_at}` to `$UBER_VAULT_DIR/.gctrl-uber/tombstones.jsonl`, then `DELETE s3://<key>`. Tombstones expire after 30d (prune job).

### Pull protocol (R2 → local)

1. Every 5 min (or on `gctrl uber vault pull`):
   - `LIST s3://<prefix>` → set of `(key, remote_sha, device-id, updated-at)`.
   - For each key: compare against local file's sha. If different AND the file is not locally dirty (i.e. `local_sha == last_pulled_sha`) → `GET` and overwrite atomically (`<path>.tmp` → fsync → rename).
   - If locally dirty → **conflict** (see below).
   - Local files not present in the remote LIST AND not recently written (stale > 1h) → leave alone (may be pending push).
2. Process tombstones from the remote: a tombstone key (`.gctrl-uber/tombstones.jsonl`) is treated the same as any markdown — it is pulled, its entries are applied as local deletes (if the local file's sha matches the `sha_at_delete`).

### Conflict handling

Conflict = same path modified on ≥ 2 devices between syncs. Resolution:
- Local file stays at its current contents (local-wins).
- The remote version is pulled to `<stem>.conflict-<remote_device_id>-<remote_updated_at>.md` (same directory, side-by-side).
- An inbox alert fires: `conflict: <vault_path>` with urgency `low`. User opens the folder in Obsidian, diffs the two files, deletes the conflict file when done.
- CLI: `gctrl uber vault conflicts` lists outstanding `<stem>.conflict-*.md` files under the vault.

### Bootstrap: `gctrl uber vault pull --from r2`

Fresh device:

1. `gctrl uber vault init --identity-slug <slug> --from r2` → creates `$UBER_VAULT_DIR` locally, writes a minimal `.gctrl-uber/` control dir.
2. `LIST s3://<bucket>/vault/<slug>/` → download every key to its corresponding vault path.
3. Write `last_pulled_at = <now>` and record `last_pulled_sha` per file in `.gctrl-uber/index.jsonl`.
4. Daemon registers the sync mount; VaultWatcher starts.
5. User opens `$UBER_VAULT_DIR` in Obsidian.

After bootstrap, pulls are incremental and the daemon runs the push/pull protocol on its normal cadence.

### Cadence + limits

- **Debounce:** 30s after local change (rapid edits coalesce into one push).
- **Pull interval:** every 5 min.
- **Max file size:** any file > 256 KiB logs a warning; only markdown + config files are expected in the vault.
- **Rate limit:** ≤ 1 `PUT` / file / 10s to avoid thrash on rapid Obsidian saves.

### Why R2 for the whole vault (not just wiki)

- Obsidian users expect one synced vault, not a hybrid.
- R2 sync is cheap — markdown compresses well; the vault is small (< 50 MB typical).
- Kernel already has the sync primitive — we just add a second mount.
- Git remains the semantic audit trail for authored content; R2 is the byte-level replication layer.

### Not R2-synced

- `.obsidian/workspace*.json` — per-machine UI state
- `.obsidian/plugins/*/data.json` — per-machine plugin state
- `.git/` — handled by git, not R2
- `.gctrl-uber/lock.json`, `.gctrl-uber/index.jsonl` — daemon-local control files

## .gitignore (shipped default)

```
# CoS-generated material for me to read — synced via R2, not git
/input/                 # raw/, wiki/, briefs/, reports/

# Driver-pulled calendar events (authored events at action/events/ top level stay tracked)
/action/events/generated/

# Authored content stays git-tracked:
#   /directives/   — standing orders for CoS
#   /output/        — my own writing
#   /action/{strategies,plans,events,tasks}/ (excl. events/generated/)
#   README.md

# App metadata
/.gctrl-uber/

# Obsidian per-machine state
/.obsidian/workspace*.json
/.obsidian/plugins/*/data.json
/.obsidian/plugins/*/data-*.json
```

## Vault Template

`gctrl uber vault init` emits this shape at `$UBER_VAULT_DIR`:

- `directives/profile.md`, `directives/topics.md`, `directives/sources.md` — minimal viable config (data in YAML frontmatter)
- `directives/theses/`, `directives/research/`, `directives/prompts/` — empty
- `directives/me.md`, `directives/projects.md`, `directives/avoid.md` — stubs
- `directives/personas/` — shipped persona-prompt defaults
- `input/raw/`, `input/wiki/`, `input/briefs/`, `input/reports/` — empty (filled on first ingest / brief / report)
- `output/` — empty (user creates subdirs as they like)
- `action/strategies/`, `action/plans/`, `action/events/`, `action/tasks/` — empty
- `.obsidian/` — default graph + appearance config
- `.gitignore`
- `README.md` — short onboarding note

## Schema

The Effect-TS `Profile` schema is canonical (see [domain-model.md § 2.5](domain-model.md#25-profile-read-only-projection)). This section documents the **on-disk** markdown shape and how it maps to that schema. Each config file is a CommonMark markdown document whose frontmatter carries the data; the body is free-form notes. Loaders parse the frontmatter with `gray-matter`.

### directives/profile.md

Frontmatter:

```yaml
schema_version: 1

identity:
  name: "Vincent"
  slug: "vincent"             # lowercase, [a-z0-9-]+; used as R2 prefix and device-agnostic id
  tz: "Asia/Hong_Kong"
  lang: "en"

budgets:
  daily_usd: 2.00
  per_brief_usd: 0.50
  max_tokens_per_brief: 32000

delivery:
  brief:
    # Default body shape for daily briefs. Cadence lives in
    # `directives/schedules.md`; see [scheduling.md](scheduling.md).
    # The legacy `cron:` field on this block is deprecated — kept transitionally
    # as the fallback when `directives/schedules.md` is absent; ignored otherwise.
    format: "long"             # long | short | digest
    cron: "0 30 7 * * *"       # DEPRECATED — see scheduling.md

  channels:
    app:
      enabled: true
      driver: "app"
      target_ref: "default"
      window: { start_local: "00:00", end_local: "23:59", tz: "Asia/Hong_Kong" }
    telegram_primary:
      enabled: true
      driver: "telegram"
      target_ref: "tg:chat:@me"             # resolved by driver-telegram
      window: { start_local: "08:00", end_local: "22:00", tz: "Asia/Hong_Kong" }
      silent: false
    discord_feed:
      enabled: false
      driver: "discord"
      target_ref: "dc:webhook:env:DISCORD_FEED_URL"

  personas:                    # persona → override prompt path (relative to $UBER_VAULT_DIR)
    uber-curator: "directives/personas/uber-curator.md"
    uber-deepdive: "directives/personas/uber-deepdive.md"

  retention:
    briefs_days: 180
    alerts_days: 90

timeboxes:
  working_windows:                            # planner schedules sessions only inside these windows
    - { days: [mon, tue, wed, thu, fri], start: "07:00", end: "08:00" }
    - { days: [sat, sun], start: "08:00", end: "10:00" }
  default_session_minutes: 60
  default_sessions_per_week: 3
  stalled_threshold: P14D                     # ISO 8601 duration; stall alert window before deadline
  replan_policy: pin-edited                   # pin-edited | redistribute-all
  coaching:
    default_channel: telegram_primary
```

Maps to: `Profile.identity`, `Profile.budgets`, `Profile.delivery`, `Profile.timeboxes`. The `timeboxes:` block is optional; missing means no working-window constraint, defaults `60` minutes / `3` sessions per week, `P14D` stall window. Full semantics in [calendar-timeboxes.md § Profile Schema Additions](calendar-timeboxes.md#profile-schema-additions).

### directives/topics.md

Frontmatter:

```yaml
topics:
  - slug: "ai-dev-workflows"
    title: "Latest AI development workflows"
    horizon: "both"            # short | long | both
    weight: 1.0
    watchlist: ["claude-code", "agent-sdk", "cursor", "aider", "codex"]

  - slug: "prediction-market"
    title: "Prediction market mechanics + liquidity"
    horizon: "long"
    weight: 0.8
    watchlist: ["kalshi", "polymarket"]

  - slug: "ai-infra-open-source"
    title: "Open-source AI infra (not products)"
    horizon: "long"
    weight: 0.6
    watchlist: ["vllm", "dspy", "effect-ts"]

  # A topic can also be a person. `kind: person` opens up two affordances:
  #   1. `aliases` are matched in source bodies in addition to the slug —
  #      so the topic catches "Sam Altman" and "@sama" without slug-shaping.
  #   2. `gctrl uber ingest person` discovers Google News RSS for the title
  #      (and an "interview OR podcast OR talk" variant), plus any explicit
  #      `discovery.feeds`, and ingests recent items tagged with this slug.
  - slug: "sam-altman"
    title: "Sam Altman"
    kind: "person"
    horizon: "both"
    weight: 0.7
    aliases: ["Sam Altman", "@sama"]
    discovery:
      google_news: true
      interviews: true
      feeds: ["https://blog.samaltman.com/posts.atom"]
```

Maps to: `Profile.topics`. Slugs are the lingua franca — they appear in theses, source topic filters, brief item tags, and rank priors.

### directives/sources.md

Frontmatter:

```yaml
sources:
  - slug: "anthropic-news"
    driver: "rss"
    url: "https://www.anthropic.com/news/rss.xml"
    cadence: "0 */15 * * * *"   # every 15 min
    topics: ["ai-dev-workflows"]

  - slug: "kalshi-macro"
    driver: "markets"
    url: null
    cadence: "0 0 */2 * * *"    # every 2 hours
    topics: ["prediction-market"]
    config:
      venue: "kalshi"
      markets: ["INXW-26", "GDPQ1-26", "CPIYOY-26"]

  - slug: "sec-watchlist"
    driver: "sec"
    cadence: "0 0 * * * *"      # hourly
    topics: ["ai-infra-open-source"]
    config:
      tickers: ["MSFT", "NVDA", "GOOGL"]
      filing_types: ["10-K", "10-Q", "8-K", "S-1"]

  - slug: "manual-reading"
    driver: "manual"             # items added via `gctrl uber ingest --url`
    cadence: "@never"
    topics: ["ai-dev-workflows", "prediction-market", "ai-infra-open-source"]
```

Maps to: `Profile.sources`. `config` is driver-specific opaque JSON — the kernel driver decodes it.

### directives/theses/\<slug\>.md

One file per thesis. Frontmatter is structured; body is free-form markdown. Body is fed into curator + deepdive prompts verbatim; frontmatter drives filtering.

A thesis is the user's **analytical frame** — a hypothesis about the world that CoS uses to filter and tag incoming material. (Distinct from `action/strategies/` which are positioning *decisions* derived from theses.)

```markdown
---
slug: llm-tooling-consolidation
title: "LLM coding tools consolidate around Claude + open-source runners"
stance: long                   # long | short | watch | avoid
conviction: medium             # high | medium | low
opened_at: 2026-02-01
last_reviewed_at: 2026-04-10
topics: [ai-dev-workflows, ai-infra-open-source]
watchlist: [claude-code, cursor, aider, codex, agent-sdk]
disconfirming:                 # explicit: what would break this thesis
  - "A non-Anthropic model leaps ahead on SWE-bench without parity on tooling ergonomics"
  - "Cursor ships proprietary protocol that locks in users away from CLI/agent SDK path"
---

## Thesis
<!-- the actual thesis statement in the user's own words -->

The agentic coding space is converging on two surfaces: (1) editor-first tools
pinned to one model family, and (2) CLI/SDK agents that run models as
interchangeable workers. Consolidation favors the second shape because...

## Key questions
1. Do enterprise teams pay for editor polish or for agent fleet orchestration?
2. ...

## Signals I watch
- Weekly release cadence of open agent frameworks
- ...
```

Maps to: `Profile.theses[]`. The body is passed to `uber-deepdive` on thesis updates; frontmatter drives candidate filtering in the curator.

### directives/avoid.md

Free-form markdown — used as a system-prompt excerpt for every persona.

```markdown
# Styles I avoid

- Hype-driven tweets and "TAM is infinite" claims.
- Unverified rumors; skip unless a primary source is linked.
- Single-analyst-opinion framings without supporting data.
- VC-blog posts restating public documentation.
- ...
```

Maps to: `Profile.avoid[]` (one entry per top-level bullet — parsed as lines).

### directives/personas.md (optional)

Frontmatter:

```yaml
personas:
  uber-curator:
    model: "@cf/google/gemma-4-26b-a4b-it"  # routed via Cloudflare AI Gateway
    prompt_path: "directives/personas/uber-curator.md"
  uber-ingest:
    model: "claude-haiku-4-5"
    prompt_path: "directives/personas/uber-ingest.md"
  uber-deepdive:
    model: "@cf/google/gemma-4-26b-a4b-it"  # routed via Cloudflare AI Gateway
    prompt_path: "directives/personas/uber-deepdive.md"
  uber-evaluator:
    model: "claude-haiku-4-5"
    prompt_path: "directives/personas/uber-evaluator.md"
```

If omitted, the shipped defaults under `apps/uebermensch/personas/` are used unchanged. Personas declare `model` at profile level so users can swap defaults without touching app code.

### directives/personas/\<persona\>.md (optional)

Prompt templates using `{{var}}` placeholders. See [briefing-pipeline.md § Prompt Contracts](briefing-pipeline.md#prompt-contracts) for the variables each persona receives.

Overrides MUST keep the shipped template's required variables (parser rejects on missing) — but MAY add more. Missing required vars fail profile validation.

### directives/research/\<slug\>.md (optional)

Long-running research-interest configs. Drive `gctrl uber report` (weekly digest per interest). Frontmatter declares topics, weight, horizon, and (optionally) field familiarity; body is a free-form description that the curator reads.

```markdown
---
slug: japan-macro
title: "Japan macroeconomics"
question: "What's moving BoJ policy and how does it affect Japan equities?"
topics: [japan-macro]
sources: [boj-feed, mof-feed]   # optional — limit to specific source slugs
horizon: both                    # short | long | both
weight: 1.0
field_familiarity: expert        # expert | novice — adjusts depth of explanation
---

Why I care: positioning around BoJ rate path, JPY moves, and JGB curve. ...
```

### directives/prompts/\<slug\>.md (optional)

The inbox surface for ad-hoc input to CoS. Drop a free-form markdown note here — bullet points, half-formed ideas, a link you saw. `gctrl uber prompts process` reads each pending file and dispatches on `kind`:

- **`kind: thought`** (default when omitted) — CoS extracts intent, generates 3–7 sharp clarifying questions, maps the note to existing wiki/source pages, and proposes addendums to the user's theses under `directives/theses/`. The structured analysis is written to `input/reports/<slug>.md` (sections: Intent / Questions / Relevant sources / Suggested thesis updates) and the source note is **moved** to `directives/prompts/archived/<slug>.md` so the inbox stays a true to-do list. CoS NEVER edits authored thesis files directly — addendums are suggestions for the user to paste in Obsidian.
- **`kind: query`** (opt-in) — one-shot Q&A. CoS runs an LLM research pass with relevant wiki context, writes the consolidated answer to `input/reports/<slug>.md`, and stamps the prompt's frontmatter with `status: processed`, `output`, `processed_at`, `content_hash`, `prompt_hash`, and `model`. The source file is left in place (frontmatter updated; body untouched) so the user can `status: rerun` it.

Minimum frontmatter (everything optional except `slug`, which defaults to filename if omitted):

```markdown
---
slug: claude-cli-distribution
title: "Claude Code CLI distribution moat"     # optional — defaults to titlized stem
topics: [ai-dev-workflows]                      # optional — narrows wiki + thesis context
kind: thought                                   # thought (default) | query
status: pending                                 # pending | processed | failed | rerun
---

Note/question goes here in free-form markdown. Anything you'd jot in a notebook works.
Uebermensch reads the whole file.
```

After processing (both kinds):

```yaml
status: processed
output: input/reports/claude-cli-distribution.md
processed_at: 2026-05-03T08:14:11Z
content_hash: sha256:…
prompt_hash: sha256:…
model: claude-opus-4-7
```

For `kind: query`: set `status: rerun` (or delete the post-processing fields) to re-process. The query file itself is never overwritten by the LLM — only its frontmatter is updated; the body stays as the user wrote it.

For `kind: thought`: the source file lives at `directives/prompts/archived/<slug>.md` after a successful run. To re-process, move it back to `directives/prompts/<slug>.md` (the loader skips the `archived/` subtree). Re-archiving fails with `kind: collision` if the destination already exists — investigate before overwriting.

### directives/me.md / directives/projects.md

Free-form markdown. Loaded into the system context for every Uebermensch persona (concatenated, wrapped in `<user_profile>...</user_profile>` sentinels).

- **directives/me.md** — who the user is, preferred depth, domain expertise, tone, pet peeves.
- **directives/projects.md** — active projects + commitments (so action items land against real work).

These two files anchor every prompt — they're the highest-leverage artifacts in the profile.

### action/ subdirs (sketch)

Detailed schemas TBD; here's the minimum the daemon currently expects. The four subdirs share one rule: every file MUST carry a top-level frontmatter with at least `slug` and `title`, plus a `status` ∈ `{open, in_progress, blocked, done, archived}`.

- **`action/strategies/<slug>.md`** — active positioning decisions ("I'm long X because thesis Y"). Frontmatter MAY reference one or more `theses: [<thesis-slug>, ...]` to link the strategy to the analytical frame it rides on.
- **`action/plans/<slug>.md`** — multi-step execution plans (rebalances, position builds, write-up calendars). Frontmatter typically carries `target_date` and `steps: [...]` checklist.
- **`action/events/...`** — calendar events. Authored events live at `action/events/<YYYY-MM-DD>--<slug>.md`; driver-pulled events under `action/events/generated/`. Recurring rules under `action/events/recurring/`. Full schema in [calendar.md](calendar.md).
- **`action/tasks/<slug>.md`** — executive-level todos (e.g. "review portfolio allocation", "reply to Y's intro request"). NOT for issue-tracker-grain work.

CoS reads `action/` to (a) surface upcoming events in briefs, (b) flag stale strategies/plans (no `last_reviewed_at` update in 30d), (c) propose new tasks based on brief items the user marked actionable. The user owns the dispositioning — CoS proposes, never closes.

## Validation Rules

`gctrl uber profile validate` runs these checks — ALL MUST pass for the daemon to start. Failures emit `ProfileInvalid` (see [domain-model.md § 3](domain-model.md#3-domain-errors-schemataggederror)).

### Structural

1. `directives/profile.md` frontmatter parses as YAML and satisfies the `Profile` schema.
2. `directives/topics.md` frontmatter satisfies `Profile.topics` and contains ≥ 1 topic.
3. `directives/sources.md` frontmatter satisfies `Profile.sources`; every `topics: [...]` entry matches a topic slug.
4. Every file under `directives/theses/` has valid frontmatter and a non-empty body.
5. Every thesis `topics: [...]` entry matches a topic slug.
6. `directives/personas.md` (if present) references files that exist under `directives/personas/`.
7. `directives/personas/<persona>.md` (if present) declares all required template variables.
8. `directives/prompts/<slug>.md` (if present) frontmatter parses; `slug` is unique within `directives/prompts/` and matches `[a-z0-9-]+`.
9. `directives/research/<slug>.md` (if present) frontmatter parses; every `topics: [...]` entry matches a topic slug.
10. The vault MUST contain only the four canonical roots (`directives/`, `input/`, `output/`, `action/`) plus permitted top-level files (`README.md`, `.gitignore`, `.obsidian/`, `.gctrl-uber/`, `.git/`). Foreign top-level directories fail validation with a remediation hint.

### Semantic

1. `schema_version` matches a known version; mismatch triggers `gctrl uber profile migrate` prompt.
2. `budgets.daily_usd > 0`, `budgets.per_brief_usd ≤ budgets.daily_usd`.
3. At least one channel has `enabled: true`.
4. `delivery.brief.cron` (legacy fallback only — see [scheduling.md § Migration](scheduling.md#migration-from-deliverybriefcron)) is a valid 6-field cron when present.
5. `identity.tz` is a valid IANA timezone.
6. No topic slug collides with a reserved namespace (`system`, `uber`, `eval`).
7. Sum of referenced `watchlist` entries across topics ≤ 500 (soft limit; warning only).

### Security

1. No YAML file references an env var outside an allowlist (`UBER_*`, `TELEGRAM_*`, `DISCORD_*`) — prevents accidental leakage of host secrets into profile-driven driver configs.
2. `personas.md` MUST NOT set `model` to a string containing `/` (prevents path-like injection into driver-llm).

Full validator in `apps/uebermensch/src/services/profile-validator.ts`.

## Change Detection

`ProfileService` (see [architecture.md § 6](architecture.md#6-external-vault-integration)) watches the authored tier of `$UBER_VAULT_DIR` (`directives/**`, `output/**`, `action/**` excluding `action/events/generated/**`) with `fs.watch(recursive: true)` and debounces changes at 500 ms. Generated-tier changes (`input/**`, `action/events/generated/**`) emit `kb.page.changed` kernel events, not profile-reload events.

On authored-tier change:

1. Re-parse + re-validate.
2. If valid → emit `ProfileChange` event, reload in-memory profile, re-register Scheduler jobs that reference changed channel configs. Cadence changes live in `directives/schedules.md` and are applied via `gctrl uber schedule sync`, not the profile reload — see [scheduling.md](scheduling.md).
3. If invalid → **keep the previous valid profile**; emit `ProfileInvalid` alert via `uber_alerts`; the CLI + app UI show the error.

Policy: **profile changes apply on next tick**, never mid-brief. A brief in `curating` with an older profile completes with that profile.

Edits made inside Obsidian are indistinguishable from editor/git edits — both land on disk via `fs.watch`. The service does not care how the bytes arrived.

## Migrations

Profile schema versions are immutable. Migrations ship as named, idempotent transforms.

```
apps/uebermensch/migrations/
  0001__initial.ts
  0002__rename_topics_yml_to_topics_yaml.ts
  0003__add_disconfirming_frontmatter.ts
```

```sh
gctrl uber profile migrate              # runs all pending; shows diff; prompts
gctrl uber profile migrate --preview    # shows diff only; exits non-zero if pending
gctrl uber profile migrate --to 2       # migrate up to specific version
```

Migrations MUST:

- Commit to a new branch in the profile repo (`uber-migrate-<from>-<to>-<ts>`).
- Emit a changelog entry to `.gctrl-uber/migrations.log`.
- Be reversible OR declare `irreversible: true` with rationale.

Policy: `daemon start` fails if the profile's `schema_version` is older than the app's — user MUST migrate explicitly; never silent.

## Portability & Sharing

A vault MUST be self-contained — the app MUST NOT rely on anything outside `$UBER_VAULT_DIR` except:

1. Kernel drivers (LLM, messaging, RSS, SEC, markets) — configured via kernel env, not profile.
2. Secrets referenced by env-var name (not value) under driver targets.

Two users MAY share the authored tier of a vault via git fork:

```
user-a/uebermensch-vault   (main)     # authored tier tracked; generated tier absent
   └─ fork → user-b/uebermensch-vault
```

But each user MUST customize `identity` + `delivery.channels` on their fork. Generated content (`input/`, `action/events/generated/`) diverges per user — each user runs their own LLM passes against their own profile. A CI check in the sample vault scaffold warns on `identity.name == "Vincent"` (the template seed) after `gctrl uber vault init`.

## Secrets Handling

Profile MUST NOT contain bearer tokens, API keys, or webhook URLs. Instead, reference by env-var name under `target_ref`:

```yaml
channels:
  discord_feed:
    driver: "discord"
    target_ref: "dc:webhook:env:DISCORD_FEED_URL"   # driver reads env var
```

`gctrl uber profile validate` greps for common token patterns (`sk-`, `xoxb-`, `ghp_`, `tg:bot:\d+:[A-Za-z0-9_-]+`) and **fails validation** on a match. This is belt-and-braces — the primary defense is that profile authors know not to paste keys.

## Read vs. Write Capabilities

| Actor | Authored tier (`directives/**`, `output/**`, `action/**` excl. `events/generated/**`) | Generated tier (`input/**`, `action/events/generated/**`) | Special |
|-------|---------------|----------------|---------|
| Uebermensch daemon (`ProfileService`) | read-only | read-only | may write `.gctrl-uber/lock.json`, `.gctrl-uber/vault.index.json` |
| `BriefingService` / `CuratorService` / `DelivererService` | read-only | write (`input/briefs/`, `input/reports/`, `input/wiki/` incl. `input/wiki/synthesis/`) via `KbPort` | — |
| `IngestService` / drivers | read-only | write `input/raw/**` via `KbPort.ingestUrl`; calendar drivers write `action/events/generated/**` | — |
| `gctrl uber profile migrate` | write (migration branch) | — | acquires exclusive lock |
| LLM personas (via prompt) | **never write** | **never write directly** — writes go via `KbPort`; ingest persona's output is validated before filesystem commit | — |
| User editor (incl. Obsidian) | read+write | read+write (user may edit generated content — daemon picks up changes on next tick) | — |

Enforcement:

- The daemon holds two file descriptors: authored tier `O_RDONLY`; generated tier `O_RDWR` (scoped to `input/` and `action/events/generated/`).
- Migration CLI acquires exclusive lock via `.gctrl-uber/lock.json` for authored writes.
- `KbPort.writePage` (see [domain-model.md § 8](domain-model.md#8-effect-ts-port-shapes-typescript-mirrors)) validates frontmatter + slug uniqueness before commit; invalid writes error out, never corrupt the vault.

## Profile → Runtime Wiring

1. Daemon start → `ProfileService.load()` → parse → emit initial `Profile`.
2. Scheduler reads `Profile.sources[*].cadence` for ingest jobs. Brief/deepdive cadence is registered separately via `gctrl uber schedule sync` from `directives/schedules.md` (see [scheduling.md](scheduling.md)) — kernel rows are created with `target_kind: exec`.
3. `CuratorService` reads `Profile.topics`, `Profile.theses`, `Profile.avoid`, `directives/me.md`, `directives/projects.md` → composes system prompt.
4. `DelivererService` reads `Profile.delivery.channels` → picks drivers, applies windows + silent.
5. `EvaluatorService` reads `Profile.budgets` → sets guardrail thresholds.
6. On `ProfileChange` → re-run steps 2-5; never mid-brief.

## Related

- [domain-model.md § 2.5](domain-model.md#25-profile-read-only-projection) — Effect-TS `Profile` schema
- [scheduling.md](scheduling.md) — `directives/schedules.md` schema + `uber schedule sync`
- [knowledge-base.md](knowledge-base.md) — wiki layout under `$UBER_VAULT_DIR/input/wiki/`
- [briefing-pipeline.md § Prompt Contracts](briefing-pipeline.md#prompt-contracts) — how profile content enters prompts
- [delivery.md § Channel Router](delivery.md#channel-router) — how `channels` config drives fan-out
- [eval.md § Budget Enforcement](eval.md#budget-enforcement) — how `budgets` meet Guardrails
- [calendar.md](calendar.md) — `action/events/` schema + driver write-back
- [kernel sync.md](../../../../vault/specs/architecture/kernel/sync.md) — the R2 sync primitive reused here
