# Formal Specs Style Guide (Lean 4 — `specs-lean4/`)

## Use Mathlib Whenever Possible

Prefer Mathlib definitions, lemmas, and tactics over hand-rolled equivalents. Mathlib provides battle-tested abstractions for order theory, graph theory, finsets, and decidability — all of which arise naturally in state machine verification.

Examples of where Mathlib helps:
- **Order relations** (`Mathlib.Order.*`) — use `PartialOrder`, `LinearOrder` for state orderings instead of custom `stateOrd` functions
- **Finsets / Fintype** — enumerate states and triggers for exhaustive proofs instead of manual case splits
- **Graph theory** (`Mathlib.Combinatorics.SimpleGraph`) — DAG acyclicity, reachability, topological sort
- **Decidability** — `Decidable`, `DecidableEq` instances from Mathlib rather than hand-derived
- **Tactics** — `omega`, `decide`, `aesop`, `positivity` from Mathlib's tactic library

When adding Mathlib as a dependency, pin to a specific toolchain-compatible version in `lakefile.lean`.

## Prefer Generic Theorems Over Per-State Variants

Instead of proving the same property individually for each state, write a single universally-quantified theorem. This is more concise and scales better as states are added.

**Avoid — repetitive per-state theorems:**

```lean
theorem completed_terminal : IsTerminalState step completed := by
  intro t; cases t <;> rfl

theorem failed_terminal : IsTerminalState step failed := by
  intro t; cases t <;> rfl

theorem cancelled_terminal : IsTerminalState step cancelled := by
  intro t; cases t <;> rfl
```

**Prefer — single generic theorem with a predicate:**

```lean
def isTerminal : Status → Bool
  | completed => true
  | failed    => true
  | cancelled => true
  | _         => false

theorem terminal_states_are_terminal :
    ∀ s, isTerminal s = true → IsTerminalState step s := by
  intro s h; cases s <;> simp_all [isTerminal] <;> intro t <;> cases t <;> rfl
```

This proves the property once for all terminal states. When a new terminal state is added, only the `isTerminal` predicate and the proof update — no new theorem name needed.

### Same Pattern for Reachability

**Avoid:** One theorem per state (`active_reachable`, `completed_reachable`, etc.)

**Prefer:** Single `∀` theorem:

```lean
theorem all_reachable : ∀ s : Status, Reachable step initial s := by
  intro s; cases s <;> exact ⟨witness, rfl⟩
```

## Shared Infrastructure in `Basic.lean`

Generic definitions (`trace`, `Reachable`, `IsTerminalState`) live in `Basic.lean` and are reused across all state machines. New state machines MUST NOT redefine these — import `KernelSpec.Basic`. Over time, migrate these to Mathlib equivalents where a good match exists.

## State Machine Structure

Each state machine file follows a consistent structure:

1. **Module docstring** — states, transitions, verified properties
2. **Inductive types** — `Status`, `Trigger`
3. **Step function** — `def step : Status → Trigger → Option Status`
4. **Predicates** — `isTerminal`, `isActive`, etc.
5. **Theorems** — generic (universally-quantified) where possible

## Naming Conventions

- State types: `Status` (not `State` — avoids shadowing Lean's `State` monad)
- Transition inputs: `Trigger` (not `Action` or `Event`)
- Step functions: `step` (consistent across all machines)
- Predicates: `isTerminal`, `isActive`, `isReady` (lowercase `is` prefix)
- Theorems: descriptive, snake_case (`all_reachable`, `terminal_convergence`, `forward_only`)

## Proof Style

- Prefer `by cases s <;> ...` tactic chains for exhaustive case analysis
- Prefer `simp_all` over manual rewriting where possible
- No `sorry` — all proofs must be complete
- Docstrings on theorems that aren't self-evident from the name
