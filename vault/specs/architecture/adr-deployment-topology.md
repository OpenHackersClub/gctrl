# ADR: Deployment topology + the durability ceiling

**Status**: proposed (names two tensions; commits to a direction, defers the build)
**Scope**: kernel daemon, sync, scheduler, orchestrator
**Drives**: future `vault/specs/architecture/kernel/*` work; `gctrl/ROADMAP.md`

## Context

Analysis of Centaur (Paradigm / Tempo, May 2026 — a self-hosted *team* agent
runtime) surfaced two architectural tensions in gctrl that the "AI-native team
OS" pivot (`gctrl/PRD.md`) had left implicit. Both are foundational, not
incidental — they follow from early, deliberate choices and deserve to be named
rather than papered over.

### Tension 1 — Stateful singleton kernel vs. the multiplayer vision

Centaur's architecture: **every service is stateless; Postgres is the single
source of truth.** Any service restarts freely; writers scale horizontally;
Postgres arbitrates concurrency.

gctrl's architecture is the inverse: **a stateful singleton daemon.** One
`gctrld` process holds the DuckDB single-writer lock, owns the file watchers,
the event bus, and the projection writers. This is *correct* and differentiating
for local-first single-user / small-team-on-one-box — it is why gctrl runs
offline with zero infra.

But the pivot's headline is "3 humans + 30 agents." Centaur shows what *team*
demands structurally: a deployed server, a shared DB the writers contend on,
per-user isolation, org-level secrets. gctrl's current answer to "team" is the
**sync layer** (D1/R2 edge replicas) — but that is read-scale-out. The *write
path still funnels through one daemon holding one lock.* Thirty concurrent
sessions all projecting inbox messages and board mutations contend on a single
SQLite writer on one machine.

The honest question: **is gctrl a personal agent-OS that syncs, or a team
agent-server?** Those are different products with different kernels. Today's
desktop-sidecar topology is the former; the marketing is the latter.

### Tension 2 — Agent-agnosticism caps durability at the orchestration layer

Centaur **owns the agent runtime**, so it checkpoints every workflow step to
Postgres and resumes after a crash without redoing work.

gctrl is **agent-agnostic** — it observes any agent via OTel spans and does not
own the agent's internal loop. Therefore gctrl *cannot* checkpoint the agent's
reasoning/conversation state the way Centaur can. A crash 90 minutes into a long
autonomous session loses the in-flight work; the scheduler only reaps the run as
failed (`gctrl-scheduler/src/runner.rs:70`).

This bites precisely because the pivot says sessions run "minutes to hours+" and
agents work "like employees." An employee does not restart their whole day on a
power blip. Agent-agnosticism buys portability (any agent that emits spans) at
the cost of resumability.

## Decision

1. **Name two topologies; do not pretend one covers both.**
   - **Personal (local-first):** the current desktop-sidecar singleton. Default.
     Sync is for the *same user's* devices and edge read replicas.
   - **Team (deployed server):** a deployed multi-tenant kernel where the
     singleton-lock assumption is replaced. Postgres (or a server-grade store)
     as source of truth; stateless shell/app services; per-user auth and thread
     isolation. **Not built yet** — this ADR commits to treating it as a
     first-class second topology rather than assuming D1/R2 sync papers over the
     single-writer bottleneck.

   Sync remains the bridge (a personal kernel can sync into a team kernel), but
   the team write path must not funnel through one SQLite writer.

2. **Durability is bounded at the orchestration layer — say so.** gctrl will
   checkpoint **orchestration** state (which task, which retry, which sub-goal
   completed) so a crash resumes at the last task boundary. gctrl will **not**
   attempt to checkpoint agent-internal reasoning — that is the runtime's job.
   Where an agent provides its own resume (e.g. Claude Code session resume),
   gctrl re-attaches to it at the orchestration boundary rather than
   reconstructing it. "Agent-agnostic" and "resumes the agent's train of
   thought" are mutually exclusive; we keep agnosticism and accept the ceiling.

## Consequences

- **Positive:** the local-first differentiator is protected; the team story gets
  an honest architecture instead of an implicit scaling cliff; the durability
  contract is explicit, so nobody designs a 3-hour autonomous workflow assuming
  mid-session resume that cannot exist.
- **Negative / cost:** a second topology is real engineering (auth, multi-tenant
  store, stateless services). It is deferred, not free. Until it exists, "team"
  at scale means "one beefy shared host running the singleton," with the
  single-writer lock as the known ceiling.
- **Follow-ups:** orchestration-layer checkpointing slice in `gctrl/ROADMAP.md`;
  a `kernel/server-topology.md` design when the team topology is scheduled.

## References

- `gctrl/PRD.md` — "3 humans + 30 agents"; the team operating model.
- `gctrl-scheduler/src/runner.rs:70` — current crash handling (reap, not resume).
- `vault/specs/architecture/kernel/sync.md` — D1/R2 sync (the current "team" answer).
- `vault/specs/comparison.md § gctrl vs. Centaur` — stateless-services contrast.
- Centaur (Paradigm / Tempo, May 2026) — stateless services + Postgres source of
  truth; runtime-owned durable workflow checkpointing.
