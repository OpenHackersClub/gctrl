# Computer-Use Coordinator

The coordinator library MUST enforce the [computer-use architecture contract](../../architecture/kernel/computer-use.md) through injected target drivers and a kernel-owned journal.

> Status: Library conformance only. Daemon wiring, production drivers/journal, human-input monitoring, HTTP/CLI/desktop supervision, and live native/SSH acceptance remain **[deferred]** under [#232](https://github.com/OpenHackersClub/gctrl/issues/232).

## Sources

| Concern | Canonical source |
|---------|------------------|
| Target/control schemas and driver/journal ports | [gctrl-core/computer_use.rs](../../../../kernel/crates/gctrl-core/src/computer_use.rs) |
| Coordination mechanisms | [gctrl-computer-use/lib.rs](../../../../kernel/crates/gctrl-computer-use/src/lib.rs) |
| Behavioral conformance | [coordination.rs](../../../../kernel/crates/gctrl-computer-use/tests/coordination.rs) |
| Claim transitions | [orchestrator.md](../../architecture/kernel/orchestrator.md) |
| Durable schemas and wire ownership | [domain-model.md](../../architecture/domain-model.md#computer-use-binding-and-control) |

## Binding and Observation

1. `bind` MUST authorize the Task/agent Session/workspace relationship through `ComputerUseJournal::authorize` before accepting a driver-issued target. It MUST reject incomplete or ambiguous incarnations. Production authority checks remain **[deferred]**; the test journal MUST NOT be used as a daemon authorization source.
2. `observe` MUST reserve the driver's actual `DesktopIdentity`, independently of environment labels or workspace paths. An observation MUST identify its binding, complete target incarnation, and nonempty driver revision.
3. The coordinator MUST hold that reservation through `act` verification or explicit `release`. An unused observation expires after 30 seconds; expiration MUST reject input and MUST NOT silently grant a peer ownership. The owner MAY refresh its observation or release an idle confirmed reservation.
4. An action MUST consume its observation once, recheck the target revision before input and between steps, and verify each expected effect on the bound target. Receipt observations MUST NOT serve as reusable input permits.
5. Input batches MUST contain 1–64 steps. Empty expectations and empty/oversized text/key requests MUST fail before consuming the owned observation.

## Revocation and Recovery

1. Drivers MUST check `InputPermit` before every input atom, including atoms within one step. A takeover or cancellation MUST revoke the runtime's generation before awaiting driver acknowledgment or in-flight completion.
2. `takeover` MUST reserve the desktop for the human; `cancel` MUST distinguish requested from confirmed cancellation. Failed/timed-out fencing MUST retain the runtime reservation. A successful tool transport return MUST NOT substitute for `ComputerUseDriver::fence` confirmation.
3. `resume` MUST be an explicit handback, fence prior controls, and produce a fresh owned observation. Pending stop requests MUST prevent handback. Normal action completion MUST release its input generation.
4. Unknown action outcomes, failed expected effects after input, or a dropped in-flight future MUST quarantine the runtime. Restart MUST mark every restored noncancelled control uncertain and block new bindings on that runtime until explicit fencing/handback.
5. Driver operations and settlement waits MUST time out after ten seconds with an uncertain outcome. Timeout MUST NOT imply remote process exit or authorize replacement dispatch.
6. Journal failures MUST NOT release uncertain ownership. The current library journal port is synchronous; its durable storage adapter remains **[deferred]** and MUST preserve the daemon's single-writer rule.

## Verification

1. Run `cargo test -p gctrl-computer-use` for authorization, runtime ownership, independent runtimes, stale/single-use observations, expected-effect failure, edits between steps, takeover between input atoms, unconfirmed cancellation, aborted futures, and restart recovery.
2. These tests MUST NOT count as the native GUI or SSH live scenarios in [computer-use.md](../../architecture/kernel/computer-use.md#contract-verification-scenarios-deferred). A production driver MUST pass those gates before support is advertised.

## Target-Host Native Observation [deferred integration]

1. The standalone [X11/AT-SPI helper](../../../../kernel/crates/gctrl-computer-use/host/x11.py) MAY discover and observe windows on an explicitly selected Linux display and D-Bus login. Its daemon driver integration remains **[deferred]**. It MUST report input and screenshot capabilities as unavailable until implemented.
2. The helper MUST establish machine/boot, login-bus, X-server root nonce, process start time, and window nonce identities. A stale/replaced identity or absent/ambiguous accessibility frame MUST reject observation. Focus and pointer observations MAY invalidate revisions; they MUST NOT select the target or issue input.
3. Run [native_identity.py](../../../../kernel/crates/gctrl-otel/tests/fixtures/native_identity.py) on a disposable Linux GUI host with the two [native fixture applications](../../../../kernel/crates/gctrl-otel/tests/fixtures/computer_use_app.py). The target host MUST provide `pyatspi`, `xprop`, `xwininfo`, `xdotool`, `gdbus`, and its own X11/AT-SPI session. This gate covers identity/accessibility discovery only; it MUST NOT establish the full VM input-isolation scenario.
