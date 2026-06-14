#!/usr/bin/env bash
# build-portable-native.sh — build a Spell dist that loads in arbitrary
# Terminal-Bench task containers.
#
# WHY (measured, 2026-06-14): the repo's committed `.node` is built on a
# bleeding-edge host (glibc 2.43, newest libstdc++) and encodes that as a
# MINIMUM. It fails to load on every realistic TB image:
#   ubuntu:24.04 (glibc 2.39) → `GLIBC_2.43 not found`
#   ubuntu:22.04 (glibc 2.35) → + CXXABI_1.3.15, GLIBC_2.39 not found
#   debian:12    (glibc 2.36) → same
#   alpine:3.20  (musl)       → no libstdc++/libgcc at all, ~45 symbol errors
# CPU-ISA is already handled by TARGET_VARIANT=baseline; libc is the open axis.
#
# FIX: build the dist `.node` against an OLD-glibc sysroot (glibc 2.28 floor,
# backward-compatible up to 2.43) + static libstdc++/libgcc to erase the CXXABI
# axis. One artifact then loads on every glibc container >= 2.28. Optional musl
# target covers Alpine.
#
# Output: ./dist/{spell, spell.autonomous.kdl} — consumed by install.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/packaging/harbor/dist}"
TARGET="${TARGET:-glibc}"  # glibc | musl

mkdir -p "${OUT_DIR}"

case "${TARGET}" in
  glibc)
    # manylinux_2_28 = glibc 2.28 floor. Static C++ runtime erases CXXABI.
    export TARGET_VARIANT="baseline"             # x86-64-v1: no AVX2/SIGILL
    export RUSTFLAGS="-C target-feature=+crt-static -C link-arg=-static-libstdc++ -C link-arg=-static-libgcc"
    echo "==> Building glibc-floor native (baseline ISA, static libstdc++)"
    echo "    Run this INSIDE a manylinux_2_28 / Debian 11 container for the"
    echo "    glibc 2.28 floor. RUSTFLAGS=${RUSTFLAGS}"
    ;;
  musl)
    export CROSS_TARGET="x86_64-unknown-linux-musl"
    export TARGET_VARIANT="baseline"
    export RUSTFLAGS="-C target-feature=+crt-static"
    echo "==> Building musl native (static): CROSS_TARGET=${CROSS_TARGET}"
    rustup target add x86_64-unknown-linux-musl 2>/dev/null || true
    ;;
  *)
    echo "✗ Unknown TARGET=${TARGET} (expected glibc|musl)" >&2
    exit 1
    ;;
esac

cd "${REPO_ROOT}"

# 1. Build the native addon for the target libc/ISA.
echo "==> bun run build:native"
bun --cwd=packages/natives run build:native

# 2. Compile the self-contained Spell binary (embeds the native addon).
echo "==> bun build --compile"
bun --cwd=packages/coding-agent run build:binary

# 3. Stage dist.
cp "${REPO_ROOT}/packages/coding-agent/dist/spell" "${OUT_DIR}/spell"
cp "${REPO_ROOT}/spell.autonomous.kdl" "${OUT_DIR}/spell.autonomous.kdl"

echo "✓ Dist staged at ${OUT_DIR}"
echo "  Verify portability with: packaging/harbor/probe-libc.sh ${OUT_DIR}/spell"
