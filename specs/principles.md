# Core Beliefs and Invariants

Foundational invariants that all agents and contributors MUST respect. These are non-negotiable constraints that govern how gctl is built and extended.

## Unix Philosophy

gctl follows the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy). These are not aspirational — they are design constraints that govern every decision.

1. **Build modular programs.** The kernel provides small, focused primitives (telemetry, storage, guardrails, orchestrator). Applications and utilities are separate, independently deployable modules. No primitive SHOULD know about any other primitive's internals.
2. **Write readable programs.** Code MUST be written for the next reader, not the original author. Prefer explicit over clever. Name things after what they do in the domain, not after implementation details.
3. **Use composition.** Utilities SHOULD do one thing well and compose via stdin/stdout where practical. Applications orchestrate utilities and kernel primitives through the shell. Prefer pipelines of small tools over monolithic features. `gctl net fetch | gctl eval score` is better than a single command that fetches and scores.
4. **Separate mechanisms from policy.** The kernel provides *mechanisms* (store spans, enforce limits, dispatch agents). *Policy* lives in configuration, WORKFLOW.md, and application logic. The kernel MUST NOT hardcode what "good" looks like — that is the application's job.
5. **Write simple programs.** Each crate, command, and driver SHOULD have a one-sentence description. If you cannot explain what it does simply, it does too much. Prefer boring, obvious code over elegant abstractions.
6. **Write small programs.** The kernel is intentionally small — four core primitives. Extensions are feature-gated. Applications are optional. Adapters are optional. A solo developer running `gctl serve` gets a working system. Complexity is opt-in, not opt-out.
7. **Write transparent programs.** Every state transition, dispatch decision, and failure MUST be observable. Structured telemetry for the orchestrator. Structured logs for the kernel. `gctl status` MUST give a clear picture of what is happening and why.
8. **Write robust programs.** Prefer crashing with a clear error over silently continuing in a bad state. Orchestrator retry and reconciliation recover from transient failures. Storage uses DuckDB transactions. Tests run against real adapters (`:memory:` DuckDB, `tempfile` workspaces), not mocks.
9. **Make data complicated when required, not the program.** DuckDB schema, WORKFLOW.md frontmatter, and driver configs carry the complexity. The programs that read them stay simple. Prefer rich data models with simple processing over simple data with complex processing.
10. **Build on potential users' expected knowledge.** gctl's CLI follows conventions developers already know: `gctl <noun> <verb>`, `--format json`, exit codes, stdin/stdout piping. Adapters use the terminology of the tools they connect to (Linear "issues", GitHub "pull requests", Obsidian "vaults"). MUST NOT invent jargon when existing terms work.
11. **Avoid unnecessary output.** Commands MUST NOT print noise on success. Structured output (JSON, tables) for machines. Human-readable summaries for terminals. Verbose/debug output behind `--verbose` or `RUST_LOG`. Errors go to stderr.
12. **Write programs which fail in a way that is easy to diagnose.** Error messages MUST include what went wrong, which input caused it, and what to do next. `gctl orchestrate dispatch BACK-42` failing MUST say *why* (no slots, blocked, not eligible) — not just "dispatch failed".
13. **Value developer time over machine time.** Fast feedback loops: `cargo test` in seconds, `gctl status` instant. Caching in the shell (HTTP responses, query results). DuckDB for zero-setup storage. No external services required for local development.
14. **Write abstract programs that generate code instead of writing code by hand.** WORKFLOW.md prompt templates generate per-issue agent prompts. Schema migrations generate DDL. Adapters are configured declaratively, not coded imperatively. Prefer configuration and templates over bespoke code for each new integration.
15. **Prototype software before polishing it.** Ship working code, then refine. Feature-gated crates allow incomplete implementations to exist without blocking the rest. Stub crates (`gctl-proxy`, `gctl-sync`) are acceptable — an empty module with a clear interface is better than no module.
16. **Write flexible and open programs.** gctl connects to the tools you already use (Linear, Notion, Obsidian, Arize Phoenix, etc.) via drivers, not replacement. Zero drivers = standalone. The kernel MUST NOT assume which applications or external tools are present.
17. **Make the program and protocols extensible.** The extension model is explicit: storage namespaces, CLI subcommand registration, HTTP route mounting, event subscriptions, kernel interface traits. Adding a new application or driver MUST NOT require modifying the kernel. WORKFLOW.md frontmatter ignores unknown keys for forward compatibility.

## Design Principles

These apply the Unix philosophy to gctl's specific architecture.

1. **Kernel MUST remain stable; applications evolve fast.** The telemetry format, storage schema, and shell interfaces MUST change rarely. Applications and utilities MAY ship, iterate, and break independently.
2. **Applications MUST share primitives, not state.** Apps read from the same DuckDB but MUST own their table namespaces (`board_*`, `eval_*`, `capacity_*`). Cross-app data MUST flow through kernel IPC (domain events, shell APIs, pipes), not direct table joins.
3. **Local-first, cloud-optional.** The kernel MUST work fully offline. Cloud sync (R2) is opt-in. Applications and utilities inherit this property automatically.
4. **Every application and driver MUST be optional.** A developer using gctl only for telemetry + guardrails MUST NOT see project management UI or capacity planning commands. Feature-gated compilation for Rust; package-level opt-in for TS. Zero drivers = gctl works standalone.
5. **Agents are first-class users of the shell.** Applications and utilities MUST expose CLI and HTTP interfaces that agents can call directly. MUST NOT have browser-only UIs — every feature MUST be automatable.
6. **Shell-first interaction model.** All operations — local and external — SHOULD go through the shell (CLI or HTTP API). This creates a single audit log, caching layer, and policy enforcement point.
7. **Adapt, don't replace.** External tools (Linear, Notion, Phoenix, etc.) are applications installed on the OS, connected via drivers implementing kernel interface traits (`TrackerPort`, `ObservabilityExportPort`, etc.). Shipped native applications (gctl-board, Observe & Eval) are defaults, not mandates.
8. **Malleable by design.** gctl MUST be software that users can adapt to their own needs with minimal friction, following the [malleable software](https://www.inkandswitch.com/essay/malleable-software/) philosophy. Anyone — developer or agent — SHOULD be able to customize gctl's behavior by updating prompts (AGENTS.md) or swapping modularized implementation components, without forking or deep code surgery. Terminal-based coding agents (Claude Code, Aider, OpenCode) are the built-in customization tool — prompts are the first-class extension surface.

## Vendor Independence

1. **Minimal vendor lock-in.** gctl MUST avoid deep coupling to proprietary platforms or APIs. Prefer open standards and protocols over vendor-specific SDKs. Where a vendor dependency exists, isolate it behind a kernel interface trait so it can be swapped without modifying the kernel or applications.
2. **Prefer MIT-licensed, open-source dependencies.** When choosing between equivalent tools, libraries, or services, prefer MIT (or similarly permissive) licensed open-source options. Copyleft and proprietary dependencies SHOULD be avoided unless no viable open-source alternative exists.
3. **OpenTelemetry as the telemetry standard.** gctl MUST use OpenTelemetry (OTLP) as the telemetry protocol. MUST NOT introduce proprietary tracing or metrics formats. Any agent or service that emits OTel spans is a first-class citizen — this is the protocol-level integration point, not a vendor SDK.
4. **Minimize dependencies to reduce supply chain attack surface.** Every dependency is a trust decision — prefer fewer, well-audited crates/packages over convenient but heavyweight ones. New dependencies MUST be justified by necessity, not convenience. Cargo.lock and package lock files MUST be committed and pinned. Builds MUST be reproducible: the same source + lock file MUST produce the same binary. Prefer dependencies with small transitive trees, active maintenance, and auditable source. Run `cargo audit` (Rust) and `npm audit` / `pnpm audit` (TS) in CI. MUST NOT pull in dependencies that themselves have unbounded transitive dependency trees without explicit review.

## Architectural Invariants

1. **Dependencies MUST flow inward: Shell → Kernel → Domain, never reverse.** The domain layer (`gctl-core`) MUST have zero I/O dependencies. Kernel implementations depend on trait interfaces, never the other way around. Applications depend on the shell, not on kernel internals directly.
2. **DuckDB is single-writer.** The server MUST hold the write lock. CLI query commands MUST use `--db` to point to a different DB file or use the HTTP API when the server is running.
3. **Application tables MUST use namespaced prefixes.** All application tables MUST be prefixed with their app name (`board_*`, `eval_*`, `capacity_*`). No un-prefixed application tables.
4. **Kernel MUST NOT make assumptions about applications.** It captures telemetry, stores data, enforces safety, and provides primitives. What you do with that — through the shell — is the application and utility layer's job.
5. **Shell MUST mediate all external access to the kernel.** Agents and applications MUST interact with kernel primitives through CLI commands or HTTP API, never by importing kernel crates directly (except Rust apps compiled into the binary).

## Crate Ownership

When modifying code, respect crate boundaries:

1. Types, traits, and config changes MUST go in `gctl-core`.
2. Storage schema changes MUST go in `gctl-storage/src/schema.rs`.
3. New CLI commands MUST go in `gctl-cli/src/commands/`.
4. New guardrail policies MUST go in `gctl-guardrails/src/policies.rs`.
5. New application tables MUST use namespaced prefixes.

## Effect-TS Invariants

1. **MUST NOT access `._tag` directly.** Use proper Effect-TS combinators:
   - `Effect.catchTag` / `Effect.catchTags` for error handling
   - `Match.tag` + `Match.exhaustive` for pattern matching
   - `Schema.TaggedError` / `Schema.TaggedClass` for defining tagged types
   - `Exit.match`, `Either.match`, `Option.match` for branching
2. **MUST follow idiomatic Effect-TS:** use `pipe`/generators (`Effect.gen`), Layer composition, and built-in combinators instead of imperative escape hatches.

## Testing Invariants

1. Every new public function MUST have at least one test.
2. Storage tests MUST use `:memory:` DuckDB — no file I/O in tests.
3. OTel tests MUST use `axum::test` with `tower::ServiceExt::oneshot`.
4. Contributors MUST run `cargo test` before committing.

## Git Workflow

1. Contributors MUST use feature branches — MUST NOT push directly to main.
2. Contributors MUST NOT force push to main nor merge with `--admin`.
