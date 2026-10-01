# Disk usage

The kernel reports build output sizes and offers scoped cleanup through `/api/disk/*`; the board renders a pie chart and removal candidates at `/disk`.

1. `GCTRL_DISK_ALLOWLIST` MUST be a JSON array of absolute directories. An empty or unset array exposes no filesystem candidates. The scan and removal MUST use directory-relative operations anchored to each allowed root, MUST skip symlinks, and MUST exclude overlapping roots from totals.
2. The kernel MUST suggest only directories with recognized build names and project markers: Rust `target` beside `Cargo.toml`; JavaScript `.next`, `.turbo`, `dist`, `build`, `out`, or `node_modules/.cache` beside a package manifest; Gradle `.gradle` or `build` beside a Gradle build file; and `cargo-target/<repo>/slot-<number>` when its slot lock is free. The API MUST reject removal of a root, a symlink, an unrecognized directory, an active Cargo slot, or a directory outside the allowlist. Removal MUST revalidate the path at click time.
3. Docker cache reporting and pruning MUST use the active local builder with the `docker` driver. The daemon data root MUST resolve to a host path inside `GCTRL_DISK_ALLOWLIST`, and `GCTRL_DOCKER_LOCAL_ROOT` MUST name that same host-mapped path. Remote Docker contexts MUST be refused. macOS and other non-Linux hosts MUST leave Docker cache reporting and pruning unavailable because a local socket can lead to a VM-backed daemon whose data root names a different filesystem.
4. Docker pruning MUST target a currently reclaimable cache record by its validated ID through `docker buildx prune --filter id=<id>`. The UI MUST display cache sizes as estimates because records can share storage.

Example operator configuration for a local Docker Engine host:

```sh
export GCTRL_DISK_ALLOWLIST='["/srv/workspaces","/var/lib/docker"]'
export GCTRL_DOCKER_LOCAL_ROOT='/var/lib/docker'
```

Endpoints: `GET /api/disk/usage`, `POST /api/disk/candidates/remove`, `GET /api/disk/docker`, and `POST /api/disk/docker/prune`. The implementation is in `kernel/crates/gctrl-otel/src/disk_usage.rs`; the view is in `apps/gctrl-board/web/src/pages/DiskPage.tsx`.
