# Computer-Use Coordination

gctrl MUST coordinate observation and input across existing applications with explicit targets, input ownership, and verifiable recovery.

> Status: Implementation is in progress under [#232](https://github.com/OpenHackersClub/gctrl/issues/232). The [browser attach layer](../../implementation/kernel/driver-browser.md) enforces ephemeral storage identities. The [coordinator library](../../implementation/kernel/computer-use.md) validates explicit bindings, reserves desktop input across observation/action/verification, revokes permits on takeover/cancellation, and requires fencing after uncertain outcomes or restart. Its conformance tests use injected drivers and journals; daemon integration, native drivers, durable storage, human-input monitoring, GUI recovery, HTTP/CLI supervision, and their live gates remain **[deferred]** until implemented and verified.

## Responsibilities and Existing Contracts

1. The kernel MUST own computer-use coordination mechanisms; the shell MUST mediate access. Applications MAY present supervision and policy through those mechanisms, following [os.md](../os.md).
2. Dispatch MUST retain the [AgentHarness](harness.md) / [ComputeSubstrate](compute.md) separation. Existing execution examples are [agent.rs](../../../../kernel/crates/gctrl-orch/src/agent.rs) and [worker.rs](../../../../kernel/crates/gctrl-orch/src/worker.rs); the port split itself remains [deferred].
3. Claim states, transitions, retry, and dispatch eligibility MUST remain owned by [orchestrator.md](orchestrator.md). Input ownership MUST NOT introduce a second claim state machine.
4. Platform capabilities and permissions MUST follow [driver-macos.md](driver-macos.md) and the existing [PlatformPort](../../../../kernel/crates/gctrl-core/src/platform.rs). Space discovery or focus support MUST NOT be treated as a general desktop-input runtime.
5. Input coordination MUST NOT add orchestrator claim states. Rust coordination interfaces MUST follow [gctrl-core/computer_use.rs](../../../../kernel/crates/gctrl-core/src/computer_use.rs); implementation MUST include conformance tests. HTTP routes and durable journal schemas remain [deferred] under [domain-model.md](../domain-model.md).

## Target Identity and Action Verification

1. Each computer-use action MUST bind to a Task and its agent Session, an execution host/environment, and the intended application target. Browser actions MUST additionally identify the browser session/profile/context and tab; desktop actions MUST identify the desktop/input environment and window. Rust target and driver schemas MUST follow [computer_use.rs](../../../../kernel/crates/gctrl-core/src/computer_use.rs). The HTTP binding contract and storage authority checks remain [deferred]. A browser session is distinct from the agent Session defined in the [glossary](../../glossary.md).
2. An action MUST NOT infer its target solely from the frontmost window, tab order, screen position, or a reused process ID. Target replacement or lost identity MUST stop input until the intended target is re-established.
3. Computer use MUST follow observation → action → verification. Observe the bound target, check input ownership when required, perform the action, then observe the same target to verify the expected effect. A successful tool return alone MUST NOT establish task success.
4. Stale observations, navigation, changed focus, or human edits that invalidate the intended action MUST require fresh observation before further input. Browser refs MUST retain the invalidation rules in [browser.md](browser.md#ref-lifecycle).
5. Target-scoped application APIs, CLI tools, and browser automation through shell/kernel mechanisms SHOULD be preferred when they can perform and verify the operation without global desktop input. External access MUST retain the driver boundary in [principles.md](../../principles.md#design-principles). Visual verification MAY complement these tools without requiring an integrated editor or browser design mode.

## Isolation Boundaries

| Surface | Isolation available | Coordination requirement |
|---------|---------------------|--------------------------|
| Browser profile or context | Separate cookies, storage, and login identity | Bind to the intended browser session and tab; follow [browser.md](browser.md#identity-and-storage-isolation) |
| Git worktree | Separate checkout/index for concurrent file work; repository resources can still be shared | Identify the workspace; GUI work still uses the desktop's input ownership |
| Spaces or monitors on one desktop | Organization and visibility within the same login desktop | Treat keyboard, pointer, and focus as shared |
| VM, remote host, or independent desktop session | Independent GUI input only when its own desktop/display and input runtime are available | Discover and bind that runtime; arbitrate input within it |
| Container | Process/filesystem isolation according to backend configuration | Require an independent desktop/input runtime before claiming GUI isolation |

1. Browser storage isolation, Git worktree isolation, and GUI input isolation MUST be evaluated separately. Each boundary MUST NOT be treated as evidence of either of the others.
2. Spaces and monitors MUST NOT be described as independent input environments. Moving windows between them MUST NOT grant concurrent agents separate keyboards, pointers, or focus.
3. Independent GUI execution MUST have a separately addressable desktop/display and input runtime. A VM or container label alone MUST NOT establish that capability. Provisioning and lifecycle policy belongs in [compute.md](compute.md#remote-execution-and-gui-environments).

## Shared Input, Cancellation, and Human Takeover

1. Agents sharing a desktop MUST serialize actions that use its global keyboard, pointer, or focus through one input owner per desktop/input environment. Ownership MUST cover observation through verification whenever intervening input could invalidate the action.
2. File operations and target-scoped API/CDP operations MAY run concurrently when they do not use or disturb global input and do not conflict on the same target. Compute concurrency slots MUST NOT be treated as desktop input permits.
3. A human takeover request or detected human input that invalidates the action MUST revoke agent input ownership, stop queued input, and interrupt ongoing input sequences at the next cancellable boundary. An already-applied action MUST be recorded and re-observed; takeover MUST NOT imply rollback.
4. Cancellation MUST stop subsequent input and request execution cancellation through the existing orchestration/compute controls. The kernel MUST distinguish a requested stop from a confirmed stop; lack of acknowledgment MUST NOT grant another agent input ownership.
5. Resume MUST require an explicit human decision, re-established target identity, fresh observation, and reacquired input ownership. Reconnection, elapsed time, or renewed focus MUST NOT automatically resume input.
6. Ownership release on normal completion MUST be explicit. On controller failure, uncertain ownership MUST block further agent input until recovery confirms the previous controller cannot continue. The coordinator library MUST enforce these rules through the [driver/journal ports and conformance tests](../../implementation/kernel/computer-use.md). Production driver acknowledgment, durable journal recovery, and daemon integration remain [deferred].

## Recovery and Remote Supervision

1. Connection loss MUST be treated as uncertain observation/control, not evidence that a remote process has exited. The previous attempt MUST be reconciled before retry or replacement dispatch; the orchestrator MUST remain the sole dispatch authority.
2. Recovery MUST reconnect to the same execution and GUI environment when identity can be established, inspect the prior action's effects, and confirm exit or fence the previous attempt before allowing replacement work. An action with an unknown outcome MUST NOT be blindly replayed.
3. A human MUST be shown whether execution and cancellation are confirmed or uncertain. Human takeover on a remote GUI MUST use the target host's independent input runtime and the same ownership contract.
4. Remote execution attachment, durable attempt identity, recursive fencing, and worker restart reconciliation MUST follow the [compute implementation](../../implementation/kernel/compute.md). Its live gate covers claimed execution; daemon restart, GUI recovery, and human supervision remain [deferred] and MUST NOT be inferred from that result. Transport policy and target-host tooling belong in [compute.md](compute.md#remote-execution-and-gui-environments).

## Contract Verification Scenarios [deferred]

These are implementation acceptance scenarios; document review does not establish runtime support.

| Scenario | Required outcome | Canonical rules |
|----------|------------------|-----------------|
| Two browser identities visit the same application | Each MUST retain its own cookies/storage; actions MUST bind to the intended session and tab | Target Identity #1; [browser identity](browser.md#identity-and-storage-isolation) |
| Two worktrees open editors on one desktop, including different Spaces/monitors | File work MAY proceed concurrently; global input MUST serialize | Isolation Boundaries #1–2; Shared Input #1–2 |
| Human takes over during a multi-step input sequence | Further agent input MUST stop; resume MUST re-observe changed state after explicit handback | Shared Input #3–5 |
| SSH disconnects after dispatch, with the remote process still running | Reconnect MUST reconcile that attempt; replacement dispatch and blind action replay MUST NOT occur while its outcome is uncertain | Recovery #1–2; [compute failures](compute.md#3-failure-as-tool-error) |
| A VM has its own GUI and input runtime | Input in the VM MUST leave the host desktop's pointer/focus unchanged; human takeover MUST arbitrate within the VM | Isolation Boundaries #3; Recovery #3 |
