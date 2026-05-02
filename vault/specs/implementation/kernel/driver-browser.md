# driver-browser — Implementation Details

Implementation spec for the **CDP attach layer** of `gctrl-browser`. The agent-facing high-level command surface (snapshot/click/fill/refs) is defined in [vault/specs/architecture/kernel/browser.md](../../architecture/kernel/browser.md). This file specifies the **lower layer** that everything else sits on:

1. A pool of warm Chromium processes managed by the kernel.
2. A WebSocket endpoint (`/api/browser/sessions/:id/cdp`) that exposes the raw Chrome DevTools Protocol so any client (Playwright, Puppeteer, chromiumoxide, raw WS) can attach.
3. A `gctrl-recorder` crate that subscribes to CDP frames from L1, structures Network/Runtime/Performance events, and exposes them as queries.

Together this lets app acceptance suites (today: `apps/gctrl-board/tests/acceptance/`) drop their per-app `CDPObserver` fixture and instead acquire a session from the kernel, drive it via Playwright `chromium.connectOverCDP(...)`, and assert against the recorder's report.

---

## 1. Why two crates

| Crate | Lifetime | Hot path | Concerns |
|---|---|---|---|
| `gctrl-browser` (L1) | one process per Chromium recycle | Yes — every CDP frame proxies through it | Lifecycle, pool, token auth, raw WS proxy |
| `gctrl-recorder` (L2) | per session, then queryable forever | No — async fanout from L1's frame stream | Structured trace capture, DuckDB persistence, query routes |

L1 stays small and fast. L2 absorbs all the "what happened" complexity. Apps that only want a browser (agent scrapers, future LLM browse skill) depend on L1 alone. Tests use both.

---

## 2. L1 — `gctrl-browser` crate

```
kernel/crates/gctrl-browser/
  src/
    lib.rs            # Public API re-exports
    error.rs          # BrowserError (thiserror)
    model.rs          # SessionId, SessionOptions, RecordingOptions, SessionInfo
    pool.rs           # Pool<Chromium> — lifecycle, recycle policy, concurrency cap
    session.rs        # Session — one BrowserContext per session id
    token.rs          # Mint + verify short-lived bearer tokens for CDP attach
    cdp_proxy.rs      # WS proxy: client ⇆ kernel ⇆ Chromium (with frame fanout tap)
    config.rs         # BrowserConfig (loaded from env + kernel config.toml [browser])
  Cargo.toml
```

### Public API

```rust
pub struct Browser {
    pool: Pool,
    config: Arc<BrowserConfig>,
}

impl Browser {
    pub async fn acquire(&self, opts: SessionOptions) -> Result<SessionInfo, BrowserError>;
    pub async fn release(&self, id: &SessionId) -> Result<(), BrowserError>;
    pub async fn list(&self) -> Vec<SessionInfo>;
    pub async fn get(&self, id: &SessionId) -> Option<SessionInfo>;

    /// Subscribe to the raw CDP frame stream for a session. The recorder
    /// is the only caller; the channel is bounded and lossy when the
    /// recorder falls behind (recording is best-effort, not lockstep).
    pub fn subscribe(&self, id: &SessionId) -> Option<broadcast::Receiver<CdpFrame>>;
}
```

### `SessionOptions` / `SessionInfo`

```rust
pub struct SessionOptions {
    pub viewport: Option<Viewport>,         // default 1280x720
    pub headed: bool,                        // default false; true requires display server
    pub recording: RecordingOptions,
    pub ttl_seconds: u32,                    // default 600 (10 min); max 3600
}

pub struct RecordingOptions {
    pub network: bool,    // default true
    pub console: bool,    // default true
    pub performance: bool,// default true
    pub screenshots: bool,// default false
    pub full: bool,       // default false; capture every CDP frame (high volume)
    pub max_bytes: u64,   // default 50 * 1024 * 1024
}

pub struct SessionInfo {
    pub id: SessionId,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub browser_version: String,
    pub status: SessionStatus,
    pub recording: RecordingOptions,
    pub cdp_endpoint: String,                // ws://127.0.0.1:4318/api/browser/sessions/<id>/cdp?token=...
    pub token: String,                       // bearer; also embedded in cdp_endpoint
}

pub enum SessionStatus { Active, Releasing, Expired }
```

### `BrowserError`

```rust
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("browser pool exhausted (max={max})")]
    PoolExhausted { max: u32 },

    #[error("session not found: {0}")]
    SessionNotFound(SessionId),

    #[error("session expired: {0}")]
    SessionExpired(SessionId),

    #[error("invalid token for session {0}")]
    InvalidToken(SessionId),

    #[error("recording disabled for this session")]
    RecordingDisabled,

    #[error("chromium launch failed: {0}")]
    Launch(String),

    #[error("cdp protocol error: {0}")]
    Cdp(String),
}
```

The kernel's HTTP route layer maps each variant to a status: `PoolExhausted` → 429 with `Retry-After`, `SessionNotFound` → 404, `SessionExpired` → 410, `InvalidToken` → 401, `RecordingDisabled` → 409, `Launch` / `Cdp` → 502.

### Pool semantics — context-per-session, time-based recycle

Confirmed design (May 2026):

- **Context-per-session.** One Chromium process can host many `BrowserContext` instances. Each `acquire()` creates a fresh context; each `release()` (or TTL expiry) closes it. This is faster than spawning a Chromium per session and isolates cookies / storage / service-workers per test.
- **Time-based recycle.** A Chromium process is recycled when **any** of:
  - `idle_seconds >= recycle_idle_seconds` (default `1800` — 30 min) **and** zero active sessions on it; **or**
  - `age_seconds >= recycle_max_age_seconds` (default `28_800` — 8 h), regardless of activity, by graceful drain (mark draining, refuse new sessions, kill once last session releases).
- **Pool sizing.** `pool_max` default `4`. When all Chromiums are saturated, `acquire()` returns `PoolExhausted` immediately (no implicit queueing — clients can retry with backoff if they want).
- **Concurrency per Chromium.** `contexts_per_chromium_max` default `8`. New sessions land on the warmest non-saturated Chromium; spin a new one only if all are saturated and `pool_max` allows.

### Token model

CDP gives arbitrary code execution against the page. The WS proxy MUST validate a per-session bearer token on every connection upgrade.

- Tokens are random 32-byte URL-safe base64 strings, generated via `getrandom`.
- Stored in-memory only (never written to DuckDB) — they expire when the session does.
- Embedded in `cdp_endpoint` as `?token=...` for client convenience; also accepted as `Authorization: Bearer <token>` for clients that prefer headers.
- On expiry / release, the token is invalidated and any active WS is closed with code `4001 session_expired`.

### CDP proxy

```
client (Playwright)
   │  ws://127.0.0.1:4318/api/browser/sessions/<id>/cdp?token=...
   ▼
axum WS handler (validates token, looks up session)
   │  pipes frames bidirectionally
   ▼
chromium ws://127.0.0.1:<random>/devtools/browser/<id>
   │
   └── frame tap → tokio::sync::broadcast::Sender<CdpFrame> (recorder subscribes)
```

The tap is a `broadcast` channel with capacity 1024 frames per session. If the recorder falls behind, the oldest frames are dropped — the proxy is the hot path and MUST NOT block on the recorder. A drop counter is exposed on the session info for observability.

---

## 3. L2 — `gctrl-recorder` crate

```
kernel/crates/gctrl-recorder/
  src/
    lib.rs            # Public API
    capture.rs        # CaptureSink: subscribes to L1 broadcast, parses CDP frames
    structured.rs     # CapturedRequest, ConsoleEntry, MetricSample, Screenshot
    storage.rs        # DuckDB writers — bounded by RecordingOptions.max_bytes
    report.rs         # ObservabilityReport (matches today's CDPObserver shape)
    error.rs
  Cargo.toml
```

The structured types **mirror today's** `apps/gctrl-board/tests/acceptance/fixtures/cdp.ts` (`CapturedRequest`, `ConsoleEntry`, `ObservabilityReport`) so the migration in PR4 swaps an HTTP fetch in place of an in-process method call without changing assertion code.

### DDL — schema lives in `gctrl-storage`

Per Crate Ownership rule, all DDL co-locates in `gctrl-storage::schema`. Recorder tables follow the existing `recorder_*` namespace pattern:

```sql
CREATE TABLE IF NOT EXISTS browser_sessions (
    id              VARCHAR PRIMARY KEY,
    created_at      VARCHAR NOT NULL,
    released_at     VARCHAR,
    browser_version VARCHAR NOT NULL,
    options_json    VARCHAR NOT NULL,
    status          VARCHAR NOT NULL,           -- 'active' | 'released' | 'expired'
    recorded_bytes  BIGINT NOT NULL DEFAULT 0,
    dropped_frames  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recorder_requests (
    session_id    VARCHAR NOT NULL,
    request_id    VARCHAR NOT NULL,
    url           VARCHAR NOT NULL,
    method        VARCHAR NOT NULL,
    status        INTEGER,
    headers_json  VARCHAR,
    timings_json  VARCHAR,
    ts            VARCHAR NOT NULL,
    PRIMARY KEY (session_id, request_id)
);

CREATE TABLE IF NOT EXISTS recorder_console (
    session_id  VARCHAR NOT NULL,
    seq         BIGINT NOT NULL,
    level       VARCHAR NOT NULL,                -- 'info' | 'warn' | 'error' | 'exception'
    type        VARCHAR NOT NULL,
    text        VARCHAR NOT NULL,
    ts          VARCHAR NOT NULL,
    PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS recorder_metrics (
    session_id  VARCHAR NOT NULL,
    name        VARCHAR NOT NULL,
    value       DOUBLE NOT NULL,
    ts          VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS recorder_cdp_events (
    session_id  VARCHAR NOT NULL,
    seq         BIGINT NOT NULL,
    method      VARCHAR NOT NULL,
    params_json VARCHAR NOT NULL,
    ts          VARCHAR NOT NULL,
    PRIMARY KEY (session_id, seq)
);
```

`recorder_cdp_events` is the high-volume table — only populated when `RecordingOptions.full = true`. The other three are sampled and capped by `max_bytes`.

### Recording cap enforcement

Per session, the capture sink tracks bytes written so far. When `recorded_bytes >= max_bytes`:

- For structured tables (`recorder_requests`, `recorder_console`, `recorder_metrics`): keep accepting but increment a counter exposed on `SessionInfo.dropped_due_to_cap` and stop persisting.
- For `recorder_cdp_events`: stop persisting silently (full mode is opt-in for debugging; users who set it accept the volume).

Default `max_bytes = 50 * 1024 * 1024` (50 MiB). Override per-session via `recording.max_bytes`.

---

## 4. HTTP routes

All routes live in `kernel/crates/gctrl-otel/src/browser_routes.rs`, mounted via `.merge(crate::browser_routes::router::<()>())` in `build_router()` — same pattern as `gcal_routes`.

### L1 routes (provided by `gctrl-browser`)

| Method | Path | Status in PR1 | Behavior |
|---|---|---|---|
| `POST` | `/api/browser/sessions` | stub → `501 not_implemented` | Acquire a session; returns `SessionInfo` |
| `DELETE` | `/api/browser/sessions/:id` | stub → `501` | Release immediately |
| `GET` | `/api/browser/sessions` | stub → `200 []` | List active sessions |
| `GET` | `/api/browser/sessions/:id` | stub → `404` | Get one session |
| `WS` | `/api/browser/sessions/:id/cdp` | stub → `501` | Token-gated CDP attach |
| `GET` | `/api/browser/health` | implemented in PR1 | `{ chromiumVersion: null, activeSessions: 0, poolMax }` until L1 lands |

### L2 routes (provided by `gctrl-recorder`)

| Method | Path | Status in PR1 | Behavior |
|---|---|---|---|
| `GET` | `/api/browser/sessions/:id/network` | not in PR1 | List `CapturedRequest[]` |
| `GET` | `/api/browser/sessions/:id/console` | not in PR1 | List `ConsoleEntry[]` |
| `GET` | `/api/browser/sessions/:id/metrics` | not in PR1 | `{ name: value, ... }` |
| `GET` | `/api/browser/sessions/:id/report` | not in PR1 | `ObservabilityReport` |
| `POST` | `/api/browser/sessions/:id/screenshot` | not in PR1 | `image/png` |
| `POST` | `/api/browser/replays` | not in PR1 | Create a replay session from a recorded trace |

### Request/response shapes

```jsonc
// POST /api/browser/sessions
{
  "viewport":  { "width": 1280, "height": 720 },
  "headed":    false,
  "ttlSeconds": 600,
  "recording": {
    "network":     true,
    "console":     true,
    "performance": true,
    "screenshots": false,
    "full":        false,
    "maxBytes":    52428800
  }
}

// 201 response
{
  "id":             "01HV…",
  "createdAt":      "2026-05-02T10:00:00Z",
  "expiresAt":      "2026-05-02T10:10:00Z",
  "browserVersion": "Chromium/124.0.6367.78",
  "status":         "active",
  "recording":      { /* echoed */ },
  "cdpEndpoint":    "ws://127.0.0.1:4318/api/browser/sessions/01HV…/cdp?token=…",
  "token":          "…"
}
```

---

## 5. Configuration

Daemon config lives in `~/.config/gctrl/config.toml` under `[browser]`. Per-session overrides flow through the `POST /api/browser/sessions` body — config defines defaults, request defines exceptions. Env vars override file for ops convenience.

```toml
[browser]
pool_max                     = 4
contexts_per_chromium_max    = 8
recycle_idle_seconds         = 1800        # 30 min
recycle_max_age_seconds      = 28800       # 8 h
default_ttl_seconds          = 600         # 10 min
default_recording_max_bytes  = 52428800    # 50 MiB
chromium_path                = ""          # empty = autodetect
headed_default               = false       # true requires display server
```

Env overrides (same prefix as other gctrl drivers):

| Env var | Maps to |
|---|---|
| `GCTRL_BROWSER_POOL_MAX` | `pool_max` |
| `GCTRL_BROWSER_RECYCLE_IDLE_SECS` | `recycle_idle_seconds` |
| `GCTRL_BROWSER_RECYCLE_MAX_AGE_SECS` | `recycle_max_age_seconds` |
| `GCTRL_BROWSER_DEFAULT_TTL_SECS` | `default_ttl_seconds` |
| `GCTRL_BROWSER_CHROMIUM_PATH` | `chromium_path` |

---

## 6. Security

- **127.0.0.1 only.** The kernel daemon already binds loopback. The CDP WS proxy MUST refuse upgrades from non-loopback origins even if a future config exposes the daemon — CDP = arbitrary RCE.
- **Per-session bearer token** validated on every WS upgrade. Tokens never logged.
- **No headed mode without display server.** PR1 returns `400 invalid_request` for `headed: true` if `DISPLAY` is unset; CI uses xvfb.
- **No third-party origin reach by default.** When `gctrl-guardrails` lands a `BrowserDomainAllowlist` policy (out of scope here), the proxy will consult it before each `Network.requestWillBeSent` and abort disallowed requests via `Fetch.failRequest`. PR1 just hooks the policy; the policy itself is a follow-up.

---

## 7. OTel integration

Every L1 operation creates a span on the kernel's existing OTel pipeline:

| Operation | Span name | Notable attributes |
|---|---|---|
| `acquire` | `browser.session.acquire` | `browser.pool_max`, `browser.pool_active` |
| `release` | `browser.session.release` | `browser.session.duration_ms` |
| WS upgrade | `browser.cdp.attach` | `browser.session.id` |
| Recycle | `browser.chromium.recycle` | `browser.recycle.reason` (`idle` \| `max_age`), `browser.chromium.age_ms` |

CDP frame proxy itself is **not** spanned per-frame (volume too high). Top-level CDP method calls from the client *can* be spanned if `recording.full = true`, derived from `recorder_cdp_events`.

---

## 8. Migration plan

| PR | Scope | This PR? |
|---|---|---|
| 1 | Spec + scaffold `gctrl-browser` (types, errors, pool stub, route stubs returning 501) + workspace registration + light update to `architecture/kernel/browser.md` | **yes** |
| 2 | Implement L1: real Chromium pool via `chromiumoxide`, WS proxy, token mint/verify, OTel spans, recycle loop | no |
| 3 | Add `gctrl-recorder` crate; subscribe to L1 broadcast; DuckDB tables; observation routes + tests | no |
| 4 | `KernelBrowserClient` Effect-TS adapter in `shell/gctrl-shell/src/services/`; mock-layer tests | no |
| 5 | Migrate `apps/gctrl-board/tests/acceptance/`: introduce `BROWSER_BACKEND={kernel,local}` env flag; require both green for one CI cycle; then delete `apps/gctrl-board/tests/acceptance/fixtures/cdp.ts` and the local-backend code path | no |
| 6 | (Additive) `gctrl-net` SPA mode using kernel browser; replay endpoint | no |

Each PR is independently mergeable: PR2 turns the stubs into real behavior; PR3 starts populating the recorder tables that PR2 wrote nothing to; PR4/5 are pure consumer changes.

---

## 9. Test parity gate (PR5 detail)

The cutover risk lives in PR5. To avoid silent regressions:

- Introduce `BROWSER_BACKEND` env var in `apps/gctrl-board/tests/acceptance/fixtures/test.ts`. Values: `local` (today's behavior — Playwright launches its own Chromium and uses in-process `CDPObserver`), `kernel` (new — `KernelBrowserClient.acquire()` + `chromium.connectOverCDP(...)` + `kernel.report()` query).
- CI runs the full acceptance suite **twice** for one cycle, once per backend. Both must pass.
- Once green for one cycle, delete the `local` branch + `cdp.ts` (~237 lines) + the `BROWSER_BACKEND` switch.

---

## 10. Open items deferred past PR1

- Whether `Network.requestWillBeSent` cancellation for guardrail enforcement is in PR2 or a later guardrails PR.
- Replay semantics: does `POST /api/browser/replays` re-execute against the *current* SPA build (drift-detection) or pin to the snapshot's commit hash?
- Headed-mode CI image (xvfb-equipped runner). Defer until PR2 actually needs it.

---

## See also

- Architecture: [vault/specs/architecture/kernel/browser.md](../../architecture/kernel/browser.md)
- Existing per-app CDP observer being replaced: `apps/gctrl-board/tests/acceptance/fixtures/cdp.ts`
- Existing per-app CDP test cases: `apps/gctrl-board/tests/acceptance/cdp-observability.spec.ts`
- Reference driver pattern: `kernel/crates/gctrl-gcal/` + `kernel/crates/gctrl-otel/src/gcal_routes.rs`
