# Uebermensch — Calendar Timeboxes

> A Timebox is a parent vault file representing a practice plan: a goal that needs scheduled, repeated time-blocks toward a measurable outcome by a deadline. Children are ordinary calendar events carrying a `timebox:` frontmatter field; they live in the existing `action/events/` paths and reuse all calendar filtering, reminders, and ICS export for free.
>
> Related: [calendar.md](calendar.md) (sibling spec; event shape and storage this extends), [profile.md § working_windows](profile.md#profile-schema-additions) (working-window config the planner reads), [briefing-pipeline.md](briefing-pipeline.md) (how today's timebox events surface in the brief), [domain-model.md](domain-model.md) (Effect-TS port/service pattern), [architecture.md](architecture.md) (L4 layering rules — never open DuckDB, never call external APIs directly).

## Why a Timebox Spec

The brief tells the user what happened; the calendar tells the user what is about to happen. Neither is enough for goals that demand repeated, compounding effort — finishing a paper, training for a marathon, shipping a content series, building a language habit.

Without first-class scheduling:

1. Intent dissolves. A reader who marks "finish Constitutional AI" on a sticky note rarely finishes Constitutional AI. The plan needs to break into sessions and block the calendar accordingly.
2. Reminders are not enough. A single alarm at the deadline tells the user they missed the target, not how to hit it. What is needed is a sequence of dated events, each a concrete unit of work.
3. Ad-hoc events lose the through-line. If sessions are scattered across the calendar without a parent, there is no progress counter, no stall detection, no completion signal, and no audit trail.
4. Disciplines look different but share one shape. Reading pages, running kilometres, recording podcast episodes, and drafting posts are all "divide a total by time remaining, spread into sessions, track done." The abstraction is the same; only the unit changes.

A Timebox is the vault-first answer: one parent file captures the goal; the planner slices it into dated child events; progress rolls up automatically as children complete.

## Principles

1. **Markdown is the source of truth.** The parent file (`action/events/timeboxes/<slug>.md`) and all child events (`action/events/<date>--<slug>.md`) are the authoritative records. SQLite (`uber_timeboxes`, new columns on `uber_calendar`) is a rebuildable index. Deleting SQLite MUST be recoverable by re-running `gctrl uber timebox reindex`.
2. **One shape across disciplines.** There is no `kind: study` vs. `kind: training` split. Every timebox is `kind: practice`, parameterised by `discipline:`. The planner only needs `unit` + `session_minutes`; `discipline` is for display and downstream filtering.
3. **Children are first-class calendar events.** Timebox child events are ordinary entries in `uber_calendar`. They appear in calendar views, fire reminders, export to ICS, and mirror to Google Calendar exactly like any other event. No separate table; no special folder.
4. **Planner is deterministic by default, LLM-assisted on demand.** `gctrl uber timebox plan` slices work with even arithmetic and produces a dry-run. `--llm` hands goal + profile working-windows to `driver-llm`; proposals are validated and presented before any write. Nothing is committed without `--apply`.
5. **Re-plan preserves the audit trail.** Superseded child events are marked `status: superseded`, not deleted. The replaced plan remains browsable in Obsidian and searchable in SQLite.
6. **Coaching nudges reuse the existing reminder pipeline.** Progress-threshold alerts and halfway messages insert rows into `uber_calendar_reminders` (channel = profile default channel). No new delivery infrastructure.
7. **Wikilinks compound.** A timebox referencing `related_pages: [paper:constitutional-ai]` wires the practice plan into the vault graph, so the brief pipeline can surface it alongside related wiki pages on the same topic.

## Vault Layout

```
$UBER_VAULT_DIR/
└── action/
    └── events/                                          # time-bound events (git-tracked at top level)
        ├── timeboxes/                                   # NEW — parent files
        │   ├── sub-3-berlin.md                          # kind: practice, discipline: running
        │   └── constitutional-ai-reading.md             # kind: practice, discipline: reading
        │
        ├── 2026-06-02--sub-3-berlin.md                  # child event; timebox: sub-3-berlin
        ├── 2026-06-04--sub-3-berlin.md                  # child event; step 2/52
        ├── 2026-04-30--constitutional-ai-reading.md     # child event; timebox: constitutional-ai-reading
        ├── ...
        └── generated/                                   # driver-pulled events (unchanged; gitignored)
```

`action/events/timeboxes/` is a new authored-tier subdirectory — git-tracked, Obsidian-mountable. Child events live directly under `action/events/` with the existing `<date>--<slug>.md` naming, distinguished from one-off events only by the presence of `timebox:` in frontmatter. The `<slug>` portion of child filenames repeats the timebox slug for browsability; a numeric suffix disambiguates same-day sessions (`2026-06-02--sub-3-berlin-a.md`, `-b.md`).

## Timebox Frontmatter

### Running example

```yaml
---
slug: sub-3-berlin
kind: practice
discipline: running
title: "Sub-3 Berlin Marathon"
goal: "Complete the Berlin Marathon in under 3 hours on 2026-09-27."
deadline: 2026-09-27
unit: km
total: 600
done: 142                         # rolled up from completed children; read-only from user's perspective
session_minutes: 60
sessions_per_week: 4
status: active                    # active | paused | done | cancelled
taper_days_before_deadline: 14    # optional; athletic disciplines only
related_pages: [running-log]      # bare slugs; wikilinks into vault graph
topics: [endurance-sports]
tags: [marathon, berlin-2026]
coaching:
  nudges:
    - { at: 0.25, template: "Quarter of the way there — {done}{unit} of {total}{unit} logged." }
    - { at: 0.5,  template: "Halfway — {done}{unit} done. Pace: on track for deadline." }
    - { at: 0.75, template: "Three-quarters in — final push. Taper starts in {taper_days} days." }
created_at: 2026-04-29T08:00:00+08:00
updated_at: 2026-04-29T08:00:00+08:00
content_hash: sha256:…
---

## Goal

Sub-3 hour marathon at Berlin on 2026-09-27.
Base: 4 sessions/week, 600km total over 22 weeks (14-day taper).

## Notes

- Long run Sunday; intervals Tuesday; easy Wednesday + Friday.
- See [[running-log]] for actual times accumulated by session.
```

### Reading example

```yaml
---
slug: constitutional-ai-reading
kind: practice
discipline: reading
title: "Constitutional AI — Anthropic paper"
goal: "Read all 64 pages of the Constitutional AI paper with margin notes."
deadline: 2026-05-20
unit: pages
total: 64
done: 12
session_minutes: 60
sessions_per_week: 4
status: active
related_pages: [paper-constitutional-ai]
topics: [ai-dev-workflows]
tags: [alignment, reading]
coaching:
  nudges:
    - { at: 0.5, template: "Page {done} of {total} — halfway through the paper." }
created_at: 2026-04-25T07:30:00+08:00
updated_at: 2026-04-29T09:00:00+08:00
content_hash: sha256:…
---
```

### Required vs. optional

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | yes | kebab-case; unique within `action/events/timeboxes/`; used as filename stem |
| `kind` | yes | always `practice` |
| `discipline` | yes | open string; see § Discipline Taxonomy |
| `title` | yes | display string |
| `goal` | yes | plain-language statement of the outcome |
| `deadline` | yes | ISO 8601 date; must be in the future at create time |
| `unit` | yes | open string (e.g., `km`, `pages`, `episodes`, `posts`) |
| `total` | yes | numeric total units to complete |
| `session_minutes` | yes | nominal duration of one session in minutes |
| `sessions_per_week` | yes | default sessions per week for the planner |
| `status` | yes | `active` is default |
| `done` | no | rolled up by `complete`; do not set by hand |
| `taper_days_before_deadline` | no | excludes the final N days from session scheduling |
| `related_pages` | no | bare slugs; wikilinks to wiki/thesis/project pages |
| `topics` | no | intersects with `profile.topics` for brief promotion |
| `tags` | no | free-form taxonomy |
| `coaching` | no | sub-block; see § Coaching Nudges |
| `created_at` | yes | ISO 8601 with offset; set at creation |
| `updated_at` | yes | ISO 8601 with offset; updated on every write |
| `content_hash` | yes | sha256 of file bytes; set by writer |

## Child Event Frontmatter Additions

Child events are ordinary events conforming to [calendar.md § Event Frontmatter](calendar.md#event-frontmatter) with three additional fields and one extended enum value:

```yaml
---
slug: 2026-06-02--sub-3-berlin
title: "Sub-3 Berlin · 12km easy · session 3/52"
kind: practice
source: user
starts_at: 2026-06-02T07:00:00+08:00
ends_at: 2026-06-02T08:00:00+08:00
tz: "Asia/Hong_Kong"
status: confirmed                   # confirmed | tentative | cancelled | superseded (NEW)
timebox: sub-3-berlin               # NEW — slug of the parent timebox
step: 3                             # NEW — ordinal position within the plan (1-based)
step_total: 52                      # NEW — total planned sessions at time of write
step_units: "12km easy"             # NEW — human-readable description of this session's units
---
```

New fields:

| Field | Required on child | Notes |
|-------|-------------------|-------|
| `timebox` | yes (if child) | slug matching a `action/events/timeboxes/<slug>.md` file |
| `step` | yes (if child) | integer ≥ 1; `step <= step_total` enforced by validation |
| `step_total` | yes (if child) | total sessions in the current plan at write time |
| `step_units` | yes (if child) | free-form string describing what this session covers (e.g., `"pages 30–40"`, `"12km easy"`, `"episode 3 outline"`) |

`status: superseded` is a new value added to the `status` enum from [calendar.md](calendar.md). Superseded events are excluded from active calendar views by default but retained for audit. The `uber_calendar` index must handle `status = 'superseded'` without error.

## Storage

### `uber_timeboxes`

New table; kernel daemon is the single writer.

```sql
CREATE TABLE uber_timeboxes (
  id                  TEXT PRIMARY KEY,           -- "tb_" || ulid
  slug                TEXT NOT NULL UNIQUE,
  vault_path          TEXT NOT NULL UNIQUE,        -- e.g. "action/events/timeboxes/sub-3-berlin.md"
  kind                TEXT NOT NULL DEFAULT 'practice',
  discipline          TEXT NOT NULL,
  title               TEXT NOT NULL,
  goal                TEXT NOT NULL,
  deadline            TEXT NOT NULL,               -- ISO 8601 date
  unit                TEXT NOT NULL,
  total               REAL NOT NULL,
  done                REAL NOT NULL DEFAULT 0,
  session_minutes     INTEGER NOT NULL,
  sessions_per_week   REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  content_hash        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX uber_timeboxes_status_idx ON uber_timeboxes(status, deadline);
```

### New columns on `uber_calendar`

```sql
ALTER TABLE uber_calendar ADD COLUMN timebox_slug  TEXT;
ALTER TABLE uber_calendar ADD COLUMN step          INTEGER;
ALTER TABLE uber_calendar ADD COLUMN step_total    INTEGER;
ALTER TABLE uber_calendar ADD COLUMN step_units    TEXT;

CREATE INDEX uber_calendar_timebox_idx
  ON uber_calendar(timebox_slug, step);
```

These columns are `NULL` for all non-timebox events. The `uber_calendar_timebox_idx` covers the primary access pattern: "list all steps for timebox X in order."

The single-writer rule from [calendar.md § Storage](calendar.md#storage) applies unchanged: the kernel daemon is the only process that inserts or updates these tables. Uebermensch app code reads via kernel HTTP routes.

## Planner

The planner is invoked by `gctrl uber timebox plan` and `gctrl uber timebox replan`. Both produce a dry-run by default; nothing is written until `--apply`.

### Inputs

- Timebox frontmatter (`total`, `done`, `deadline`, `session_minutes`, `sessions_per_week`, `taper_days_before_deadline`)
- `profile.timeboxes.working_windows` — per-weekday time windows within which sessions may be scheduled
- Existing `action/events/` for the target user (read via `KbPort`) — used to avoid double-booking
- For re-plan: which child events the user has manually edited (these are "pinned" — excluded from redistribution)

### Default (deterministic) algorithm

```
remaining_units  = total - done
weeks_remaining  = floor((deadline - today - taper_days) / 7)
sessions_needed  = ceil(weeks_remaining * sessions_per_week)
units_per_session = remaining_units / sessions_needed   (rounded to sensible precision)
```

The planner walks forward from `today + 1d`, for each day:

1. Check if the day falls within a `working_windows` entry.
2. Check if the time slot overlaps any existing confirmed/tentative calendar event (double-booking guard).
3. If clear, allocate a session: `starts_at = window.start`, `ends_at = starts_at + session_minutes`.
4. Repeat until `sessions_needed` events are placed or `deadline - taper_days` is reached (whichever comes first).

If `taper_days_before_deadline > 0`, the final `taper_days` before the deadline are left clear (no new sessions placed). The taper window may receive manually added sessions via `gctrl uber timebox add-event`.

### LLM-assisted (`--llm`)

When `--llm` is passed, the planner instead:

1. Composes a prompt containing: goal, total, done, deadline, unit, session_minutes, sessions_per_week, working_windows (serialised), and the list of already-blocked time slots.
2. Sends to `driver-llm` via `POST /api/llm/generate` (kernel route — app code never calls the LLM directly).
3. Expects a JSON response: `{ "sessions": [{ "date": "YYYY-MM-DD", "start": "HH:MM", "end": "HH:MM", "units": "string" }, ...] }`.
4. Validates each proposal: date within range, no overlap with existing events, total proposed units approximately equals `remaining_units`, count matches `sessions_needed`.
5. Presents the validated proposals as a dry-run diff. The user inspects and runs `--apply` to commit.

The `--llm` path adds an `llm` span (cost tracked in the session) to the plan trace. The deterministic path emits no LLM call.

### Re-plan

`gctrl uber timebox replan <slug>` re-runs the algorithm against:

- `remaining_units = total - done` (recalculated from completed children)
- `remaining_time = deadline - today` (recalculated)
- Pinned events: any child event the user has manually edited since creation (`updated_at > created_at + 60s`) is excluded from redistribution and kept in place

Superseded events (old plan) are marked `status: superseded` in their frontmatter and in `uber_calendar`. New events are written at the new schedule. The audit trail is preserved.

## CLI — `gctrl uber timebox`

```sh
# List all timeboxes (active by default; --all for all statuses)
gctrl uber timebox list
gctrl uber timebox list --status paused

# Show a timebox (frontmatter + progress summary + child event list)
gctrl uber timebox show <slug>

# Plan a new timebox (dry-run by default; --apply to commit)
gctrl uber timebox plan \
  --discipline reading \
  --title "Constitutional AI" \
  --total 64 \
  --unit pages \
  --session-minutes 60 \
  --sessions-per-week 4 \
  --deadline 2026-05-20 \
  --related-page paper-constitutional-ai

gctrl uber timebox plan \
  --discipline running \
  --title "Sub-3 Berlin" \
  --total 600 \
  --unit km \
  --sessions-per-week 4 \
  --deadline 2026-09-27 \
  --taper-days 14 \
  --llm

# --apply commits the dry-run plan (writes parent file + all child events)
gctrl uber timebox plan --discipline reading ... --apply

# Add a single child event manually (outside the planner's automatic slots)
gctrl uber timebox add-event <slug> \
  --start 2026-05-15T07:00 \
  --units "12km easy"

# Mark a step done; rolls up done on parent; checks nudge thresholds
gctrl uber timebox complete <slug>:<step>

# Mark a step skipped; updates plan offset for re-plan
gctrl uber timebox skip <slug>:<step>

# Re-plan remaining sessions (dry-run by default)
gctrl uber timebox replan <slug>
gctrl uber timebox replan <slug> --llm
gctrl uber timebox replan <slug> --apply

# Lifecycle transitions
gctrl uber timebox pause <slug>
gctrl uber timebox resume <slug>
gctrl uber timebox cancel <slug>

# Mark a timebox fully done (sets status: done, updates parent frontmatter)
gctrl uber timebox complete <slug>

# Rebuild uber_timeboxes and timebox columns in uber_calendar from vault
gctrl uber timebox reindex
```

`plan` and `replan` default to dry-run — they print a table of proposed child events (date, start, end, units) without writing anything. Append `--apply` to commit. The `--llm` flag is available on both commands; without it the deterministic algorithm runs.

## HTTP API

Served on the Uebermensch app port (separate from kernel `:4318`). Mirrors CLI surface 1:1.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/uber/calendar/timeboxes` | List timeboxes. Query params: `status`, `discipline`. |
| POST | `/api/uber/calendar/timeboxes` | Create a new timebox (parent file only; no child events yet). |
| GET | `/api/uber/calendar/timeboxes/{slug}` | Get one timebox (frontmatter + progress + child event list). |
| PATCH | `/api/uber/calendar/timeboxes/{slug}` | Update frontmatter (title, goal, sessions_per_week, etc.). 422 on `done` or `content_hash` write attempts. |
| DELETE | `/api/uber/calendar/timeboxes/{slug}` | Cancel and archive — sets `status: cancelled`; child events marked `status: superseded`. |
| POST | `/api/uber/calendar/timeboxes/{slug}/plan` | Run the planner. Body: `{ apply: bool, llm: bool }`. Returns dry-run diff or applies and returns created event slugs. |
| POST | `/api/uber/calendar/timeboxes/{slug}/replan` | Re-run planner against remaining work + time. Same body shape as plan. |
| POST | `/api/uber/calendar/timeboxes/{slug}/complete/{step}` | Mark step N done. Updates `done` on parent; checks nudge thresholds; returns updated timebox. |
| POST | `/api/uber/calendar/timeboxes/{slug}/skip/{step}` | Mark step N skipped. Does not increment `done`. |

## Briefing Integration

Today's timebox child events appear in the "On the calendar today" section of the morning brief. Each entry follows the line shape:

```
**Practice** — Sub-3 Berlin · 12km easy · 60min · session 18/52 · [[running-log]]
**Practice** — Constitutional AI · pages 30–40 · 60min · session 4/7 · [[paper-constitutional-ai]]
```

Fields: `kind: practice` (the display label), timebox title, `step_units`, `session_minutes`, `step/step_total`, and the first `related_pages` bare wikilink if present.

Practice events appear after `deadline` and before `personal` in the brief's kind ordering (see [calendar.md § Briefing Integration](calendar.md#briefing-integration) for the full ordering rule).

### Off-track timeboxes block

A new block fires in the brief when a timebox is stalled. Stall condition: no child event with `status: done` or `status: confirmed` has been seen within `2 × (7 / sessions_per_week)` days, AND the deadline is within `profile.timeboxes.stalled_threshold` (ISO 8601 duration, e.g. `P14D`).

```markdown
## Off track

**Sub-3 Berlin** — last session 12 days ago · 142/600km done · deadline in 19 days
**Constitutional AI** — last session 8 days ago · 12/64 pages done · deadline in 6 days
```

This block is included in the curator's prompt as `<offtrack_timeboxes>...</offtrack_timeboxes>` so the LLM may reference it in the brief summary (e.g., surfacing a deadline risk alongside related wiki updates). The block is omitted — not rendered as empty — when no timebox meets the stall condition.

## Coaching Nudges

The `coaching.nudges[]` sub-block in a timebox's frontmatter specifies progress-triggered messages. Each nudge has:

- `at`: a progress fraction in `(0, 1]` (e.g., `0.5` = 50% of `total` done) or an absolute ISO 8601 date
- `template`: a string with `{done}`, `{total}`, `{unit}`, `{taper_days}` interpolation placeholders

On every `gctrl uber timebox complete <slug>:<step>` call, the writer checks which nudge thresholds have been crossed since the last complete. For each newly crossed threshold:

1. Render the template with current progress values.
2. Insert a row into `uber_calendar_reminders` with:
   - `event_id` pointing at the parent timebox's synthetic event id (a stable id derived from the timebox slug)
   - `fire_at = now + PT5M` (near-immediate; the scheduler picks it up on its next tick)
   - `channel = profile.timeboxes.coaching.default_channel`
   - `status = pending`
3. Idempotency key: `(timebox_slug, nudge_index)` stored as `event_id || ':nudge:' || nudge_index`. A nudge fires at most once per timebox lifetime.

The `Scheduler` → `DelivererService` path delivers the nudge message through the existing reminder pipeline. No new delivery infrastructure is introduced.

## Discipline Taxonomy

`discipline` is an open string enum — the planner does not validate it against a fixed list. Common values and their conventions:

| Value | `unit` examples | `related_pages` convention |
|-------|-----------------|---------------------------|
| `reading` | `pages`, `chapters` | bare slug for the paper/book/course wiki page (e.g. `paper-constitutional-ai`, `book-thinking-fast-and-slow`) |
| `writing` | `posts`, `words`, `chapters` | project or entity page |
| `running` | `km`, `miles`, `sessions` | `running-log` or `training-log` |
| `strength` | `sessions`, `sets` | `training-log` |
| `recording` | `episodes`, `minutes` | podcast or project page |
| `language` | `sessions`, `lessons` | `language-log` or course page |
| `instrument` | `sessions`, `pieces` | practice log or repertoire page |
| `meditation` | `sessions`, `minutes` | journal or habit log |
| `other` | any | any |

The planner only needs `unit` + `session_minutes`. `discipline` drives display labels, brief rendering, and downstream filtering. New discipline values are valid immediately — no schema migration required.

## Wiki Linkage

By convention:

- `discipline: reading` timeboxes reference the source material via `related_pages` (e.g., `paper-constitutional-ai`, `book-thinking-fast-and-slow`, `course-fast-ai`). The linked page is the wiki entity for the material, where annotations, summaries, and deepdive results accumulate.
- `discipline: writing` and `discipline: recording` timeboxes link to the project or entity page the output belongs to (e.g., a newsletter entity, a podcast project).
- Athletic disciplines (`running`, `strength`, `instrument`, `meditation`) link to a log page (e.g., `running-log`, `strength-log`) where actual session data accumulates over time, separate from the timebox plan.

All links use bare `[[slug]]` wikilinks — no typed prefixes (`[[paper:constitutional-ai]]` is forbidden; the vault's globally-unique slug rule makes prefixes unnecessary). See [calendar.md § Principles #5](calendar.md#principles) and [briefing-pipeline.md § Curator](briefing-pipeline.md#3-curator-llm) for the wikilink invariant.

## Validation Rules

`gctrl uber profile validate` extends with timebox checks — all must pass for the daemon to start:

1. Every file under `action/events/timeboxes/` parses as `Timebox` schema (all required fields present; no unknown fields that would fail the decoder).
2. Every child event with `timebox:` set has `step` and `step_total` set, and `step <= step_total`.
3. Sum of completed children's numeric units for a given timebox does not exceed `total`. (Derived from `step_units` numeric prefix where parseable; skipped for free-form strings.)
4. `discipline` is a non-empty string matching `[a-z][a-z0-9-]*`.
5. `unit` is a non-empty string.
6. `deadline` parses as ISO 8601 date; at create time, must be in the future (validator is lenient post-create — a past deadline is a warning, not an error, so completed timeboxes do not fail validation).
7. For each nudge, `at` is either a fraction in `(0, 1]` or a valid ISO 8601 date.
8. `slug` is unique across all files under `action/events/timeboxes/`.
9. Every `timebox:` field on a child event resolves to an existing file under `action/events/timeboxes/<slug>.md`.
10. `related_pages` slugs match `[a-z0-9-]+` (bare slug rule; no typed prefixes).

## Eval & Observability

- **Stalled timebox alert.** A daily check (registered alongside `uber.eval.daily`) queries `uber_timeboxes` for active timeboxes where `(today - last_completed_child_at) > 2 × (7 / sessions_per_week) days` AND `deadline - today < stalled_threshold`. For each match, inserts a row into `uber_alerts` with `kind = 'timebox_stalled'`, `subject = timebox.slug`, `urgency = high` if deadline is within 7 days, `medium` otherwise. The alert clears automatically on the next `complete` call.
- **Plan and replan sessions.** Each `plan` or `replan` call creates a kernel `Session` with spans for: `loadProfile`, `loadExistingEvents`, `slice`, `validate`, `write`. When `--llm` is passed, an additional `llm` span is emitted (cost tracked in `sessions.total_cost_usd`). This makes plan regressions detectable — every generated schedule ties to a specific prompt hash and model.
- **Progress rollup.** `uber_timeboxes.done` is updated on every `complete` call via `PATCH /api/uber/calendar/timeboxes/{slug}` (kernel route). The kernel's `updated_at` timestamp on the row enables the stall check without scanning all child events.

## R2 Sync

Both `action/events/timeboxes/**.md` (parent files) and child event files (`action/events/<date>--<slug>.md` with `timebox:` set) fall under the existing `**/*.md` include glob in the vault sync config (see [profile.md § Sync (R2)](profile.md#sync-r2)). No new sync mount or special handling is needed. The conflict policy (`local-wins-with-warning`) applies to timebox parent files the same as any authored-tier markdown.

## Profile Schema Additions

Add a `timeboxes:` section to `profile.md` frontmatter:

```yaml
timeboxes:
  working_windows:
    - { days: [mon, tue, wed, thu, fri], start: "07:00", end: "08:00" }
    - { days: [sat, sun], start: "08:00", end: "10:00" }
  default_session_minutes: 60
  default_sessions_per_week: 3
  stalled_threshold: P14D          # ISO 8601 duration; stall alert window before deadline
  replan_policy: pin-edited        # pin-edited | redistribute-all
  coaching:
    default_channel: telegram_primary
```

| Field | Default | Notes |
|-------|---------|-------|
| `working_windows` | none | List of per-weekday time windows the planner may schedule into |
| `default_session_minutes` | 60 | Used when `--session-minutes` is omitted from `plan` |
| `default_sessions_per_week` | 3 | Used when `--sessions-per-week` is omitted |
| `stalled_threshold` | `P14D` | ISO 8601 duration; stall alert fires when deadline is closer than this |
| `replan_policy` | `pin-edited` | `pin-edited`: keep user-edited children fixed; `redistribute-all`: clear and re-plan all remaining steps |
| `coaching.default_channel` | profile default channel | Which delivery channel coaching nudges use |

Missing `timeboxes:` block falls back to in-app defaults (no working-window constraints; deterministic planner schedules any slot; stall alerts use `P14D`).

## Roadmap Hooks

Three implementation phases. See [ROADMAP.md](../ROADMAP.md) for the milestone breakdown.

| Phase | Scope |
|-------|-------|
| **Timebox M0** | Parent vault files + `uber_timeboxes` table + `uber_calendar` new columns; manual `add-event` + `complete` + `skip` commands; briefing integration (today's practice events + off-track block); deterministic planner (`plan` without `--llm`); `reindex`. |
| **Timebox M1** | LLM-assisted `plan` and `replan` (`--llm` flag); working-window scheduling (profile `timeboxes.working_windows` respected); coaching nudges (nudge threshold checks + `uber_calendar_reminders` inserts); stalled-timebox daily alert (`uber_alerts(kind='timebox_stalled')`); `replan` with pinned-event logic. |
| **Timebox M2** | Web UI timebox view (gantt-lite showing sessions as bars, coloured by `status: done / confirmed / superseded`); `driver-gcal` write-back for timebox child events with title-prefix convention `[Sub-3 Berlin 18/52]` (opt-in; same write-back flag as calendar.md § Drivers). |

## Non-Goals

1. **Not a project management tool.** No Gantt dependencies, no resource allocation, no milestone relationships between timeboxes.
2. **Not milestone tracking.** Use `kind: deadline` events for hard due dates — see [calendar.md § Event Kinds](calendar.md#event-kinds).
3. **Not habit tracking.** `gctrl-context` covers daily journaling and recurring habits. Timeboxes have a definite end and a measurable total; they are not open-ended streaks.
4. **Not a fitness app.** No biometric integration in M0. `done` is updated by the user via `complete`; the timebox does not read from Strava, Garmin, or any wearable automatically.
5. **Not multi-user accountability.** The vault is a single-identity system per [profile.md § Location & Identity](profile.md#location--identity). Shared coaching or partner accountability is out of scope.

## Open Questions

1. **External tracker integration.** Auto-updating `done` from Strava km, Readwise pages-read, or GitHub commits would reduce manual `complete` calls. This is a natural extension but requires new kernel driver hooks and is deferred past M1.
2. **Auto-extraction of reading structure.** For a given paper or book, `gctrl-net` + LLM could extract a page count or chapter list and pre-populate `total`. Useful; out of scope for M0.
3. **Completed child event archival.** Should completed children remain in `action/events/` indefinitely, or be moved to an archive subfolder after the timebox closes? Current leaning: keep in place (audit trail in Obsidian); `gctrl uber calendar prune` handles bulk cleanup.
4. **gcal write-back title-prefix format.** `[<title> <step>/<step_total>]` is readable but may pollute Google Calendar search results. An alternative is a structured description field. Needs user testing before M2.
5. **Taper logic scope.** `taper_days_before_deadline` is currently a generic field. Should it be restricted to `discipline: running | strength` (hard-coded) or remain a generic declarative shape any discipline may use? Current leaning: generic — the planner does not need to know discipline to honour it.
6. **Recurring timeboxes.** A user who sets a quarterly reading goal would want to create a new timebox each quarter. Recurrence support (e.g., `recurs: quarterly`) is out of scope; the user creates a new file per cycle and the vault graph links them via `related_pages`.
