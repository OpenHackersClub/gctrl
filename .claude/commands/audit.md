Run a full codebase quality audit — build, lint, tests, and acceptance criteria — then report results.

## Instructions

### 1. Run the Audit CLI

Execute the gctl audit command from the workspace root:

```
node shell/gctl-shell/dist/main.js audit
```

If the shell hasn't been built yet, build it first:

```
npm run build
```

### 2. Analyze Results

Parse the audit output. Each check reports PASS, FAIL, or WARN:

- **Build** — TypeScript compilation (tsup + DTS) for all workspace packages
- **Biome Lint** — static analysis on `shell/*/src/` and `apps/*/src/`
- **Tests (TS)** — vitest test suites across shell and apps
- **Acceptance Criteria** — unchecked `- [ ]` items in `specs/`

### 3. If Any Check Fails

For each failure:

1. Read the error output to identify the root cause
2. Attempt to fix the issue (type errors, lint violations, test failures)
3. Re-run the audit to confirm the fix

For lint issues, you can run with `--fix`:

```
node shell/gctl-shell/dist/main.js audit --fix
```

### 4. Report

Present results in this format:

```
## Audit Results

| Check               | Status | Details           |
|---------------------|--------|-------------------|
| Build               | PASS   |                   |
| Biome Lint          | PASS   | 0 errors, N warns |
| Tests (TS)          | PASS   | 22 passing        |
| Acceptance Criteria | WARN   | N unchecked items |

### Issues Found
1. ...

### Recommendations
1. ...
```

If everything passes, confirm the codebase is ready for PR.

$ARGUMENTS
