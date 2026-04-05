---
id: BOARD-13
project: BOARD
status: backlog
priority: none
labels: [enhancement, deployment]
created_by: debuggingfuture
github_issue: 5
---

# Add Cloudflare Worker deployment setup for gctl-board

Add Cloudflare Worker deployment setup for gctl-board web UI so the kanban board can be hosted and accessed remotely.

## Requirements

- Add wrangler.toml config for gctl-board Worker
- Configure Vite build output for Workers-compatible static asset serving
- Set up environment variables / secrets for kernel API base URL
- Add pnpm deploy / pnpm deploy:preview scripts
- Add GitHub Actions workflow for preview deploys on PR and production deploy on merge to main
- Document the deployment setup

## Considerations

- Board frontend needs to reach the kernel API — consider Cloudflare Tunnel or public API endpoint
- Evaluate Cloudflare Pages vs Workers for static site hosting
- Align with arch-taste.md patterns (Miniflare for local acceptance tests)
