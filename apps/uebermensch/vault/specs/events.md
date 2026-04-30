# Uebermensch — Events Discovery

> Crawl public event sources for the user's city, score against profile interests, and write candidate **suggestions** to the vault. The user reviews, accepts, or dismisses; accepted suggestions become normal calendar events.
>
> Related: [calendar.md](calendar.md) (event storage shape — events use `kind: industry`), [profile.md](profile.md) (city + interests), [knowledge-base.md](knowledge-base.md) (suggestions may link wiki entities).

## Why

The morning brief tells the user what *happened*; the calendar tells them what *will* happen on dates already known. **Events discovery** answers the third question: "what's worth showing up to that I don't yet know about?" Conferences, meetups, hackathons, and talks are high-signal once filtered by topic — and ungoogleable in batch. A daily crawl + topic match makes them tractable.

## Principles

1. **Suggestions are tentative until confirmed.** Driver-pulled candidates land under `calendar/suggested/` with `status: tentative`. They appear in `events list` but **not** in the default calendar view (which filters `status=confirmed`). The morning brief's "On the calendar today" section MUST NOT include suggestions.
2. **Accept = promote.** Accepting a suggestion flips `status: confirmed` and moves the file from `calendar/suggested/<date>--<slug>.md` to `calendar/<date>--<slug>.md`. The slug is preserved; backlinks stay valid.
3. **Dismiss is sticky.** Dismiss flips `status: cancelled` and leaves the file in place. Re-pulls MUST NOT resurrect dismissed events — `(source, external_id)` is the dedupe key.
4. **City + interests come from the profile.** Defaults read from `profile.identity.city` and `profile.topics[]`; CLI flags (`--city`, `--interests`) override per-call. No secret config.
5. **Match is transparent.** Each suggestion records `match_score` (0..1) and `matched_terms` in frontmatter so the user can see *why* it was suggested.
6. **Local-first.** The CLI is the canonical writer. The web UI's accept/dismiss writes through R2 sync (same vault as the local daemon).

## Sources (M0: Luma only)

| Driver | URL pattern | Notes |
|--------|-------------|-------|
| `driver-events.luma` | `https://lu.ma/<city-slug>` | Public Luma city page. We extract JSON-LD `Event` entries and embedded hydration data. Respects User-Agent + robots.txt. |

Future sources (Meetup, Eventbrite, IRL conference calendars) use the same `EventCandidate` shape — only the fetcher changes.

## Suggestion frontmatter (extends `EventFrontmatter`)

```yaml
---
slug: 2026-05-12--ai-infra-meetup-hk
title: "AI Infrastructure Meetup — Hong Kong"
kind: industry
source: driver-events
starts_at: 2026-05-12T19:00:00+08:00
ends_at:   2026-05-12T21:30:00+08:00
tz: "Asia/Hong_Kong"
status: tentative
location: "WeWork Tower 535, Causeway Bay"
topics: [ai-infra-capex]
tags: [meetup, event-suggestion, source:luma]
links:
  - { title: "Event page", url: "https://lu.ma/abc123" }
external_id: "luma:abc123"
external_etag: "luma:abc123:2026-04-28"
generator: "driver-events.luma"
match_score: 0.62
matched_terms: ["ai", "infrastructure"]
---
```

`match_score` and `matched_terms` are events-only extensions. The `EventFrontmatter` schema accepts them via the existing forward-compat policy (unknown fields preserved on round-trip).

## Profile additions

```yaml
# profile.md frontmatter
identity:
  city: hong-kong            # optional; lowercase kebab-case city slug
  country: HK                # optional; ISO 3166-1 alpha-2

events:
  enabled: true              # default true once any source is configured
  min_match_score: 0.2       # below this, candidates are not written to disk
  interests:                 # optional; augments topics[].title + aliases
    - artificial intelligence
    - prediction markets
  sources:
    - driver: luma
      city: hong-kong        # falls back to identity.city if omitted
```

`events.interests[]` is **additive** to `topics[].title` and `topics[].aliases`. The matcher's keyword set is the union.

## CLI

```sh
gctrl uber events pull                     # uses profile.identity.city + profile.topics
gctrl uber events pull --city tokyo
gctrl uber events pull --interests "ai,llm,prediction-markets" --limit 50

gctrl uber events list                     # tentative suggestions (default)
gctrl uber events list --status all
gctrl uber events show <slug>

gctrl uber events accept <slug>            # status: confirmed; move out of suggested/
gctrl uber events dismiss <slug>           # status: cancelled; remains in suggested/
```

`accept` and `dismiss` are no-ops if the slug already has the target status (idempotent). Both fail if the event's `source` is not `driver-events` — the existing `calendar add/edit/remove` commands handle user-authored events.

## Web UI

`/events` lists tentative suggestions from R2 (read path mirrors `/briefs`). Each card has **Accept** and **Dismiss** buttons that POST to Astro server endpoints (`/api/events/<slug>/accept`, `.../dismiss`). The endpoint:

1. Reads the suggestion's markdown from R2 (`vault/<identity.slug>/calendar/suggested/<date>--<slug>.md`).
2. Decodes frontmatter, applies the status flip.
3. On `accept`: writes the new key (`calendar/<date>--<slug>.md`), then deletes the old one.
4. On `dismiss`: writes back in place with `status: cancelled`.

The local daemon's bidirectional R2 sync (per [profile.md § Sync](profile.md#sync-r2)) reflects the change locally on the next pull cycle (≤5 min).

## Matching algorithm (M0 — keyword)

1. Build the **keyword set** from `topics[].title`, `topics[].aliases`, and `events.interests[]`. Lowercase, strip punctuation, drop stopwords (`the`, `and`, `for`, …).
2. Build the **event tokens** from `title + description + tags` of each fetched event. Same normalisation.
3. `match_score = |keywords ∩ tokens| / max(1, |keywords|)`. `matched_terms = keywords ∩ tokens` sorted alphabetically.
4. Drop candidates with `match_score < min_match_score` (default 0.2).
5. Tie-break by `starts_at` ascending.

Embedding-based matching is a follow-up (M1).

## Storage

No new SQLite tables. Suggestions are normal `uber_calendar` rows with `source='driver-events'` and `status='tentative'`. The existing `(source, external_id)` unique index is the dedupe key.

## Eval & observability

- Each `events pull` is a kernel `Session` with spans for fetch + parse + score + write.
- Per-source success rate (events fetched vs. matched vs. accepted) feeds into the existing scrape-health dashboard.
- Acceptance rate is the north star: fewer than 5% of suggestions accepted over 30 days → tighten `min_match_score` or revisit interest keywords.

## Non-goals

1. **Not a discovery feed.** Suggestions are scoped to the user's interests; we do not surface "popular events in your city" without a topic match.
2. **Not RSVP.** Accepting a suggestion adds it to the calendar; the user RSVPs on the event's own page (link preserved in frontmatter).
3. **Not multi-city.** One identity = one default city. CLI flag is per-call.
4. **Not paid-event filtering.** Cost is preserved as a tag (`tags: [paid]` if detected) but not used for ranking. Open question — see below.

## Open questions

1. **Luma JSON-LD vs. hydration scrape.** Luma emits JSON-LD for individual event pages but the city page uses Next.js hydration. **Leaning:** parse the city page's `__NEXT_DATA__` for the event list, then optionally fetch each event page for richer JSON-LD. Document the fragility. Needed by M0.
2. **Cost as a ranking signal.** Should free events outrank paid ones at the same match score? **Leaning:** no — leave to the user; show price in the card.
3. **De-dupe across sources.** Once Meetup is added, the same conference may appear twice. **Leaning:** dedupe key is `(starts_at, normalised_title)`; second occurrence merges its `links[]` into the first.
