# Uebermensch — Scheduling

> Vault-defined cron jobs for uber's recurring work (daily briefs, deepdives, ingest ticks). The vault is source of truth; the kernel scheduler (`gctrl-scheduler`) is the canonical registry, fed via `uber schedule sync`. Schedules fire by exec'ing the `uber` CLI — no app-specific HTTP routes in the kernel.

See [delivery.md](delivery.md) for what gets delivered, [briefing-pipeline.md](briefing-pipeline.md) for what `run-daily` produces, and the [kernel scheduler spec](../../../../vault/specs/architecture/kernel/scheduler.md#exec-target-kind) for the `target_kind: exec` primitive this design depends on.

## Why a separate file (not `profile.md`)

`directives/profile.md` is identity + delivery prefs + budgets — *who* the user is. Schedules are *operational config* — *when* uber runs. Mixing the two inflates profile frontmatter and forces a reload of every brief preference whenever a cron changes. Schedules live in their own `directives/schedules.md` so they can be edited without churning the profile.

This obsoletes the legacy `delivery.brief.cron` field on `directives/profile.md` (kept transitionally; ignored by the runtime once `directives/schedules.md` exists).

## Vault Schema — `directives/schedules.md`

A single file, frontmatter-only, in the authored tier (git-tracked):

```yaml
---
schema_version: 1
schedules:
  morning_brief:
    cron: "30 8 * * *"
    tz: Asia/Hong_Kong
    job: brief-and-send
    enabled: true
  evening_brief:
    cron: "59 23 * * *"
    tz: Asia/Hong_Kong
    job: brief-and-send
    enabled: true
---

# Schedules

Free-form notes below the frontmatter. Edit cron strings here; run
`gctrl uber schedule sync` to apply.
```

| Field | Type | Notes |
|-------|------|-------|
| `name` (map key) | `[a-z0-9_]+` | Local name; sync prepends `uber.` to derive the kernel schedule's `name`. |
| `cron` | string | 5-field cron, in `tz`. Validated by the same parser as the kernel (`cron::Schedule`). |
| `tz` | IANA tz | Today: `Asia/Hong_Kong` only (constant +8). Other zones rejected at sync until the conversion gains DST awareness. |
| `job` | enum | `brief-and-send` ⇒ `uber run-daily`. `report-and-send` ⇒ `uber report --send`. Future jobs (`deepdive`, `ingest`) extend this enum. |
| `enabled` | bool | Default `true`. `false` rows are still synced (`enabled=false` on kernel row) so a re-enable doesn't drop history. |

Schedule names MUST be unique within the file. Foreign top-level frontmatter keys fail validation.

## Job Registry

The `job` enum is the contract between vault and CLI. Each job maps to an argv that the kernel scheduler will exec:

| `job` | argv (after sync) | `env_keys` | Notes |
|-------|-------------------|------------|-------|
| `brief-and-send` | `["<abs>/node", "<abs>/uber.js", "run-daily"]` | `UBER_VAULT_DIR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_PRIMARY_CHAT_ID`, `DISCORD_NOTIFY_WEBHOOK_URL`, `GCTRL_KERNEL_URL` | Generates today's brief if missing, then fans out per `profile.delivery.channels`. |
| `report-and-send` | `["<abs>/node", "<abs>/uber.js", "report", "--send"]` | (same as above) | Generates per-interest deep research reports under `input/reports/`, then sends the index to channels. Cadence is typically weekly. |

The argv MUST use absolute paths — the kernel scheduler rejects relative `argv[0]` (`PATH`-injection defence; see [scheduler.md § exec target kind](../../../../vault/specs/architecture/kernel/scheduler.md#exec-target-kind)). Resolution happens in `uber schedule sync` once at sync time and is stored verbatim in the kernel row.

The `env_keys` list names env vars the kernel passes through from its own process environment to the spawned child. Values are never stored in the schedule row.

## `uber schedule sync`

Reconciler. Reads `directives/schedules.md`, computes the desired set, queries the kernel (`GET /api/schedules?name_prefix=uber.`), diffs, and applies upserts/deletes. Idempotent.

### Algorithm

```
load profile.identity.tz                    (sanity check; should match per-row tz)
read directives/schedules.md → desired[]    (after schema validate)
GET /api/schedules?name_prefix=uber.        → existing[]
for each desired d:
  cron_utc = convert(d.cron, d.tz, "UTC")   # constant offset; HKT only at M2
  argv     = registry[d.job].argv
  body     = { name: "uber." + d.name,
               cron: cron_utc,
               target_kind: "exec",
               command: argv,
               cwd: $UBER_VAULT_DIR,
               env_keys: registry[d.job].env_keys,
               enabled: d.enabled,
               timeout_secs: 300 }
  if existing has same name → PUT (or DELETE+POST if PUT not supported)
  else                      → POST
for each existing e not in desired → DELETE
print summary: created N, updated M, deleted K, unchanged U
```

### Authority + drift

The vault is authoritative. Manual edits to `uber.*` rows via `curl` (or other clients) are clobbered on next sync. Document this; do not add a `managed: bool` flag — the prefix scoping is the contract.

Non-`uber.` rows are untouched.

### TZ conversion

Done in the CLI, not the kernel. Kernel only sees UTC cron expressions. M2 supports `Asia/Hong_Kong` only (constant +8, no DST). Adding `America/New_York` etc. requires a real tz library in the CLI; kernel stays tz-naïve.

### Failure modes

| Symptom | Behaviour |
|---------|-----------|
| `directives/schedules.md` missing | No-op; print "no schedules defined". |
| Schema invalid | Abort with line number; touch nothing. |
| Job in registry missing | Abort with the offending `job:` value; touch nothing. |
| Kernel daemon down | Abort with "kernel unreachable at $GCTRL_KERNEL_URL"; touch nothing. |
| Partial apply (e.g. POST 4 of 6 succeed, 5th 500) | Stop; print what succeeded, what didn't; next sync is idempotent and continues. |

The CLI reports a non-zero exit on any error.

## `uber run-daily`

Thin entrypoint invoked by the kernel scheduler. Accepts no args — generates today's brief if not already in `input/briefs/<today>.md` and runs `send` against today's brief.

```
uber run-daily
  ├─ uber brief --date <today>           # idempotent: re-uses existing brief if present
  └─ uber send  --date <today>           # per-channel idempotent (uber_deliveries unique key)
```

Implemented as a single command that calls the existing `BriefingService` and `DelivererService` programs (see `apps/uebermensch/src/commands/run-daily.ts`). No new services.

`run-daily` is also the manual recovery surface — running it from a shell does the same work as a scheduler fire. This is a deliberate property: scheduler fires are not a privileged path.

### Exit codes

| Exit | Meaning |
|------|---------|
| 0 | Brief generated (or already existed) AND ≥ 1 channel delivered. |
| 1 | Brief generation failed (LLM, network, profile invalid). |
| 2 | Brief generated but no channel delivered (all `kind=config` or `kind=invalid`). |
| 3 | Partial delivery (≥ 1 success, ≥ 1 transient failure). Scheduler treats this as success; downstream alerting via `uber_alerts.delivery_stalled` if the same channel fails N times in a row. |

stdout: human-readable progress. stderr: errors. The kernel scheduler caps both at the standard `RESPONSE_BODY_CAP_BYTES`; full output is in the `gctrl-orch` span tree if span-level detail is needed.

## Observability

The kernel scheduler emits `scheduler.exec` spans (see kernel spec). At the uber layer, `run-daily` produces the existing `uber.brief.pipeline` and `uber.delivery.fan_out` spans. The two are linked by the kernel scheduler attaching `parent_span_id` if the schedule fire emits a trace context, otherwise they are separate trace roots.

Daily/twice-daily cadence is low enough that span volume is not a concern; full retention applies.

## Migration from `delivery.brief.cron`

`directives/profile.md` carries a legacy `delivery.brief.cron` field (single 6-field cron). When `directives/schedules.md` is present, that field is **ignored**. When `schedules.md` is absent, `uber schedule sync` falls back to a single auto-generated `uber.brief_default` row from `delivery.brief.cron` (transitional; removal target M3).

The validation rules in [profile.md § Semantic](profile.md#semantic) for `delivery.brief.cron` apply only in fallback mode.

## Related

- [delivery.md](delivery.md) — what `run-daily` fans out per channel
- [briefing-pipeline.md](briefing-pipeline.md) — what `uber brief` produces
- [kernel scheduler — exec target kind](../../../../vault/specs/architecture/kernel/scheduler.md#exec-target-kind) — the kernel primitive this depends on
- [profile.md § Migrations](profile.md#migrations) — `delivery.brief.cron` deprecation timeline
