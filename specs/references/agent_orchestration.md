# AI Coding Agent Internals Reference

Comparing **Claude Code**, **OpenAI Codex CLI**, and **OpenCode** across six architectural dimensions:
process management, memory, sockets/IPC, sandboxing, OpenTelemetry, and cross-agent communications.

---

## Overview

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| **Language** | Node.js (TypeScript) | Rust (Tokio async) | TypeScript/Bun |
| **Interface** | CLI + IDE extensions | CLI / TUI / MCP server | CLI + TUI (Rust) + desktop (Tauri) |
| **Model** | Claude (Anthropic) | OpenAI (o-series, codex-mini) | Any (configurable via opencode.json) |
| **MCP Role** | Client + subagents | Client **and** server (`codex mcp-server`) | Client only |
| **Repo** | Closed-source | `github.com/openai/codex` | `github.com/sst/opencode` |

---

## 1. Process Management

### Claude Code

- Commands run in **isolated subprocesses** via the sandboxed `Bash` tool — no persistent shell session between invocations.
- Each command gets a **fresh shell** (inherits user environment); shell state (e.g. `cd`, exported vars) does not carry over.
- `CLAUDE_ENV_FILE` can be set to inject environment updates (e.g. via `direnv`) between commands.
- Lifecycle hooks fire around each tool call: `PreToolUse` (block/validate) → execution → `PostToolUse` / `PostToolUseFailure`.
- **Git worktrees** provide parallel session isolation; each worktree is an independent cwd with its own shell context. `WorktreeRemove` hook fires on cleanup.
- No persistent daemon — the process lives only for the duration of the CLI invocation.

### Codex CLI

- Tokio-async Rust binary; shell commands executed via `tokio::process::Child` (`spawn_child_async` in `codex-rs/core/src/spawn.rs`).
- Core abstraction: `ExecRequest` carrying command, cwd, env, sandbox type, network proxy config, and expiration policy.
- Two capture modes:
  - `ShellTool` — output capped at ~256 KB, 10-second default timeout, hard kill on expiry.
  - `FullBuffer` — trusted internal helpers, no cap, no timeout.
- On timeout: child **and its entire process group** killed via `kill_child_process_group`; 2-second I/O drain guard after kill.
- `codex exec` subcommand is the headless/non-interactive entrypoint.

### OpenCode

- `bash` tool (`src/tool/bash.ts`) uses Node.js `child_process.spawn()` with `shell: true`, `detached: true` (non-Windows), `stdio: ['ignore', 'pipe', 'pipe']`.
- Shell resolved via `Shell.acceptable()` / `Shell.preferred()`; commands pre-parsed with **tree-sitter** (WASM) before spawn for permission checks.
- Default timeout: 2 minutes (`OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`). Process group killed on abort.
- **PTY system** via `bun-pty` (`src/pty/index.ts`): interactive terminal sessions with 2 MB output buffer, multiplexed to WebSocket subscribers.

### Comparison

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Shell execution | Fresh subprocess per call | `tokio::process::Child` | `child_process.spawn` |
| Shell state persistence | None (stateless) | None (stateless) | None (stateless) |
| Timeout/kill | OS-level signal | Kill process group + drain | Kill process group |
| PTY support | No | No | Yes (bun-pty + WebSocket) |
| Parallel isolation | Git worktrees | Multiple sessions | Multiple sessions (SQLite) |

---

## 2. Memory / Context Management

### Claude Code

Two-tier file-based system:

**CLAUDE.md (persistent instructions)**
- Loaded at session start from: managed policy → project `.claude/CLAUDE.md` → user `~/.claude/CLAUDE.md`.
- Re-injected fresh after context compaction; imported via `@path/to/file` syntax (5-hop recursion limit).
- Scoped rules possible via `.claude/rules/` subdirectory.

**Auto-memory (learned state)**
- Stored at `~/.claude/projects/<project-hash>/memory/`; `MEMORY.md` index loaded at startup (first 200 lines only).
- Topic files written by Claude during session; loaded on-demand.
- Survives session restarts; shared across all worktrees in the same git repo.

**Context compaction**
- Triggered at ~95% context window usage (`CLAUDE_AUTO_COMPACT_PCT_OVERRIDE` to tune).
- Clears old tool outputs, summarizes conversation, re-reads CLAUDE.md from disk.
- `PreCompact` / `PostCompact` hooks available.

### Codex CLI

**In-session context** (`ContextManager` in `core/src/context_manager/history.rs`):
- `Vec<ResponseItem>` ordered oldest-first; normalized and image-stripped per model input modality.
- Token usage tracked via byte-based heuristics.

**Cross-session memory pipeline** (`core/src/memories/`):
- Phase 1 — raw extraction: scans up to 5,000 session rollouts (JSONL); extracts memories via `gpt-5.1-codex-mini` (low reasoning, concurrency 8); writes `~/.codex/memories/raw_memories.md`.
- Phase 2 — consolidation: `gpt-5.3-codex` (medium reasoning) produces `memory_summary.md`; injected into future sessions (5,000-token cap).
- Job ownership via **SQLite-backed global lock** (1-hour lease, 1-hour retry backoff).
- Session rollouts persisted as JSONL; SQLite state DB path configurable via `CODEX_SQLITE_HOME`.

### OpenCode

- **SQLite via Drizzle ORM** (`src/storage/db.ts`): `~/.local/share/opencode/opencode.db`, WAL mode, NORMAL sync, 5-second busy timeout.
- Sessions, messages, and tool parts all persisted in SQLite; filesystem JSON fallback under `~/.local/share/opencode/storage/`.
- Session hierarchy: parent-child tree via `parentID`/`childID`; fork creates new session from snapshot.
- **Context compaction**: hidden `compaction` agent runs automatically when context grows too large; AI-driven summarization injected back into session.

### Comparison

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Persistence format | Markdown files | JSONL + SQLite | SQLite (Drizzle) |
| Instruction injection | CLAUDE.md (file-based) | memory_summary.md (LLM-generated) | None (config only) |
| Memory extraction | Manual (Claude writes files) | Automated 2-phase LLM pipeline | None |
| Compaction trigger | ~95% context | Memory pipeline at startup | AI-driven agent |
| Token budget for memory | 200 lines MEMORY.md index | 5,000 tokens summary | Unbounded (until compaction) |

---

## 3. Sockets / IPC

### Claude Code

- **No Unix domain sockets** — team coordination is entirely file-based.
- Agent teams use a shared task list at `~/.claude/tasks/{team-name}/` with **file locks** to prevent race conditions when multiple teammates claim tasks.
- **Mailbox system**: message delivery between teammates via filesystem; lead notified on teammate completion without polling.
- `SendMessage` tool: delivers a message to a named agent by ID; resumes stopped subagents in background.
- **MCP connections**: stdio, HTTP, SSE, or WebSocket depending on MCP server configuration.

### Codex CLI

- **MCP server mode** (`codex mcp-server`): JSON-RPC over **stdin/stdout** (newline-delimited). Tokio `mpsc` channel (capacity 128) separates stdin reader from processor; processor writes to stdout via unbounded channel.
- **Network proxy** (`codex-network-proxy`): opens **loopback TCP listeners** (HTTP proxy + optional SOCKS5) at startup. Child processes receive addresses via `HTTP_PROXY` / `HTTPS_PROXY` env vars.
- No Unix domain sockets in hot paths.

### OpenCode

- Runs a **Bun HTTP server** (Hono) on TCP (starts at port 4096, falls back to OS ephemeral).
- **SSE event stream** (`GET /event`): publishes all `Bus` events (session updates, tool calls, PTY output) with 10-second heartbeat.
- **PTY WebSocket** (`GET /pty/:id/connect`): bidirectional PTY interaction.
- **mDNS discovery** (`MDNS.publish`): announces service over Bonjour when not on loopback — enables mobile/desktop clients to connect without manual port config.
- `WorkspaceRouterMiddleware`: routes requests to different worktree instances via `x-opencode-workspace` header.
- Control plane (`src/control-plane/adaptors/worktree.ts`): multi-worktree proxy routes requests in-process via `Server.Default().fetch(request)`.

### Comparison

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Primary IPC | File-based (tasks, mailbox) | stdio JSON-RPC (MCP mode) | HTTP/SSE/WebSocket |
| Unix sockets | None | None | None |
| Network proxy | HTTPS proxy (configurable) | Loopback TCP (auto-injected) | None built-in |
| Service discovery | None | None | mDNS (Bonjour) |
| Real-time events | File polling / hooks | Tokio channels | SSE stream |

---

## 4. Sandbox

### Claude Code

**OS-level isolation**:
- **macOS**: Apple Seatbelt (`sandbox-exec`)
- **Linux / WSL2**: bubblewrap namespaces
- Filesystem write scope defaults to cwd + subdirectories; configurable via `sandbox.filesystem.allowWrite` / `denyWrite` / `allowRead` / `denyRead`.

**Network isolation**:
- Allowlist of approved domains; new requests trigger permission prompts.
- `allowManagedDomainsOnly` to auto-deny unlisted domains.
- Custom proxy with HTTPS decryption via `httpProxyPort` / `socksProxyPort`.

**Permission modes**:

| Mode | Behavior |
|---|---|
| `default` | Prompt for edits and bash |
| `acceptEdits` | Auto-accept file edits; prompt for bash |
| `dontAsk` | Auto-deny all prompts (explicit allow rules still work) |
| `bypassPermissions` | Skip all prompts (`.git`/`.claude` still protected) |
| `plan` | Read-only exploration |
| `auto` | Inference-based classifier evaluates each call |

**Subagent tool restrictions**: `tools: [...]` allowlist or `disallowedTools: [...]` denylist per subagent.

### Codex CLI

**Three platform backends**:

- **macOS**: `MacosSeatbelt` — `sandbox-exec` with embedded SBPL policy. Three modes: `read-only`, `workspace-write` (writes scoped to cwd + `~/.codex/memories`), `danger-full-access`.
- **Linux**: `codex-linux-sandbox` helper binary using **bubblewrap** (filesystem namespaces) + **seccomp** (network syscall filter). Policies serialized as JSON, passed as CLI args.
- **Windows**: Restricted-token backend (deny-write overlay) + optional Windows Sandbox full isolation; `windows_sandbox_private_desktop` flag for desktop isolation.

**Network sandbox**: separate `codex-network-proxy` crate; HTTP/SOCKS5 MITM proxy on loopback; proxy env vars injected into child environment.

**CLI flags**: `--sandbox read-only | workspace-write | danger-full-access`

### OpenCode

- **No OS-level sandbox** — no Seatbelt, bubblewrap, seccomp, or Docker.
- Access control via **permission rule arrays** with glob matching on permission type (`bash`, `edit`, `external_directory`, `read`).
- Rules support `allow`, `deny`, `ask` actions; `ask` prompts user before proceeding.
- Commands pre-parsed with tree-sitter to extract paths; `external_directory` permission checks whether paths fall outside project root.
- Built-in agent modes: `build` (all tools), `plan` (no writes, ask for bash), `explore` (read-only).

### Comparison

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| OS-level isolation | Seatbelt (macOS) / bubblewrap (Linux) | Seatbelt / bubblewrap / seccomp / Windows Sandbox | None |
| Network isolation | Domain allowlist + proxy | MITM proxy on loopback TCP | None |
| Permission granularity | Tool + resource-level glob rules | Three preset modes | Rule arrays with glob + tree-sitter |
| Escape hatch | `dangerouslyDisableSandbox` param | `danger-full-access` mode | Permissions are soft (user can allow all) |
| Subagent restrictions | Per-subagent tool allowlist/denylist | Depth limits + agent cap | `task: deny` permission rule |

---

## 5. OpenTelemetry / Observability

### Claude Code

- **No direct OTel integration** in the CLI itself.
- Uses **Statsig** (operational metrics: latency, reliability, usage — no code/file paths) and **Sentry** (error reporting + stack traces).
- Disabled by default for Bedrock/Vertex/Foundry; opt-in via `CLAUDE_CODE_USE_*` env vars.
- `DISABLE_TELEMETRY` / `DISABLE_ERROR_REPORTING` to opt out entirely.
- Hook-based observability: `PostToolUse` hooks can log tool calls to files; `InstructionsLoaded` hook fires when CLAUDE.md loads (logs file, reason, source).
- **Agent SDK** (separate product) includes OTel support for custom agent implementations.

### Codex CLI

Full first-class OTel via `codex-otel` crate (`core/src/otel_init.rs`):

**Exporters** (logs, traces, metrics independently configurable):
- `None`
- `Statsig` (internal analytics)
- `OtlpHttp` — JSON or binary; optional mTLS via `ca_certificate`, `client_certificate`, `client_private_key`
- `OtlpGrpc` — with optional mTLS

**Features**:
- `analytics_enabled` flag gates the metrics exporter.
- `RuntimeMetrics` feature flag enables process-level runtime metrics.
- MCP server wires both `fmt` (stderr) and OTel logger/tracing layers via `tracing_subscriber::registry`.
- Named metric constants: `codex.memory.phase1`, `codex.memory.phase1.e2e_ms`, `codex.memory.phase1.token_usage`.
- Service name defaults to originator name; overridable per component (e.g. `codex_mcp_server`).

### OpenCode

- **No OTel integration** — not found in the codebase.
- Structured `Log` utility (`src/util/log.ts`) for internal service logging.
- `/log` HTTP endpoint (excluded from access logs) for log streaming.
- No tracing, no metrics export, no OTLP.
- OpenAPI spec auto-generated from Hono routes at `/openapi`.

### Comparison

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| OTel support | None (CLI); yes (Agent SDK) | Full: OTLP HTTP + gRPC, traces + logs + metrics | None |
| mTLS for exports | N/A | Yes (ca_cert + client cert/key) | N/A |
| Internal telemetry | Statsig + Sentry | Statsig + custom OTLP | Structured logs only |
| Hook-based logging | Yes (PostToolUse, InstructionsLoaded) | No hooks; tracing layers | `/log` HTTP endpoint |
| Opt-out mechanism | `DISABLE_TELEMETRY` env var | Per-exporter config | N/A |

---

## 6. Cross-Agent Communications

### Claude Code

**Subagent model**:
- Each subagent runs in an **isolated context window** — no access to parent's conversation history.
- Spawned via `Agent(agent-type)` tool; results summarized and returned to parent.
- Cannot spawn further subagents (no nesting by default).
- `SendMessage(to: agent_id)` resumes a stopped subagent in background without new `Agent` invocation.

**Built-in agent types**: `Explore` (read-only, fast), `Plan` (read-only), `General-purpose` (full tools), `statusline-setup`.

**Agent Teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):
- **Lead** spawns teammates; coordinates via shared task list at `~/.claude/tasks/{team-name}/`.
- **File-locking** prevents race conditions when multiple teammates claim tasks.
- **Mailbox**: automatic message delivery; no polling required.
- Display modes: in-process (Shift+Down to cycle) or split-pane (requires tmux/iTerm2).
- Token cost scales linearly with team size (each teammate = separate Claude instance).
- Hooks: `TeammateIdle`, `TaskCompleted`, `TaskCreated` for quality gates.

### Codex CLI

**`AgentControl` + `AgentRegistry`** (`core/src/agent/`):
- `AgentControl::spawn_agent()` creates a `CodexThread` sharing the same `AgentControl` (no independent registries per subtree).
- Agent nicknames assigned from pre-seeded `agent_names.txt`; depth-suffixed after rollover.
- **Depth limiting**: `exceeds_thread_spawn_depth_limit(depth, max_depth)` enforced at spawn.
- **Agent cap**: `AgentRegistry::reserve_spawn_slot(max_threads)` with atomic counting.
- **Tree structure**: tracked by `AgentPath` (e.g. `/root/child/grandchild`) in `HashMap<AgentPath>` behind `Mutex<ActiveAgents>`.
- **Fork**: parent conversation history snapshotted to JSONL → `ensure_rollout_materialized` → `flush_rollout` for child.
- `InterAgentCommunication` protocol type in `codex_protocol::protocol`; completion emits context lines via `format_subagent_context_line`.
- **MCP as agent surface**: `codex mcp-server` exposes Codex as an MCP-callable agent — enables agent-of-agents over JSON-RPC stdio.

### OpenCode

**`task` tool** (`src/tool/task.ts`):
- Creates a child `Session` (`parentID` set to calling session) and calls `SessionPrompt.prompt()` recursively.
- **Abort linking**: aborting parent aborts child via `ctx.abort.addEventListener("abort", cancel)`.
- `task_id` parameter allows resuming a prior subagent session by SQLite session ID.
- Subagents inherit model from current message unless overridden in agent config.
- Built-in subagents: `general` (full access except `todowrite`), `explore` (read-only).
- Custom subagents via `opencode.json` or markdown files in `.opencode/agents/` or `~/.config/opencode/agents/`.
- Agent modes: `subagent` (cannot be primary) / `primary` (cannot be subagent).
- Session parent-child navigation exposed in TUI: `session_child_first`, `session_child_cycle`, `session_parent`.
- Experimental `@general` mention invokes general subagent inline.

### Comparison

| | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| Spawn mechanism | `Agent(type)` tool | `AgentControl::spawn_agent()` | `task` tool → child Session |
| Nesting | Flat (no nesting by default) | Tree (`AgentPath`) with depth limit | Recursive (parent-child sessions) |
| Abort propagation | Parent shutdown → teammate shutdown | `AgentControl` shared across tree | Linked via `AbortController` |
| Context isolation | Full (separate context window) | Full (separate `CodexThread`) | Full (separate Session) |
| Resumption | `SendMessage(to: agent_id)` | Fork from JSONL snapshot | `task_id` in task tool call |
| Cap / limit | None stated | `agent_max_threads` (atomic counter) | None stated |
| Coordination protocol | File-based mailbox + task list | `InterAgentCommunication` protocol | Parent reads child output only |
| MCP exposure | Client only (per session) | Client **and** server | Client only |
| Parallel teams | Yes (Agent Teams, experimental) | Yes (AgentRegistry tree) | No first-class team model |

---

## Summary Matrix

| Dimension | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| **Process isolation** | OS sandbox (Seatbelt/bubblewrap) + fresh shell per call | OS sandbox + process group kill | No OS sandbox; kill process group |
| **Memory format** | Markdown files (CLAUDE.md + MEMORY.md) | JSONL rollouts + SQLite + LLM-generated summary | SQLite (Drizzle), JSON fallback |
| **Memory extraction** | Manual (Claude writes during session) | Automated 2-phase LLM pipeline at startup | AI compaction agent on demand |
| **IPC** | File system (tasks, mailbox) + hooks | stdio JSON-RPC (MCP); loopback TCP proxy | HTTP/SSE/WebSocket; mDNS discovery |
| **Sandbox depth** | OS-level + permission modes + proxy | OS-level (3 platform backends) + proxy | Permission rules only (no OS confinement) |
| **OTel** | None in CLI; Statsig/Sentry internally | Full OTLP (HTTP + gRPC) with mTLS, traces/logs/metrics | None; structured logs only |
| **Multi-agent model** | Flat subagents + experimental Teams (file-based coordination) | Tree (AgentPath) + depth/cap limits + InterAgentCommunication | Recursive child Sessions; abort-linked |
| **MCP role** | Client + per-session subagents | Client **and** server (stdio) | Client only |
