import KernelSpec.Basic

/-!
# Run Attempt Lifecycle

Models a single dispatch attempt's execution pipeline:
  PreparingWorkspace → BuildingPrompt → LaunchingAgent → StreamingWork → Finishing → Succeeded
  (with failure/timeout/cancel exits at each stage)

Each run attempt is a single agent process execution.
The Orchestrator creates a new run attempt for each dispatch or retry.

## Verified Properties
- All phases reachable from PreparingWorkspace
- Succeeded, Failed, TimedOut, Canceled are terminal
- Terminal convergence: every phase reaches a terminal state
- Always-forward progress: every transition increases phase ordering
-/

set_option autoImplicit false

namespace KernelSpec.RunAttempt

inductive Phase where
  | preparingWorkspace
  | buildingPrompt
  | launchingAgent
  | streamingWork
  | finishing
  | succeeded
  | failed
  | timedOut
  | canceled
  deriving DecidableEq

inductive Trigger where
  | workspaceReady
  | hookFailed
  | promptReady
  | templateError
  | agentStarted
  | agentNotFound
  | workDone
  | stallTimeout
  | reconciliation
  | exitClean
  | exitError
  deriving DecidableEq

open Phase Trigger

/-- Run attempt transition function -/
def step : Phase → Trigger → Option Phase
  | preparingWorkspace, workspaceReady => some buildingPrompt
  | preparingWorkspace, hookFailed     => some failed
  | buildingPrompt,     promptReady    => some launchingAgent
  | buildingPrompt,     templateError  => some failed
  | launchingAgent,     agentStarted   => some streamingWork
  | launchingAgent,     agentNotFound  => some failed
  | streamingWork,      workDone       => some finishing
  | streamingWork,      stallTimeout   => some timedOut
  | streamingWork,      reconciliation => some canceled
  | finishing,          exitClean      => some succeeded
  | finishing,          exitError      => some failed
  | _, _                               => none

-- ═══════════════════════════════════════════════════════════════
-- Terminal States
-- ═══════════════════════════════════════════════════════════════

theorem succeeded_terminal : KernelSpec.IsTerminalState step succeeded := by
  intro t; cases t <;> rfl

theorem failed_terminal : KernelSpec.IsTerminalState step failed := by
  intro t; cases t <;> rfl

theorem timedOut_terminal : KernelSpec.IsTerminalState step timedOut := by
  intro t; cases t <;> rfl

theorem canceled_terminal : KernelSpec.IsTerminalState step canceled := by
  intro t; cases t <;> rfl

-- ═══════════════════════════════════════════════════════════════
-- Reachability (all phases from PreparingWorkspace)
-- ═══════════════════════════════════════════════════════════════

theorem all_reachable : ∀ p : Phase, KernelSpec.Reachable step preparingWorkspace p := by
  intro p; cases p
  · exact ⟨[], rfl⟩
  · exact ⟨[workspaceReady], rfl⟩
  · exact ⟨[workspaceReady, promptReady], rfl⟩
  · exact ⟨[workspaceReady, promptReady, agentStarted], rfl⟩
  · exact ⟨[workspaceReady, promptReady, agentStarted, workDone], rfl⟩
  · exact ⟨[workspaceReady, promptReady, agentStarted, workDone, exitClean], rfl⟩
  · exact ⟨[hookFailed], rfl⟩
  · exact ⟨[workspaceReady, promptReady, agentStarted, stallTimeout], rfl⟩
  · exact ⟨[workspaceReady, promptReady, agentStarted, reconciliation], rfl⟩

-- ═══════════════════════════════════════════════════════════════
-- Terminal Convergence
-- ═══════════════════════════════════════════════════════════════

def isTerminal : Phase → Bool
  | succeeded => true
  | failed    => true
  | timedOut  => true
  | canceled  => true
  | _         => false

theorem terminal_convergence : ∀ p : Phase, ∃ p' : Phase,
    KernelSpec.Reachable step p p' ∧ isTerminal p' = true := by
  intro p; cases p
  · exact ⟨failed, ⟨[hookFailed], rfl⟩, rfl⟩                            -- preparingWorkspace
  · exact ⟨failed, ⟨[templateError], rfl⟩, rfl⟩                          -- buildingPrompt
  · exact ⟨failed, ⟨[agentNotFound], rfl⟩, rfl⟩                          -- launchingAgent
  · exact ⟨timedOut, ⟨[stallTimeout], rfl⟩, rfl⟩                         -- streamingWork
  · exact ⟨succeeded, ⟨[exitClean], rfl⟩, rfl⟩                           -- finishing
  · exact ⟨succeeded, ⟨[], rfl⟩, rfl⟩                                    -- succeeded
  · exact ⟨failed, ⟨[], rfl⟩, rfl⟩                                       -- failed
  · exact ⟨timedOut, ⟨[], rfl⟩, rfl⟩                                     -- timedOut
  · exact ⟨canceled, ⟨[], rfl⟩, rfl⟩                                     -- canceled

-- ═══════════════════════════════════════════════════════════════
-- Always-Forward Progress
-- Every valid transition strictly increases phase ordering.
-- This guarantees run attempts cannot loop and always terminate.
-- ═══════════════════════════════════════════════════════════════

/-- Numeric ordering on phases. Every transition increases this value,
    which proves the pipeline is a DAG (no cycles possible). -/
def phaseOrd : Phase → Nat
  | preparingWorkspace => 0
  | buildingPrompt     => 1
  | launchingAgent     => 2
  | streamingWork      => 3
  | finishing          => 4
  | succeeded          => 5
  | failed             => 6
  | timedOut           => 7
  | canceled           => 8

theorem always_forward : ∀ (p p' : Phase) (t : Trigger),
    step p t = some p' → phaseOrd p < phaseOrd p' := by
  intro p p' t h
  cases p <;> cases t <;> cases p' <;> simp_all [step, phaseOrd]

-- Happy path is the linear pipeline
theorem happy_path :
    KernelSpec.Reachable step preparingWorkspace succeeded :=
  ⟨[workspaceReady, promptReady, agentStarted, workDone, exitClean], rfl⟩

end KernelSpec.RunAttempt
