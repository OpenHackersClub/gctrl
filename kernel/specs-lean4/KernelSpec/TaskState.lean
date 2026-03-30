import KernelSpec.Basic

/-!
# Task State Machine (Scheduler)

Models the kernel-level task lifecycle:
  pending ↔ blocked
  pending → running → done | failed | cancelled
  running → paused → running
  failed → pending (retry)

Tasks are the normalized unit of work across all agent systems.
The Scheduler owns task lifecycle; the Orchestrator owns dispatch claims.

## Verified Properties
- All states reachable from Pending (initial state)
- Terminal states have no outgoing transitions
- Terminal convergence: every state can reach a terminal state
- Cancel reachable from all non-terminal states
- Restricted-exit integrity: paused, failed, blocked have limited exits
-/

set_option autoImplicit false

namespace KernelSpec.Task

inductive Status where
  | pending
  | running
  | paused
  | blocked
  | done
  | failed
  | cancelled
  deriving DecidableEq

inductive Trigger where
  | dispatch
  | complete
  | fail
  | cancel
  | pause
  | resume
  | block
  | unblock
  | retry
  deriving DecidableEq

open Status Trigger

/-- Task state transition function -/
def step : Status → Trigger → Option Status
  | pending, dispatch  => some running
  | pending, block     => some blocked
  | pending, cancel    => some cancelled
  | blocked, unblock   => some pending
  | blocked, cancel    => some cancelled
  | running, complete  => some done
  | running, fail      => some failed
  | running, pause     => some paused
  | running, cancel    => some cancelled
  | paused, resume     => some running
  | paused, cancel     => some cancelled
  | failed, retry      => some pending
  | _, _               => none

def isTerminal : Status → Bool
  | done      => true
  | cancelled => true
  | _         => false

/-- Non-terminal states that can be cancelled. -/
def isCancellable : Status → Bool
  | pending => true
  | running => true
  | paused  => true
  | blocked => true
  | _       => false

-- ═══════════════════════════════════════════════════════════════
-- Terminal States (generic)
-- ═══════════════════════════════════════════════════════════════

theorem terminal_states_are_terminal :
    ∀ s, isTerminal s = true → KernelSpec.IsTerminalState step s := by
  intro s h; cases s <;> simp_all [isTerminal] <;> intro t <;> cases t <;> rfl

-- ═══════════════════════════════════════════════════════════════
-- Reachability (all states reachable from Pending)
-- ═══════════════════════════════════════════════════════════════

theorem all_reachable : ∀ s : Status, KernelSpec.Reachable step pending s := by
  intro s; cases s
  · exact ⟨[], rfl⟩                          -- pending
  · exact ⟨[dispatch], rfl⟩                  -- running
  · exact ⟨[dispatch, pause], rfl⟩           -- paused
  · exact ⟨[block], rfl⟩                     -- blocked
  · exact ⟨[dispatch, complete], rfl⟩        -- done
  · exact ⟨[dispatch, fail], rfl⟩            -- failed
  · exact ⟨[cancel], rfl⟩                    -- cancelled

-- ═══════════════════════════════════════════════════════════════
-- Terminal Convergence
-- ═══════════════════════════════════════════════════════════════

theorem terminal_convergence : ∀ s : Status, ∃ s' : Status,
    KernelSpec.Reachable step s s' ∧ isTerminal s' = true := by
  intro s; cases s
  · exact ⟨done, ⟨[dispatch, complete], rfl⟩, rfl⟩           -- pending
  · exact ⟨done, ⟨[complete], rfl⟩, rfl⟩                      -- running
  · exact ⟨done, ⟨[resume, complete], rfl⟩, rfl⟩              -- paused
  · exact ⟨done, ⟨[unblock, dispatch, complete], rfl⟩, rfl⟩   -- blocked
  · exact ⟨done, ⟨[], rfl⟩, rfl⟩                              -- done
  · exact ⟨done, ⟨[retry, dispatch, complete], rfl⟩, rfl⟩     -- failed
  · exact ⟨cancelled, ⟨[], rfl⟩, rfl⟩                         -- cancelled

-- ═══════════════════════════════════════════════════════════════
-- Cancel reachable from all non-terminal states (generic)
-- ═══════════════════════════════════════════════════════════════

theorem cancellable_can_cancel :
    ∀ s, isCancellable s = true → step s cancel = some cancelled := by
  intro s h; cases s <;> simp_all [isCancellable, step]

-- ═══════════════════════════════════════════════════════════════
-- Restricted-exit integrity
-- ═══════════════════════════════════════════════════════════════

/-- Paused: only resume or cancel exits. -/
theorem paused_integrity : ∀ (t : Trigger) (s' : Status),
    step paused t = some s' →
    (t = resume ∧ s' = running) ∨ (t = cancel ∧ s' = cancelled) := by
  intro t s' h
  cases t <;> simp_all [step]

/-- Failed: only retry exits. -/
theorem failed_only_retry : ∀ (t : Trigger) (s' : Status),
    step failed t = some s' → t = retry ∧ s' = pending := by
  intro t s' h
  cases t <;> simp_all [step]

/-- Blocked: only unblock or cancel exits. -/
theorem blocked_integrity : ∀ (t : Trigger) (s' : Status),
    step blocked t = some s' →
    (t = unblock ∧ s' = pending) ∨ (t = cancel ∧ s' = cancelled) := by
  intro t s' h
  cases t <;> simp_all [step]

end KernelSpec.Task
