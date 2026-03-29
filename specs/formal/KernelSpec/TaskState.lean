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
- Done and Cancelled are terminal (no outgoing transitions)
- Terminal convergence: every state can reach a terminal state
- Paused integrity: only resume or cancel exits Paused
- Failed semi-terminal: only retry exits Failed
- Blocked integrity: only unblock or cancel exits Blocked
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

-- ═══════════════════════════════════════════════════════════════
-- Terminal States
-- ═══════════════════════════════════════════════════════════════

theorem done_terminal : KernelSpec.IsTerminalState step done := by
  intro t; cases t <;> rfl

theorem cancelled_terminal : KernelSpec.IsTerminalState step cancelled := by
  intro t; cases t <;> rfl

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

def isTerminal : Status → Bool
  | done      => true
  | cancelled => true
  | _         => false

theorem terminal_convergence : ∀ s : Status, ∃ s' : Status,
    KernelSpec.Reachable step s s' ∧ isTerminal s' = true := by
  intro s; cases s
  · -- pending → running → done
    exact ⟨done, ⟨[dispatch, complete], rfl⟩, rfl⟩
  · -- running → done
    exact ⟨done, ⟨[complete], rfl⟩, rfl⟩
  · -- paused → running → done
    exact ⟨done, ⟨[resume, complete], rfl⟩, rfl⟩
  · -- blocked → pending → running → done
    exact ⟨done, ⟨[unblock, dispatch, complete], rfl⟩, rfl⟩
  · -- done (already terminal)
    exact ⟨done, ⟨[], rfl⟩, rfl⟩
  · -- failed → pending → running → done
    exact ⟨done, ⟨[retry, dispatch, complete], rfl⟩, rfl⟩
  · -- cancelled (already terminal)
    exact ⟨cancelled, ⟨[], rfl⟩, rfl⟩

-- ═══════════════════════════════════════════════════════════════
-- Paused Integrity: only resume or cancel exits Paused
-- ═══════════════════════════════════════════════════════════════

theorem paused_integrity : ∀ (t : Trigger) (s' : Status),
    step paused t = some s' →
    (t = resume ∧ s' = running) ∨ (t = cancel ∧ s' = cancelled) := by
  intro t s' h
  cases t <;> simp_all [step]

-- ═══════════════════════════════════════════════════════════════
-- Failed Semi-Terminal: only retry exits Failed
-- ═══════════════════════════════════════════════════════════════

theorem failed_only_retry : ∀ (t : Trigger) (s' : Status),
    step failed t = some s' → t = retry ∧ s' = pending := by
  intro t s' h
  cases t <;> simp_all [step]

-- ═══════════════════════════════════════════════════════════════
-- Blocked Integrity: only unblock or cancel exits Blocked
-- ═══════════════════════════════════════════════════════════════

theorem blocked_integrity : ∀ (t : Trigger) (s' : Status),
    step blocked t = some s' →
    (t = unblock ∧ s' = pending) ∨ (t = cancel ∧ s' = cancelled) := by
  intro t s' h
  cases t <;> simp_all [step]

-- ═══════════════════════════════════════════════════════════════
-- Cancel available from all non-terminal, non-done states
-- ═══════════════════════════════════════════════════════════════

theorem pending_can_cancel : step pending cancel = some cancelled := rfl
theorem blocked_can_cancel : step blocked cancel = some cancelled := rfl
theorem running_can_cancel : step running cancel = some cancelled := rfl
theorem paused_can_cancel : step paused cancel = some cancelled := rfl

end KernelSpec.Task
