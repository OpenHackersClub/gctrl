#!/usr/bin/env bash
# Build the gctrl Rust kernel as a macOS universal2 (arm64 + x86_64) binary
# and stage it under `apps/gctrl-desktop/resources/kernel/` for inclusion in
# the Electron bundle as `extraResources`.
#
# Requires: macOS host, rustup with both apple-darwin targets.
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#
# Implementation note — why not cargo-zigbuild?
# We tried zigbuild for single-command universal2 output, but zig's C
# toolchain is incompatible with the `ring` crate's assembly: zig's `ar`
# fails to link `libring_core_*.a`. Vanilla cargo + `lipo` works because
# each per-arch build uses Apple's own toolchain (arm64 native, x86_64
# cross-compiled via the Apple SDK that ships with Xcode/macOS).

set -euo pipefail

# Resolve paths — script runs from anywhere; targets are computed relative
# to this script's directory so `pnpm release` and CI both work the same way.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="$(cd "${PACKAGE_ROOT}/../.." && pwd)"

OUT_DIR="${PACKAGE_ROOT}/resources/kernel"
# Source binary defined in `kernel/crates/gctrl-cli/Cargo.toml`. The kernel
# daemon binary is `gctrld` (with the `d` suffix); we bundle it under a
# friendlier `gctrl-kernel` name so the desktop's path resolver doesn't have
# to know about the daemon convention.
BIN_NAME="gctrld"
DEST_NAME="gctrl-kernel"

echo "[build-kernel] workspace: ${WORKSPACE_ROOT}"

# Sanity-check toolchain so failures surface at the top of the log instead
# of mid-cargo.
command -v cargo >/dev/null || { echo "[build-kernel] cargo not found"; exit 1; }
command -v lipo >/dev/null || { echo "[build-kernel] lipo not found — macOS host required"; exit 1; }

cd "${WORKSPACE_ROOT}"

echo "[build-kernel] building aarch64-apple-darwin (host arch on Apple Silicon)..."
cargo build \
  --release \
  --target aarch64-apple-darwin \
  --workspace \
  --bin "${BIN_NAME}"

echo "[build-kernel] building x86_64-apple-darwin (cross-compile via Apple SDK)..."
cargo build \
  --release \
  --target x86_64-apple-darwin \
  --workspace \
  --bin "${BIN_NAME}"

echo "[build-kernel] fusing into universal2 with lipo..."
mkdir -p "${OUT_DIR}"
lipo -create -output "${OUT_DIR}/${DEST_NAME}" \
  "target/aarch64-apple-darwin/release/${BIN_NAME}" \
  "target/x86_64-apple-darwin/release/${BIN_NAME}"

echo "[build-kernel] staged ${OUT_DIR}/${DEST_NAME}"
file "${OUT_DIR}/${DEST_NAME}"
