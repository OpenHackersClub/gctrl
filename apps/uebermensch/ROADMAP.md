# Uebermensch — Roadmap

> Milestones and task breakdown. See [PRD.md](PRD.md) for the problem, goals, and design principles.

## M0: Foundations — Planned

**Goal:** Uebermensch can read a profile (= Obsidian-mountable vault), ingest a handful of URLs through the existing KB, and produce a brief rendered to stdout **and written to the vault as markdown**.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Vault scaffolding | Template vault shape — `directives/` (profile.md, topics.md, sources.md, theses/, personas/, prompts/), `input/raw/`, `input/wiki/`, `input/briefs/`, `input/reports/`, `output/`, `action/events/`, `.obsidian/` defaults, `.gitignore` — emitted by `gctrl uber vault init` | P0 | — | TBD |
| Profile schema lock-in | Finalise profile+vault layout in `vault/specs/profile.md`; commit sample vault | P0 | — | TBD |
| Profile/Vault reader | Effect-TS `ProfileService` reading markdown + YAML frontmatter from `$UBER_VAULT_DIR` (authored tier) with schema validation; VaultWatcher fiber for `fs.watch` | P0 | Profile schema | TBD |
| Kernel vault mount | Wire `gctrl-kb` with `context_root = $UBER_VAULT_DIR, wiki_subpath = "wiki"` so the kernel reads/writes wiki pages at the vault root. Retire the legacy `~/.local/share/gctrl/context/wiki` path for Uebermensch workspaces. | P0 | Profile/Vault reader | TBD |
| `uber_*` storage migration | Add `uber_briefs` (with `vault_path`, `content_hash`, `failed_at`, `failed_reason`), `uber_brief_items`, `uber_deliveries`, `uber_alerts` to SQLite schema | P0 | — | TBD |
| HTTP routes (kernel proxy) | Kernel-side `/api/uber/briefs` CRUD — resolves `vault_path` to markdown on read | P0 | Storage migration | TBD |
| CLI: `gctrl uber vault init` | Scaffold an empty `$UBER_VAULT_DIR` from the template, derive `identity.slug` from name | P0 | Vault scaffolding | TBD |
| CLI: `gctrl uber profile validate` | Round-trip parse + report on authored tier | P0 | Profile reader | TBD |
| CLI: `gctrl uber brief` (vault + stdout) | Reads 24h of wiki pages, calls LLM via `driver-llm` (stub OK), writes `input/briefs/<date>.md` atomically to the vault, echoes markdown to stdout | P0 | Profile reader, driver-llm stub, Kernel vault mount | TBD |
| driver-llm stub | `LlmPort` trait + stub adapter returning fixture data; real adapters in M1 | P0 | — | TBD |
| Prompt versioning plumbing | Every LLM call via `driver-llm` registers a `prompt_versions` row keyed by SHA-256 of rendered prompt | P0 | driver-llm stub | TBD |

**Done when:** `gctrl uber brief` writes a valid brief markdown file under `$UBER_VAULT_DIR/input/briefs/` and inserts a matching `uber_briefs` row with `vault_path` + `content_hash`, against a sample vault and fixture LLM, with every LLM call recorded as a Session/spans with a `prompt_hash`. Opening the vault in Obsidian shows the brief in the graph.

## M1: Ingest, KB Extensions & Vault Sync — Planned

**Goal:** Uebermensch ingests sources on a schedule, maintains investment-scoped wiki pages in the vault, pushes the vault to R2 for multi-device, and produces a brief grounded in real data.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Investment KB schema | `kb-schema.md` shipped under `vault/specs/knowledge-base.md` — page types, frontmatter, lint rules, bare-slug wikilink convention | P0 | M0 | TBD |
| Thesis page type | Extend `gctrl-kb` `WikiPageType` with `Thesis`; wiki lint knows about it; thesis pages live at `$UBER_VAULT_DIR/directives/theses/` (authored tier) | P0 | Investment KB schema | TBD |
| R2 vault sync (bidirectional) | Extend kernel sync with `sync.vault.uber` mount per [profile.md § Sync (R2)](vault/specs/profile.md#sync-r2) — object keys `vault/<identity.slug>/<vault_path>`, debounced 30s push, 5min pull, conflict files as `<stem>.conflict-<device>-<ts>.md` | P0 | M0 Kernel vault mount | TBD |
| `gctrl uber vault pull --from r2` | Bootstrap a fresh device from R2 for a given `identity.slug` — LISTs the prefix, downloads every key, seeds `.gctrl-uber/index.jsonl`, then hands off to the bidirectional sync | P0 | R2 vault sync | TBD |
| `gctrl uber vault conflicts` | List outstanding `*.conflict-*.md` files under the vault so the user can resolve in Obsidian | P1 | R2 vault sync | TBD |
| driver-rss | Kernel LKM polling RSS feeds listed in profile, producing sources under `$UBER_VAULT_DIR/input/raw/` | P0 | M0 Kernel vault mount | TBD |
| driver-llm: local-first adapter | Real client behind `LlmPort`. **Default**: LM Studio at `http://127.0.0.1:1234/v1/chat/completions`, default model `google/gemma-4-31b`. **Opt-in**: Cloudflare AI Gateway via `GCTRL_LLM_PROVIDER=cloudflare` (kernel holds `CF_API_TOKEN` + `CLOUDFLARE_AI_GATEWAY_ID`). Anthropic-shape models reachable via `/api/llm/messages` | P0 | M0 driver-llm stub | TBD |
| Curator pipeline | Effect-TS `CuratorService` — query wiki for recent+topic-matching pages, call LLM, emit ranked brief items with bare `[[slug]]` citations | P0 | driver-llm local-first adapter, KB schema | TBD |
| Renderer | Write `input/briefs/<date>.md` with frontmatter + H2 items + citation verification; fail on unresolved bare `[[slug]]` or any typed prefix | P0 | Curator | TBD |
| Scheduler wiring | `uber.brief.daily` registered via Scheduler port on daemon start | P0 | M0, Curator | TBD |
| `gctrl uber ingest --url` | End-to-end URL → vault source page + entity updates | P0 | driver-llm local-first adapter | TBD |
| Daily budget guardrail | Guardrail policy enforcing `profile.budgets.daily_usd`; pauses Uebermensch sessions when breached | P0 | M0 | TBD |

**Done when:** An investor with a populated vault can run Uebermensch against real RSS feeds + manual URL ingests; `gctrl uber brief` produces a brief grounded in today's wiki updates with ≥90% citation coverage; the vault pushes to R2 within 60s of a change; a fresh device pulls the vault and opens it in Obsidian without edits.

## M2: Delivery & Web UI — Planned

**Goal:** Briefs reach the user via Web, Telegram, and Discord. The Web UI is a first-class user surface — first-time users can complete onboarding (identity → topics → channels → schedule) without ever opening Obsidian or the CLI.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| driver-telegram | Bot API adapter: send messages, receive webhook updates, slash commands | P0 | M1 | TBD |
| driver-discord | Webhook post + interactions endpoint for slash commands | P0 | M1 | TBD |
| Deliverer service | Idempotent per (brief_id, channel) write to `uber_deliveries`; retry with backoff | P0 | drivers | TBD |
| Channel router | Profile-driven: `delivery.channels.<name>.enabled`, time windows, silent mode | P0 | Deliverer | TBD |
| Inbound ingest flow | User forwards URL to Telegram/Discord → ingest pipeline → reply with wiki citation | P0 | drivers | TBD |
| `VaultWriterPort` + adapters | Single port for authored-tier writes with `FsVaultWriter` adapter; emits `vault.updated` after fsync. Web UI + CLI + future Worker all use it. | P0 | M1 | TBD |
| Web UI: onboarding wizard | Identity → topics → channels → schedule wizard producing atomic markdown rewrites of `directives/profile.md`, `directives/topics.md`, etc. via `VaultWriterPort` | P0 | `VaultWriterPort`, channel onboarding routes | TBD |
| Web UI: channel onboarding routes | `/api/uber/onboard/{telegram,discord}/{start,callback}` per [delivery.md § Channel Onboarding (Web)](vault/specs/delivery.md#channel-onboarding-web) — tokens never written to vault | P0 | drivers | TBD |
| Web UI: brief feed | SPA with brief list, detail view, citation chips, human score form — reads brief markdown from vault | P0 | Renderer | TBD |
| Web UI: profile editor | Form-driven editor for `directives/profile.md` + `directives/topics.md` + `directives/theses/<slug>.md`; round-trips through `VaultWriterPort` | P0 | `VaultWriterPort` | TBD |
| Web UI: wiki explorer | Browse wiki pages, follow `[[links]]`, view backlinks | P1 | M1 | TBD |
| Web UI: thesis tracker | List theses, last-update, open deep-dive button | P1 | M1 | TBD |
| Web UI: eval dashboard | Citation-coverage, hype-ratio, cost/day, per-brief scores | P1 | M1 | TBD |
| Web UI: SSE | Live updates for new briefs, new ingest events, channel.bound | P1 | Web UI | TBD |
| Web UI: auth | Single-user bearer token from profile (local mode) | P1 | Web UI | TBD |
| Profile migration command | `gctrl uber profile migrate` with preview diff | P1 | — | TBD |

**Done when:** A first-time user lands on the local Web UI, runs the onboarding wizard end-to-end (no Obsidian, no markdown editor, no CLI), connects Telegram + Discord via the in-browser flow, and receives the next morning's brief on all three channels. Forwarding a URL from Telegram files it within 30 s. The full brief renders in the Web UI with working citations.

## M3: Long-Horizon + Market Data — Planned

**Goal:** Monthly thesis deep-dives produce compound synthesis; market data and SEC filings flow in; prediction-market alerts surface inbound.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Deepdive pipeline | `uber-deepdive` persona + prompt; reads thesis + evidence pages; files update synthesis page | P0 | M1 | TBD |
| driver-sec | SEC EDGAR polling for configured tickers; produces source pages | P1 | M1 | TBD |
| driver-markets: Kalshi | Kalshi API adapter; prices + event outcomes into `uber_markets` table | P1 | — | TBD |
| driver-markets: Polymarket (best-effort) | Public endpoint poll; flagged as best-effort source | P2 | — | TBD |
| Market alert rules | Rule engine: threshold crossings fire inbox alerts tagged to the topic's thesis | P1 | driver-markets, kernel alerts | TBD |
| Action items (UBER project) | `gctrl uber brief` items convert to `UBER-N` issues in gctrl-board via `/api/board/issues` | P1 | gctrl-board | TBD |
| Action reminders | Open UBER actions past due surface in next brief | P2 | Action items | TBD |

**Done when:** A monthly thesis deep-dive produces a `input/wiki/synthesis/thesis-*-update-<date>.md` with ≥3 new citations since last update, and a Kalshi market move on a watched topic produces an inbox alert within 10 min.

## M4: Eval Rigor + Cloud-Only Mode — Planned

**Goal:** Prompt regressions are automatically caught; Uebermensch runs as a hosted Cloudflare Worker so a first-time user with no laptop can onboard, configure channels, and read briefs entirely from a browser — see [PRD § Deployment Modes](PRD.md#deployment-modes) and [architecture.md § 0](vault/specs/architecture.md#0-deployment-modes).

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Automated eval: citation-coverage | Per-brief evaluator computing cited_claims / total_claims | P0 | M1 | TBD |
| Automated eval: hype-ratio | Heuristic + LLM-as-judge flag on hype language | P0 | M1 | TBD |
| Automated eval: cost + length | Kernel analytics joins; alert on anomaly | P0 | M1 | TBD |
| LLM-as-judge evaluator | `uber-evaluator` persona scores briefs against rubric | P1 | M1 | TBD |
| Prompt A/B harness | Run two prompt versions against same candidate set; compare scores | P2 | eval pipeline | TBD |
| Scrape-health promotion | Graduate `gctrl uber scrape-health` CLI + dashboard (CLI shipped in M1 behind feature flag; M4 enables alerting) | P1 | M1 | TBD |
| Sync: `uber_*` SQLite → D1 | Wire `uber_briefs`, `uber_brief_items`, `uber_deliveries` into kernel row-level sync | P0 | gctrl sync | TBD |
| `R2VaultWriter` adapter | Implement `VaultWriterPort` against R2 with `If-Match: <etag>` optimistic concurrency; emit `vault.updated` after PUT | P0 | M2 `VaultWriterPort` | TBD |
| Per-slug Durable Object lease | Replace `lock.json` with a Durable Object that serialises writes for a given `identity.slug` | P0 | `R2VaultWriter` | TBD |
| Cloudflare Worker deploy | Uebermensch Web UI + API as Cloudflare Worker backed by D1 (index) + R2 (vault byte-store) + DO (per-slug write coordinator) | P0 | D1 sync, `R2VaultWriter` | TBD |
| Worker secret store binding | Per-slug `wrangler secret`s for Telegram bot tokens, Discord bot tokens, LLM keys; enforce slug-scoped read on every fetch | P0 | Worker deploy | TBD |
| Worker Cron Triggers for `uber.brief.daily` | Replace local kernel scheduler entry with a Cron Trigger; reuse the same job DSL | P0 | Worker deploy | TBD |
| `gctrl uber vault pull --from r2` | Bootstrap a local mirror of an R2-resident vault; flips writer authority from Worker (DO lease) to local FS (lock.json). Already shipped in M1; M4 verifies it round-trips a vault first authored entirely on the Worker. | P0 | M1 vault pull, Worker deploy | TBD |

**Done when:** An intentional prompt regression is flagged in the next brief's eval alert; a brand-new user with no laptop completes the wizard on a phone, receives a brief in Telegram + Discord the next morning, and a later `gctrl uber vault pull --from r2 --identity-slug <slug>` reproduces a byte-identical local vault.

## M5: SinkIn — Planned

**Goal:** The wiki introspects on itself weekly — surfacing knowledge gaps as filed Question pages, answering what it can from existing content, and noticing cross-cutting connections that no single ingest pass saw.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| `SinkInService` scaffold | Effect-TS service with gap-pass + answer-pass + file-pages stages; connected to `KbPort` + `LlmPort` | P0 | M1 | TBD |
| `uber-sinkin` prompt templates | `directives/personas/sinkin-gap.md` + `directives/personas/sinkin-answer.md`; prompt-injection sentinels; gap cap enforcement | P0 | SinkInService scaffold | TBD |
| `uber_sinkin_sessions` table | SQLite table tracking per-session cost, scope, gap/connection counts | P0 | M0 storage migration | TBD |
| `gctrl uber sinkin` CLI | Run scheduled SinkIn; `--topic`, `--thesis`, `--dry-run` flags; session report to stdout | P0 | SinkInService | TBD |
| `gctrl uber query` CLI | Answer a user question from the wiki; `--file` flag files as Question page | P0 | SinkInService | TBD |
| `gctrl uber questions` CLI | List Question pages by status (`answered` / open) | P1 | SinkInService | TBD |
| Scheduler: `uber.sinkin` | Weekly cron registered at daemon start from `profile.sinkin.cron` | P0 | SinkInService, M1 Scheduler wiring | TBD |
| Lint exemption: `synthesis-unparented` | Guard already updated in `knowledge-base.md` — wire it in the lint runner | P0 | M1 KB lint | TBD |
| `sinkin.cron` in profile schema | Add `sinkin:` block to profile YAML schema + `ProfileService` decode | P1 | M0 Profile schema | TBD |
| App UI: Questions view | List unanswered questions; answer-from-wiki button; file result | P2 | M2 App web UI | TBD |

**Done when:** A weekly SinkIn run files ≥1 Question page and ≥1 Connection synthesis page against a vault with ≥10 source pages; `gctrl uber query "..."` answers a question from the wiki and optionally files it; all pages render correctly in Obsidian with resolved `[[slug]]` links.

## M6: Calendar — Planned

**Goal:** Time-bound events (personal commitments + market dates) live in the vault, surface in the morning brief, drive opt-in reminders, and are filterable by source/kind/ticker/topic/thesis. Spec: [vault/specs/calendar.md](vault/specs/calendar.md).

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Calendar vault layout + frontmatter schema | `action/events/` (authored events) + `action/events/generated/` (driver-pulled events); `EventFrontmatter` with `slug, title, kind, source, starts_at, ends_at, tz, tickers, topics, theses, tags, reminders, status` | P0 | M0 vault scaffolding | TBD |
| `uber_calendar` + `uber_calendar_reminders` SQLite migrations | Index tables with `(starts_at)`, `(kind, starts_at)`, `(source, starts_at)`, `(source, external_id)` indexes | P0 | M0 storage migration | TBD |
| `CalendarService` + filter predicate engine | Effect-TS service: list/get/create/update/remove with predicate set (source, kind, from/to, tickers, topics, theses, tag, status, q) | P0 | calendar schema | TBD |
| CLI: `gctrl uber calendar {list,show,add,edit,remove,reindex}` | Mirrors filter predicates; `add/edit` round-trips through schema | P0 | CalendarService | TBD |
| Briefing-pipeline integration | Renderer prepends "On the calendar today" section grouped by `kind`; curator prompt receives `<calendar_today>` block | P0 | M1 Curator pipeline | TBD |
| Reminder scheduler + delivery | Compute `fire_at = starts_at + offset` on event write; Scheduler polls `pending` rows; hand off to existing `DelivererService` | P0 | M2 Deliverer | TBD |
| `.ics` feed at `/api/uber/calendar/feed.ics` | Read-only iCalendar export of the active default view; bearer token auth in query param | P1 | CalendarService HTTP API | TBD |
| `driver-markets` calendar producer | Earnings calendar + macro release dates; writes `action/events/generated/<date>--<ticker>-<period>-earnings.md` and macro events | P0 | M3 driver-markets | TBD |
| `driver-sec` calendar producer | Lockup expiries, S-1/S-3 effective dates, scheduled comment periods | P1 | M3 driver-sec | TBD |
| `driver-gcal` (read-only) | OAuth 2.0 via kernel; poll Google Calendar; mirror events with `source: driver-gcal` | P0 | calendar schema | TBD |
| App web UI: Calendar view (agenda + week + month) | Filter chip strip; saved view presets; agenda/week/month layout modes | P1 | M2 App web UI | TBD |
| `driver-gcal` write-back (opt-in) | `direction: read-write` flag per calendar; pushes `source: user` events to Google with local-wins conflict policy | P2 | driver-gcal read-only | TBD |

**Done when:** A user can `gctrl uber calendar add` a personal event and see it in tomorrow's brief; `driver-markets` populates earnings dates for the user's ticker watchlist; `gctrl uber calendar list --view personal-week` returns the right shape on stdout and `/api/uber/calendar/feed.ics` is subscribable from Google Calendar; reminders fire idempotently to the configured channel within 60s of the scheduled offset.

## M7: Calendar Timeboxes — Planned

**Goal:** Multi-event practice plans (reading a paper, training for a race, shipping a content series) live as parent vault files that own N child calendar events, with deterministic and LLM-assisted slicing of work into sessions, progress rollup, coaching nudges, and stalled-plan detection. Spec: [vault/specs/calendar-timeboxes.md](vault/specs/calendar-timeboxes.md).

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Timebox M0: parent files + storage | `calendar/timeboxes/<slug>.md` shape; `uber_timeboxes` table; `timebox_slug`/`step`/`step_total`/`step_units` columns added to `uber_calendar`; `status: superseded` value added to event status enum | P0 | M6 calendar schema | TBD |
| Timebox M0: deterministic planner + manual lifecycle | `gctrl uber timebox plan` (no `--llm`) with even arithmetic slice; `add-event`, `complete`, `skip`, `pause`/`resume`/`cancel`, `reindex`; dry-run by default; `--apply` commits | P0 | uber_timeboxes table | TBD |
| Timebox M0: briefing integration | Today's practice events render in "On the calendar today" with `step/step_total`; off-track block fires when stalled and deadline within `stalled_threshold` | P0 | M6 briefing-pipeline calendar block | TBD |
| Timebox M1: LLM-assisted planner + working-windows | `--llm` flag on `plan` and `replan`; planner reads `profile.timeboxes.working_windows`; pinned-event logic for re-plan (`replan_policy: pin-edited`) | P0 | Timebox M0; M1 driver-llm | TBD |
| Timebox M1: coaching nudges | `coaching.nudges[]` in timebox frontmatter; on `complete`, crossed thresholds insert reminder rows; idempotency key `(timebox_slug, nudge_index)`; reuses `uber_calendar_reminders` + `DelivererService` | P1 | Timebox M0; M2 Deliverer | TBD |
| Timebox M1: stalled-timebox alert | Daily check inserts `uber_alerts(kind='timebox_stalled')` with high/medium urgency; auto-clears on next `complete` | P1 | Timebox M0; M4 alert pipeline | TBD |
| Timebox M2: web UI gantt-lite view | Timeline of child events as bars per timebox; coloured by `status: done / confirmed / superseded`; click-through to the markdown file | P2 | Timebox M0; M2 App web UI | TBD |
| Timebox M2: `driver-gcal` mirror | Timebox children mirror to Google Calendar with title-prefix convention `[<title> <step>/<step_total>]`; opt-in via the same write-back flag as M6 calendar | P2 | M6 driver-gcal read-only; Timebox M0 | TBD |

**Done when:** A user can `gctrl uber timebox plan --discipline reading --total 64 --unit pages --session-minutes 60 --sessions-per-week 4 --deadline 2026-05-20 --apply` and find the parent file plus all child events in the vault; today's session shows up in the morning brief with progress; `complete` rolls progress up and fires the next coaching nudge; missing two consecutive sessions within the stall window produces a `timebox_stalled` alert and an "Off-track" line in the next brief.

## Backlog (unprioritized)

1. LLM-as-judge with rubric per dimension (accuracy, depth, freshness)
2. Voice brief (TTS synthesis for audio channel)
3. Slack delivery driver
4. Browser-control ingestion for gated content (via `kernel/browser.md`)
5. Podcast transcription pipeline (Whisper via driver-llm)
6. Mobile Telegram WebApp view of the full brief
7. Thesis diffing UI (side-by-side thesis versions)
8. Private knowledge merge (user-added context without overwriting LLM-maintained wiki)
9. Model comparison: same prompt vs Claude/GPT/Gemini side-by-side
10. Multi-profile team mode with shared wiki, private theses

## Open Questions

1. [ ] `driver-llm` shape: kernel-proxy vs app-held key — needed by M0
2. [ ] Profile write-back semantics — needed by M1
3. [ ] Channel auth: per-user token placement — needed by M2
4. [ ] Immediate vs batched alerts — needed by M3
5. [ ] Multi-user deployment model — needed by M4
6. [ ] Prediction-market data source policy (Polymarket TOS) — needed by M3
7. [ ] Profile schema migration tooling — needed by M2
8. [ ] Should scheduled brief run inside kernel Scheduler or inside the Uebermensch app process? (Leaning: kernel Scheduler fires, Uebermensch executes.) — needed by M1
9. [ ] Earnings data source — free public scrape vs. paid API trade-off — needed by calendar M1 (see [calendar.md § Open Questions #1](vault/specs/calendar.md#open-questions))
10. [ ] `driver-gcal` write-back conflict UX — needed by calendar M2 (see [calendar.md § Open Questions #6](vault/specs/calendar.md#open-questions))
