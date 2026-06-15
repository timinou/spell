#!/usr/bin/env bash
# build-portable-native.sh — ONE command to produce a Spell dist that runs in
# arbitrary Terminal-Bench task containers.
#
# Output: spell_harbor/dist/
#   spell                — self-contained binary (glibc-2.28 floor, baseline ISA)
#   spell.autonomous.kdl — the autonomous + harbor domain spec
#
# SAFETY: this NEVER touches your working tree. The repo is mounted READ-ONLY
# at /src; the build copies it into a container-local /build and works there. A
# failed build can't delete or corrupt your local pi_natives .node. (An earlier
# version mounted the live repo read-write and rm'd the addon before a failing
# build — that broke local spell. Never again.)
#
# PROVEN (2026-06-14): the addon built this way require()s + inits on
# ubuntu:24.04 / 22.04 / debian:12 — where the committed Arch-host .node
# (GLIBC_2.43) fails. glibc symbol versioning is backward-compatible
# (2.28->latest); CPU-ISA handled by baseline x86-64. Built INSIDE
# manylinux_2_28 (glibc 2.28 + gcc 14) so the binary inherits the low floor.
#
# NB the pi-knowledge-worker binary (fastembed->ort) is NOT required: ort's
# prebuilt onnxruntime emits glibc-2.38 symbols that don't link against 2.28,
# AND the harbor profile never invokes it (PI_KNOWLEDGE_WORKER=inprocess +
# embeddings off => org/memory run in-process via pi-natives BM25+graph; the
# vector lane that would call the worker is weight-zeroed). org/memory still work.
#
# Usage:  spell_harbor/build-portable-native.sh             # glibc (default)
#         TARGET=musl spell_harbor/build-portable-native.sh # Alpine tasks
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/spell_harbor/dist"
TARGET="${TARGET:-glibc}"
mkdir -p "${OUT_DIR}"

case "${TARGET}" in
  glibc) IMAGE="quay.io/pypa/manylinux_2_28_x86_64" ;;
  musl)  IMAGE="rust:alpine" ;;
  *) echo "Unknown TARGET=${TARGET} (expected glibc|musl)" >&2; exit 1 ;;
esac

echo "==> Building Spell dist (${TARGET}) inside ${IMAGE}"
echo "    Isolated copy build; your tree is read-only. First run ~10-20 min."

HOST_UID="$(id -u)"; HOST_GID="$(id -g)"

docker run --rm \
  -e HOST_UID="${HOST_UID}" -e HOST_GID="${HOST_GID}" \
  -v "${REPO_ROOT}":/src:ro \
  -v "${OUT_DIR}":/out \
  "${IMAGE}" bash -euo pipefail -c '
  trap "chown -R ${HOST_UID}:${HOST_GID} /out 2>/dev/null || true" EXIT
  export CARGO_HOME=/build/.cargo CARGO_TARGET_DIR=/build/target PATH=$HOME/.bun/bin:$PATH
  export RUSTFLAGS="-C target-cpu=x86-64" TARGET_VARIANT=baseline

  echo "==> copy repo into isolated /build (your tree is read-only at /src)"
  mkdir -p /build && cp -a /src/. /build/ && cd /build
  rm -f packages/natives/native/pi_natives.*.node packages/natives/native/pi-knowledge-worker*

  echo "==> install rust (nightly) + bun"
  command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly --profile minimal >/tmp/rustup.log 2>&1
  source "$CARGO_HOME/env"
  command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/tmp/bun.log 2>&1

  echo "==> bun install"; bun install --frozen-lockfile >/tmp/install.log 2>&1 || bun install >/tmp/install.log 2>&1

  echo "==> build pi-natives addon (baseline; worker non-fatal/unused)"
  bun --cwd=packages/natives run build:native || true

  ADDON=$(find packages/natives/native -name "pi_natives*.node" | head -1)
  [ -n "$ADDON" ] || { echo "pi-natives addon was not built" >&2; tail -40 /tmp/install.log 2>/dev/null; exit 1; }
  FLOOR=$(objdump -T "$ADDON" 2>/dev/null | grep -oE "GLIBC_[0-9.]+" | sort -V | uniq | tail -1)
  echo "==> embedded addon ($ADDON) GLIBC floor: ${FLOOR}"
  case "$FLOOR" in GLIBC_2.2[0-9]|GLIBC_2.1?) : ;; *) echo "addon floor ${FLOOR} too high - stale artifact" >&2; exit 1 ;; esac

  echo "==> compile self-contained binary"; bun --cwd=packages/coding-agent run build:binary
  cp packages/coding-agent/dist/spell /out/spell
  # Ship the addon as a SIDECAR file too. bun --compile records the addon in the
  # binary manifest but does NOT embed .node as an fs-readable blob, so at
  # runtime the loader reads it from ~/.spell/natives/<version>/ instead. The
  # adapter uploads this sidecar there. (On a dev host the loader silently falls
  # back to the workspace native/ dir; a clean container has neither, hence the
  # sidecar.)
  VER=$(grep -m1 "\"version\"" packages/natives/package.json | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")
  cp "$ADDON" "/out/$(basename "$ADDON")"
  echo "$VER" > /out/.natives-version
  echo "==> sidecar addon: $(basename "$ADDON") for natives version $VER"
  echo "==> binary glibc floor: $(objdump -T /out/spell 2>/dev/null | grep -oE "GLIBC_[0-9.]+" | sort -V | uniq | tail -1)"
'

cp "${REPO_ROOT}/spell.autonomous.kdl" "${OUT_DIR}/spell.autonomous.kdl"
chmod +x "${OUT_DIR}/spell"

echo "Dist ready: ${OUT_DIR}/{spell, spell.autonomous.kdl}"
echo "Prove it loads:  spell_harbor/probe-libc.sh ${OUT_DIR}/spell ubuntu:24.04"
