---
id: BOARD-15
project: BOARD
status: backlog
priority: none
labels: [enhancement, ci-cd]
created_by: debuggingfuture
github_issue: 7
---

# Add GitHub Actions CI/CD — build, test, deployment

Add GitHub Actions CI/CD pipeline for gctl: build, test, and deployment.

## CI (on every PR + push to main)

- Rust: `cargo build --workspace` + `cargo test --workspace`
- Shell: `pnpm test` (vitest)
- Board app: `pnpm test` (vitest)
- Board web: `pnpm build:web` (Vite + TypeScript check)
- Biome lint: `biome lint` across shell + apps

## Acceptance tests (on PR)

- Playwright tests against in-memory kernel (`cargo run -- --db :memory: serve`)
- Cache Rust build artifacts + pnpm store for speed

## Deployment (on merge to main)

- Build gctl-board web assets (`pnpm build:web`)
- Deploy to Cloudflare Pages/Workers (see BOARD-13)
- Optionally: publish kernel binary as GitHub Release artifact
