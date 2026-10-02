# driver-browser — CDP Attach and Recording

The kernel MUST allocate an isolated Chromium storage context per browser identity and confine CDP traffic and observations to that identity.

## Ownership and Sources

| Concern | Source |
|---------|--------|
| Browser wire types and launcher port | [gctrl-core/browser.rs](../../../../kernel/crates/gctrl-core/src/browser.rs) |
| Context allocation and lifecycle | [launcher.rs](../../../../kernel/crates/gctrl-browser/src/launcher.rs), [pool.rs](../../../../kernel/crates/gctrl-browser/src/pool.rs) |
| CDP confinement | [scope.rs](../../../../kernel/crates/gctrl-browser/src/scope.rs) |
| HTTP API | [browser_routes.rs](../../../../kernel/crates/gctrl-otel/src/browser_routes.rs) |
| Observation wire types | [browser_recording.rs](../../../../kernel/crates/gctrl-core/src/browser_recording.rs) |
| Recorder | [recorder_routes.rs](../../../../kernel/crates/gctrl-otel/src/recorder_routes.rs), [gctrl-recorder](../../../../kernel/crates/gctrl-recorder/src/lib.rs) |
| Shell port and adapter | [BrowserClient.ts](../../../../shell/gctrl-shell/src/services/BrowserClient.ts), [HttpBrowserClient.ts](../../../../shell/gctrl-shell/src/adapters/HttpBrowserClient.ts) |
| Configuration | [config.rs](../../../../kernel/crates/gctrl-browser/src/config.rs) |

1. Domain schemas MUST have one source in `gctrl-core`; the browser crate MUST re-export them for compatibility. A browser `SessionId` MUST remain distinct from an agent Session.
2. High-level snapshot/ref commands remain **[deferred]**; [browser.md](../../architecture/kernel/browser.md) owns their contract. [computer-use.md](../../architecture/kernel/computer-use.md) owns Task binding, desktop input, and takeover.
3. Persistent profile selection remains **[deferred]**. The attach layer supplies ephemeral storage contexts, not saved login profiles.

## Context Lifecycle

1. `Pool::acquire` MUST create a real Chromium `BrowserContext` before publishing its `SessionInfo`. `browserContextId` MUST identify that context; endpoint/token separation alone MUST NOT count as storage isolation.
2. Allocation MUST reserve process/context capacity atomically. Concurrent acquisitions MUST NOT exceed `pool_max × contexts_per_chromium_max`. An unconfirmed context creation MUST drain the process rather than assume no allocation occurred.
3. An unavailable Chromium MUST fail acquisition. Production MUST NOT substitute the test `MockLauncher` or advertise a fake identity.
4. Release MUST revoke existing connections before disposing the context. Unconfirmed disposal MUST retain the capacity reservation in `releasing`; sweep MUST retry cleanup. Peer identities MUST remain usable.
5. A successful client `Target.disposeBrowserContext` MUST end the managed identity and revoke its other connections. Expiration MUST close existing connections without waiting for the periodic sweep.
6. Idle and aged process recycling MUST follow [recycle.rs](../../../../kernel/crates/gctrl-browser/src/recycle.rs). A process with retained context reservations MUST NOT be recycled as empty. `Launcher::kill` MUST confirm process exit before releasing pool capacity; failed confirmation MUST retain a draining reservation for retry.

## Scoped CDP

1. HTTP upgrades MUST validate the browser session's bearer token and active lifetime. Clients MUST receive the serving kernel endpoint, never the upstream browser WebSocket URL. HTTP acquisition MUST validate the Host authority and preserve its address in later session inspection.
2. The proxy MUST bind context-sensitive commands to the managed context. Target discovery, replies, events, flattened sessions, and recorder frames MUST exclude sibling identities.
3. Browser-level CDP attachment sessions MUST retain the root allowlist, context filtering, and lifetime limits; attachment MUST NOT grant page-domain powers. A client MUST discover or create an owned target before attaching to it. An omitted target MAY resolve through an already validated flattened session. Synthetic errors MUST preserve that session's response routing.
4. Browser-wide commands such as `Browser.close`, legacy nested-message forwarding, and root `Runtime.evaluate` MUST be rejected. Opaque binary traffic MUST NOT bypass the JSON scope checks.
5. Root auto-attach MUST NOT pause peer pages. A client MAY obtain the managed context through `Target.createBrowserContext`; another context MUST require another kernel browser session. Context proxy/security options remain **[deferred]**.
6. The supported CDP subset MUST follow the allowlist in `ProtocolScope`, not an unrestricted raw-proxy promise. Standard Playwright use MUST pass the live gate below. Arbitrary CDP domain compatibility remains **[deferred]**.
7. Browser context isolation MUST NOT be advertised as independent GUI input. Headed windows still share desktop input according to [computer-use.md](../../architecture/kernel/computer-use.md#isolation-boundaries).

## HTTP and Shell

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/browser/health` | Pool/version discovery |
| GET / POST | `/api/browser/sessions` | List / acquire identities |
| GET / DELETE | `/api/browser/sessions/{id}` | Inspect / release identity |
| WebSocket | `/api/browser/sessions/{id}/cdp` | Scoped CDP attachment |
| GET | `/api/browser/sessions/{id}/{network,console,metrics,report}` | Per-identity observations |
| POST | `/api/browser/replays` | Existing replay stub; execution **[deferred]** |

1. HTTP error/status mapping MUST follow `err_response` in the route source. The shell MUST validate `browserContextId` through its `SessionInfo` schema.
2. The kernel MUST remain loopback-bound by default. Remote access and authorization beyond the existing bearer attach token remain **[deferred]**.
3. HTTP acquisition MUST subscribe the recorder before returning the endpoint; the first report MUST include earlier frames. Recorder queries MUST identify the same browser session that controls the page. Acceptance tests MUST NOT query a separately acquired observer identity or silently substitute a local browser when `BROWSER_BACKEND=kernel` fails.
4. Durable recorder persistence, replay, egress guardrails, configured viewport application, and general desktop input remain **[deferred]**. Existing recorder tables MUST retain the schema source in [domain-model.md](../../architecture/domain-model.md).

## Verification

1. Pool and protocol tests MUST cover capacity races, distinct contexts, cross-identity targeting, response routing, separate recorder taps, revocation, and uncertain cleanup.
2. The live [browser_identity.rs](../../../../kernel/crates/gctrl-otel/tests/browser_identity.rs) gate MUST use real Chromium. It MUST verify cookies/storage separation, rejected cross-target attachment, Playwright input and screenshot verification, per-identity recording, peer-safe disposal, active-connection fencing, and confirmed process recycling.
3. Run the live gate from the workspace root with installed pnpm dependencies and a Chromium binary:

```sh
GCTRL_BROWSER_CHROMIUM_PATH=/path/to/chromium cargo test --workspace separate_browser_identities_do_not_share_cookies_or_storage -- --ignored --nocapture
```

4. Board acceptance fixtures MUST acquire one identity per test and use the shell browser adapter. `BROWSER_BACKEND=local` MAY retain the existing local test path; it MUST NOT establish kernel isolation evidence.
