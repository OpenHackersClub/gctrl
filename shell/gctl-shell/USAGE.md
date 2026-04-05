# gctl-shell Usage

Effect-TS CLI for GroundCtrl. Invokes the Rust kernel via HTTP API (`:4318`) and GitHub via direct REST API.

## Prerequisites

```sh
# Kernel daemon must be running for most commands
gctl serve

# GitHub commands require a token
export GITHUB_TOKEN=ghp_...   # or GH_TOKEN
```

## CLI Commands

```
gctl <command> <subcommand> [options]
```

---

### `gctl status`

Show kernel health and system overview.

```sh
gctl status
```

Output: kernel online/offline status, total sessions, active sessions, span count, cost.

---

### `gctl sessions`

Manage agent sessions (kernel telemetry).

#### `gctl sessions list`

```sh
gctl sessions list
gctl sessions list --agent "Claude Code" --status active --limit 10
```

| Flag | Default | Description |
|------|---------|-------------|
| `--agent` | | Filter by agent name |
| `--status` | | Filter by status (`active`, `completed`, `failed`) |
| `--limit` | `20` | Max results |

#### `gctl sessions show <session-id>`

```sh
gctl sessions show sess-abc123
```

#### `gctl sessions spans <session-id>`

List spans (LLM calls, tool invocations) for a session.

```sh
gctl sessions spans sess-abc123
```

#### `gctl sessions tree <session-id>`

Show trace tree hierarchy for a session.

```sh
gctl sessions tree sess-abc123
```

#### `gctl sessions end <session-id>`

End an active session.

```sh
gctl sessions end sess-abc123
```

#### `gctl sessions score <session-id>`

Auto-score a session (generates quality metrics).

```sh
gctl sessions score sess-abc123
```

#### `gctl sessions loops <session-id>`

Check for error loops in a session.

```sh
gctl sessions loops sess-abc123
```

#### `gctl sessions cost <session-id>`

Per-model cost breakdown for a session.

```sh
gctl sessions cost sess-abc123
```

---

### `gctl analytics`

Analytics dashboard and queries (kernel telemetry + storage).

#### `gctl analytics overview`

```sh
gctl analytics overview
```

#### `gctl analytics cost`

Cost breakdown by model and by agent.

```sh
gctl analytics cost
```

#### `gctl analytics latency`

Latency percentiles (p50, p95, p99) by model.

```sh
gctl analytics latency
```

#### `gctl analytics spans`

Span type distribution.

```sh
gctl analytics spans
```

#### `gctl analytics scores --name <name>`

Score summary for a named metric.

```sh
gctl analytics scores --name tests_pass
```

#### `gctl analytics daily`

Daily aggregates (sessions, spans, cost).

```sh
gctl analytics daily --days 14
```

| Flag | Default | Description |
|------|---------|-------------|
| `--days` | `7` | Number of days |

#### `gctl analytics score`

Create a manual score.

```sh
gctl analytics score --target-id sess-abc --name quality --value 0.85
gctl analytics score --target-id sess-abc --name quality --value 0.85 --comment "Good output"
```

| Flag | Description |
|------|-------------|
| `--target-id` | Session or span ID |
| `--name` | Score name |
| `--value` | Score value (0-1) |
| `--comment` | Optional comment |

#### `gctl analytics tag`

Create a tag on a session.

```sh
gctl analytics tag --target-id sess-abc --key env --value staging
```

#### `gctl analytics alerts`

List configured alert rules.

```sh
gctl analytics alerts
```

---

### `gctl context`

Manage agent context (kernel context manager — hybrid DuckDB + filesystem).

#### `gctl context list`

```sh
gctl context list
gctl context list --kind document --tag rust --search "error handling" --limit 50
```

| Flag | Default | Description |
|------|---------|-------------|
| `--kind` | | Filter by kind (`document`, `config`, `snapshot`) |
| `--tag` | | Filter by tag |
| `--search` | | Full-text search |
| `--limit` | `100` | Max results |

#### `gctl context add`

```sh
gctl context add --path docs/api.md --title "API Reference" --content "..." --kind document
```

| Flag | Default | Description |
|------|---------|-------------|
| `--path` | | Context path (required) |
| `--title` | | Context title (required) |
| `--content` | | Content body (required) |
| `--kind` | `document` | Kind |

#### `gctl context show <id>`

Show context entry metadata.

```sh
gctl context show ctx-abc123
```

#### `gctl context content <id>`

Print raw markdown content of an entry.

```sh
gctl context content ctx-abc123
```

#### `gctl context remove <id>`

```sh
gctl context remove ctx-abc123
```

#### `gctl context compact`

Compact context into LLM-ready output.

```sh
gctl context compact
gctl context compact --kind document --tag rust
```

#### `gctl context stats`

Show context store statistics (entry count, word count, breakdown by kind/source).

```sh
gctl context stats
```

---

### `gctl board`

Kanban board operations (kernel board app — `board_*` tables).

#### `gctl board projects list`

```sh
gctl board projects list
```

#### `gctl board projects create`

```sh
gctl board projects create --name "GroundCtrl" --key GCTL
```

#### `gctl board issues list`

```sh
gctl board issues list
gctl board issues list --project proj-123 --status in_progress --assignee alice --label bug --limit 20
```

| Flag | Default | Description |
|------|---------|-------------|
| `--project` | | Filter by project ID |
| `--status` | | Filter by status (`backlog`, `todo`, `in_progress`, `in_review`, `done`) |
| `--assignee` | | Filter by assignee ID |
| `--label` | | Filter by label |
| `--limit` | `50` | Max results |

#### `gctl board issues create`

```sh
gctl board issues create --project proj-123 --title "Fix login bug" --priority high
gctl board issues create --project proj-123 --title "Refactor auth" --description "..." --priority medium
```

| Flag | Default | Description |
|------|---------|-------------|
| `--project` | | Project ID (required) |
| `--title` | | Issue title (required) |
| `--description` | | Issue description |
| `--priority` | `none` | Priority (`none`, `low`, `medium`, `high`, `urgent`) |

#### `gctl board issues view <id>`

```sh
gctl board issues view issue-abc123
```

#### `gctl board issues move <id>`

```sh
gctl board issues move issue-abc123 --status done
```

#### `gctl board issues assign <id>`

```sh
gctl board issues assign issue-abc123 --assignee-id user-1 --assignee-name "Alice"
```

#### `gctl board issues comment <id>`

```sh
gctl board issues comment issue-abc123 --body "Working on this now"
```

#### `gctl board issues events <id>`

Show event history for an issue.

```sh
gctl board issues events issue-abc123
```

#### `gctl board issues comments <id>`

List all comments on an issue.

```sh
gctl board issues comments issue-abc123
```

#### `gctl board issues link <id>`

Link a session to an issue.

```sh
gctl board issues link issue-abc123 --session sess-xyz
```

---

### `gctl gh`

GitHub integration (direct REST API — requires `GITHUB_TOKEN`).

#### `gctl gh issues list`

```sh
gctl gh issues list --repo owner/repo
gctl gh issues list --repo owner/repo --limit 20
```

#### `gctl gh issues view <number>`

```sh
gctl gh issues view 42 --repo owner/repo
```

#### `gctl gh issues create`

```sh
gctl gh issues create --repo owner/repo --title "Bug report" --body "Steps to reproduce..."
gctl gh issues create --repo owner/repo --title "Feature" --label enhancement --label frontend
```

| Flag | Description |
|------|-------------|
| `--repo` / `-r` | owner/repo (required) |
| `--title` | Issue title (required) |
| `--body` | Issue body |
| `--label` | Label (repeatable) |

#### `gctl gh prs list`

```sh
gctl gh prs list --repo owner/repo --limit 10
```

#### `gctl gh prs view <number>`

```sh
gctl gh prs view 99 --repo owner/repo
```

#### `gctl gh runs list`

```sh
gctl gh runs list --repo owner/repo
gctl gh runs list --repo owner/repo --branch main --limit 5
```

| Flag | Description |
|------|-------------|
| `--repo` / `-r` | owner/repo (required) |
| `--limit` | Max results (default 10) |
| `--branch` / `-b` | Filter by branch |

#### `gctl gh runs view <run-id>`

```sh
gctl gh runs view 123456 --repo owner/repo
```

---

### `gctl net`

Web scraping and context tools. Delegates to the `gctl` Rust binary (subprocess).

#### `gctl net fetch <url>`

Fetch a URL and convert to markdown.

```sh
gctl net fetch https://docs.example.com/getting-started
```

#### `gctl net crawl <url>`

Crawl a site and save pages as markdown.

```sh
gctl net crawl https://docs.example.com
gctl net crawl https://docs.example.com --depth 5 --max-pages 100
```

| Flag | Default | Description |
|------|---------|-------------|
| `--depth` | `3` | Max crawl depth |
| `--max-pages` | `50` | Max pages |

#### `gctl net list`

List all crawled domains.

```sh
gctl net list
```

#### `gctl net show <domain>`

Show crawled content for a domain.

```sh
gctl net show docs.example.com
gctl net show docs.example.com --page getting-started.md
```

#### `gctl net compact <domain>`

Compact crawled pages into LLM-ready output.

```sh
gctl net compact docs.example.com
```

---

### `gctl audit`

Run build, lint, test, and acceptance criteria checks.

```sh
gctl audit
gctl audit --fix            # auto-fix lint issues
gctl audit --skip-tests     # skip test step
```

| Flag | Default | Description |
|------|---------|-------------|
| `--fix` | `false` | Auto-fix lint issues |
| `--skip-tests` | `false` | Skip tests |

---

## Programmatic Usage (Effect-TS)

Apps under `apps/` can import service ports and adapters from `gctl-shell` to reuse the same clients programmatically instead of shelling out to the CLI.

### Installation

```json
{
  "dependencies": {
    "gctl-shell": "workspace:*"
  }
}
```

### Service Ports

Two service ports are available as Effect `Context.Tag` services:

#### KernelClient

Typed HTTP client for the Rust kernel daemon on `:4318`.

```typescript
import { Effect, Schema } from "effect"
import { KernelClient, HttpKernelClientLive } from "gctl-shell"

// Define your response schema
const MySchema = Schema.Struct({
  id: Schema.String,
  value: Schema.Number,
})

const program = Effect.gen(function* () {
  const kernel = yield* KernelClient

  // GET with schema decode
  const data = yield* kernel.get("/api/sessions?limit=10", MySchema)

  // POST with body and schema decode
  const result = yield* kernel.post("/api/analytics/score", {
    target_type: "session",
    target_id: "sess-123",
    name: "quality",
    value: 0.9,
    source: "human",
  }, Schema.Struct({ id: Schema.String }))

  // DELETE
  yield* kernel.delete("/api/context/ctx-abc")

  // GET raw text (markdown, etc.)
  const text = yield* kernel.getText("/api/context/ctx-abc/content")

  // Health check
  const healthy = yield* kernel.health()
})

// Provide the real HTTP adapter
program.pipe(
  Effect.provide(HttpKernelClientLive()),           // default: localhost:4318
  // or: Effect.provide(HttpKernelClientLive("http://custom:4318")),
)
```

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `(path, schema) => Effect<A, KernelError \| KernelUnavailableError>` | GET + schema decode |
| `post` | `(path, body, schema) => Effect<A, KernelError \| KernelUnavailableError>` | POST JSON + schema decode |
| `delete` | `(path) => Effect<void, KernelError \| KernelUnavailableError>` | DELETE |
| `getText` | `(path) => Effect<string, KernelError \| KernelUnavailableError>` | GET raw text |
| `health` | `() => Effect<boolean, KernelUnavailableError>` | Health check |

#### GitHubClient

Typed HTTP client for GitHub REST API. Reads `GITHUB_TOKEN` or `GH_TOKEN` from environment.

```typescript
import { Effect } from "effect"
import { GitHubClient, HttpGitHubClientLive } from "gctl-shell"

const program = Effect.gen(function* () {
  const gh = yield* GitHubClient

  // List issues
  const issues = yield* gh.listIssues("owner/repo", {
    state: "open",
    label: "bug",
    limit: 20,
  })

  // View single issue
  const issue = yield* gh.viewIssue("owner/repo", 42)

  // Create issue
  const created = yield* gh.createIssue("owner/repo", {
    title: "Bug report",
    body: "Steps to reproduce...",
    labels: ["bug"],
  })

  // List PRs
  const prs = yield* gh.listPRs("owner/repo", { limit: 10 })

  // View single PR
  const pr = yield* gh.viewPR("owner/repo", 99)

  // List workflow runs
  const runs = yield* gh.listRuns("owner/repo", {
    branch: "main",
    limit: 5,
  })

  // View single run
  const run = yield* gh.viewRun("owner/repo", 123456)
})

program.pipe(Effect.provide(HttpGitHubClientLive))
```

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `listIssues` | `(repo, options?) => Effect<GhIssue[], GitHubError \| GitHubAuthError>` | List issues (filters: state, label, limit) |
| `viewIssue` | `(repo, number) => Effect<GhIssue, GitHubError \| GitHubAuthError>` | View single issue |
| `createIssue` | `(repo, input) => Effect<GhIssue, GitHubError \| GitHubAuthError>` | Create issue |
| `listPRs` | `(repo, options?) => Effect<GhPR[], GitHubError \| GitHubAuthError>` | List open PRs |
| `viewPR` | `(repo, number) => Effect<GhPR, GitHubError \| GitHubAuthError>` | View single PR |
| `listRuns` | `(repo, options?) => Effect<GhRun[], GitHubError \| GitHubAuthError>` | List workflow runs (filter: branch, limit) |
| `viewRun` | `(repo, runId) => Effect<GhRun, GitHubError \| GitHubAuthError>` | View single run |

### Error Types

All errors are `Schema.TaggedError` — use `Effect.catchTag` for typed handling.

```typescript
import { Effect } from "effect"
import { KernelClient, KernelError, KernelUnavailableError, GitHubError, GitHubAuthError } from "gctl-shell"

const program = Effect.gen(function* () {
  const kernel = yield* KernelClient
  return yield* kernel.get("/api/sessions", SessionList)
}).pipe(
  Effect.catchTags({
    KernelError: (e) =>
      Effect.log(`Kernel error (${e.statusCode}): ${e.message}`),
    KernelUnavailableError: (e) =>
      Effect.log(`Kernel offline: ${e.message}`),
  })
)
```

| Error | Tag | Fields | When |
|-------|-----|--------|------|
| `KernelError` | `"KernelError"` | `message`, `statusCode?` | Non-2xx response from kernel |
| `KernelUnavailableError` | `"KernelUnavailableError"` | `message` | Cannot reach kernel (not running) |
| `GitHubError` | `"GitHubError"` | `message` | GitHub API error (non-auth) |
| `GitHubAuthError` | `"GitHubAuthError"` | `message` | GitHub 401/403 (missing or invalid token) |

### Testing with Mock Layers

Replace real adapters with mock Layers for isolated tests — no HTTP server needed.

```typescript
import { Effect, Layer, Schema } from "effect"
import { KernelClient, GitHubClient, KernelError } from "gctl-shell"

// Mock KernelClient
const MockKernel = Layer.succeed(KernelClient, {
  get: (path, schema) => {
    if (path.startsWith("/api/sessions"))
      return Schema.decodeUnknown(schema)([{ id: "s1", status: "active" }])
    return Effect.fail(new KernelError({ message: "not found", statusCode: 404 }))
  },
  post: (_path, _body, schema) =>
    Schema.decodeUnknown(schema)({ id: "new-1" }),
  delete: (_path) => Effect.void,
  getText: (_path) => Effect.succeed("mock content"),
  health: () => Effect.succeed(true),
})

// Mock GitHubClient
const MockGitHub = Layer.succeed(GitHubClient, {
  listIssues: () => Effect.succeed([]),
  viewIssue: (_repo, n) =>
    Effect.succeed({ number: n, title: "Test", state: "open", author: "user", labels: [], createdAt: "", url: "" }),
  createIssue: (_repo, input) =>
    Effect.succeed({ number: 1, title: input.title, state: "open", author: "test", labels: input.labels ?? [], createdAt: "", url: "" }),
  listPRs: () => Effect.succeed([]),
  viewPR: (_repo, n) =>
    Effect.succeed({ number: n, title: "PR", state: "open", author: "user", branch: "main", url: "" }),
  listRuns: () => Effect.succeed([]),
  viewRun: (_repo, id) =>
    Effect.succeed({ id, name: "CI", status: "completed", conclusion: "success", branch: "main", url: "" }),
})

// Use in tests
const result = await Effect.runPromise(
  myProgram.pipe(Effect.provide(Layer.merge(MockKernel, MockGitHub)))
)
```

### Kernel HTTP API Routes

The shell consumes these routes from the Rust kernel on `:4318`:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/traces` | OTel OTLP span ingestion |
| GET | `/api/sessions` | List sessions (query: limit, agent, status) |
| GET | `/api/sessions/{id}` | Session detail |
| GET | `/api/sessions/{id}/spans` | Spans for session |
| GET | `/api/sessions/{id}/tree` | Trace tree |
| POST | `/api/sessions/{id}/end` | End session |
| POST | `/api/sessions/{id}/auto-score` | Auto-score session |
| GET | `/api/sessions/{id}/loops` | Loop detection |
| GET | `/api/sessions/{id}/cost-breakdown` | Per-model cost |
| GET | `/api/analytics` | Overview analytics |
| GET | `/api/analytics/cost` | Cost by model/agent |
| GET | `/api/analytics/latency` | Latency percentiles |
| GET | `/api/analytics/spans` | Span distribution |
| GET | `/api/analytics/scores` | Score summary (query: name) |
| GET | `/api/analytics/daily` | Daily aggregates (query: days) |
| POST | `/api/analytics/score` | Create score |
| POST | `/api/analytics/tag` | Create tag |
| GET | `/api/analytics/alerts` | List alert rules |
| GET | `/api/context` | List context entries (query: kind, tag, search, limit) |
| POST | `/api/context` | Upsert context entry |
| GET | `/api/context/{id}` | Context entry metadata |
| GET | `/api/context/{id}/content` | Context entry content (markdown) |
| DELETE | `/api/context/{id}` | Remove context entry |
| GET | `/api/context/compact` | Compact context (query: kind, tag) |
| GET | `/api/context/stats` | Context store statistics |
| GET | `/api/board/projects` | List board projects |
| POST | `/api/board/projects` | Create project |
| GET | `/api/board/issues` | List issues (query: project_id, status, assignee_id, label, limit) |
| POST | `/api/board/issues` | Create issue |
| GET | `/api/board/issues/{id}` | View issue |
| POST | `/api/board/issues/{id}/move` | Move issue status |
| POST | `/api/board/issues/{id}/assign` | Assign issue |
| POST | `/api/board/issues/{id}/comment` | Comment on issue |
| GET | `/api/board/issues/{id}/events` | Issue events |
| GET | `/api/board/issues/{id}/comments` | Issue comments |
| POST | `/api/board/issues/{id}/link-session` | Link session to issue |
| GET | `/health` | Health check |
