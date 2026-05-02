---
description: Bootstrap a new gctrl native app — scaffold apps/<name>/ with PRD.md, WORKFLOW.md, ROADMAP.md, vault/ stub. PRD generated via kernel LLM relay.
argument-hint: <name> [<one-line description>]
---

Run the `bootstrap-gctrl-app` skill with arguments: `$ARGUMENTS`.

Parse `$ARGUMENTS` as: first whitespace-separated token is the app `<name>` (kebab-case slug, e.g. `gctrl-watch`); the remainder (if any) is the one-line description. If `<name>` is missing, ask the user for it before proceeding.

Then follow the skill's procedure exactly — pre-flight (CWD, collision, kernel `:4318/health`, feature branch), generate `PRD.md` via `POST :4318/v1/chat/completions` grounded in `apps/gctrl-board/vault/specs/workflows/prd-template.md` + one exemplar, generate `WORKFLOW.md` and `ROADMAP.md`, stub `vault/`, and report. Do not commit or push.
