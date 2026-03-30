import KernelSpec.Basic

/-!
# Session State Machine

Models the telemetry session lifecycle:
  Active → Completed | Failed | Cancelled

Sessions are execution vehicles (analogous to Unix processes).

## Verified Properties
- All states reachable from Active
- Terminal states have no outgoing transitions
- Terminal convergence: every state reaches a terminal state
- Determinism: each (state, trigger) pair has a unique result
- Active is the only non-terminal state
-/

set_option autoImplicit false

namespace KernelSpec.Session

inductive Status where
  | active
  | completed
  | failed
  | cancelled
  deriving DecidableEq

inductive Trigger where
  | complete
  | error
  | cancel
  deriving DecidableEq

open Status Trigger

/-- Session state transition function -/
def step : Status → Trigger → Option Status
  | active, complete => some completed
  | active, error    => some failed
  | active, cancel   => some cancelled
  | _, _             => none

def isTerminal : Status → Bool
  | active => false
  | _      => true

-- ═══════════════════════════════════════════════════════════════
-- Terminal States (generic)
-- ═══════════════════════════════════════════════════════════════

theorem terminal_states_are_terminal :
    ∀ s, isTerminal s = true → KernelSpec.IsTerminalState step s := by
  intro s h; cases s <;> simp_all [isTerminal] <;> intro t <;> cases t <;> rfl

-- ═══════════════════════════════════════════════════════════════
-- Reachability (all states reachable from Active)
-- ═══════════════════════════════════════════════════════════════

theorem all_reachable : ∀ s : Status, KernelSpec.Reachable step active s := by
  intro s; cases s
  · exact ⟨[], rfl⟩                -- active: empty trace
  · exact ⟨[complete], rfl⟩        -- completed: [complete]
  · exact ⟨[error], rfl⟩           -- failed: [error]
  · exact ⟨[cancel], rfl⟩          -- cancelled: [cancel]

-- ═══════════════════════════════════════════════════════════════
-- Terminal Convergence
-- ═══════════════════════════════════════════════════════════════

theorem terminal_convergence : ∀ s : Status, ∃ s' : Status,
    KernelSpec.Reachable step s s' ∧ isTerminal s' = true := by
  intro s; cases s
  · exact ⟨completed, ⟨[complete], rfl⟩, rfl⟩   -- active → completed
  · exact ⟨completed, ⟨[], rfl⟩, rfl⟩            -- completed (already terminal)
  · exact ⟨failed, ⟨[], rfl⟩, rfl⟩               -- failed (already terminal)
  · exact ⟨cancelled, ⟨[], rfl⟩, rfl⟩            -- cancelled (already terminal)

-- ═══════════════════════════════════════════════════════════════
-- Determinism
-- ═══════════════════════════════════════════════════════════════

theorem deterministic : ∀ (s : Status) (t : Trigger) (r1 r2 : Option Status),
    step s t = r1 → step s t = r2 → r1 = r2 :=
  fun _ _ _ _ h1 h2 => h1.symm.trans h2

-- ═══════════════════════════════════════════════════════════════
-- Active is the only non-terminal state
-- ═══════════════════════════════════════════════════════════════

theorem only_active_has_transitions : ∀ s : Status,
    (∃ t : Trigger, step s t ≠ none) ↔ s = active := by
  intro s; constructor
  · intro ⟨t, h⟩; cases s <;> cases t <;> simp_all [step]
  · intro h; subst h; exact ⟨complete, by simp [step]⟩

end KernelSpec.Session
