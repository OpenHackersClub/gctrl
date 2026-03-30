import KernelSpec.Basic

/-!
# Orchestrator Claim State Machine

Models the kernel dispatch coordination layer:
  Unclaimed → Claimed → Running → Released
                      → Paused → Running / Released
                      → RetryQueued → Running / Released

The Orchestrator owns claim states (distinct from Task Scheduler states).
These prevent duplicate dispatch and coordinate agent lifecycle.

## Verified Properties
1. **No duplicate dispatch**: dispatchEligible only transitions from Unclaimed
2. **Reachability**: every state reachable from Unclaimed
3. **Liveness**: Claimed and RetryQueued always have a path to Running or Released
4. **Determinism**: each (state, trigger) has a unique result
5. **Terminal convergence**: Released is reachable from every state
6. **Pause/resume integrity**: Paused only exits via humanResume or reconciliationTerminal
-/

set_option autoImplicit false

namespace KernelSpec.Orchestrator

inductive ClaimState where
  | unclaimed
  | claimed
  | running
  | paused
  | retryQueued
  | released
  deriving DecidableEq

inductive Trigger where
  | dispatchEligible
  | agentLaunched
  | dispatchFailed
  | guardrailSuspend
  | humanPause
  | humanResume
  | agentExitNormal
  | agentExitAbnormal
  | retryDispatch
  | noLongerEligible
  | maxRetries
  | reconciliationTerminal
  | reEligibleNextTick
  deriving DecidableEq

open ClaimState Trigger

/-- Orchestrator claim state transition function -/
def step : ClaimState → Trigger → Option ClaimState
  | unclaimed,  dispatchEligible       => some claimed
  | claimed,    agentLaunched          => some running
  | claimed,    dispatchFailed         => some released
  | running,    guardrailSuspend       => some paused
  | running,    humanPause             => some paused
  | running,    agentExitNormal        => some retryQueued
  | running,    agentExitAbnormal      => some retryQueued
  | running,    reconciliationTerminal => some released
  | paused,     humanResume            => some running
  | paused,     reconciliationTerminal => some released
  | retryQueued, retryDispatch         => some running
  | retryQueued, noLongerEligible      => some released
  | retryQueued, maxRetries            => some released
  | released,   reEligibleNextTick     => some unclaimed
  | _, _                               => none

-- ═══════════════════════════════════════════════════════════════
-- Property 1: No Duplicate Dispatch
-- dispatchEligible only works from Unclaimed
-- ═══════════════════════════════════════════════════════════════

theorem no_duplicate_dispatch_running : step running dispatchEligible = none := rfl
theorem no_duplicate_dispatch_claimed : step claimed dispatchEligible = none := rfl
theorem no_duplicate_dispatch_paused : step paused dispatchEligible = none := rfl
theorem no_duplicate_dispatch_retryQueued : step retryQueued dispatchEligible = none := rfl

theorem dispatch_only_from_unclaimed : ∀ (s s' : ClaimState),
    step s dispatchEligible = some s' → s = unclaimed := by
  intro s s' h
  cases s <;> simp_all [step]

-- ═══════════════════════════════════════════════════════════════
-- Property 2: Reachability (all states from Unclaimed)
-- ═══════════════════════════════════════════════════════════════

theorem all_reachable : ∀ s : ClaimState, KernelSpec.Reachable step unclaimed s := by
  intro s; cases s
  · -- unclaimed: empty trace
    exact ⟨[], rfl⟩
  · -- claimed: [dispatchEligible]
    exact ⟨[dispatchEligible], rfl⟩
  · -- running: [dispatchEligible, agentLaunched]
    exact ⟨[dispatchEligible, agentLaunched], rfl⟩
  · -- paused: [dispatchEligible, agentLaunched, guardrailSuspend]
    exact ⟨[dispatchEligible, agentLaunched, guardrailSuspend], rfl⟩
  · -- retryQueued: [dispatchEligible, agentLaunched, agentExitNormal]
    exact ⟨[dispatchEligible, agentLaunched, agentExitNormal], rfl⟩
  · -- released: [dispatchEligible, agentLaunched, reconciliationTerminal]
    exact ⟨[dispatchEligible, agentLaunched, reconciliationTerminal], rfl⟩

-- ═══════════════════════════════════════════════════════════════
-- Property 3: Liveness
-- From Claimed: ∃ trigger → Running or Released
-- From RetryQueued: ∃ trigger → Running or Released
-- ═══════════════════════════════════════════════════════════════

theorem claimed_liveness : ∃ (t : Trigger) (s' : ClaimState),
    step claimed t = some s' ∧ (s' = running ∨ s' = released) :=
  ⟨agentLaunched, running, rfl, Or.inl rfl⟩

theorem retryQueued_liveness : ∃ (t : Trigger) (s' : ClaimState),
    step retryQueued t = some s' ∧ (s' = running ∨ s' = released) :=
  ⟨retryDispatch, running, rfl, Or.inl rfl⟩

-- Stronger liveness: ALL valid transitions from Claimed lead to Running or Released
theorem claimed_always_progresses : ∀ (t : Trigger) (s' : ClaimState),
    step claimed t = some s' → s' = running ∨ s' = released := by
  intro t s' h
  cases t <;> simp_all [step]

-- ALL valid transitions from RetryQueued lead to Running or Released
theorem retryQueued_always_progresses : ∀ (t : Trigger) (s' : ClaimState),
    step retryQueued t = some s' → s' = running ∨ s' = released := by
  intro t s' h
  cases t <;> simp_all [step]

-- ═══════════════════════════════════════════════════════════════
-- Property 4: Determinism
-- ═══════════════════════════════════════════════════════════════

theorem deterministic : ∀ (s : ClaimState) (t : Trigger) (r1 r2 : Option ClaimState),
    step s t = r1 → step s t = r2 → r1 = r2 :=
  fun _ _ _ _ h1 h2 => h1.symm.trans h2

-- ═══════════════════════════════════════════════════════════════
-- Property 5: Terminal Convergence (Released reachable from any state)
-- ═══════════════════════════════════════════════════════════════

theorem released_reachable_from_any : ∀ s : ClaimState,
    KernelSpec.Reachable step s released := by
  intro s; cases s
  · -- unclaimed → claimed → running → released
    exact ⟨[dispatchEligible, agentLaunched, reconciliationTerminal], rfl⟩
  · -- claimed → running → released
    exact ⟨[agentLaunched, reconciliationTerminal], rfl⟩
  · -- running → released
    exact ⟨[reconciliationTerminal], rfl⟩
  · -- paused → released
    exact ⟨[reconciliationTerminal], rfl⟩
  · -- retryQueued → released
    exact ⟨[noLongerEligible], rfl⟩
  · -- released (already there)
    exact ⟨[], rfl⟩

-- ═══════════════════════════════════════════════════════════════
-- Property 6: Pause/Resume Integrity
-- Paused MUST only exit via humanResume or reconciliationTerminal
-- ═══════════════════════════════════════════════════════════════

theorem paused_integrity : ∀ (t : Trigger) (s' : ClaimState),
    step paused t = some s' →
    (t = humanResume ∧ s' = running) ∨
    (t = reconciliationTerminal ∧ s' = released) := by
  intro t s' h
  cases t <;> simp_all [step]

-- Paused is NOT re-dispatchable
theorem paused_not_dispatchable : step paused dispatchEligible = none := rfl

-- ═══════════════════════════════════════════════════════════════
-- Released can cycle back to Unclaimed (re-eligibility)
-- ═══════════════════════════════════════════════════════════════

theorem released_can_recycle : step released reEligibleNextTick = some unclaimed := rfl

-- Full cycle: Unclaimed → Claimed → Running → Released → Unclaimed
theorem full_cycle : KernelSpec.Reachable step unclaimed unclaimed :=
  ⟨[dispatchEligible, agentLaunched, reconciliationTerminal, reEligibleNextTick], rfl⟩

end KernelSpec.Orchestrator
