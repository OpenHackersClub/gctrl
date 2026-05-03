---
description: Bootstrap a new gctrl native app — scaffold apps/<name>/vault/ with PRD.md, WORKFLOW.md, ROADMAP.md. PRD generated via kernel LLM relay.
argument-hint: <name> [<one-line description>]
---

Run the `bootstrap-gctrl-app` skill with arguments: `$ARGUMENTS`.

Parse `$ARGUMENTS` as: first whitespace-separated token is the app `<name>` (kebab-case slug, e.g. `gctrl-watch`); the remainder (if any) is the one-line description. If `<name>` is missing, ask the user for it before proceeding.

Then follow the skill's procedure exactly — pre-flight (CWD, collision, kernel `:4318/health`, feature branch), create the app's vault at `apps/<name>/vault/`, generate `apps/<name>/vault/PRD.md` via `POST :4318/v1/chat/completions` grounded in `apps/gctrl-board/vault/specs/workflows/prd-template.md` + one exemplar, generate `apps/<name>/vault/WORKFLOW.md` and `apps/<name>/vault/ROADMAP.md` (NEVER at the app top level — see AGENTS.md § Application Specs), and report. Do not commit or push.
