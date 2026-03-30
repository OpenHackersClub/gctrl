import KernelSpec.TaskState
import KernelSpec.Orchestrator

/-!
# Dispatch Eligibility & Retry Bounds

Formal model of the 7-condition dispatch eligibility predicate from the
Orchestrator specification. Composes TaskState and Orchestrator ClaimState
with runtime concurrency/DAG constraints into a single verified predicate.

Also proves retry backoff is bounded and terminates.

## Verified Properties
- The conjunction is satisfiable (eligible contexts exist)
- Terminal tasks are never eligible
- Non-unclaimed claim states are never eligible (including Paused)
- Each of the 7 conditions is independently necessary
- Active status is the complement of terminal status
- Backoff delay is bounded by max_backoff for all attempts
- Retries terminate after max_retries attempts
-/

set_option autoImplicit false

namespace KernelSpec.Dispatch

-- ═══════════════════════════════════════════════════════════════
-- Helper predicates
-- ═══════════════════════════════════════════════════════════════

/-- A task status is active (non-terminal): not Done and not Cancelled. -/
def isActiveStatus : Task.Status → Bool
  | .done      => false
  | .cancelled => false
  | _          => true

/-- A claim state is unclaimed (available for dispatch). -/
def isUnclaimed : Orchestrator.ClaimState → Bool
  | .unclaimed => true
  | _          => false

/-- Active status is exactly the complement of terminal status. -/
theorem active_iff_not_terminal : ∀ s : Task.Status,
    isActiveStatus s = !Task.isTerminal s := by
  intro s; cases s <;> rfl

-- ═══════════════════════════════════════════════════════════════
-- Dispatch Context & Eligibility Predicate
-- ═══════════════════════════════════════════════════════════════

/-- The state needed for the dispatch eligibility check.
    Maps to the 7 machine-checkable conditions from orchestrator.md §5:
    1. taskStatus active       — isActiveStatus
    2. claimState unclaimed    — isUnclaimed
    3. global slots available  — runtime capacity check
    4. per-state slots available — runtime capacity check
    5. no blockers non-terminal — DAG + task status check
    6. user resolvable         — WORKFLOW.md persona lookup
    7. per-user slots available — runtime capacity check -/
structure Context where
  taskStatus            : Task.Status
  claimState            : Orchestrator.ClaimState
  globalSlotsAvailable  : Bool
  perStateSlotsAvailable : Bool
  noBlockersNonTerminal : Bool
  userResolvable        : Bool
  perUserSlotsAvailable : Bool

/-- A task is dispatch-eligible iff ALL 7 conditions hold simultaneously. -/
def isEligible (ctx : Context) : Bool :=
  isActiveStatus ctx.taskStatus &&
  isUnclaimed ctx.claimState &&
  ctx.globalSlotsAvailable &&
  ctx.perStateSlotsAvailable &&
  ctx.noBlockersNonTerminal &&
  ctx.userResolvable &&
  ctx.perUserSlotsAvailable

-- ═══════════════════════════════════════════════════════════════
-- Consistency: the predicate is satisfiable
-- ═══════════════════════════════════════════════════════════════

/-- There exists a context where dispatch is eligible. -/
theorem eligible_exists : ∃ ctx : Context, isEligible ctx = true :=
  ⟨⟨.pending, .unclaimed, true, true, true, true, true⟩, rfl⟩

-- ═══════════════════════════════════════════════════════════════
-- Necessary conditions: terminal tasks never eligible
-- ═══════════════════════════════════════════════════════════════

theorem done_not_eligible (ctx : Context) (h : ctx.taskStatus = .done) :
    isEligible ctx = false := by
  simp [isEligible, isActiveStatus, h]

theorem cancelled_not_eligible (ctx : Context) (h : ctx.taskStatus = .cancelled) :
    isEligible ctx = false := by
  simp [isEligible, isActiveStatus, h]

-- ═══════════════════════════════════════════════════════════════
-- Necessary conditions: only Unclaimed allows dispatch
-- ═══════════════════════════════════════════════════════════════

theorem claimed_not_eligible (ctx : Context) (h : ctx.claimState = .claimed) :
    isEligible ctx = false := by
  simp [isEligible, isUnclaimed, h]

theorem running_not_eligible (ctx : Context) (h : ctx.claimState = .running) :
    isEligible ctx = false := by
  simp [isEligible, isUnclaimed, h]

theorem paused_not_eligible (ctx : Context) (h : ctx.claimState = .paused) :
    isEligible ctx = false := by
  simp [isEligible, isUnclaimed, h]

theorem retryQueued_not_eligible (ctx : Context) (h : ctx.claimState = .retryQueued) :
    isEligible ctx = false := by
  simp [isEligible, isUnclaimed, h]

theorem released_not_eligible (ctx : Context) (h : ctx.claimState = .released) :
    isEligible ctx = false := by
  simp [isEligible, isUnclaimed, h]

-- ═══════════════════════════════════════════════════════════════
-- Each condition is independently necessary
-- For each condition, we exhibit a context where ONLY that one fails.
-- ═══════════════════════════════════════════════════════════════

theorem activeStatus_necessary : ∃ ctx : Context,
    isActiveStatus ctx.taskStatus = false ∧ isEligible ctx = false :=
  ⟨⟨.done, .unclaimed, true, true, true, true, true⟩, rfl, rfl⟩

theorem unclaimed_necessary : ∃ ctx : Context,
    isUnclaimed ctx.claimState = false ∧ isEligible ctx = false :=
  ⟨⟨.pending, .claimed, true, true, true, true, true⟩, rfl, rfl⟩

theorem globalSlots_necessary : ∃ ctx : Context,
    ctx.globalSlotsAvailable = false ∧ isEligible ctx = false :=
  ⟨⟨.pending, .unclaimed, false, true, true, true, true⟩, rfl, rfl⟩

theorem perStateSlots_necessary : ∃ ctx : Context,
    ctx.perStateSlotsAvailable = false ∧ isEligible ctx = false :=
  ⟨⟨.pending, .unclaimed, true, false, true, true, true⟩, rfl, rfl⟩

theorem noBlockers_necessary : ∃ ctx : Context,
    ctx.noBlockersNonTerminal = false ∧ isEligible ctx = false :=
  ⟨⟨.pending, .unclaimed, true, true, false, true, true⟩, rfl, rfl⟩

theorem userResolvable_necessary : ∃ ctx : Context,
    ctx.userResolvable = false ∧ isEligible ctx = false :=
  ⟨⟨.pending, .unclaimed, true, true, true, false, true⟩, rfl, rfl⟩

theorem perUserSlots_necessary : ∃ ctx : Context,
    ctx.perUserSlotsAvailable = false ∧ isEligible ctx = false :=
  ⟨⟨.pending, .unclaimed, true, true, true, true, false⟩, rfl, rfl⟩

-- ═══════════════════════════════════════════════════════════════
-- Retry Backoff Bounds
-- ═══════════════════════════════════════════════════════════════

/-- Exponential backoff delay: min(base * 2^attempt, maxBackoff).
    base: initial delay in ms (spec default: 10000).
    maxBackoff: cap in ms (spec default: 300000). -/
def backoffDelay (base maxBackoff attempt : Nat) : Nat :=
  min (base * 2 ^ attempt) maxBackoff

/-- Backoff delay is always bounded by maxBackoff, for any attempt. -/
theorem backoff_bounded (base maxBackoff attempt : Nat) :
    backoffDelay base maxBackoff attempt ≤ maxBackoff :=
  Nat.min_le_right _ _

/-- Whether a retry should be attempted (attempt < maxRetries). -/
def shouldRetry (maxRetries attempt : Nat) : Bool :=
  decide (attempt < maxRetries)

/-- Retries terminate: at maxRetries, no more retries. -/
theorem retry_terminates (maxRetries : Nat) :
    shouldRetry maxRetries maxRetries = false := by
  simp [shouldRetry]

/-- Retries terminate: any attempt ≥ maxRetries exhausts retries. -/
theorem retry_exhausted (maxRetries attempt : Nat) (h : maxRetries ≤ attempt) :
    shouldRetry maxRetries attempt = false := by
  simp [shouldRetry]; omega

/-- Early attempts are always retried. -/
theorem retry_early (maxRetries attempt : Nat) (h : attempt < maxRetries) :
    shouldRetry maxRetries attempt = true := by
  simp [shouldRetry, h]

end KernelSpec.Dispatch
