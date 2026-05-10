#!/usr/bin/env bash
# Start kernel daemon (gctrld serve on :4318) and gctrl-board dev server together.
# Ctrl-C stops both.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

pids=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# If anything is already on :4318 (gctrl-desktop's bundled kernel sidecar, a
# brew/cargo `gctrld serve`, or some other listener), `cargo run -- serve`
# will fail to bind. Detect and bail with a hint instead of thrashing.
if lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[dev] something is already listening on :4318" >&2
  echo "[dev] inspect: lsof -nP -iTCP:4318 -sTCP:LISTEN" >&2
  echo "[dev] common causes: gctrl.app (quit it), or a brew/cargo gctrld serve" >&2
  exit 1
fi

echo "[dev] starting kernel on :4318..."
( cargo run -p gctrl-cli -- serve ) &
pids+=($!)

echo "[dev] waiting for kernel health on :4318..."
for _ in {1..120}; do
  if curl -sf http://127.0.0.1:4318/health >/dev/null 2>&1; then
    echo "[dev] kernel ready"
    break
  fi
  if ! kill -0 "${pids[0]}" 2>/dev/null; then
    echo "[dev] kernel exited before becoming healthy" >&2
    exit 1
  fi
  sleep 1
done

echo "[dev] starting gctrl-board dev server..."
( pnpm --filter gctrl-board dev ) &
pids+=($!)

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 1
done
