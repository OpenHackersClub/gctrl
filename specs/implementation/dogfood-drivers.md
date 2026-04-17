# Dogfooding Plan — gh & wrangler Drivers

gctl's invariant: **shell and CI never call external CLIs directly**. All
external tooling flows through a kernel driver (LKM) exposed over the kernel
HTTP API (`:4318`). This pins the driver surface the project depends on and
makes sure gctl is its own first user.

## Current State (2026-04-17)

| Tool      | Shell surface                     | Kernel routes             | CI usage                                          |
|-----------|-----------------------------------|---------------------------|---------------------------------------------------|
| `gh`      | `gctl gh {issues,prs,runs}`       | `/api/github/*` (read+create) | `.claude/hooks/pre-pr-check.sh` greps `gh pr create`; `deploy.yml` uses `actions/github-script` for PR comments |
| `wrangler`| *(none)*                          | *(none)*                  | `.github/workflows/deploy.yml` calls `pnpm exec wrangler d1 …` and `cloudflare/wrangler-action@v3` |
| `dotenvx` | npm scripts (`env:encrypt/decrypt/run`) | n/a (local secrets only) | not yet wired                                      |

## `gctl gh` — Gap Fill

Mirror the existing inline driver in `kernel/crates/gctl-otel/src/receiver.rs`
(90-95, 1100-1256). Extract to a dedicated `gctl-driver-github` crate once it
outgrows the receiver module.

Missing ops to add, in priority order:

1. **`gctl gh prs create`** — `POST /api/github/prs` (delegates to `gh pr create`)
2. **`gctl gh prs comment <#>`** — `POST /api/github/prs/{n}/comments`
3. **`gctl gh prs diff <#>`** — `GET /api/github/prs/{n}/diff` (text/plain)
4. **`gctl gh prs checks <#>`** — `GET /api/github/prs/{n}/checks`
5. **`gctl gh prs merge <#>`** — `POST /api/github/prs/{n}/merge`
6. **`gctl gh runs watch <id>`** — `GET /api/github/runs/{id}/watch` (SSE; polls `gh run view --json`)
7. **`gctl gh issues comment <#>`** — `POST /api/github/issues/{n}/comments`
8. **`gctl gh workflow dispatch`** — `POST /api/github/workflows/{file}/dispatches`

Each op gets: axum handler → shell command → schema decode → 1 happy-path test
(mock `KernelClient`) + 1 integration test (real `gh` against a fixture repo
when `CI_INTEGRATION=1`).

## `gctl wrangler` — New Driver

New kernel surface under `/api/wrangler/*`, delegating to local `wrangler`
binary (already a root `devDependency`). Auth is resolved from the kernel
process environment (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`), which
dotenvx populates from the encrypted `.env.vault`.

Scope for v0:

1. **`gctl wrangler whoami`** — `GET /api/wrangler/whoami` (proves the pattern)
2. **`gctl wrangler d1 execute`** — `POST /api/wrangler/d1/{db}/execute` (body: `{ sql, env, remote }`)
3. **`gctl wrangler d1 migrations apply`** — `POST /api/wrangler/d1/{db}/migrations/apply`
4. **`gctl wrangler deploy`** — `POST /api/wrangler/deploy` (body: `{ env, dryRun }`)
5. **`gctl wrangler tail`** — `GET /api/wrangler/tail?env=…` (SSE — stream logs)

`deploy.yml` migrates as each op lands:

```yaml
# Before
- run: pnpm exec wrangler d1 migrations apply gctl-board-preview-db --env preview --remote

# After
- run: pnpm exec gctl wrangler d1 migrations apply gctl-board-preview-db --env preview --remote
```

`cloudflare/wrangler-action@v3` stays for now — replacing it requires the
kernel driver to expose everything the action does (publish + secrets). Park
until v1.

## `dotenvx` — Secrets

Dotenvx is a developer tool, not a kernel driver — the kernel reads env vars
directly from its process. Dotenvx only handles the encrypt/decrypt boundary.

Workflow:

- `.env` (plaintext) — gitignored, decrypted locally on demand.
- `.env.keys` — private key, **never committed** (dotenvx marks it so).
- `.env.vault` — encrypted envelope, **safe to commit**, read in CI.
- `.env.example` — schema/template, committed.

CI loads secrets with `pnpm exec dotenvx run -- <command>` once `.env.vault`
exists. For now it's not wired — production secrets still flow through GitHub
Actions repo secrets.

## Hook Policy

`.claude/settings.json` pre-tool-use hooks currently gate PR creation on
`npm run build` + `biome lint`. After `gctl gh prs create` lands, extend the
hook to *also* reject raw `gh pr create` in favour of `gctl gh prs create`,
completing the dogfood loop.

## Acceptance

Dogfooding is "done" when:

- [ ] `rg "\\bgh (pr|issue|run|workflow|api)\\b" .github/ .claude/` returns no matches outside this spec.
- [ ] `rg "\\bwrangler\\b" .github/ | grep -v "gctl wrangler"` returns no matches outside this spec.
- [ ] Pre-PR hook rejects raw `gh pr create`.
- [ ] `gctl gh prs create` used at least once in a published PR.
