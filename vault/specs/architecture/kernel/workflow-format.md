# WORKFLOW.md File Format

Defines the `WORKFLOW.md` file format for agent dispatch — a Markdown file with optional YAML frontmatter that configures tracker, polling, workspace, hooks, and agent settings plus a prompt template body.

The orchestrator (see [orchestrator.md](orchestrator.md)) reads this file to configure dispatch behavior. Applications built on gctrl use this format to define automated agent workflows.

## File Discovery

Workflow file path precedence:

1. Explicit application/runtime setting (set by CLI startup path).
2. Default: `WORKFLOW.md` in the current process working directory.

If the file cannot be read, return `missing_workflow_file` error. The workflow file is expected to be repository-owned and version-controlled.

## File Format

`WORKFLOW.md` is a Markdown file with optional YAML front matter.

`WORKFLOW.md` SHOULD be self-contained enough to describe and run different workflows (prompt, runtime settings, hooks, and tracker selection/config) without requiring out-of-band service-specific configuration.

### Parsing Rules

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter must decode to a map/object; non-map YAML is an error.
- Prompt body is trimmed before use.

### Returned Workflow Object

- `config`: front matter root object (not nested under a `config` key).
- `prompt_template`: trimmed Markdown body.

## Front Matter Schema

Top-level keys:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`

Unknown keys SHOULD be ignored for forward compatibility. The front matter is extensible — optional extensions may define additional top-level keys without changing the core schema.

### `tracker` (object)

| Field | Default | Description |
|-------|---------|-------------|
| `kind` | (required) | Tracker type. Supported: `github`, `linear` |
| `endpoint` | varies by kind | API endpoint URL |
| `api_key` | env var | Literal token or `$VAR_NAME`. If `$VAR_NAME` resolves to empty, treat as missing. |
| `project_slug` | (required) | Project identifier for dispatch |
| `active_states` | `["Todo", "In Progress"]` | States considered active |
| `terminal_states` | `["Closed", "Cancelled", "Done"]` | States considered terminal |

### `polling` (object)

| Field | Default | Description |
|-------|---------|-------------|
| `interval_ms` | `30000` | Poll interval. Changes re-apply at runtime without restart. |

### `workspace` (object)

| Field | Default | Description |
|-------|---------|-------------|
| `root` | `<system-temp>/gctrl_workspaces` | Workspace directory. `~` and path separators expanded. |

### `hooks` (object)

| Field | Default | Description |
|-------|---------|-------------|
| `after_create` | — | Shell script run when workspace is newly created. Failure aborts creation. |
| `before_run` | — | Shell script run before each agent attempt. Failure aborts attempt. |
| `after_run` | — | Shell script run after each attempt. Failure logged, ignored. |
| `before_remove` | — | Shell script run before workspace deletion. Failure logged, ignored. |
| `timeout_ms` | `60000` | Timeout for all hooks. Non-positive falls back to default. |

### `agent` (object)

| Field | Default | Description |
|-------|---------|-------------|
| `max_concurrent_agents` | `10` | Max parallel agents. Re-applied at runtime. |
| `max_retry_backoff_ms` | `300000` | Max retry backoff. Re-applied at runtime. |
| `max_concurrent_agents_by_state` | `{}` | Per-state concurrency limits. Keys normalized to lowercase. |

## Prompt Template

The Markdown body of `WORKFLOW.md` is the per-issue prompt template.

### Rendering

- Use a strict template engine (Liquid-compatible semantics).
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

### Template Variables

| Variable | Type | Description |
|----------|------|-------------|
| `issue` | object | All normalized issue fields (title, labels, blockers, etc.) |
| `attempt` | integer or null | `null` on first attempt, integer on retry |

### Fallback

- If prompt body is empty, the runtime MAY use a minimal default prompt.
- File read/parse failures are configuration errors and MUST NOT silently fall back.

## Validation and Errors

| Error Class | Description |
|-------------|-------------|
| `missing_workflow_file` | File not found |
| `workflow_parse_error` | YAML parse failure |
| `workflow_front_matter_not_a_map` | Front matter is not a YAML map |
| `template_parse_error` | Prompt template syntax error |
| `template_render_error` | Unknown variable/filter during render |

Workflow file errors block new dispatches until fixed. Template errors fail only the affected run attempt.
