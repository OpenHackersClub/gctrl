---
name: pr-green
description: Autonomous loop that reviews a PR, diagnoses failing CI, applies fixes, commits, and pushes until the required checks pass or the iteration cap is reached. Use when a PR is ready-in-principle but CI is red and the failure looks mechanical. Usage - /pr-green <pr_number> [--max-cycles 3]
allowed-tools: Bash(gctrl gh:*) Bash(git:*) Bash(cargo:*) Bash(pnpm:*) Bash(bun:*) Bash(make:*) Read Edit Grep Glob
metadata:
  owner: gctrl-core
  stability: alpha
  scope: project
---

# /pr-green

Drive a pull request to green CI. Read the PR, read the failing runs, apply the smallest fix that could plausibly work, verify locally where possible, commit, push, and watch. Loop with a hard iteration cap. Stop cleanly when the failure class is not something a mechanical fix should handle.

## When to use

- A PR you own is mergeable-in-principle but CI is red.
- Failures look mechanical: lint, format, type errors, missing test snapshot, `cargo fmt`, `pnpm install` drift, deterministic unit-test breakage.
- Iterating manually would be repetitive churn.

Do NOT use when:

- The PR has requested-changes reviews open — address reviewer feedback first.
- The failure is a logic bug in code under review (that's what the human review is for).
- You suspect flake without a known cause — run once manually first to confirm.
- The branch targets `main` / `master` directly without a feature branch of its own.

## Inputs

- `pr_number` (required) — GitHub PR number.
- `max_cycles` (optional) — hard cap on diagnose-fix-push iterations. Default `3`.
- `skip_checks` (optional) — comma-separated check names to ignore (e.g. a known-flaky job). Default empty. Use sparingly; prefer fixing.
- `repo` (optional) — `owner/repo`; defaults to the current repo.

## Hard rules

1. **No force push.** Ever. If history rewriting would be needed, stop and hand back to the human.
2. **No `--no-verify`.** Respect pre-commit and commit-msg hooks. If a hook fails, fix the underlying issue, re-stage, and make a new commit.
3. **No amending.** New commits only. Each cycle produces a new commit with a descriptive message.
4. **Never edit files outside the PR's existing change surface unless the fix requires it.** Prefer the smallest possible diff.
5. **Never bypass gctrl guardrails.** If a command is blocked, stop.
6. **Stop on merge conflicts with base.** These require human judgement — do not auto-resolve.
7. **Cap at `max_cycles`.** If not green after N cycles, stop and summarise what changed and what's still red.

## Procedure

### 1. Orient

```sh
gctrl gh pr view <pr_number> --repo <repo> --format json
gctrl gh pr checks <pr_number> --repo <repo> --no-cache --format json
```

Capture: branch name, base branch, head SHA, list of checks with status, mergeable state, review state.

Exit 0 immediately if all required checks are `success`.

Exit 2 if `mergeable: false` due to base-branch conflict, or if there are `CHANGES_REQUESTED` reviews.

### 2. Sync local branch

```sh
git fetch origin
git checkout <branch>
git pull --ff-only origin <branch>
```

If `--ff-only` fails, stop — local branch has diverged and needs human attention.

### 3. Diagnose

For each failing check:

```sh
gctrl gh run list --branch <branch> --repo <repo> --limit 5 --format json
gctrl gh run view  <run_id>        --repo <repo> --no-cache
```

Parse the run logs. Categorise the failure:

| Category | Signal | Fix strategy |
|---|---|---|
| **Format** | `cargo fmt --check` diff, `prettier --check` mismatch | Run formatter, stage all formatted files |
| **Lint** | `clippy`, `eslint`, `biome` warnings-as-errors | Auto-fix with `--fix` where supported; hand-fix the remainder |
| **Type** | `tsc` error, `cargo check` type mismatch | Targeted edit at the reported file:line |
| **Unit test** | Assertion mismatch, snapshot drift | Update snapshot if trivially obvious; otherwise fix production code |
| **Build** | Missing dep, lockfile drift | `pnpm install`, `cargo update -p <crate>`, commit lockfile |
| **Infra / flake** | Timeout, network error, runner died | Re-run once via `gh run rerun`; if it fails again, stop |
| **Secrets / auth** | 401/403 from external API | Stop — not a code fix |
| **Policy** | Guardrail / spec-audit rejection | Address root cause; do not bypass |

### 4. Apply the smallest plausible fix

Prefer:

1. Running the canonical fixer (`cargo fmt`, `pnpm biome check --write`, etc.).
2. A targeted edit at the reported line.
3. A lockfile regeneration if dependency drift is the cause.

Forbid:

1. Broad refactors.
2. Disabling the failing test or lint rule.
3. Adding `@ts-ignore`, `#[allow(...)]`, `eslint-disable` as a shortcut unless the human clearly requested it.
4. Touching unrelated files.

### 5. Verify locally where possible

Run the same tool locally before pushing:

```sh
# Examples — pick the ones relevant to the failing check
cargo fmt --check && cargo clippy --all-targets -- -D warnings
pnpm -w check
pnpm --filter <pkg> test -- --run
```

If the local check still fails, iterate on the fix before committing.

### 6. Commit and push

Write the commit message to `.tmp/commit-msg-pr-green-<pr_number>-<cycle>.txt` first (per CLAUDE.md convention), then:

```sh
git add -- <specific files>
git commit -F .tmp/commit-msg-pr-green-<pr_number>-<cycle>.txt
git push origin <branch>                    # never --force
```

Commit message shape:

```
fix(ci): <category> — <one-line summary>

<2-3 lines explaining which check failed and the minimal fix applied>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### 7. Watch

```sh
gctrl gh run watch --branch <branch> --repo <repo> --interval 15 --timeout 1200
```

`gctrl gh run watch` exits with:

- `0` — run succeeded
- `1` — run failed (return to step 1 with `cycle + 1`)
- `3` — cancelled / other (stop and report)

### 8. Loop or stop

- If green: emit final report (below), exit 0.
- If red and `cycle < max_cycles`: loop to step 1.
- If `cycle == max_cycles`: emit final report, exit 1.

## Output contract

Emit a JSON summary to stdout at exit:

```json
{
  "pr": 99,
  "branch": "feat/thing",
  "final_status": "green | red | aborted",
  "cycles_used": 2,
  "cycles_max": 3,
  "commits_pushed": [
    { "sha": "...", "category": "format", "summary": "cargo fmt on 3 files" },
    { "sha": "...", "category": "lint",   "summary": "clippy needless_clone" }
  ],
  "remaining_failures": [
    { "check": "integration-tests", "run_id": 123, "category": "unit-test", "note": "test_roundtrip asserts 42 == 41, requires human judgement" }
  ],
  "aborted_reason": null
}
```

On stderr: the running narrative — what was tried, what was observed, why the loop exited.

## Failure modes

| Case | Behaviour |
|---|---|
| PR has `CHANGES_REQUESTED` review | Exit 2 without touching the branch. |
| Base-branch merge conflict | Exit 2, tell caller to rebase/merge manually. |
| Fix would require touching files outside PR scope | Exit 1 with the list of files; do not edit. |
| Hook failure after commit attempt | Retry once after addressing hook output; escalate to caller if persistent. |
| Guardrail blocks a command | Stop immediately, report which command and guardrail. |
| `max_cycles` exhausted | Exit 1 with the remaining failure list; do not push a partial fix. |

## Interaction with other skills

- `/review` — run before `/pr-green` if the PR hasn't had a code review yet. `/pr-green` assumes the diff is correct in principle.
- `/risk-scan` — run before `/pr-green` on high-blast-radius changes; `/pr-green` should refuse to auto-push if `/risk-scan` flagged the PR.
- `/memorize` — after `/pr-green` succeeds, consider memorising the root cause of any non-obvious failure (e.g. "snapshot drifted because tzdata was bumped in upstream image").

## Future

When `gctrl` sessions and guardrails are deeper:

- Register each cycle as a sub-session of a parent `pr-green:<pr>` session; cost-attribute the loop correctly.
- Gate `max_cycles` and allowed fix categories through persona-level capability grants (so `reviewer-bot` can propose fixes but only `engineer` can push them).
- Persist the failure→fix pairs as `entity_observations` on the affected modules to speed future diagnoses.
