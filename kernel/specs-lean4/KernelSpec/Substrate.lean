import KernelSpec.Basic
import KernelSpec.DomainTypes
import KernelSpec.Orchestrator

/-!
# Substrate — AgentRuntime × ComputeSubstrate Decoupling

Formalizes the kernel ports defined in
`vault/specs/architecture/kernel/runtime.md` and `compute.md`, and the
invariants in
`vault/specs/architecture/apps/adr-runtime-compute-decoupling.md`.

A `Dispatch` is a `(AgentKind, ComputeKind)` pair — the brain (which agent
program runs) and the hand (where it runs). The Orchestrator state machine
lives in `Orchestrator.lean` and is *runtime- and compute-agnostic*; this
module proves that property and two corollaries.

## Verified Properties

1. **Orthogonality** — the Orchestrator claim-state machine is independent
   of the `(runtime, compute)` pair. Changing one component does not change
   any claim-state transition. (`orthogonality`, `runtime_independent`,
   `compute_independent`)

2. **Failure-as-tool-error** — every `ComputeExit` (clean exit, error code,
   crash, kill, lost connection) maps to a `Trigger` that has a defined
   transition from `Running`. Compute failure cannot break the claim-state
   machine. (`exit_lands_in_retryQueued`, `failure_is_tool_error`)

3. **Cross-pair recovery** — after a compute failure, the orchestrator can
   re-dispatch on a *different* `(runtime, compute)` pair. The path
   Running → RetryQueued → Released → Unclaimed → Claimed is reachable
   regardless of whether the new pair equals the old pair.
   (`crash_recover_different_pair`, `cross_pair_redispatch`)
-/

set_option autoImplicit false

namespace KernelSpec.Substrate

open KernelSpec
open KernelSpec.Orchestrator

-- ═══════════════════════════════════════════════════════════════
-- Dispatch — the (brain, hand) pair
-- ═══════════════════════════════════════════════════════════════

/-- A Dispatch carries the `(runtime, compute)` pair that identifies a
    Task's execution. Decoupled at the type level — neither component
    constrains the other. -/
structure Dispatch where
  runtime : AgentKind
  compute : ComputeKind
  deriving DecidableEq

namespace Dispatch
  /-- Project to the brain. -/
  def runtimeOf (d : Dispatch) : AgentKind := d.runtime
  /-- Project to the hand. -/
  def substrateOf (d : Dispatch) : ComputeKind := d.compute
end Dispatch

-- ═══════════════════════════════════════════════════════════════
-- ComputeExit — every ComputeSubstrate lifecycle outcome
-- ═══════════════════════════════════════════════════════════════

/-- A ComputeSubstrate's exit signal. Any compute outcome — clean exit,
    error code, crash, kernel kill, network drop — is one of these. The
    Substrate trait MUST resolve its `wait` future to one of these values
    and MUST NOT propagate kernel-level errors. See
    `vault/specs/architecture/kernel/compute.md` § Failure-as-Tool-Error. -/
inductive ComputeExit where
  | clean              -- runtime returned cleanly (exit 0)
  | error (code : Nat) -- runtime returned a non-zero exit code
  | crashed            -- container died, OOM, host failure
  | killed             -- kernel-issued kill (timeout, guardrail)
  | networkLost        -- ssh-remote dropped, e2b quota, CF host disconnect
  deriving DecidableEq

/-- Map any `ComputeExit` to the corresponding Orchestrator `Trigger`.
    Clean exit becomes `agentExitNormal`; everything else becomes
    `agentExitAbnormal` so the existing retry path handles recovery. -/
def mapExit : ComputeExit → Trigger
  | .clean        => Trigger.agentExitNormal
  | .error _      => Trigger.agentExitAbnormal
  | .crashed      => Trigger.agentExitAbnormal
  | .killed       => Trigger.agentExitAbnormal
  | .networkLost  => Trigger.agentExitAbnormal

-- ═══════════════════════════════════════════════════════════════
-- Property 1: Orthogonality
-- The Orchestrator state machine does not depend on Dispatch.
-- ═══════════════════════════════════════════════════════════════

/-- Annotated step: thread a `Dispatch` through the Orchestrator step.
    The result depends only on `(state, trigger)` — never on dispatch. -/
def stepWithDispatch (_d : Dispatch) (s : ClaimState) (t : Trigger)
    : Option ClaimState :=
  step s t

/-- **Orthogonality.** For any two dispatches, the annotated step gives
    identical results. The Orchestrator never branches on runtime or
    compute — proving the "Brain ≠ Hand" invariant from the ADR. -/
theorem orthogonality : ∀ (d1 d2 : Dispatch) (s : ClaimState) (t : Trigger),
    stepWithDispatch d1 s t = stepWithDispatch d2 s t := by
  intros; rfl

/-- Corollary: changing only the runtime preserves transitions. -/
theorem runtime_independent :
    ∀ (r1 r2 : AgentKind) (c : ComputeKind) (s : ClaimState) (t : Trigger),
    stepWithDispatch ⟨r1, c⟩ s t = stepWithDispatch ⟨r2, c⟩ s t := by
  intros; rfl

/-- Corollary: changing only the compute preserves transitions. -/
theorem compute_independent :
    ∀ (r : AgentKind) (c1 c2 : ComputeKind) (s : ClaimState) (t : Trigger),
    stepWithDispatch ⟨r, c1⟩ s t = stepWithDispatch ⟨r, c2⟩ s t := by
  intros; rfl

-- ═══════════════════════════════════════════════════════════════
-- Property 2: Failure-as-tool-error
-- Every ComputeExit produces a defined transition from Running.
-- ═══════════════════════════════════════════════════════════════

/-- **Failure-as-tool-error (strong form).** Every `ComputeExit` lands
    in `RetryQueued` from `Running`. The orchestrator never gets stuck
    because of *how* a compute died. -/
theorem exit_lands_in_retryQueued : ∀ e : ComputeExit,
    step ClaimState.running (mapExit e) = some ClaimState.retryQueued := by
  intro e
  cases e <;> rfl

/-- Failure-as-tool-error (weak form / existence). For every `ComputeExit`
    there exists a successor claim state — `step running (mapExit e)` is
    never `none`. -/
theorem failure_is_tool_error : ∀ e : ComputeExit,
    ∃ s' : ClaimState, step ClaimState.running (mapExit e) = some s' := by
  intro e
  exact ⟨ClaimState.retryQueued, exit_lands_in_retryQueued e⟩

/-- The `mapExit` codomain is exactly the two exit triggers — no other
    `Trigger` constructor is reachable from a `ComputeExit`. -/
theorem mapExit_in_exit_triggers : ∀ e : ComputeExit,
    mapExit e = Trigger.agentExitNormal ∨ mapExit e = Trigger.agentExitAbnormal := by
  intro e
  cases e
  · left;  rfl
  · right; rfl
  · right; rfl
  · right; rfl
  · right; rfl

-- ═══════════════════════════════════════════════════════════════
-- Property 3: Cross-pair recovery
-- After a compute failure, redispatch on a different (runtime, compute)
-- pair is reachable. The kernel state machine doesn't track which pair
-- was used previously, so any next pair is admissible.
-- ═══════════════════════════════════════════════════════════════

/-- From `Released`, the orchestrator can cycle back to `Claimed` via
    `reEligibleNextTick` then `dispatchEligible`. The `prior` and `next`
    dispatches are unconstrained — they MAY differ in runtime, in compute,
    or in both. -/
theorem cross_pair_redispatch :
    ∀ (_prior _next : Dispatch),
    Reachable step ClaimState.released ClaimState.claimed := by
  intros _ _
  exact ⟨[Trigger.reEligibleNextTick, Trigger.dispatchEligible], rfl⟩

/-- **Crash → recover on a different pair.** The full trace from a running
    compute that crashes (any `ComputeExit`) through to a fresh `Claimed`
    state on a possibly-different `(runtime, compute)` pair is reachable.

    Trace:
      Running ─agentExitAbnormal→ RetryQueued
              ─noLongerEligible→ Released
              ─reEligibleNextTick→ Unclaimed
              ─dispatchEligible→ Claimed

    The `prior` and `next` Dispatch values are unconstrained — proving the
    ADR invariant that "a re-dispatch on a different `(runtime, compute)`
    pair MUST be possible if the previous attempt's SessionEvents are
    intact". -/
theorem crash_recover_different_pair :
    ∀ (_e : ComputeExit) (_prior _next : Dispatch),
    Reachable step ClaimState.running ClaimState.claimed := by
  intros _ _ _
  exact ⟨[Trigger.agentExitAbnormal, Trigger.noLongerEligible,
          Trigger.reEligibleNextTick, Trigger.dispatchEligible], rfl⟩

/-- The recovery trace is well-formed regardless of whether the next pair
    equals the prior pair — i.e. retry on the same compute is admissible
    too. (Same-pair retry is the existing default; this theorem just shows
    cross-pair is no different from the state-machine's view.) -/
theorem same_pair_retry :
    ∀ (_e : ComputeExit) (_d : Dispatch),
    Reachable step ClaimState.running ClaimState.claimed :=
  fun e d => crash_recover_different_pair e d d

end KernelSpec.Substrate
