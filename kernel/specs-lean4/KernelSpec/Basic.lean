/-!
# Basic Definitions

Shared infrastructure for state machine verification:
- `trace`: execute a sequence of triggers on a state machine
- `Reachable`: existential witness of a valid trace
- `IsTerminalState`: no outgoing transitions
-/

set_option autoImplicit false

namespace KernelSpec

/-- Execute a sequence of triggers against a state machine step function.
    Returns `some finalState` if every trigger produced a valid transition,
    `none` if any trigger was invalid in the current state. -/
def trace {S T : Type} (step : S → T → Option S) : S → List T → Option S
  | s, [] => some s
  | s, t :: ts =>
    match step s t with
    | some s' => trace step s' ts
    | none => none

/-- A target state is reachable from an initial state if there exists
    a finite sequence of triggers that transforms init into target. -/
def Reachable {S T : Type} (step : S → T → Option S) (init target : S) : Prop :=
  ∃ ts : List T, trace step init ts = some target

/-- A state is terminal if no trigger produces a valid transition. -/
def IsTerminalState {S T : Type} (step : S → T → Option S) (s : S) : Prop :=
  ∀ t : T, step s t = none

end KernelSpec
