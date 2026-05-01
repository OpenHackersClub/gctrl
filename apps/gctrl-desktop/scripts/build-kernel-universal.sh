#!/usr/bin/env bash
# Build the gctrl Rust kernel as a macOS universal2 (arm64 + x86_64) binary
# and stage it under `apps/gctrl-desktop/resources/kernel/` for inclusion in
# the Electron bundle as `extraResources`.
#
# Requires: rustup with both apple-darwin targets, zig, and cargo-zigbuild.
#   brew install zig
#   cargo install --locked cargo-zigbuild
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin

set -euo pipefail

# Resolve paths — script runs from anywhere; targets are computed relative
# to this script's directory so `pnpm release` and CI both work the same way.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="$(cd "${PACKAGE_ROOT}/../.." && pwd)"

OUT_DIR="${PACKAGE_ROOT}/resources/kernel"
TARGET="universal2-apple-darwin"
# Source binary defined in `kernel/crates/gctrl-cli/Cargo.toml`. The kernel
# daemon binary is `gctrld` (with the `d` suffix); we bundle it under a
# friendlier `gctrl-kernel` name so the desktop's path resolver doesn't have
# to know about the daemon convention.
BIN_NAME="gctrld"
DEST_NAME="gctrl-kernel"

echo "[build-kernel] workspace: ${WORKSPACE_ROOT}"
echo "[build-kernel] target: ${TARGET}"

# Sanity-check toolchain so failures surface at the top of the log instead
# of mid-cargo.
command -v cargo >/dev/null || { echo "[build-kernel] cargo not found"; exit 1; }
command -v zig >/dev/null || { echo "[build-kernel] zig not found — brew install zig"; exit 1; }
command -v cargo-zigbuild >/dev/null || { echo "[build-kernel] cargo-zigbuild not found — cargo install --locked cargo-zigbuild"; exit 1; }

cd "${WORKSPACE_ROOT}"

cargo zigbuild \
  --release \
  --workspace \
  --target "${TARGET}" \
  --bin "${BIN_NAME}"

mkdir -p "${OUT_DIR}"
cp "target/${TARGET}/release/${BIN_NAME}" "${OUT_DIR}/${DEST_NAME}"

echo "[build-kernel] staged ${OUT_DIR}/${DEST_NAME}"
file "${OUT_DIR}/${DEST_NAME}"
