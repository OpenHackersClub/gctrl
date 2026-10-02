# Durable SSH Execution

The kernel MUST retain the original claimed attempt through transport loss, restart, and cancellation before allowing replacement execution.

> Status: Substrate, target supervisor, durable ledger, and opt-in worker library are implemented. Daemon/HTTP/shell integration, workflow selection, network sandbox enforcement, GUI control, and full daemon restart acceptance remain **[deferred]** under [#232](https://github.com/OpenHackersClub/gctrl/issues/232).

## Sources

| Concern | Canonical source |
|---------|------------------|
| Pure ports, configuration, invocation hashing, receipts | [gctrl-core/compute.rs](../../../../kernel/crates/gctrl-core/src/compute.rs) |
| Ordinary OpenSSH transport and substrate | [gctrl-compute/lib.rs](../../../../kernel/crates/gctrl-compute/src/lib.rs) |
| Linux target supervisor | [supervisor.py](../../../../kernel/crates/gctrl-compute/host/supervisor.py) |
| Durable kernel intent and Task reservation | [compute_journal.rs](../../../../kernel/crates/gctrl-storage/src/compute_journal.rs) |
| Kernel-owned DDL | [domain-model.md](../../architecture/domain-model.md#durable-compute-attempts) |
| Existing-claim worker integration and restart recovery | [compute_worker.rs](../../../../kernel/crates/gctrl-orch/src/compute_worker.rs) |
| Claim states and transitions | [orchestrator.md](../../architecture/kernel/orchestrator.md) |

## Dispatch and Recovery

1. `ComputeWorker` MUST select existing dispatch-eligible claims through SQLite CAS. It MUST create a scheduler-provenance Session and persist its workspace/environment association before target dispatch. It MUST NOT accept caller-supplied task identities for launch.
2. The worker MUST retain uncertain intent before awaiting launch. Recovery MUST reconcile the original attempt or repeat its persisted cancellation request; it MUST NOT invoke launch again. A dropped future MUST leave the reservation intact.
3. Receipt import MUST validate the invocation hash and actual host/process identity through the kernel journal. Missing/mismatched evidence MUST retain uncertainty. A later running receipt MUST NOT erase cancellation intent.
4. Terminal receipts MUST survive a crash before or after the claim transition. Completion comments MUST use a stable attempt identifier and the actual agent Session. Reservation release MUST follow claim update and completion import through `settle`.
5. The operator MUST supply target-host program, cwd, and environment values. The transport MUST use a configured OpenSSH alias with strict host-key checking, batch mode, no agent forwarding, and no forwarded ports. It MUST shell-quote configured helper paths and MUST NOT interpolate the invocation into shell text.
6. SSH RPCs MUST bound request/response size and time. Killing a timed-out local SSH client MUST NOT be represented as terminating the detached target attempt.

## Target Runtime

1. The Linux helper MUST require an existing, exclusively owned delegated cgroup-v2 subtree with recursive `cgroup.kill`, plus an exclusively owned state directory. Missing capabilities MUST fail before command execution. Provisioning or delegation MAY remain an external operator action.
2. Each attempt MUST use its own cgroup incarnation. The supervisor MUST durably record the actual machine/boot, execution PID/start, and cgroup inode before permitting the command to execute. Detached descendants MUST remain covered by recursive cancellation and exit verification.
3. The helper MUST persist cancellation before fencing. It MUST report `Cancelled` only after the attempt cgroup is unpopulated. A cancellation tombstone MUST prevent late launch of that attempt; repeated cancellation MUST be idempotent.
4. Reused PID/cgroup identities, changed host/boot, missing target state, and unconfirmed termination MUST remain uncertain. Recovery MUST NOT signal an unrelated runtime or infer success from SSH reconnection.
5. This runtime MUST NOT be advertised as a complete sandbox for untrusted Tasks. Network policy, credential delivery, privilege confinement, and daemon capability gating remain [deferred] under [compute.md](../../architecture/kernel/compute.md). Cgroup process containment MUST NOT establish independent GUI input.

## Verification

1. Unit and storage gates MUST cover claimed Task lookup, Session provenance, one retained Task reservation, requested/confirmed cancellation, misbound receipts, dropped dispatch futures, restart without relaunch, and terminal import across both claim-update crash windows.
2. Run `compute_identity.py` on an explicitly owned Linux target for idempotent launch, output/exit reconciliation, exact child environment, background and detached descendants, recursive cancellation, and cancel-before-launch tombstones. Its source is [compute_identity.py](../../../../kernel/crates/gctrl-otel/tests/fixtures/compute_identity.py).
3. Run the ignored `live_ssh_reconciles` gate in [ssh.rs](../../../../kernel/crates/gctrl-compute/tests/ssh.rs) and `live_ssh_worker` gate in [worker_dispatch.rs](../../../../kernel/crates/gctrl-orch/tests/worker_dispatch.rs) explicitly. Configure `GCTRL_LIVE_SSH_ALIAS`, `GCTRL_LIVE_SSH_CONFIG`, `GCTRL_LIVE_COMPUTE_HELPER`, `GCTRL_LIVE_COMPUTE_DELAYED_HELPER`, `GCTRL_LIVE_COMPUTE_STATE`, `GCTRL_LIVE_COMPUTE_CGROUP`, and `GCTRL_LIVE_COMPUTE_CWD` for that target. The delayed acknowledgment fixture MUST remain test-only.
4. These gates MUST verify that lost dispatch acknowledgment leaves one remote execution and the same kernel claim/session/attempt after worker recreation. They MUST NOT substitute for full daemon restart, native human takeover, or the VM pointer/focus isolation scenarios in [computer-use.md](../../architecture/kernel/computer-use.md#contract-verification-scenarios-deferred).
