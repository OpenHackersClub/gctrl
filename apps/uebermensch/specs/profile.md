# Uebermensch — Profile & Vault

> The profile directory is also the **Obsidian vault** — a single markdown-first root holding user-authored config (topics, theses, prompts) alongside LLM-generated content (wiki, briefs, synthesis). The user opens this directory in Obsidian; the app reads it; R2 syncs it.

## Location & Identity

- Default path: `~/workspaces/debuggingfuture/uebermensch-profile` — overridable via `UBER_VAULT_DIR` (alias `UBER_PROFILE_DIR` retained for continuity).
- The directory is a **git repository** the user owns *and* an **Obsidian vault** the user opens — one location, two hats.
- A sample vault ships under `apps/uebermensch/vault.sample/` for bootstrap (`gctrl uber vault init --from-sample`).

The identity (`identity.slug` × machine fingerprint) gates sync: each vault is keyed to one user identity; vault content MUST NOT leak between identities in shared storage. `identity.slug` is the canonical machine id — lowercase, `[a-z0-9-]+`, derived from `identity.name` at vault-init time (user may override). `identity.name` is the display name used in UI + generated markdown; it MAY contain spaces, mixed case, and non-ASCII.

### Two content tiers in one vault

| Tier | Path glob | Authored by | Git | R2 sync |
|------|-----------|-------------|-----|---------|
| **Authored** (source of truth = user) | `profile.md`, `topics.md`, `sources.md`, `theses/**`, `prompts/**`, `personas.md`, `avoid.md`, `ME.md`, `projects.md`, `README.md` | User | ✅ tracked | ✅ |
| **Generated** (source of truth = LLM / app) | `wiki/**` (includes `wiki/synthesis/**`, `wiki/sources/**`), `briefs/**`, `.gctrl-uber/**`, `.obsidian/workspace*.json` | LLM personas (`uber-ingest`, `uber-curator`, `uber-deepdive`) + app | ❌ gitignored | ✅ |

R2 syncs both tiers — git is for the authored tier only, so the user can `git diff` meaningful changes without generated noise.

## Vault Layout

```
$UBER_VAULT_DIR/
├── .obsidian/                # Obsidian workspace (mostly gitignored; see § Obsidian)
│   ├── app.json
│   ├── appearance.json
│   ├── graph.json
│   └── workspace.json        # gitignored (per-machine)
├── .gitignore                # excludes wiki/ (incl. wiki/synthesis/), briefs/, .gctrl-uber/, .obsidian/workspace*.json
├── .gctrl-uber/              # app metadata (gitignored; R2-synced)
│   ├── lock.json             # schema version + last-validated timestamp
│   ├── migrations.log
│   └── vault.index.json      # fast-open manifest: paths → (mtime, hash)
│
├── README.md                 # vault-level readme (optional, rendered in Obsidian home)
│
│  ─── Authored (git-tracked) ───
├── profile.md                # top-level config: identity, budgets, delivery, brief cadence (YAML frontmatter)
├── topics.md                 # topics of interest (rank prior + watchlists; YAML frontmatter)
├── sources.md                # RSS, SEC, markets, manual sources (YAML frontmatter)
├── avoid.md                  # style / topic negatives in natural language
├── personas.md               # persona → model + prompt path map (optional; YAML frontmatter)
├── ME.md                     # free-form self-description; fed as system context
├── projects.md               # projects + commitments; fed as system context
├── prompts/                  # per-persona prompt overrides (optional)
│   ├── uber-curator.md
│   ├── uber-ingest.md
│   ├── uber-deepdive.md
│   └── uber-evaluator.md
├── theses/                   # one file per open thesis
│   ├── llm-tooling-consolidation.md
│   └── prediction-market-liquidity.md
│
│  ─── Generated (gitignored; R2-synced) ───
├── briefs/                   # one markdown file per brief
│   ├── 2026-04-18.md
│   ├── 2026-04-19.md
│   └── deepdive/
│       └── thesis-llm-tooling-consolidation-2026-04-15.md
├── wiki/                     # kb pages — mirrors kernel gctrl-kb layout
│   ├── index.md
│   ├── log.md
│   ├── entities/
│   │   ├── companies/
│   │   ├── people/
│   │   └── orgs/
│   ├── topics/
│   │   ├── sectors/
│   │   ├── macro/
│   │   └── markets/
│   ├── sources/
│   ├── synthesis/
│   └── questions/
```

### What lives here vs. kernel SQLite

| Lives in vault (markdown) | Lives in SQLite (index / event log) |
|---------------------------|--------------------------------------|
| Profile config (YAML + markdown) | — |
| Theses, ME.md, projects.md, avoid.md | — |
| Wiki pages (sources, entities, topics, synthesis, questions) | — |
| Brief bodies (`briefs/<date>.md`) | `uber_briefs` index row (vault_path, cost, prompt_hash) |
| Deepdive synthesis page (`wiki/synthesis/...md`) | `uber_briefs` index row with `kind=deepdive` |
| — | `uber_brief_items` (per-item search index; rebuild-able from markdown) |
| — | `uber_deliveries` (per-channel send receipts) |
| — | `uber_alerts` (eval/scrape/budget alerts) |
| — | `uber_sources_cfg` (last-seen timestamps) |
| — | `scores`, `sessions`, `spans`, `traffic`, `prompt_versions` (kernel tables) |

**Policy:** the vault is authoritative for any content a human might read or edit. SQLite is an index + event log — rebuildable from vault + kernel sessions.

Rule of thumb: if it renders as a page in Obsidian, it lives in the vault. If it's a row of metadata, it lives in SQLite.

## Obsidian Integration

- **Opening:** point Obsidian at `$UBER_VAULT_DIR`. The vault works out of the box with zero plugins.
- **Graph view:** frontmatter + `[[wikilinks]]` light up Obsidian's native graph. Thesis pages act as hubs.
- **Shipped `.obsidian/` defaults** (in `vault.sample`):
  - `graph.json` — groups coloured by page_type (thesis=gold, source=grey, synthesis=blue, entity=green, topic=purple)
  - `appearance.json` — "Show frontmatter" on
  - `app.json` — `newFileLocation: folder, newFileFolderPath: inbox/`
  - `hotkeys.json` — no custom bindings (respect user preference)
- **Workspace state** (`workspace.json`, `workspace-mobile.json`) is per-machine — gitignored, **not** R2-synced (would cause split-brain between devices).
- **Plugins:** none required. If user installs community plugins (e.g. Dataview), plugin data under `.obsidian/plugins/*/data.json` follows the same workspace-state rule — gitignored, not R2-synced.

### Obsidian-friendliness invariants

1. Every markdown file is valid CommonMark + YAML frontmatter parseable by Obsidian.
2. Every `[[slug]]` resolves to exactly one file by filename stem — no typed prefixes (`[[thesis:slug]]` is forbidden; see [knowledge-base.md § Wikilink Conventions](knowledge-base.md#wikilink-conventions)).
3. Filenames are Obsidian-safe — no `:`, `?`, `*`, `<`, `>`, `|`, `"`, `\`, `/` in stems.
4. The LLM ingest persona writes frontmatter at the top (between `---` lines) — Obsidian reads it natively.
5. Generated content is self-contained — deleting `wiki/` (including `wiki/synthesis/`) and `briefs/` does not corrupt the authored tier.

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
- `$UBER_VAULT_DIR/briefs/2026-04-18.md`         → `vault/vincent/briefs/2026-04-18.md`
- `$UBER_VAULT_DIR/wiki/entities/nvidia.md`       → `vault/vincent/wiki/entities/nvidia.md`
- `$UBER_VAULT_DIR/theses/ai-infra-capex.md`      → `vault/vincent/theses/ai-infra-capex.md`

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
# Generated content (LLM + app) — synced via R2, not git
/wiki/        # includes wiki/synthesis/, wiki/sources/, wiki/entities/, wiki/topics/, wiki/questions/
/briefs/

# App metadata
/.gctrl-uber/

# Obsidian per-machine state
/.obsidian/workspace*.json
/.obsidian/plugins/*/data.json
/.obsidian/plugins/*/data-*.json
```

## Sample Vault

`apps/uebermensch/vault.sample/` ships with:

- `profile.md`, `topics.md`, `sources.md` — minimal viable config (data in YAML frontmatter)
- `theses/example-thesis.md` — one annotated thesis
- `ME.md`, `projects.md`, `avoid.md` — stub
- `prompts/` — copies of shipped defaults
- `.obsidian/` — default graph + appearance config
- `.gitignore`
- `README.md` — 10-line onboarding note

`gctrl uber vault init --from-sample` copies it into `$UBER_VAULT_DIR`.

## Schema

The Effect-TS `Profile` schema is canonical (see [domain-model.md § 2.5](domain-model.md#25-profile-read-only-projection)). This section documents the **on-disk** markdown shape and how it maps to that schema. Each config file is a CommonMark markdown document whose frontmatter carries the data; the body is free-form notes. Loaders parse the frontmatter with `gray-matter`.

### profile.md

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
    cron: "0 30 7 * * *"      # 07:30 local, daily
    format: "long"             # long | short | digest

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
    uber-curator: "prompts/uber-curator.md"
    uber-deepdive: "prompts/uber-deepdive.md"

  retention:
    briefs_days: 180
    alerts_days: 90
```

Maps to: `Profile.identity`, `Profile.budgets`, `Profile.delivery`.

### topics.md

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
```

Maps to: `Profile.topics`. Slugs are the lingua franca — they appear in theses, source topic filters, brief item tags, and rank priors.

### sources.md

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

### theses/\<slug\>.md

One file per thesis. Frontmatter is structured; body is free-form markdown. Body is fed into curator + deepdive prompts verbatim; frontmatter drives filtering.

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

### avoid.md

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

### personas.md (optional)

Frontmatter:

```yaml
personas:
  uber-curator:
    model: "claude-opus-4-7"
    prompt_path: "prompts/uber-curator.md"
  uber-ingest:
    model: "claude-haiku-4-5"
    prompt_path: "prompts/uber-ingest.md"
  uber-deepdive:
    model: "claude-opus-4-7"
    prompt_path: "prompts/uber-deepdive.md"
  uber-evaluator:
    model: "claude-haiku-4-5"
    prompt_path: "prompts/uber-evaluator.md"
```

If omitted, the shipped defaults under `apps/uebermensch/prompts/` are used unchanged. Personas declare `model` at profile level so users can swap defaults without touching app code.

### prompts/\<persona\>.md (optional)

Prompt templates using `{{var}}` placeholders. See [briefing-pipeline.md § Prompt Contracts](briefing-pipeline.md#prompt-contracts) for the variables each persona receives.

Overrides MUST keep the shipped template's required variables (parser rejects on missing) — but MAY add more. Missing required vars fail profile validation.

### ME.md / projects.md

Free-form markdown. Loaded into the system context for every Uebermensch persona (concatenated, wrapped in `<user_profile>...</user_profile>` sentinels).

- **ME.md** — who the user is, preferred depth, domain expertise, tone, pet peeves.
- **projects.md** — active projects + commitments (so action items land against real work).

These two files anchor every prompt — they're the highest-leverage artifacts in the profile.

## Validation Rules

`gctrl uber profile validate` runs these checks — ALL MUST pass for the daemon to start. Failures emit `ProfileInvalid` (see [domain-model.md § 3](domain-model.md#3-domain-errors-schemataggederror)).

### Structural

1. `profile.md` frontmatter parses as YAML and satisfies the `Profile` schema.
2. `topics.md` frontmatter satisfies `Profile.topics` and contains ≥ 1 topic.
3. `sources.md` frontmatter satisfies `Profile.sources`; every `topics: [...]` entry matches a topic slug.
4. Every file under `theses/` has valid frontmatter and a non-empty body.
5. Every thesis `topics: [...]` entry matches a topic slug.
6. `personas.md` (if present) references files that exist under `prompts/`.
7. `prompts/<persona>.md` (if present) declares all required template variables.

### Semantic

1. `schema_version` matches a known version; mismatch triggers `gctrl uber profile migrate` prompt.
2. `budgets.daily_usd > 0`, `budgets.per_brief_usd ≤ budgets.daily_usd`.
3. At least one channel has `enabled: true`.
4. `delivery.brief.cron` is a valid 6-field cron.
5. `identity.tz` is a valid IANA timezone.
6. No topic slug collides with a reserved namespace (`system`, `uber`, `eval`).
7. Sum of referenced `watchlist` entries across topics ≤ 500 (soft limit; warning only).

### Security

1. No YAML file references an env var outside an allowlist (`UBER_*`, `TELEGRAM_*`, `DISCORD_*`) — prevents accidental leakage of host secrets into profile-driven driver configs.
2. `personas.md` MUST NOT set `model` to a string containing `/` (prevents path-like injection into driver-llm).

Full validator in `apps/uebermensch/src/services/profile-validator.ts`.

## Change Detection

`ProfileService` (see [architecture.md § 6](architecture.md#6-external-vault-integration)) watches the authored tier of `$UBER_VAULT_DIR` with `fs.watch(recursive: true)` and debounces changes at 500 ms. Generated-tier changes (`wiki/`, `briefs/`) emit `kb.page.changed` kernel events, not profile-reload events.

On authored-tier change:

1. Re-parse + re-validate.
2. If valid → emit `ProfileChange` event, reload in-memory profile, re-register Scheduler jobs that reference changed cron/channel configs.
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

But each user MUST customize `identity` + `delivery.channels` on their fork. Generated content (`wiki/`, `briefs/`) diverges per user — each user runs their own LLM passes against their own profile. A CI check in the sample vault scaffold warns on `identity.name == "Vincent"` (the template seed) after `gctrl uber vault init`.

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

| Actor | Authored tier | Generated tier | Special |
|-------|---------------|----------------|---------|
| Uebermensch daemon (`ProfileService`) | read-only | read-only | may write `.gctrl-uber/lock.json`, `.gctrl-uber/vault.index.json` |
| `BriefingService` / `CuratorService` / `DelivererService` | read-only | write (`briefs/`, `wiki/` incl. `wiki/synthesis/`) via `KbPort` | — |
| `gctrl uber profile migrate` | write (migration branch) | — | acquires exclusive lock |
| LLM personas (via prompt) | **never write** | **never write directly** — writes go via `KbPort`; ingest persona's output is validated before filesystem commit | — |
| User editor (incl. Obsidian) | read+write | read+write (user may edit generated content — daemon picks up changes on next tick) | — |

Enforcement:

- The daemon holds two file descriptors: authored tier `O_RDONLY`; generated tier `O_RDWR` (scoped to `wiki/` and `briefs/`).
- Migration CLI acquires exclusive lock via `.gctrl-uber/lock.json` for authored writes.
- `KbPort.writePage` (see [domain-model.md § 8](domain-model.md#8-effect-ts-port-shapes-typescript-mirrors)) validates frontmatter + slug uniqueness before commit; invalid writes error out, never corrupt the vault.

## Profile → Runtime Wiring

1. Daemon start → `ProfileService.load()` → parse → emit initial `Profile`.
2. Scheduler reads `Profile.sources[*].cadence` + `Profile.delivery.brief.cron` → registers jobs.
3. `CuratorService` reads `Profile.topics`, `Profile.theses`, `Profile.avoid`, `ME.md`, `projects.md` → composes system prompt.
4. `DelivererService` reads `Profile.delivery.channels` → picks drivers, applies windows + silent.
5. `EvaluatorService` reads `Profile.budgets` → sets guardrail thresholds.
6. On `ProfileChange` → re-run steps 2-5; never mid-brief.

## Related

- [domain-model.md § 2.5](domain-model.md#25-profile-read-only-projection) — Effect-TS `Profile` schema
- [knowledge-base.md](knowledge-base.md) — wiki layout under `$UBER_VAULT_DIR/wiki/`
- [briefing-pipeline.md § Prompt Contracts](briefing-pipeline.md#prompt-contracts) — how profile content enters prompts
- [delivery.md § Channel Router](delivery.md#channel-router) — how `channels` config drives fan-out
- [eval.md § Budget Enforcement](eval.md#budget-enforcement) — how `budgets` meet Guardrails
- [kernel sync.md](../../../specs/architecture/kernel/sync.md) — the R2 sync primitive reused here
