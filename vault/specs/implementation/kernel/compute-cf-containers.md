# Compute Backend: cf-containers

Implementation spec for the `cf-containers` ComputeSubstrate — running agent sessions in Cloudflare Containers with telemetry streaming back to the local (Slice 2) or cloud (Slice 3) kernel.

> Parent spec: [../../architecture/kernel/compute.md](../../architecture/kernel/compute.md)
> Deployment phasing: [../../architecture/session-trigger-from-board.md](../../architecture/session-trigger-from-board.md)

---

## 1. Architecture Overview

```mermaid
flowchart TD
    subgraph Local["Local Machine"]
        Orch[gctrl-orch]
        Kernel[Kernel OTLP :4318]
        Tunnel[cloudflared tunnel]
    end

    subgraph CF["Cloudflare"]
        API[Containers API]
        Container[Agent Container]
        Proxy[LLM Proxy Worker]
        R2[R2 Workspace Snapshots]
    end

    subgraph Providers["LLM Providers"]
        Claude[Anthropic API]
        OpenAI[OpenAI API]
    end

    Orch -->|"launch(invocation, spec)"| API
    API -->|"provision"| Container
    Container -->|"OTLP spans"| Tunnel
    Tunnel -->|"/v1/traces"| Kernel
    Container -->|"LLM requests"| Proxy
    Proxy -->|"inject auth + enforce cost cap"| Claude
    Proxy -->|"inject auth + enforce cost cap"| OpenAI
    Orch -->|"workspace snapshot"| R2
    R2 -->|"mount at launch"| Container
```

### Slice 2 vs Slice 3

| Concern | Slice 2 (local orchestrator) | Slice 3 (cloud orchestrator) |
|---------|------------------------------|------------------------------|
| Who calls Containers API | Local `gctrl-orch` daemon | Worker + Durable Object |
| OTLP destination | Local kernel via cloudflared tunnel | Cloud relay Worker → R2 Parquet |
| Claim state lives in | Local DuckDB | D1 (Durable Object writes) |
| Workspace source | Local git worktree → R2 snapshot | R2 snapshot (already remote) |
| Session SSE | Local kernel event bus | Cloud Worker SSE endpoint |

This spec covers **Slice 2** end-to-end. Slice 3 additions are noted inline where the topology differs.

---

## 2. Container Lifecycle

### 2.1 Provision

```rust
impl ComputeSubstrate for CfContainerSubstrate {
    fn kind(&self) -> ComputeKind { ComputeKind::CfContainers }

    async fn launch(&self, invocation: Invocation, spec: ComputeSpec)
        -> Result<ComputeHandle, ComputeError>
    {
        // 1. Snapshot workspace to R2 (if workspace_mount is non-empty)
        let snapshot_key = self.upload_workspace(&invocation.workspace_mount).await?;

        // 2. Call Containers API to provision
        let container = self.containers_api.create(ContainerRequest {
            image: spec.image.unwrap_or_else(|| self.default_image(&invocation)),
            env: self.build_env(&invocation, &spec, &snapshot_key),
            cpu_ms: spec.cpu_ms,
            memory_mb: spec.memory_mb,
            network: self.build_network_policy(&spec.egress),
        }).await.map_err(|e| ComputeError::Provision(e.to_string()))?;

        // 3. Return handle
        Ok(ComputeHandle {
            id: container.id.clone(),
            kill: Box::new(move || { /* DELETE container */ }),
            wait: Box::new(async move { /* poll until exit */ }),
        })
    }
}
```

### 2.2 Environment Injection

The container receives these environment variables at provision time:

| Variable | Source | Purpose |
|----------|--------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Kernel config (tunnel URL or relay Worker) | Span destination |
| `OTEL_EXPORTER_OTLP_HEADERS` | `"x-session-id={session_id}"` | Session attribution |
| `GCTRL_SESSION_ID` | Orchestrator | Session identity |
| `GCTRL_WORKSPACE_SNAPSHOT` | R2 key from step 1 | Workspace to restore |
| `HTTP_PROXY` / `HTTPS_PROXY` | LLM Proxy Worker URL | Egress choke-point |
| `NODE_EXTRA_CA_CERTS` | Proxy Worker's CA cert (if MITM) | Trust the proxy |
| `ANTHROPIC_API_KEY` | **NOT injected** — proxy injects at egress | Never in container env |

**Rule:** Long-lived provider secrets MUST NOT appear in the container environment. The proxy Worker holds credentials and injects them at the network level. This matches Cloudflare's internal pattern of stripping auth headers and rewriting them at the proxy.

### 2.3 Workspace Transfer

The agent needs a git worktree to operate on. Two strategies:

1. **Snapshot-and-restore** (default): orchestrator tars the workspace, uploads to R2, container downloads and extracts at boot. ~5-15s overhead for typical repos.
2. **Git-clone-at-boot** (for public repos or when snapshot is stale): container runs `git clone` using a resource-bundled PAT (see [compute.md §6 Credentials](../../architecture/kernel/compute.md#6-credentials--resource-bundled-vs-vault-proxied)). The PAT is consumed during setup and erased before the runtime launches.

The container's entrypoint:
```sh
#!/bin/sh
# 1. Restore workspace
if [ -n "$GCTRL_WORKSPACE_SNAPSHOT" ]; then
  aws s3 cp "s3://${R2_BUCKET}/${GCTRL_WORKSPACE_SNAPSHOT}" /workspace.tar.gz
  tar xzf /workspace.tar.gz -C /workspace
fi
# 2. Launch the agent runtime (command from Invocation)
exec "$@"
```

### 2.4 Exit and Cleanup

The `wait` future polls the Containers API for exit status. On any exit:

1. Container stdout/stderr (if not already streamed as spans) is fetched and stored as a synthetic `agent.output` span.
2. The container is deleted (ephemeral — no persistence between attempts).
3. `ComputeExit` is returned to the orchestrator, which transitions the claim state per [orchestrator.md](../../architecture/kernel/orchestrator.md).

Exit mapping:

| Container exit | `ComputeExit` variant | Orchestrator transition |
|---------------|----------------------|------------------------|
| Code 0 | `Clean` | Running → Released |
| Code != 0 | `Error(code, stderr)` | Running → RetryQueued |
| OOM killed | `Crashed("oom")` | Running → RetryQueued |
| Timeout (cpu_ms exceeded) | `Killed("timeout")` | Running → RetryQueued |
| Network lost (API unreachable) | `NetworkLost` | Running → RetryQueued |

---

## 3. LLM Proxy Worker

A Hono Worker deployed alongside the board that acts as the sole egress path for LLM calls from containers. Inspired by Cloudflare's internal proxy pattern.

### 3.1 Responsibilities

1. **Credential injection** — strips any auth headers from the container's request, looks up the correct provider API key from Workers Secrets, injects it.
2. **Cost enforcement** — reads the session's cost cap from D1/KV, tracks running total, returns 429 if exceeded.
3. **Telemetry emission** — emits an OTLP span per LLM call (model, tokens, cost, latency) to the same OTLP endpoint the container uses.
4. **Zero Data Retention** — injects provider-specific ZDR flags (`store: false` for OpenAI, no logging for Anthropic) per workspace policy.
5. **Model routing** — rewrites model identifiers if the workspace config specifies model overrides.

### 3.2 Route Structure

```
POST /v1/chat/completions      → OpenAI-compatible (rewrite to provider)
POST /v1/messages              → Anthropic native
POST /v1/models                → Model catalog (cached from providers, refreshed hourly)
```

### 3.3 Auth Between Container and Proxy

The container authenticates to the proxy via a short-lived session token:

1. At provision, orchestrator mints a token: `HMAC-SHA256(session_id + expiry, proxy_signing_key)`.
2. Token is injected as `GCTRL_PROXY_TOKEN` env var.
3. Container sets `Proxy-Authorization: Bearer {token}` on every proxied request.
4. Proxy validates token, extracts session_id for attribution.

Token lifetime = `spec.cpu_ms` + 60s grace. On expiry, proxy returns 401 and the agent fails cleanly (triggering retry).

---

## 4. Telemetry Relay

### 4.1 Slice 2: Tunnel-Based

The container's `OTEL_EXPORTER_OTLP_ENDPOINT` points to a cloudflared tunnel endpoint that routes to the local kernel's `:4318/v1/traces`.

**Prerequisite:** user runs `cloudflared tunnel` (already common for gctrl users exposing the board locally). The tunnel URL is stored in kernel config and injected at provision time.

**Fallback:** if no tunnel is configured, the substrate deploys a **relay Worker** that:
1. Accepts OTLP spans from the container.
2. Buffers them in a Durable Object (max 1000 spans, 30s flush).
3. The local kernel polls `GET /api/relay/{session_id}/spans` on interval (default 5s).

This loses real-time SSE granularity but requires zero inbound networking on the user's machine.

### 4.2 Slice 3: Direct to Cloud Kernel

The container's OTLP endpoint points directly to the cloud-deployed kernel Worker (`/v1/traces`). Spans land in D1 (session metadata) and R2 (Parquet, via the sync engine's cloud-side push). No tunnel needed.

---

## 5. Container Images

Pre-built per-runtime images stored in GHCR (Cloudflare Container Registry support TBD):

| Image | Base | Contents | Size target |
|-------|------|----------|-------------|
| `ghcr.io/gctrl/claude-code:latest` | `node:22-slim` | Claude Code CLI, git, OTLP shim, aws-cli (for R2) | < 500MB |
| `ghcr.io/gctrl/codex:latest` | `rust:1-slim` | Codex CLI, git, OTLP configured | < 600MB |
| `ghcr.io/gctrl/opencode:latest` | `oven/bun:1` | OpenCode, git, SSE-to-OTLP translator | < 400MB |
| `ghcr.io/gctrl/aider:latest` | `python:3.12-slim` | Aider, git, stdout-to-OTLP wrapper | < 500MB |
| `ghcr.io/gctrl/base:latest` | `debian:bookworm-slim` | git, OTLP shim, workspace restore — for `custom` runtimes | < 200MB |

Images are built in CI on tag push. The `WORKFLOW.md` `compute_config.image` field overrides for custom images.

---

## 6. Network Egress Policy

The container's network is locked down at the Cloudflare Containers level:

```mermaid
flowchart LR
    Agent[Agent Process] -->|"HTTPS_PROXY"| Proxy[LLM Proxy Worker]
    Agent -->|"OTEL_EXPORTER"| Relay[OTLP Relay / Tunnel]
    Agent -.->|"BLOCKED"| Internet((Public Internet))
```

**Default policy (`EgressPolicy::Allowlist`):**
- Container can reach: LLM Proxy Worker URL, OTLP relay/tunnel URL.
- Container cannot reach: anything else.
- DNS resolution restricted to Cloudflare's internal resolver.

**Open policy (`EgressPolicy::Open`):**
- For trusted internal tasks (e.g., tasks that need to `npm install` or fetch dependencies).
- All egress still routes through the proxy for observability (HTTP_PROXY set), but the proxy allows pass-through.
- MUST be explicitly declared in WORKFLOW.md.

**Implementation:** Cloudflare Containers' network policy API (or network rules if available) restricts outbound. Backup: the container runs with iptables rules in its entrypoint that only allow the proxy and relay IPs.

---

## 7. Credential Delivery

Following [compute.md §6](../../architecture/kernel/compute.md#6-credentials--resource-bundled-vs-vault-proxied):

| Credential type | Delivery | Example |
|----------------|----------|---------|
| Git PAT (repo clone) | Resource-bundled: used in entrypoint, erased | `git clone https://x-access-token:{PAT}@github.com/...` |
| LLM provider keys | Vault-proxied: live in proxy Worker Secrets | Agent hits proxy; proxy injects key at egress |
| GitHub API (for PRs) | Vault-proxied: kernel MCP endpoint | Agent calls `mcp://kernel/github.create_pr` |
| R2 credentials (workspace) | Resource-bundled: used in entrypoint, erased | `aws s3 cp` in boot script |

**Slice 3 addition:** kernel-hosted MCP endpoint exposed as a Worker that the container connects to for capabilities that require secrets (GitHub, Linear, Slack). The container never holds these credentials — it calls the MCP endpoint with its session token.

---

## 8. Concurrency and Quotas

From [compute.md §7](../../architecture/kernel/compute.md#7-concurrency--per-compute-slots):

```toml
[orchestrator.compute_slots]
cf-containers = 20  # default; tunable per workspace
```

The substrate tracks in-flight containers and refuses `launch()` with `ComputeError::SlotExhausted` when the limit is reached. The orchestrator keeps those tasks `Unclaimed` until a slot frees.

**Cloudflare-side limits:** Containers have per-account concurrency limits. The substrate reads the account's limit at startup and caps `compute_slots` to `min(config, account_limit)`.

---

## 9. Cost Tracking

Three layers of cost attribution:

1. **Proxy Worker** — emits OTLP spans with `cost_usd`, `input_tokens`, `output_tokens` per LLM call. These land in the session's span log.
2. **Containers API** — compute cost (CPU-ms × rate). Emitted as `compute.exit` event with `cpu_ms` field.
3. **R2 transfer** — workspace upload/download bytes. Negligible but tracked in `compute.provision.ready` event.

All three are attributed to the `session_id` and rolled up into `Session.total_cost_usd`.

---

## 10. Discovery Endpoint (Slice 3)

When the cloud orchestrator is deployed, expose `/.well-known/gctrl` from the board Worker:

```json
{
  "version": "1",
  "workspace_id": "ws_abc",
  "endpoints": {
    "otel": "https://gctrl.example.workers.dev/v1/traces",
    "sessions": "https://gctrl.example.workers.dev/api/sessions",
    "stream": "https://gctrl.example.workers.dev/api/sessions/{id}/stream",
    "board": "https://gctrl.example.workers.dev/api/board",
    "sync": "https://gctrl.example.workers.dev/api/sync",
    "mcp": "https://gctrl.example.workers.dev/mcp"
  },
  "compute_substrates": ["cf-containers"],
  "agent_runtimes": ["claude-code", "codex", "opencode", "aider"]
}
```

Clients (mobile, desktop, CLI) discover the cloud kernel by fetching this endpoint. Local kernel discovery remains via `localhost:4318`.

---

## 11. Configuration

### Kernel config (`gctrl.toml`)

```toml
[compute.cf-containers]
enabled = true
account_id = "cf_account_id"               # Cloudflare account
api_token = "${GCTRL_CF_API_TOKEN}"         # env var reference
default_image = "ghcr.io/gctrl/claude-code:latest"
proxy_worker_url = "https://gctrl-proxy.example.workers.dev"
proxy_signing_key = "${GCTRL_PROXY_SIGNING_KEY}"

# Telemetry relay (Slice 2 — pick one)
[compute.cf-containers.telemetry]
mode = "tunnel"                             # "tunnel" | "relay"
tunnel_url = "https://gctrl-otel.example.trycloudflare.com"
# OR
# mode = "relay"
# relay_worker_url = "https://gctrl-relay.example.workers.dev"
# poll_interval_ms = 5000
```

### WORKFLOW.md per-task override

```yaml
agent:
  runtime: claude-code
  compute: cf-containers
  compute_config:
    image: "ghcr.io/gctrl/claude-code:latest"
    cpu_ms: 60000
    memory_mb: 4096
    egress: "allowlist"
    egress_allowlist:
      - "api.anthropic.com"
      - "github.com"
      - "registry.npmjs.org"
```

---

## 12. Acceptance Criteria (Slice 2)

1. `gctrl board move BACK-42 in_progress` with `compute: cf-containers` in WORKFLOW.md provisions a CF Container.
2. Agent completes a simple task (create a file, commit, push) inside the container.
3. All spans appear in local DuckDB with correct `session_id` attribution.
4. Session SSE stream on desktop/CLI shows live span events during execution.
5. LLM calls route through the proxy Worker; provider keys never appear in container env or spans.
6. Cost cap enforcement: when `guardrails.session_cost_limit_usd` is reached, proxy returns 429, agent exits, session transitions to `Failed`.
7. On container OOM/timeout, orchestrator receives `RetryQueued` and retries with backoff.
8. `gctrl sync push` uploads the session's spans to R2 as Parquet.

---

## 13. Open Questions

1. **Workspace size limit.** Large monorepos (>1GB) make snapshot-and-restore slow. Should we support incremental workspace sync (rsync-over-R2) or require shallow clones for large repos?
2. **Container keep-alive.** For multi-turn agent sessions (human-in-the-loop), should the container stay warm between turns, or re-provision each time? Keep-alive burns compute; re-provision loses in-memory state.
3. **Cross-container networking.** If a task spawns sub-tasks on separate containers (via Scheduler), should containers be able to communicate directly, or must all coordination go through the kernel?
4. **Image caching.** Cloudflare Containers may cold-pull images on each provision. Should we pre-warm images via a cron Worker, or accept the cold-start latency?
