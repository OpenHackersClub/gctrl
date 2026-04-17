import KernelSpec.Basic
import KernelSpec.DomainTypes
import KernelSpec.SessionState
import KernelSpec.TaskState
import KernelSpec.Orchestrator
import KernelSpec.RunAttempt
import KernelSpec.TaskDAG
import KernelSpec.DispatchEligibility

/-!
# gctrl Kernel — Formal Specification

Verified state machines, domain types, and invariants for the GroundCtrl OS
**kernel layer**. All proofs are complete (no `sorry`).

## Kernel Modules

- **Basic**: Shared definitions (trace execution, reachability, terminal states)
- **DomainTypes**: Pure enums — SpanStatus, PolicyDecision, UserKind, AgentKind, ActorKind
- **SessionState**: Telemetry session lifecycle (Active → Completed/Failed/Cancelled)
- **TaskState**: Scheduler task lifecycle with dependency blocking
- **Orchestrator**: Claim-based dispatch coordination (no duplicate dispatch, liveness, pause integrity)
- **RunAttempt**: Per-dispatch execution pipeline (always-forward progress)
- **TaskDAG**: Dependency graph acyclicity via topological ordering
- **DispatchEligibility**: 7-condition dispatch predicate, retry backoff bounds

Application-level specs (e.g. IssueState for gctrl-board) are separate from the kernel.
-/
