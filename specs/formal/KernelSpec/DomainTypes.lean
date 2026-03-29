import KernelSpec.Basic

/-!
# Kernel Domain Types

Pure enumerations used across the kernel — single source of truth.
Markdown specs MUST reference these definitions rather than duplicating them.

Types defined here have no state machine semantics (no transition functions).
For types with transitions, see TaskState.lean, SessionState.lean, Orchestrator.lean.

## Types
- **SpanStatus**: Telemetry span execution outcome (Ok/Error/Unset)
- **PolicyDecision**: Guardrail policy engine verdict (Allow/Warn/Deny)
- **UserKind**: Persona classification (Human/Agent/System)
- **AgentKind**: Agent runtime system (ClaudeCode/Codex/Aider/OpenAI/Custom)
- **ActorKind**: Audit trail attribution (Human/Agent)
-/

set_option autoImplicit false

namespace KernelSpec

-- ═══════════════════════════════════════════════════════════════
-- SpanStatus (Telemetry)
-- ═══════════════════════════════════════════════════════════════

/-- Span execution status (Telemetry primitive).
    Ok: completed successfully. Error: failed. Unset: not yet determined. -/
inductive SpanStatus where
  | ok
  | error
  | unset
  deriving DecidableEq

/-- Ok is the unique success state. -/
theorem spanStatus_trichotomy : ∀ s : SpanStatus,
    s = .ok ∨ s = .error ∨ s = .unset := by
  intro s; cases s <;> simp

-- ═══════════════════════════════════════════════════════════════
-- PolicyDecision (Guardrails)
-- ═══════════════════════════════════════════════════════════════

/-- Guardrail policy engine decision.
    Allow: proceed. Warn: proceed but alert. Deny: block. -/
inductive PolicyDecision where
  | allow
  | warn
  | deny
  deriving DecidableEq

/-- Numeric severity: Allow(0) < Warn(1) < Deny(2). -/
def PolicyDecision.severity : PolicyDecision → Nat
  | .allow => 0
  | .warn  => 1
  | .deny  => 2

/-- Deny is the most severe decision. -/
theorem deny_most_severe : ∀ d : PolicyDecision,
    d.severity ≤ PolicyDecision.deny.severity := by
  intro d; cases d <;> simp [PolicyDecision.severity]

/-- Allow is the least severe decision. -/
theorem allow_least_severe : ∀ d : PolicyDecision,
    PolicyDecision.allow.severity ≤ d.severity := by
  intro d; cases d <;> simp [PolicyDecision.severity]

/-- Severity is a total order: for any two decisions, one is at least as severe. -/
theorem severity_total : ∀ (a b : PolicyDecision),
    a.severity ≤ b.severity ∨ b.severity ≤ a.severity := by
  intro a b; cases a <;> cases b <;> simp [PolicyDecision.severity]

-- ═══════════════════════════════════════════════════════════════
-- UserKind
-- ═══════════════════════════════════════════════════════════════

/-- User persona classification.
    Human: interactive user. Agent: LLM persona. System: kernel-internal. -/
inductive UserKind where
  | human
  | agent
  | system
  deriving DecidableEq

-- ═══════════════════════════════════════════════════════════════
-- AgentKind
-- ═══════════════════════════════════════════════════════════════

/-- Agent system classification — which runtime executes a task. -/
inductive AgentKind where
  | claudeCode
  | codex
  | aider
  | openAI
  | custom
  deriving DecidableEq

-- ═══════════════════════════════════════════════════════════════
-- ActorKind (subset of UserKind)
-- ═══════════════════════════════════════════════════════════════

/-- Audit trail attribution — who performed an action. -/
inductive ActorKind where
  | human
  | agent
  deriving DecidableEq

/-- Every ActorKind embeds into UserKind. System is not an actor. -/
def ActorKind.toUserKind : ActorKind → UserKind
  | .human => .human
  | .agent => .agent

/-- The embedding is injective. -/
theorem actorKind_toUserKind_injective : ∀ (a b : ActorKind),
    a.toUserKind = b.toUserKind → a = b := by
  intro a b h; cases a <;> cases b <;> simp_all [ActorKind.toUserKind]

/-- System is not in the image of the actor→user embedding. -/
theorem system_not_actor : ∀ a : ActorKind, a.toUserKind ≠ .system := by
  intro a; cases a <;> simp [ActorKind.toUserKind]

end KernelSpec
