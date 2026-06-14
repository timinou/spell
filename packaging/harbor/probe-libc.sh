#!/usr/bin/env bash
# probe-libc.sh — verify a Spell native addon loads across the libc spectrum.
#
# Codifies the de-risk measurement: mount an artifact into containers spanning
# glibc (new→old) and musl, and check symbol resolution. Use after
# build-portable-native.sh to PROVE portability rather than assume it.
#
# Usage: probe-libc.sh <path-to-.node-or-binary> [img1 img2 ...]
set -euo pipefail

ARTIFACT="${1:?usage: probe-libc.sh <artifact> [images...]}"
shift || true
IMAGES=("$@")
if [ ${#IMAGES[@]} -eq 0 ]; then
  IMAGES=(ubuntu:24.04 ubuntu:22.04 debian:12 alpine:3.20)
fi

ABS="$(cd "$(dirname "${ARTIFACT}")" && pwd)/$(basename "${ARTIFACT}")"
echo "Probing: ${ABS}"
echo "Max GLIBC demanded by artifact:"
objdump -T "${ABS}" 2>/dev/null | grep -oE 'GLIBC_[0-9.]+' | sort -V | uniq | tail -1 || true
echo

fail=0
for img in "${IMAGES[@]}"; do
  echo "==================== ${img} ===================="
  out="$(docker run --rm -v "${ABS}":/probe.node:ro "${img}" sh -c '
    bad=$(ldd /probe.node 2>&1 | grep -iE "not found|version .* not found|undefined symbol" || true)
    if [ -n "$bad" ]; then echo "$bad"; exit 1; fi
    echo "(all deps resolved)"
  ' 2>&1 || true)"
  echo "${out}" | sed 's/^/  /'
  if echo "${out}" | grep -qiE "not found|undefined symbol"; then
    echo "  ✗ FAIL on ${img}"
    fail=1
  else
    echo "  ✓ OK on ${img}"
  fi
done

if [ "${fail}" -ne 0 ]; then
  echo "✗ Portability probe FAILED — artifact will not load in some TB images."
  exit 1
fi
echo "✓ Portability probe PASSED across: ${IMAGES[*]}"
