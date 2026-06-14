#!/usr/bin/env bash
# build-portable-native.sh — build a Spell native addon that loads in arbitrary
# Terminal-Bench task containers.
#
# PROVEN (2026-06-14): built pi-natives inside manylinux_2_28 (glibc 2.28) and
# verified the resulting .node `require()`s + initializes (not just resolves
# symbols) on ubuntu:24.04 / ubuntu:22.04 / debian:12 — the exact images the
# committed Arch-host .node (GLIBC_2.43) FAILS to load on. GLIBC floor 2.43→2.28.
#
# WHY: glibc symbol versioning is backward-compatible — a 2.28-built addon runs
# on 2.28→latest. CPU-ISA (SIGILL) is separately handled by x86-64 baseline.
#
# This script runs the build INSIDE the manylinux container (it has glibc 2.28 +
# gcc 14; it installs rustup nightly). For musl/Alpine, set TARGET=musl.
#
# Output: packaging/harbor/dist/pi_natives.<tag>.node — staged for install.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/packaging/harbor/dist}"
TARGET="${TARGET:-glibc}"  # glibc | musl
mkdir -p "${OUT_DIR}"

case "${TARGET}" in
  glibc) IMAGE="quay.io/pypa/manylinux_2_28_x86_64"; TAG="manylinux_2_28-x64" ;;
  musl)  IMAGE="rust:alpine";                        TAG="musl-x64" ;;
  *) echo "✗ Unknown TARGET=${TARGET} (expected glibc|musl)" >&2; exit 1 ;;
esac

echo "==> Building portable pi-natives (${TARGET}) in ${IMAGE}"

# In-container build script. Baseline ISA (x86-64-v1: no AVX2 → no SIGILL on
# old/cloud CPUs). cdylib (.so) renamed to .node for napi require().
cat > "${OUT_DIR}/.ml-build.sh" <<'SCRIPT'
set -euo pipefail
export CARGO_HOME=/tmp/cargo CARGO_TARGET_DIR=/tmp/ml-target
if ! command -v cargo >/dev/null 2>&1; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly --profile minimal >/tmp/rustup.log 2>&1
  source "$CARGO_HOME/env"
fi
export RUSTFLAGS="${RUSTFLAGS:-} -C target-cpu=x86-64"
cd /work
cargo build -p pi-natives --release
SO=$(find "$CARGO_TARGET_DIR/release" -maxdepth 1 -name 'libpi_natives.so' | head -1)
cp "$SO" "/work/packaging/harbor/dist/pi_natives.${TAG}.node"
echo "max GLIBC: $(objdump -T "/work/packaging/harbor/dist/pi_natives.${TAG}.node" 2>/dev/null | grep -oE 'GLIBC_[0-9.]+' | sort -V | uniq | tail -1)"
SCRIPT

docker run --rm -e "TAG=${TAG}" -v "${REPO_ROOT}":/work \
  "${IMAGE}" bash "/work/packaging/harbor/dist/.ml-build.sh"
rm -f "${OUT_DIR}/.ml-build.sh"

echo "✓ Native addon staged: ${OUT_DIR}/pi_natives.${TAG}.node"
echo "  Prove portability:  packaging/harbor/probe-libc.sh ${OUT_DIR}/pi_natives.${TAG}.node"
echo "  Then build the self-contained binary with this .node embedded:"
echo "    (inside the same manylinux image) bun --cwd=packages/coding-agent run build:binary"
