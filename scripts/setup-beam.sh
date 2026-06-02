#!/bin/sh
# scripts/setup-beam.sh — BEAM (Elixir) runtime project setup
#
# Runs mix deps.get && mix compile in beam/ptc_runtime/ to fetch dependencies
# and compile the Elixir project. Restores original cwd on exit.
#
# Hooked into the prepare lifecycle in root package.json so the mix run --no-halt
# dev fallback in spawn.ts works out of the box on fresh checkouts.
# ---------------------------------------------------------------------------

BEAM_DIR="beam/ptc_runtime"

if which mix; then
  ORIG_DIR="$(pwd)"
  cd "$(dirname "$0")/../$BEAM_DIR"

  echo "  -> beam: fetching dependencies..."
  mix deps.get

  echo "  -> beam: compiling..."
  mix compile

  echo "  -> beam: ready."
  cd "$ORIG_DIR"
else
  echo "  -> beam: mix not found - skipping. Install Elixir to build the BEAM runtime."
fi
