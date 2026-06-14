#!/usr/bin/env bash
# build-portable-native.sh — ONE command to produce a Spell dist that runs in
# arbitrary Terminal-Bench task containers.
#
# Output: packaging/harbor/dist/
#   spell                      — self-contained binary (glibc-2.28 floor, baseline ISA)
#   spell.autonomous.kdl       — the autonomous + harbor domain spec
#
# PROVEN (2026-06-14): the native addon built this way `require()`s + inits on
# ubuntu:24.04 / ubuntu:22.04 / debian:12 — where the committed Arch-host .node
# (GLIBC_2.43) fails. glibc symbol versioning is backward-compatible (2.28→latest);
# CPU-ISA handled by baseline x86-64. Everything runs INSIDE manylinux_2_28
# (glibc 2.28 + gcc 14) so the binary inherits the low floor.
#
# Usage:  packaging/harbor/build-portable-native.sh            # glibc (default)
#         TARGET=musl packaging/harbor/build-portable-native.sh # Alpine tasks
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/packaging/harbor/dist"
TARGET="${TARGET:-glibc}"
mkdir -p "${OUT_DIR}"

case "${TARGET}" in
  glibc) IMAGE="quay.io/pypa/manylinux_2_28_x86_64" ;;
  musl)  IMAGE="rust:alpine" ;;
  *) echo "✗ Unknown TARGET=${TARGET} (expected glibc|musl)" >&2; exit 1 ;;
esac

echo "==> Building full Spell dist (${TARGET}) inside ${IMAGE}"
echo "    This installs rust+bun in the container and compiles — first run ~10–20 min."

# Everything happens in one container invocation: native addon + embedded
# binary. The build script honors a pre-set RUSTFLAGS (build-native.ts guard),
# so baseline ISA propagates to the cdylib.
docker run --rm -v "${REPO_ROOT}":/work "${IMAGE}" bash -euo pipefail -c '
  export CARGO_HOME=/tmp/cargo CARGO_TARGET_DIR=/tmp/ml-target PATH=$HOME/.bun/bin:$PATH
  export RUSTFLAGS="-C target-cpu=x86-64"   # baseline: no AVX2 → no SIGILL
  echo "==> install rust (nightly) + bun"
  command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly --profile minimal >/tmp/rustup.log 2>&1
  source "$CARGO_HOME/env"
  command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/tmp/bun.log 2>&1
  cd /work
  echo "==> bun install"; bun install --frozen-lockfile >/tmp/install.log 2>&1 || bun install >/tmp/install.log 2>&1
  echo "==> build native addon (baseline)"; bun --cwd=packages/natives run build:native
  echo "==> compile self-contained binary"; bun --cwd=packages/coding-agent run build:binary
  cp packages/coding-agent/dist/spell /work/packaging/harbor/dist/spell
  echo "==> max GLIBC demanded by binary:"; objdump -T /work/packaging/harbor/dist/spell 2>/dev/null | grep -oE "GLIBC_[0-9.]+" | sort -V | uniq | tail -1 || true
'

cp "${REPO_ROOT}/spell.autonomous.kdl" "${OUT_DIR}/spell.autonomous.kdl"
chmod +x "${OUT_DIR}/spell"

echo "✓ Dist ready: ${OUT_DIR}/{spell, spell.autonomous.kdl}"
echo "  Prove it loads on TB images:"
echo "    packaging/harbor/probe-libc.sh ${OUT_DIR}/spell ubuntu:24.04"
