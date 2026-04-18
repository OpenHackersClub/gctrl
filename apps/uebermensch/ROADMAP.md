# Uebermensch — Roadmap

> Milestones and task breakdown. See [PRD.md](PRD.md) for the problem, goals, and design principles.

## M0: Foundations — Planned

**Goal:** Uebermensch can read a profile (= Obsidian-mountable vault), ingest a handful of URLs through the existing KB, and produce a brief rendered to stdout **and written to the vault as markdown**.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Vault scaffolding | `apps/uebermensch/vault.sample/` with `profile.yaml`, `topics.yaml`, `sources.yaml`, `theses/`, `prompts/`, `.obsidian/` defaults, `.gitignore` | P0 | — | TBD |
| Profile schema lock-in | Finalise profile+vault layout in `specs/profile.md`; commit sample vault | P0 | — | TBD |
| Profile/Vault reader | Effect-TS `ProfileService` reading markdown + YAML from `$UBER_VAULT_DIR` (authored tier) with schema validation; VaultWatcher fiber for `fs.watch` | P0 | Profile schema | TBD |
| Kernel vault mount | Wire `gctrl-kb` with `context_root = $UBER_VAULT_DIR, wiki_subpath = "wiki"` so the kernel reads/writes wiki pages at the vault root. Retire the legacy `~/.local/share/gctrl/context/wiki` path for Uebermensch workspaces. | P0 | Profile/Vault reader | TBD |
| `uber_*` storage migration | Add `uber_briefs` (with `vault_path`, `content_hash`, `failed_at`, `failed_reason`), `uber_brief_items`, `uber_deliveries`, `uber_alerts` to SQLite schema | P0 | — | TBD |
| HTTP routes (kernel proxy) | Kernel-side `/api/uber/briefs` CRUD — resolves `vault_path` to markdown on read | P0 | Storage migration | TBD |
| CLI: `gctrl uber vault init --from-sample` | Scaffold `$UBER_VAULT_DIR` from shipped sample, derive `identity.slug` from name | P0 | Vault scaffolding | TBD |
| CLI: `gctrl uber profile validate` | Round-trip parse + report on authored tier | P0 | Profile reader | TBD |
| CLI: `gctrl uber brief` (vault + stdout) | Reads 24h of wiki pages, calls LLM via `driver-llm` (stub OK), writes `briefs/<date>.md` atomically to the vault, echoes markdown to stdout | P0 | Profile reader, driver-llm stub, Kernel vault mount | TBD |
| driver-llm stub | `LlmPort` trait + stub adapter returning fixture data; real adapters in M1 | P0 | — | TBD |
| Prompt versioning plumbing | Every LLM call via `driver-llm` registers a `prompt_versions` row keyed by SHA-256 of rendered prompt | P0 | driver-llm stub | TBD |

**Done when:** `gctrl uber brief` writes a valid brief markdown file under `$UBER_VAULT_DIR/briefs/` and inserts a matching `uber_briefs` row with `vault_path` + `content_hash`, against a sample vault and fixture LLM, with every LLM call recorded as a Session/spans with a `prompt_hash`. Opening the vault in Obsidian shows the brief in the graph.

## M1: Ingest, KB Extensions & Vault Sync — Planned

**Goal:** Uebermensch ingests sources on a schedule, maintains investment-scoped wiki pages in the vault, pushes the vault to R2 for multi-device, and produces a brief grounded in real data.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Investment KB schema | `kb-schema.md` shipped under `specs/knowledge-base.md` — page types, frontmatter, lint rules, bare-slug wikilink convention | P0 | M0 | TBD |
| Thesis page type | Extend `gctrl-kb` `WikiPageType` with `Thesis`; wiki lint knows about it; thesis pages live at `$UBER_VAULT_DIR/theses/` (authored tier) | P0 | Investment KB schema | TBD |
| R2 vault sync (bidirectional) | Extend kernel sync with `sync.vault.uber` mount per [profile.md § Sync (R2)](specs/profile.md#sync-r2) — object keys `vault/<identity.slug>/<vault_path>`, debounced 30s push, 5min pull, conflict files as `<stem>.conflict-<device>-<ts>.md` | P0 | M0 Kernel vault mount | TBD |
| `gctrl uber vault pull --from r2` | Bootstrap a fresh device from R2 for a given `identity.slug` — LISTs the prefix, downloads every key, seeds `.gctrl-uber/index.jsonl`, then hands off to the bidirectional sync | P0 | R2 vault sync | TBD |
| `gctrl uber vault conflicts` | List outstanding `*.conflict-*.md` files under the vault so the user can resolve in Obsidian | P1 | R2 vault sync | TBD |
| driver-rss | Kernel LKM polling RSS feeds listed in profile, producing sources under `$UBER_VAULT_DIR/wiki/sources/` | P0 | M0 Kernel vault mount | TBD |
| driver-llm: Anthropic adapter | Real Anthropic client behind `LlmPort`; kernel holds the key | P0 | M0 driver-llm stub | TBD |
| Curator pipeline | Effect-TS `CuratorService` — query wiki for recent+topic-matching pages, call LLM, emit ranked brief items with bare `[[slug]]` citations | P0 | driver-llm Anthropic, KB schema | TBD |
| Renderer | Write `briefs/<date>.md` with frontmatter + H2 items + citation verification; fail on unresolved bare `[[slug]]` or any typed prefix | P0 | Curator | TBD |
| Scheduler wiring | `uber.brief.daily` registered via Scheduler port on daemon start | P0 | M0, Curator | TBD |
| `gctrl uber ingest --url` | End-to-end URL → vault source page + entity updates | P0 | driver-llm Anthropic | TBD |
| Daily budget guardrail | Guardrail policy enforcing `profile.budgets.daily_usd`; pauses Uebermensch sessions when breached | P0 | M0 | TBD |

**Done when:** An investor with a populated vault can run Uebermensch against real RSS feeds + manual URL ingests; `gctrl uber brief` produces a brief grounded in today's wiki updates with ≥90% citation coverage; the vault pushes to R2 within 60s of a change; a fresh device pulls the vault and opens it in Obsidian without edits.

## M2: Delivery & App UI — Planned

**Goal:** Briefs reach the user via App, Telegram, and Discord. The App is the primary surface.

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| driver-telegram | Bot API adapter: send messages, receive webhook updates, slash commands | P0 | M1 | TBD |
| driver-discord | Webhook post + interactions endpoint for slash commands | P0 | M1 | TBD |
| Deliverer service | Idempotent per (brief_id, channel) write to `uber_deliveries`; retry with backoff | P0 | drivers | TBD |
| Channel router | Profile-driven: `delivery.channels.<name>.enabled`, time windows, silent mode | P0 | Deliverer | TBD |
| Inbound ingest flow | User forwards URL to Telegram/Discord → ingest pipeline → reply with wiki citation | P0 | drivers | TBD |
| App web UI: brief feed | SPA with brief list, detail view, citation chips, human score form | P0 | Renderer | TBD |
| App web UI: wiki explorer | Browse wiki pages, follow `[[links]]`, view backlinks | P1 | M1 | TBD |
| App web UI: thesis tracker | List theses, last-update, open deep-dive button | P1 | M1 | TBD |
| App web UI: eval dashboard | Citation-coverage, hype-ratio, cost/day, per-brief scores | P1 | M1 | TBD |
| App SSE | Live updates for new briefs + new ingest events | P1 | App UI | TBD |
| App auth | Single-user bearer token from profile | P1 | App UI | TBD |
| Profile migration command | `gctrl uber profile migrate` with preview diff | P1 | — | TBD |

**Done when:** The user receives the 08:00 brief on all three channels, can forward a URL from Telegram and see it filed within 30 s, and views the full brief in the App with working citations.

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

**Done when:** A monthly thesis deep-dive produces a `wiki/synthesis/thesis-*-update-<date>.md` with ≥3 new citations since last update, and a Kalshi market move on a watched topic produces an inbox alert within 10 min.

## M4: Eval Rigor + Index Sync — Planned

**Goal:** Prompt regressions are automatically caught; the `uber_*` SQLite index syncs to D1 so the Cloudflare Worker deployment can read briefs by reading D1 + R2 (vault content already syncs via R2 from M1).

| Task | Description | Priority | Depends On | Issue |
|------|-------------|----------|------------|-------|
| Automated eval: citation-coverage | Per-brief evaluator computing cited_claims / total_claims | P0 | M1 | TBD |
| Automated eval: hype-ratio | Heuristic + LLM-as-judge flag on hype language | P0 | M1 | TBD |
| Automated eval: cost + length | Kernel analytics joins; alert on anomaly | P0 | M1 | TBD |
| LLM-as-judge evaluator | `uber-evaluator` persona scores briefs against rubric | P1 | M1 | TBD |
| Prompt A/B harness | Run two prompt versions against same candidate set; compare scores | P2 | eval pipeline | TBD |
| Scrape-health promotion | Graduate `gctrl uber scrape-health` CLI + dashboard (CLI shipped in M1 behind feature flag; M4 enables alerting) | P1 | M1 | TBD |
| Sync: `uber_*` SQLite → D1 | Wire `uber_briefs`, `uber_brief_items`, `uber_deliveries` into kernel row-level sync | P1 | gctrl sync | TBD |
| Cloudflare Worker deploy | Uebermensch web UI + API as Cloudflare Worker backed by D1 (for the index) + R2 (for the vault markdown bytes) | P2 | D1 index sync | TBD |

**Done when:** An intentional prompt regression is flagged in the next brief's eval alert; a second device running the Worker reads the index from D1 and renders the brief markdown from R2 identically to the local daemon.

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
