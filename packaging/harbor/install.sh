#!/usr/bin/env bash
# install.sh — stage Spell into a Harbor / Terminal-Bench task container.
#
# Run by Harbor during BaseInstalledAgent.install(). Installs a *portable*
# Spell binary (built against an old-glibc sysroot + static libstdc++ — see
# build-portable-native.sh and README.md) plus the autonomous domain spec.
#
# Portability note (measured): the default repo `.node` is built on a bleeding
# -edge host (glibc 2.43) and will NOT load in older-glibc or musl containers.
# The artifact this script installs MUST be the portable one. We verify the
# native addon actually loads before declaring success — fail loud otherwise.
set -euo pipefail

SPELL_PREFIX="${SPELL_PREFIX:-/opt/spell}"
SPELL_BIN="${SPELL_PREFIX}/spell"
DOMAIN_DST="/root/.spell"

# Source of the prebuilt artifacts. Either baked into the agent image at
# /spell-dist (preferred — built in CI by build-portable-native.sh) or fetched.
DIST_DIR="${SPELL_DIST_DIR:-/spell-dist}"

echo "==> Installing Spell into ${SPELL_PREFIX}"
mkdir -p "${SPELL_PREFIX}" "${DOMAIN_DST}"

if [ ! -d "${DIST_DIR}" ]; then
  echo "✗ Spell dist not found at ${DIST_DIR}." >&2
  echo "  Build it first: packaging/harbor/build-portable-native.sh" >&2
  exit 1
fi

# 1. Binary (self-contained bun-compiled executable with embedded native addon).
cp "${DIST_DIR}/spell" "${SPELL_BIN}"
chmod +x "${SPELL_BIN}"

# 2. Autonomous domain spec → imported from the user spell.kdl so `--domain
#    harbor` resolves. A minimal user spell.kdl that imports the shipped spec.
cp "${DIST_DIR}/spell.autonomous.kdl" "${DOMAIN_DST}/spell.autonomous.kdl"
cat > "${DOMAIN_DST}/spell.kdl" <<'KDL'
// Harbor task container — import the autonomous/harbor domain definitions.
import "./spell.autonomous.kdl"
KDL

# 3. Verify the native addon LOADS in THIS container (the real portability
#    gate). `spell --version` exercises the napi load path; a glibc/musl
#    mismatch surfaces here as a symbol/relocation error, failing the install
#    loudly instead of at first tool call mid-benchmark.
echo "==> Verifying native addon loads"
if ! "${SPELL_BIN}" --version >/dev/null 2>&1; then
  echo "✗ Spell binary failed to load in this container." >&2
  echo "  Likely a libc mismatch — the installed .node was built for a" >&2
  echo "  different libc than this image. Rebuild with the matching target:" >&2
  echo "    glibc image → TARGET_VARIANT=baseline against an old-glibc sysroot" >&2
  echo "    musl image  → CROSS_TARGET=x86_64-unknown-linux-musl" >&2
  exit 1
fi

echo "✓ Spell installed and native addon verified: $(${SPELL_BIN} --version)"
