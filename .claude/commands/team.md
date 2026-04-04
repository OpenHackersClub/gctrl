Spawn a team of specialist agents for a task — each with the right persona and system prompt.

> **Thin bridge**: Persona data is managed by the kernel (`persona_definitions` table).
> This skill calls `gctl persona` and `gctl team` CLI commands to resolve and render prompts.
> Edit personas in `specs/team/personas.md` and run `gctl persona seed` to update the kernel.

## Instructions

### 1. Load Available Personas

Read `specs/team/personas.md` to understand the 7 specialist roles.

Run `gctl persona list --format json` to get kernel-stored personas. If empty, run `gctl persona seed` first.

### 2. Resolve Team

If $ARGUMENTS provides labels, issue key, PR type, or task description:

1. Run `gctl team recommend --labels <extracted-labels> --format json` to get the recommended team.
2. If a `--pr-type` is provided (e.g., `new_kernel_primitive`, `new_cli_command`, `new_application`, `guardrail_change`, `ci_cd_change`, `spec_change`), use `gctl team recommend --pr-type <type> --format json` instead.

If no arguments provided, show the available personas and ask the user what work needs a team.

### 3. Render Prompts

For each recommended persona, get the rendered system prompt:

```
gctl team render <comma-separated-persona-ids> --format json
```

If an issue key is available, include it: `gctl team render <ids> --issue <key> --format json`

### 4. Spawn Agents

For each persona in the rendered response, spawn a subagent using the Agent tool:

- **Name**: Use the persona name (e.g., "Principal Fullstack Engineer")
- **Prompt**: Use the rendered system prompt from step 3, followed by the task description from $ARGUMENTS
- Launch agents **in parallel** when they are independent (e.g., multiple reviewers)
- Launch agents **sequentially** when one depends on another's output

### 5. Synthesize

After all agents complete:

1. **Summarize** each persona's findings or output in a concise section
2. **Flag conflicts** between persona perspectives (e.g., Security wants more validation vs. UX wants simpler CLI)
3. If conflicts exist, apply the **Tech Lead** resolution pattern: evaluate the trade-off, document the rationale
4. **Recommend** concrete next steps

$ARGUMENTS
