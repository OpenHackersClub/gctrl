# Uebermensch — Calendar

> Time-bound events live alongside the wiki. Personal commitments (meetings, deadlines, travel) and market-moving dates (earnings, FOMC, CPI prints, dividend ex-dates, lockup expiries, election days) share one storage shape and one query surface — filtered by source/kind for display.
>
> Related: [profile.md § Vault Layout](profile.md#vault-layout) (where calendar files live), [briefing-pipeline.md](briefing-pipeline.md) (how today's events surface in the morning brief), [knowledge-base.md § Wikilink Conventions](knowledge-base.md#wikilink-conventions) (link rules events follow), [delivery.md](delivery.md) (how reminders fan out).

## Why a Calendar Spec

The brief tells the user what *happened*. The calendar tells the user what is *about to happen*. For an investor that distinction is the difference between reading a recap and being positioned for it.

Without a first-class calendar:

1. Earnings windows are buried in commentary instead of forcing themselves into the morning brief.
2. The user maintains personal scheduling outside the vault — and so the assistant cannot factor "you have a board meeting at 14:00" into action items, brief cadence, or quiet hours.
3. There is no single place to ask "what's the week ahead?" — the answer is scattered across SEC, the user's email, prediction market expiry tables, and head-canon.
4. Long-horizon dates (lockup expiries, debt maturities, regulatory cliff dates) drop off the radar between briefs.

The calendar is **not** a replacement for Google Calendar / Outlook. It is the vault's view of time — the assistant's working memory of what dates matter — with optional bidirectional sync to the user's existing calendar.

## Principles

1. **Markdown is the source of truth.** Every event is a file under `$UBER_VAULT_DIR/calendar/<YYYY-MM-DD>--<slug>.md` (or for ranges, the start date). SQLite (`uber_calendar` index) holds `vault_path` + `content_hash` + denormalised `(starts_at, ends_at, kind, source)` for fast filtering. Deleting SQLite MUST be recoverable by re-indexing the markdown.
2. **One event shape, many sources.** Whether an event was authored by the user in Obsidian, ingested by `driver-markets` from an earnings calendar, or pulled from Google Calendar, it lands in the same frontmatter shape. The `source` field discriminates origin; `kind` discriminates display.
3. **Filterable by intent, not by folder.** Users ask "show me my personal week" or "show me earnings for my watchlist" — both queries go through the same predicate engine over frontmatter (`source`, `kind`, `tickers`, `topics`, `tags`). No folder hierarchy by source.
4. **Authored vs. generated split is preserved.** Personal events (`source: user`) live in the **authored tier** and are git-tracked. Driver-pulled events (`source: driver-markets`, `source: driver-sec`, `source: driver-gcal`) live in the **generated tier** under `calendar/generated/` — gitignored, R2-synced, regeneratable.
5. **Wikilinks compound.** An earnings event for `[[nvidia]]` links to the company entity wiki page; a thesis-relevant CPI print can list `theses: [ai-infra-capex]` so the briefing pipeline can promote it. Bare `[[slug]]` only — the existing rule applies.
6. **Reminders are deliveries.** Today's events surface in the morning brief; cross-threshold events (e.g. earnings ±2h) MAY fire a separate channel-aware reminder via `DelivererService`. Reminders are idempotent per `(event_id, channel, fire_at)`.
7. **External sync is opt-in and one-way by default.** `driver-gcal` reads Google Calendar by default; **write-back** (mirroring user-authored vault events into Google Calendar) is a separate opt-in flag per channel. We never silently mutate the user's external calendar.

## Vault Layout

```
$UBER_VAULT_DIR/
├── calendar/                              # NEW — events live here
│   │  ─── Authored (git-tracked) ───
│   ├── 2026-05-08--board-meeting.md       # source: user
│   ├── 2026-05-15--family-trip-tokyo.md   # source: user (multi-day)
│   ├── recurring/                         # optional — RFC 5545 RRULE files
│   │   └── weekly-team-standup.md
│   │
│   │  ─── Generated (gitignored; R2-synced) ───
│   └── generated/
│       ├── 2026-05-21--nvda-q1-2026-earnings.md   # source: driver-markets
│       ├── 2026-06-12--fomc-statement.md          # source: driver-markets
│       ├── 2026-06-30--lockup-expiry-rddt.md      # source: driver-sec
│       └── 2026-05-09--gcal-eu-ai-summit.md       # source: driver-gcal (mirror)
```

`calendar/` is a new top-level directory in the vault. The authored tier holds files the user creates by hand or via `gctrl uber calendar add`; the `generated/` subfolder holds driver-pulled events. The split mirrors the existing `theses/` (authored) vs. `wiki/` (generated) division so users can `git diff` only the events they themselves authored.

Events are filename-prefixed with their start date for chronological browsability in Obsidian's file pane. The `<slug>` portion is human-readable kebab-case derived from the title.

## Event Frontmatter

Every event file has YAML frontmatter conforming to this shape (validated by `Schema.Struct`; full Effect schema lives in `apps/uebermensch/src/schemas.ts` once implemented):

```yaml
---
slug: 2026-05-21--nvda-q1-2026-earnings   # globally unique within calendar/
title: "NVDA Q1 2026 earnings call"
kind: earnings                            # see § Event Kinds
source: driver-markets                    # see § Sources
starts_at: 2026-05-21T20:00:00-04:00      # ISO 8601 with offset; required
ends_at: 2026-05-21T21:30:00-04:00        # optional; omit for point-in-time
all_day: false                            # bool; true → starts/ends_at YYYY-MM-DD
tz: "America/New_York"                    # IANA tz the event is anchored to
location: "earnings call (webcast)"       # free-form, optional
tickers: ["NVDA"]                         # optional; lights up watchlist match
topics: [ai-infra-capex]                  # optional; ties into curator topic filter
theses: [ai-infra-capex]                  # optional; ties into deepdive scope
tags: [earnings, q1-2026]                 # free-form taxonomy
links:                                    # optional outbound URLs
  - title: "Investor relations"
    url: "https://investor.nvidia.com/financial-info/financial-reports/"
  - title: "Q4 transcript"
    url: "https://..."
related_pages: [nvidia, ai-infra-capex]   # optional bare slugs (wiki entities/topics)
reminders:                                # optional
  - { offset: -P1D,  channel: telegram_primary }
  - { offset: -PT2H, channel: app }
external_id: "gcal:abc123"                # set by drivers; opaque
external_etag: "W/\"...\""                # set by drivers; for upsert idempotency
status: confirmed                         # confirmed | tentative | cancelled
created_at: 2026-04-25T08:14:11Z
updated_at: 2026-04-25T08:14:11Z
generator: driver-markets                 # who wrote/last-touched this file
content_hash: sha256:…                    # set by writer; matches uber_calendar row
---

Optional free-form markdown body. For driver-pulled events this is typically empty
or holds the ingested description. For user-authored events this is your notes
(agenda, prep, links, follow-ups). Wikilinks (`[[slug]]`) cross-reference the wiki.
```

### Required vs. optional

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | yes | filename stem; globally unique within `calendar/` |
| `title` | yes | display string |
| `kind` | yes | drives display, filtering, and reminder defaults |
| `source` | yes | provenance (see § Sources) |
| `starts_at` | yes | ISO 8601; for `all_day: true` use `YYYY-MM-DD` |
| `tz` | yes | IANA timezone for display rendering |
| `status` | yes | `confirmed` is default |
| everything else | no | | 

### Event Kinds

| Kind | Use | Default reminder |
|------|-----|------------------|
| `personal` | meetings, blocks, family/admin | `-PT15M` to `app` |
| `deadline` | due dates, hard deadlines | `-P1D` + `-PT1H` to `app` |
| `travel` | flights, hotels, multi-day trips | `-P1D` to `app` (whole-trip) |
| `earnings` | quarterly earnings calls | `-P1D` + `-PT30M` to chosen channel |
| `macro` | FOMC, CPI, NFP, BoJ, ECB releases | `-P1D` to chosen channel |
| `regulatory` | SEC filing windows, regulator hearings, statute effective dates | `-P1D` |
| `corporate-action` | dividend ex-date, lockup expiry, splits, capital raises | `-P1D` |
| `political` | elections, vote dates, key floor votes | `-P1D` |
| `prediction-market` | Kalshi/Polymarket resolution dates | `-PT1H` |
| `industry` | conferences, summits, regulator hearings | `-P1D` |
| `other` | catch-all | none |

`kind` is intentionally coarse — fine taxonomy goes in `tags`. The curator and the visualizer key off `kind` for default colours, default reminder cadence, and the default visibility toggle.

### Sources

`source` records who wrote the file. Used for filtering, not display.

| Source | Tier | Origin |
|--------|------|--------|
| `user` | authored | `gctrl uber calendar add` or hand-edit in Obsidian |
| `driver-markets` | generated | Kalshi / Polymarket / earnings feed via kernel LKM |
| `driver-sec` | generated | SEC EDGAR (lockup expiries, S-1/S-3 effective dates, scheduled filings) |
| `driver-gcal` | generated | Google Calendar mirror (read by default) |
| `import` | authored | one-shot bulk import (`gctrl uber calendar import --ics ...`) |

Drivers MUST set `external_id` + `external_etag` on every event they write so re-pulls upsert in place rather than duplicating. `external_id` MUST be opaque to Uebermensch (the kernel driver owns its format).

## Storage

### `uber_calendar` SQLite index

Pure index over `calendar/` files. Rebuildable by walking the directory.

```sql
CREATE TABLE uber_calendar (
  id            TEXT PRIMARY KEY,            -- "cal_" || ulid
  slug          TEXT NOT NULL UNIQUE,        -- matches frontmatter slug
  vault_path    TEXT NOT NULL UNIQUE,        -- relative, e.g. "calendar/2026-05-21--…md"
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  source        TEXT NOT NULL,
  starts_at     TEXT NOT NULL,               -- ISO 8601 with offset, denormalised
  ends_at       TEXT,                        -- nullable
  all_day       INTEGER NOT NULL DEFAULT 0,
  tz            TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'confirmed',
  tickers_json  TEXT,                        -- JSON array
  topics_json   TEXT,                        -- JSON array
  theses_json   TEXT,                        -- JSON array
  tags_json     TEXT,                        -- JSON array
  external_id   TEXT,                        -- driver-owned
  content_hash  TEXT NOT NULL,               -- matches frontmatter
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX uber_calendar_starts_at_idx ON uber_calendar(starts_at);
CREATE INDEX uber_calendar_kind_starts_idx ON uber_calendar(kind, starts_at);
CREATE INDEX uber_calendar_source_starts_idx ON uber_calendar(source, starts_at);
CREATE UNIQUE INDEX uber_calendar_external_idx ON uber_calendar(source, external_id) WHERE external_id IS NOT NULL;
```

Per [profile.md § Read vs. Write Capabilities](profile.md#read-vs-write-capabilities): the kernel daemon is the single SQLite writer; the Uebermensch process reads the vault directly for performance but routes mutations through kernel HTTP routes.

### `uber_calendar_reminders`

```sql
CREATE TABLE uber_calendar_reminders (
  id          TEXT PRIMARY KEY,    -- "remind_" || ulid
  event_id    TEXT NOT NULL REFERENCES uber_calendar(id) ON DELETE CASCADE,
  fire_at     TEXT NOT NULL,       -- absolute ISO 8601 (event_starts_at + offset)
  channel     TEXT NOT NULL,       -- profile.delivery.channels.<name>
  status      TEXT NOT NULL,       -- pending | sent | failed | skipped
  delivery_id TEXT,                -- FK → uber_deliveries.id once sent
  attempted_at TEXT,
  error       TEXT
);

CREATE UNIQUE INDEX uber_calendar_reminders_idem
  ON uber_calendar_reminders(event_id, channel, fire_at);
```

Idempotency key: `(event_id, channel, fire_at)`. The `Scheduler` polls the next due reminder and hands off to `DelivererService` (same fan-out as briefs).

## Filtering & Views

Filtering is the calendar's primary user surface — both the CLI and the web UI accept the same predicate set.

### Filter predicates

| Predicate | Example | Meaning |
|-----------|---------|---------|
| `source` | `source=user` | restrict to one or more origins (comma-separated) |
| `kind` | `kind=earnings,macro` | restrict to one or more event kinds |
| `from` / `to` | `from=today to=+7d` | inclusive date window; relative shortcuts: `today`, `tomorrow`, `+Nd`, `+Nw`, `eom` |
| `tickers` | `tickers=NVDA,AMZN` | match if event's `tickers` intersects |
| `topics` | `topics=ai-infra-capex` | match if event's `topics` intersects |
| `theses` | `theses=ai-infra-capex` | match if event's `theses` intersects |
| `tag` | `tag=q1-2026` | match if event's `tags` contains |
| `status` | `status=confirmed` | default; pass `status=tentative,confirmed` to widen |
| `q` | `q="board"` | case-insensitive substring on title or body |

Predicates AND together. Within a predicate, multiple values OR.

### Saved views

Three named views ship by default; users can add more in `profile.md` under `calendar.views`:

```yaml
calendar:
  default_view: personal-week
  views:
    personal-week:
      description: "My next 7 days"
      filter: { source: [user, driver-gcal], from: today, to: +7d }
    finance-week:
      description: "Watchlist earnings + macro this week"
      filter: { kind: [earnings, macro], from: today, to: +7d }
    earnings-watchlist:
      description: "Earnings for tickers I watch, next 30d"
      filter:
        kind: [earnings]
        tickers: [NVDA, AMZN, GOOGL, MSFT, META, AAPL]
        from: today
        to: +30d
    ai-thesis-month:
      description: "Anything tied to my AI infra capex thesis, next 30d"
      filter: { theses: [ai-infra-capex], from: today, to: +30d }
```

Views are pure shortcuts — they expand to the same predicate set above.

## CLI — `gctrl uber calendar`

```sh
# List events with optional filters
gctrl uber calendar list                                      # default view from profile
gctrl uber calendar list --view personal-week
gctrl uber calendar list --kind earnings --from today --to +7d
gctrl uber calendar list --source user --tag q1-2026

# Show one event (markdown)
gctrl uber calendar show <slug>

# Add a personal event interactively or with flags
gctrl uber calendar add --title "Board meeting" --start 2026-05-08T14:00 --tz Asia/Hong_Kong --kind personal
gctrl uber calendar add --title "NVDA earnings prep" --start 2026-05-20 --all-day --kind deadline --topics ai-infra-capex

# Edit an event in $EDITOR
gctrl uber calendar edit <slug>

# Remove a personal event (driver-generated events cannot be removed via CLI;
# fix the upstream source instead)
gctrl uber calendar remove <slug>

# Pull driver-managed events on demand (otherwise runs on schedule)
gctrl uber calendar pull --driver markets
gctrl uber calendar pull --driver sec --tickers NVDA,AMZN
gctrl uber calendar pull --driver gcal --calendar-id primary

# Push user-authored events into Google Calendar (extension; opt-in)
gctrl uber calendar push --to gcal --calendar-id primary --dry-run

# Reindex the SQLite table from vault (recovery / migration)
gctrl uber calendar reindex
```

Validation: `add` and `edit` round-trip the file through the `EventFrontmatter` schema before write. Unknown fields are preserved (forward-compat) but unknown enum values fail.

## HTTP API

Served on the Uebermensch app port (separate from kernel `:4318`). Mirrors the CLI surface 1:1.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/uber/calendar/events` | List events. Query params match the filter predicates. |
| GET | `/api/uber/calendar/events/{slug}` | Get one event (frontmatter + body). |
| POST | `/api/uber/calendar/events` | Create a `source: user` event. Returns the canonical slug. |
| PATCH | `/api/uber/calendar/events/{slug}` | Update frontmatter / body of a `source: user` event. 403 on driver-owned events. |
| DELETE | `/api/uber/calendar/events/{slug}` | Remove a `source: user` event. 403 on driver-owned events. |
| GET | `/api/uber/calendar/views` | List saved views from profile. |
| POST | `/api/uber/calendar/pull` | Trigger a driver pull on demand. Body: `{ driver, params }`. |
| GET | `/api/uber/calendar/feed.ics` | RFC 5545 iCalendar feed of the current default view (read-only, useful for read-only Google Calendar subscription). |

The `.ics` feed is the cheapest possible "extension #2 lite" — point Google Calendar (or anything iCal-aware) at the URL with a bearer token query param and you get the personal-week view as a calendar overlay, without needing the bidirectional `driver-gcal` integration.

## Briefing Integration

The morning brief gets a deterministic "On the calendar today" section, prepended before the curated items. It is **not** generated by the LLM — it's a renderer pass over today's events, grouped by `kind`.

```markdown
## On the calendar today

**Earnings** — NVDA Q1 2026 earnings call · 20:00 ET · `[[nvidia]]`
**Macro** — US CPI release · 08:30 ET
**Personal** — Board meeting · 14:00 HKT · `[[projects/quarterly-review]]`
```

Rules:

1. The section is included only if `today_events.length > 0`.
2. Order: `earnings`, `macro`, `regulatory`, `corporate-action`, `political`, `prediction-market`, `industry`, `personal`, `deadline`, `travel`, `other`.
3. Each entry: title, time (in `profile.identity.tz`), `[[slug]]` link to the related entity / project page if `related_pages` is non-empty.
4. The curator's prompt receives the same list as a `<calendar_today>...</calendar_today>` block so it can reference upcoming events in the analysis (e.g., "this is the second of three earnings days this week" — links events to the brief items).
5. Item-level `kind: action` may be promoted into the brief's action items if the event is `<= +1d` away and `kind=deadline` — the curator decides whether to surface.

The briefing pipeline imports `today_events` via `KbPort.listCalendarEvents({ from: 'today', to: 'today' })` — same predicate engine as the CLI/API.

## Reminder Pipeline

Distinct from morning brief. Reminders fire at specific times and target a specific channel.

```
┌──────────┐   ┌────────────────┐   ┌──────────────────┐   ┌────────────────┐
│Scheduler │──▶│ ReminderPicker │──▶│  DelivererService│──▶│  Channels (TG, │
│ (kernel) │   │ (next due rows)│   │   (idempotent)   │   │  Discord, App) │
└──────────┘   └────────────────┘   └──────────────────┘   └────────────────┘
```

1. On event create/update, the writer computes absolute `fire_at = starts_at + offset` for each entry in `reminders[]` and inserts into `uber_calendar_reminders` with `status: pending`.
2. Scheduler ticks every 60s, picks rows where `fire_at <= now AND status='pending'` (LIMIT 50, ORDER BY fire_at).
3. Each row is handed to `DelivererService` with the rendered reminder body (templated; one-line title + time + relevant `[[wikilinks]]`).
4. Idempotency key `(event_id, channel, fire_at)` makes re-fires safe across restarts.
5. Quiet hours from `profile.delivery.channels.<name>.window` apply — fires inside a quiet window get `status: skipped` with `error: 'quiet_hours'` and the user sees them rolled up in the next morning brief.

## Drivers

Three drivers feed the calendar; each is feature-gated as a kernel LKM (per [os.md § 5](../../vault/specs/architecture/os.md)).

### `driver-markets` (extends existing)

Already planned in M3 for prices + prediction markets ([ROADMAP.md](../ROADMAP.md)). This spec extends it with a calendar producer:

- **Earnings calendar:** poll a public earnings-feed source (TBD on commercial vs. scraped — open question) on a daily cadence; for each ticker in the user's `topics[].watchlist` ∪ explicit `calendar.tickers_watchlist`, write/update `calendar/generated/<date>--<ticker>-<period>-earnings.md` with `kind: earnings, source: driver-markets`.
- **Macro events:** known release calendar (FOMC, CPI, NFP, ECB, BoJ) maintained as a small static list inside the driver, refreshed quarterly. `kind: macro`.
- **Prediction-market resolution:** for any market in `sources[].config.markets`, emit a `kind: prediction-market` event at the resolution date.

### `driver-sec` (extends existing)

Already planned in M3 for filings ingest. Calendar producer:

- **Lockup expiries:** parse S-1 prospectuses for `LOCK_UP_EXPIRATION` blocks; emit `kind: corporate-action`.
- **Effective dates:** post-effective amendment effective dates from S-3 / S-1.
- **Scheduled comment periods:** Reg A / Reg D windows.

### `driver-gcal` (NEW)

New kernel LKM. Read-only by default, write-back opt-in per calendar.

**Read path:**

- Configured per-calendar in `profile.md` under `delivery.calendars[]`:
  ```yaml
  calendars:
    - id: primary
      driver: gcal
      external_calendar_id: "you@example.com"
      direction: read
      kind_default: personal
      tag_default: ["from-gcal"]
  ```
- Polls Google Calendar API on a configurable cadence (default 5min), maps each event into the `EventFrontmatter` shape with `source: driver-gcal`, writes to `calendar/generated/<date>--gcal-<slug>.md`.
- `external_id = "gcal:<event_id>"`, `external_etag = <etag>` — re-pulls upsert in place.
- Deletions on the Google side mark the local file with `status: cancelled` rather than deleting (keeps an audit trail; user can `gctrl uber calendar prune --status cancelled --older-than 30d`).

**Write-back path (extension; opt-in):**

- Set `direction: read-write` on the calendar config and add `write_back: { allowed_kinds: [personal, deadline] }`.
- On any `source: user` event create/update under `calendar/`, push to the configured Google Calendar after a 5s debounce.
- Conflict policy: **local-wins** for fields the user owns (title, body, times, tz); Google-side updates to those fields fire an inbox alert rather than overwriting.
- Bidirectional sync inherits the same idempotency fields (`external_id`, `external_etag`).
- The driver MUST authenticate via OAuth 2.0 with the kernel holding the refresh token — Uebermensch app code never sees the token (per [os.md § Dependency Direction](../../vault/specs/architecture/os.md#dependency-direction-invariant)).

## Visualization (Extension)

The Uebermensch web UI ([architecture.md](architecture.md)) gains a `Calendar` view alongside `Briefs`, `Wiki`, and `Theses`.

### MVP shape (first cut)

- **Filter chips strip** at the top: source (user / markets / sec / gcal), kind (multi-select), date range (today / week / month / custom), ticker / topic / thesis filter via search-as-you-type.
- **Three layout modes:**
  - **Agenda** (default): linear list grouped by date; densest, mobile-friendly.
  - **Week**: 7-day column grid; useful for personal scheduling.
  - **Month**: classic month grid; useful for spotting clustering of earnings + macro days.
- **Event card:** title, time, kind chip, source chip, ticker chips, link out to the underlying markdown file in the wiki explorer (which renders the body with resolved wikilinks).
- **Saved views** appear as preset chips above the filter strip. Switching a view rewrites the URL query string so the view is shareable / bookmarkable.

### Stretch features

- **Heatmap row** above the month grid showing daily event density by kind — instantly surfaces "FOMC day stacked on top of three earnings".
- **Watchlist overlay:** select a ticker; all earnings + corporate-action events for that ticker highlight, even outside the current filter.
- **Brief-link badge:** each event links forward to the next morning brief that referenced it (and backward to deepdives).

The web UI reads `/api/uber/calendar/events` — same endpoint the CLI uses, so feature parity is enforced by construction.

## R2 Sync

Both tiers of `calendar/` participate in the existing R2 sync (per [profile.md § Sync (R2)](profile.md#sync-r2)). No new sync mount needed — the `**/*.md` include glob already covers `calendar/**/*.md`. Conflict policy follows the existing local-wins-with-warning rule; conflicting files surface as `<stem>.conflict-<device>-<ts>.md` and `gctrl uber vault conflicts` lists them.

## Profile Schema Additions

Add a `calendar:` section to `profile.md` frontmatter:

```yaml
calendar:
  default_view: personal-week
  tickers_watchlist: [NVDA, AMZN, GOOGL, MSFT, META, AAPL]   # union with topics[].watchlist
  default_reminders:
    earnings: ["-P1D", "-PT30M"]
    macro: ["-P1D"]
    personal: ["-PT15M"]
    deadline: ["-P1D", "-PT1H"]
  views:
    # see § Saved views above
  calendars:
    - id: primary
      driver: gcal
      external_calendar_id: "..."
      direction: read         # or read-write (extension; opt-in)
      kind_default: personal
```

Extends `Profile` schema; the daemon's `ProfileService` decodes it on load. Missing `calendar:` block falls back to in-app defaults (no driver-pulled events, only user-authored).

## Validation Rules

`gctrl uber profile validate` extends with:

1. Every file under `calendar/` parses as `EventFrontmatter` and has a non-empty `slug`.
2. `slug` is unique across `calendar/**/*.md` (folder split is for organisation only).
3. `starts_at` parses as ISO 8601 with offset; `ends_at` (if present) is `>= starts_at`; `tz` is a valid IANA timezone.
4. `kind` is one of the documented enum values; unknown kinds fail.
5. `tickers` are uppercase `[A-Z][A-Z0-9.\-]{0,9}`.
6. `topics`, `theses`, `tags`, `related_pages` slugs match `[a-z0-9-]+`.
7. Driver-owned events MUST have `external_id` set and `source` ∈ {`driver-*`}.
8. `reminders[].channel` resolves to an entry in `profile.delivery.channels`.
9. `reminders[].offset` parses as ISO 8601 duration (`-P1D`, `-PT2H`, `-PT15M`).
10. No two events share the same `(source, external_id)` — the `uber_calendar_external_idx` unique index makes this loud at upsert time too.

## Eval & Observability

Calendar work generates kernel telemetry like everything else:

- Each driver pull is a `Session` with spans for fetch + parse + upsert; total cost (zero for most drivers; non-zero if `driver-gcal` ever uses Workers AI for free-form-event summarisation).
- Reminder deliveries write `uber_deliveries` rows (same table as brief deliveries) — a unified delivery dashboard surfaces both.
- Two new automated checks run daily:
  - **Stale driver:** if `driver-markets` hasn't produced an event update in ≥ 7d for a given source, fire `uber_alerts(kind='scrape_health')`.
  - **Missed reminder:** if a `pending` reminder's `fire_at` is older than 1h, fire `uber_alerts(kind='scrape_health', subject='reminder backlog')`. (Quiet-hours-skipped reminders do not count.)

## Roadmap Hooks

This spec is implemented in three phases. See [ROADMAP.md](../ROADMAP.md) for the milestone breakdown.

| Phase | Scope | Where |
|-------|-------|-------|
| **Core** (calendar M0) | `calendar/` folder + `EventFrontmatter` + `uber_calendar` index + CLI (`list`, `add`, `show`, `edit`, `remove`, `reindex`) + briefing-pipeline integration + `ICS` feed | New milestone after M2 |
| **Drivers** (calendar M1) | `driver-markets` earnings + macro producers; `driver-sec` lockup/effective-date producer; `driver-gcal` read-only | Folds into M3 (existing market-data milestone) |
| **Visualization + write-back** (calendar M2) | Web UI calendar view (agenda + week + month); `driver-gcal` write-back behind opt-in flag | Folds into M2 (web UI milestone) and M3 |

## Non-Goals

1. **Not a calendaring app.** No invites, no RSVP tracking, no scheduling-assistant ("find a 30-min slot"). The user's existing calendar app does that better.
2. **Not a CRM.** Contacts and meeting attendees are not first-class entities. Reference them via `[[wikilinks]]` to wiki entity pages if useful.
3. **Not a quant calendar product.** No backtesting around event windows, no event-driven signal generation. The calendar surfaces dates; the human reasons over them.
4. **Not a notification stream.** Reminders are deliberate and bounded by per-channel quiet windows. We will not page the user every 15 minutes.
5. **Not multi-user.** A vault is one identity (per [profile.md § Identity](profile.md#location--identity)); shared team calendars are out of scope. Two devices for the same user is fine via R2.

## Open Questions

1. **Earnings data source.** Free public sources (Yahoo Finance scrape, Nasdaq calendar HTML) are fragile; commercial APIs cost money. **Leaning:** start with Yahoo HTML scrape (single low-volume daily request) gated behind an explicit user opt-in; document the fragility in the driver README. Needed by calendar M1.
2. **Recurring events shape.** RFC 5545 RRULE is verbose but the standard. **Leaning:** support a `recurrence:` frontmatter block parsing a small RRULE subset (`FREQ`, `BYDAY`, `INTERVAL`, `UNTIL`, `COUNT`) for the `recurring/` directory; expand on the fly into materialised events for the requested window rather than persisting every occurrence. Needed by calendar M0 personal-events polish.
3. **Driver-pulled event deletion semantics.** When a driver source removes an event (e.g., earnings call cancelled), do we delete the file or mark `status: cancelled`? **Leaning:** mark cancelled; provide `gctrl uber calendar prune` for periodic cleanup. Needed by calendar M1.
4. **Time-zone display rule.** Render in event's `tz` or in `profile.identity.tz`? **Leaning:** render in `profile.identity.tz` by default with the original `tz` in parens (`20:00 ET (08:00 HKT next day)`); CLI `--tz` flag overrides per-call. Needed by calendar M0.
5. **`.ics` feed auth model.** Bearer-token query param works for read-only subscriptions but is leakable in URL access logs. **Leaning:** bearer in query param for now (it's the only thing iCal subscriptions support); rotate via `gctrl uber calendar feed-token rotate`; document the trade-off. Needed by calendar M2.
6. **Google Calendar write-back conflict UX.** When the user edits both sides between syncs, do we surface a conflict file (calendar version of `<stem>.conflict-<device>-<ts>.md`) or a merge UI? **Leaning:** conflict file in `calendar/conflicts/` plus an inbox alert; merge happens in Obsidian. Needed by calendar M2 write-back.
7. **Multi-calendar support in `driver-gcal`.** Personal + work + a shared team calendar all push events into one vault — do we need per-calendar prefixes in slug to avoid collisions? **Leaning:** include `external_id` in slug as a suffix (`<date>--gcal-<calendar-id>-<event-id>.md`) so collisions are impossible; nice display name is the title. Needed by calendar M1.
