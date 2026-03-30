import KernelSpec.Basic

/-!
# Task Dependency DAG

Formal verification of the task dependency graph properties.
Tasks form a directed acyclic graph via `blocked_by` / `blocking` edges.

Key idea: we use **topological orderings** as certificates of acyclicity.
If a graph has a topological ordering (every edge goes from lower to higher),
then no cycle can exist (a cycle would require some node to be both lower and
higher than itself).

## Verified Properties
- Topological ordering implies acyclicity (no cycles)
- Empty graph is acyclic
- Adding an edge consistent with the ordering preserves acyclicity
- Subgraphs of acyclic graphs are acyclic
- Reachability in subgraphs implies reachability in supergraphs
- Concrete example: 3-task linear pipeline verified acyclic
-/

set_option autoImplicit false

namespace KernelSpec.TaskDAG

/-- A directed graph represented as a list of (source, target) edges.
    Nodes are natural numbers (task indices). -/
abbrev Graph := List (Nat × Nat)

-- ═══════════════════════════════════════════════════════════════
-- Reachability
-- ═══════════════════════════════════════════════════════════════

/-- Node `v` is reachable from `u` in graph `g` via a sequence of edges. -/
inductive Reaches (g : Graph) : Nat → Nat → Prop where
  | edge {u v : Nat} : (u, v) ∈ g → Reaches g u v
  | trans {u w v : Nat} : Reaches g u w → Reaches g w v → Reaches g u v

-- ═══════════════════════════════════════════════════════════════
-- Acyclicity
-- ═══════════════════════════════════════════════════════════════

/-- A graph is acyclic if no node can reach itself. -/
def IsAcyclic (g : Graph) : Prop := ∀ v : Nat, ¬ Reaches g v v

-- ═══════════════════════════════════════════════════════════════
-- Topological Ordering
-- ═══════════════════════════════════════════════════════════════

/-- A topological ordering assigns each node a rank such that
    every edge (u, v) satisfies rank(u) < rank(v). -/
def HasTopologicalOrder (g : Graph) (ord : Nat → Nat) : Prop :=
  ∀ e : Nat × Nat, e ∈ g → ord e.1 < ord e.2

/-- Reachability respects topological order:
    if u reaches v, then ord(u) < ord(v). -/
theorem reaches_respects_order (g : Graph) (ord : Nat → Nat)
    (h : HasTopologicalOrder g ord) (u v : Nat) (hr : Reaches g u v) :
    ord u < ord v := by
  induction hr with
  | edge hmem => exact h _ hmem
  | trans _ _ ih1 ih2 => exact Nat.lt_trans ih1 ih2

/-- **Core theorem**: A topological ordering implies acyclicity.
    Proof: a cycle v → ... → v would require ord(v) < ord(v), contradicting irreflexivity. -/
theorem topological_order_implies_acyclic (g : Graph) (ord : Nat → Nat)
    (h : HasTopologicalOrder g ord) : IsAcyclic g := by
  intro v hcycle
  have := reaches_respects_order g ord h v v hcycle
  omega

-- ═══════════════════════════════════════════════════════════════
-- Empty Graph
-- ═══════════════════════════════════════════════════════════════

/-- The empty graph has a (trivial) topological ordering. -/
theorem empty_has_topological_order :
    HasTopologicalOrder ([] : Graph) (fun n => n) := by
  intro e hmem
  nomatch hmem

/-- The empty graph is acyclic. -/
theorem empty_acyclic : IsAcyclic ([] : Graph) :=
  topological_order_implies_acyclic [] (fun n => n) empty_has_topological_order

-- ═══════════════════════════════════════════════════════════════
-- Adding Edges
-- ═══════════════════════════════════════════════════════════════

/-- Adding an edge (u, v) preserves the topological ordering
    when ord(u) < ord(v). This is the formal justification for
    the cycle-check in add_dependency: before adding a dependency
    from blocker to blocked, verify ord(blocker) < ord(blocked). -/
theorem add_edge_preserves_order (g : Graph) (ord : Nat → Nat) (u v : Nat)
    (h : HasTopologicalOrder g ord) (hlt : ord u < ord v) :
    HasTopologicalOrder ((u, v) :: g) ord := by
  intro e hmem
  cases hmem with
  | head => exact hlt
  | tail _ htail => exact h e htail

/-- Corollary: adding a consistent edge to an acyclic graph preserves acyclicity. -/
theorem add_edge_preserves_acyclic (g : Graph) (ord : Nat → Nat) (u v : Nat)
    (h : HasTopologicalOrder g ord) (hlt : ord u < ord v) :
    IsAcyclic ((u, v) :: g) :=
  topological_order_implies_acyclic _ ord (add_edge_preserves_order g ord u v h hlt)

-- ═══════════════════════════════════════════════════════════════
-- Subgraph Monotonicity
-- ═══════════════════════════════════════════════════════════════

/-- Reachability in a subgraph implies reachability in the supergraph. -/
theorem reaches_subgraph (g' g : Graph) (hsub : ∀ e : Nat × Nat, e ∈ g' → e ∈ g)
    (u v : Nat) (h : Reaches g' u v) : Reaches g u v := by
  induction h with
  | edge hmem => exact .edge (hsub _ hmem)
  | trans _ _ ih1 ih2 => exact .trans ih1 ih2

/-- Removing edges from an acyclic graph preserves acyclicity. -/
theorem subgraph_acyclic (g g' : Graph) (hsub : ∀ e : Nat × Nat, e ∈ g' → e ∈ g)
    (hac : IsAcyclic g) : IsAcyclic g' := by
  intro v hcycle
  exact hac v (reaches_subgraph g' g hsub v v hcycle)

/-- Removing an edge preserves the topological ordering. -/
theorem remove_edge_preserves_order (g : Graph) (ord : Nat → Nat) (u v : Nat)
    (h : HasTopologicalOrder ((u, v) :: g) ord) :
    HasTopologicalOrder g ord := by
  intro e hmem
  exact h e (List.mem_cons_of_mem _ hmem)

-- ═══════════════════════════════════════════════════════════════
-- Ready Tasks (no incoming dependency edges)
-- ═══════════════════════════════════════════════════════════════

/-- A task is ready if it has no incoming edges (no unresolved blockers). -/
def IsReady (g : Graph) (task : Nat) : Prop :=
  ∀ blocker : Nat, (blocker, task) ∉ g

/-- Every node in the empty graph is ready. -/
theorem empty_all_ready : ∀ task : Nat, IsReady ([] : Graph) task := by
  intro task blocker hmem
  nomatch hmem

-- ═══════════════════════════════════════════════════════════════
-- Concrete Example: 3-task linear pipeline
-- Tasks: 0 → 1 → 2 (task 0 blocks 1, task 1 blocks 2)
-- ═══════════════════════════════════════════════════════════════

/-- The linear pipeline 0 → 1 → 2 -/
def pipeline : Graph := [(0, 1), (1, 2)]

/-- The identity function serves as a topological ordering for the pipeline. -/
theorem pipeline_has_order : HasTopologicalOrder pipeline (fun n => n) := by
  intro ⟨a, b⟩ hmem
  simp [pipeline] at hmem
  rcases hmem with ⟨rfl, rfl⟩ | ⟨rfl, rfl⟩ <;> decide

/-- The pipeline is acyclic. -/
theorem pipeline_acyclic : IsAcyclic pipeline :=
  topological_order_implies_acyclic pipeline (fun n => n) pipeline_has_order

/-- Task 0 is ready (no incoming edges). -/
theorem pipeline_task0_ready : IsReady pipeline 0 := by
  intro blocker hmem
  simp [pipeline] at hmem

/-- After completing task 0 (removing its outgoing edges),
    task 1 becomes ready. Modeled as the subgraph [(1, 2)]. -/
def pipelineAfterTask0 : Graph := [(1, 2)]

theorem pipeline_after_task0_acyclic : IsAcyclic pipelineAfterTask0 :=
  subgraph_acyclic pipeline pipelineAfterTask0
    (by intro e hmem; simp [pipelineAfterTask0] at hmem; simp [pipeline]; right; exact hmem)
    pipeline_acyclic

theorem pipeline_task1_ready_after_task0 : IsReady pipelineAfterTask0 1 := by
  intro blocker hmem
  simp [pipelineAfterTask0] at hmem

end KernelSpec.TaskDAG
