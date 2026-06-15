#!/usr/bin/env bash
# scripts/detect-ryzenai-ort.sh — discover AMD RyzenAI ONNX Runtime provider libs.
#
# Purpose:
#   Find the canonical AMD RyzenAI deployment/lib directory that contains both
#   libonnxruntime.so and libonnxruntime_providers_{ryzenai,vitisai}.so, then
#   emit or apply the environment Spell needs for ort::load-dynamic.
#
# Usage:
#   scripts/detect-ryzenai-ort.sh
#   eval "$(scripts/detect-ryzenai-ort.sh --env)"
#   source scripts/detect-ryzenai-ort.sh
#   scripts/detect-ryzenai-ort.sh --probe-spell
#   scripts/detect-ryzenai-ort.sh --restart-worker
#
# Notes:
#   - This script does not install RyzenAI. Canonical install is AMD's
#     ryzen_ai-<version>.tgz Linux package, which creates a venv with
#     $RYZEN_AI_INSTALLATION_PATH/deployment/lib.
#   - It is safe on machines without RyzenAI: it exits non-zero and prints the
#     exact missing piece.

set -o pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SOURCED=0
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  SOURCED=1
fi

MODE="report"
PROBE_SPELL=0
RESTART_WORKER=0
QUIET=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/detect-ryzenai-ort.sh [options]
  eval "$(scripts/detect-ryzenai-ort.sh --env)"
  source scripts/detect-ryzenai-ort.sh

Options:
  --env              Print only export commands for eval/shell startup files.
  --source           Export variables into the current shell when sourced.
  --probe-spell      After detection, query Spell recall_stats with this env.
  --restart-worker   Kill the user-scoped pi-knowledge-worker after detection.
  -q, --quiet        Suppress explanatory report; errors still print.
  -h, --help         Show this help.

Exit codes:
  0  RyzenAI ORT + provider found and env emitted/applied.
  1  No usable provider found.
  2  Invalid arguments or unsupported shell usage.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      MODE="env"
      shift
      ;;
    --source)
      MODE="source"
      shift
      ;;
    --probe-spell)
      PROBE_SPELL=1
      shift
      ;;
    --restart-worker)
      RESTART_WORKER=1
      shift
      ;;
    -q|--quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      usage
      if [[ $SOURCED -eq 1 ]]; then return 0; else exit 0; fi
      ;;
    *)
      echo "$SCRIPT_NAME: unknown option: $1" >&2
      usage >&2
      if [[ $SOURCED -eq 1 ]]; then return 2; else exit 2; fi
      ;;
  esac
done

if [[ $SOURCED -eq 1 && "$MODE" == "report" ]]; then
  MODE="source"
fi

if [[ $SOURCED -eq 0 && "$MODE" == "source" ]]; then
  echo "$SCRIPT_NAME: --source only works when the script is sourced" >&2
  echo "Use: source scripts/detect-ryzenai-ort.sh" >&2
  exit 2
fi


say() {
  if [[ $QUIET -eq 0 && "$MODE" != "env" ]]; then
    printf '%s\n' "$*"
  fi
}

warn() {
  if [[ "$MODE" != "env" ]]; then
    printf 'warning: %s\n' "$*" >&2
  fi
}

err() {
  if [[ "$MODE" != "env" ]]; then
    printf 'error: %s\n' "$*" >&2
  fi
}

quote() {
  printf '%q' "$1"
}

add_unique_dir() {
  local dir="$1"
  [[ -n "$dir" ]] || return 0
  dir="${dir/#\~/$HOME}"
  [[ -d "$dir" ]] || return 0
  local existing
  for existing in "${CANDIDATE_DIRS[@]}"; do
    [[ "$existing" == "$dir" ]] && return 0
  done
  CANDIDATE_DIRS+=("$dir")
}

add_dir_from_file() {
  local file="$1"
  [[ -n "$file" ]] || return 0
  add_unique_dir "$(dirname "$file")"
}

first_match() {
  local pattern="$1"
  local matches=()
  mapfile -t matches < <(compgen -G "$pattern" | sort -V)
  [[ ${#matches[@]} -gt 0 ]] || return 1
  printf '%s\n' "${matches[$((${#matches[@]} - 1))]}"
}

find_ort_in_dir() {
  local dir="$1"
  local exact="$dir/libonnxruntime.so"
  if [[ -f "$exact" || -L "$exact" ]]; then
    printf '%s\n' "$exact"
    return 0
  fi
  first_match "$dir/libonnxruntime.so*"
}

find_provider_in_dir() {
  local dir="$1"
  local exact
  for exact in \
    "$dir/libonnxruntime_providers_ryzenai.so" \
    "$dir/libonnxruntime_providers_vitisai.so"; do
    if [[ -f "$exact" || -L "$exact" ]]; then
      printf '%s\n' "$exact"
      return 0
    fi
  done
  first_match "$dir/libonnxruntime_providers_ryzenai.so*" && return 0
  first_match "$dir/libonnxruntime_providers_vitisai.so*" && return 0
  return 1
}

ort_version() {
  local ort="$1"
  command -v python3 >/dev/null 2>&1 || return 1
  LD_LIBRARY_PATH="$(dirname "$ort"):${LD_LIBRARY_PATH:-}" python3 - "$ort" <<'PY'
import ctypes
import sys

path = sys.argv[1]
try:
    lib = ctypes.CDLL(path)
    lib.OrtGetApiBase.restype = ctypes.c_void_p
    ptr = lib.OrtGetApiBase()
    if not ptr:
        raise RuntimeError("OrtGetApiBase returned NULL")
    GetApi = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_uint32)
    GetVersionString = ctypes.CFUNCTYPE(ctypes.c_char_p)
    class OrtApiBase(ctypes.Structure):
        _fields_ = [("GetApi", GetApi), ("GetVersionString", GetVersionString)]
    base = ctypes.cast(ptr, ctypes.POINTER(OrtApiBase)).contents
    version = base.GetVersionString()
    print(version.decode("utf-8") if version else "unknown")
except Exception as exc:
    print(f"ERROR: {exc}")
    sys.exit(1)
PY
}

version_minor() {
  local version="$1"
  [[ "$version" =~ ^[0-9]+\.([0-9]+)\. ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

provider_dlopen_check() {
  local provider="$1"
  local lib_dir="$2"
  command -v python3 >/dev/null 2>&1 || return 2
  LD_LIBRARY_PATH="$lib_dir:${LD_LIBRARY_PATH:-}" python3 - "$provider" <<'PY'
import ctypes
import sys
try:
    ctypes.CDLL(sys.argv[1], mode=ctypes.RTLD_GLOBAL)
except Exception as exc:
    print(exc)
    sys.exit(1)
PY
}

has_npu_hardware() {
  [[ -e /dev/accel/accel0 ]] && return 0
  if command -v lspci >/dev/null 2>&1 && lspci -nn | grep -qiE '1022:17f0|xdna|npu'; then
    return 0
  fi
  return 1
}

emit_exports() {
  local lib_dir="$1"
  local ort="$2"
  local provider="$3"
  printf 'export ORT_DYLIB_PATH=%s\n' "$(quote "$ort")"
  printf 'export RYZENAI_EP_PATH=%s\n' "$(quote "$provider")"
  printf 'export LD_LIBRARY_PATH=%s${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n' "$(quote "$lib_dir")"
  printf 'export PI_KNOWLEDGE_EMBED_BACKEND=${PI_KNOWLEDGE_EMBED_BACKEND:-auto}\n'
}

probe_spell() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)" || return 1
  [[ -f "$repo_root/packages/natives/src/index.ts" ]] || return 1
  command -v bun >/dev/null 2>&1 || return 1
  (
    cd "$repo_root" || exit 1
    bun -e 'import { executeOrg } from "./packages/natives/src/index.ts";
const s = await executeOrg({ command: "recall_stats", repoRoot: process.cwd() });
console.log(JSON.stringify(s, null, 2));'
  )
}

restart_worker() {
  pkill -f 'pi-knowledge-worker --socket .*/spell/knowledge.sock' 2>/dev/null || true
}

shopt -s nullglob

CANDIDATE_DIRS=()

add_dir_from_file "${ORT_DYLIB_PATH:-}"
add_dir_from_file "${RYZENAI_EP_PATH:-}"

if [[ -n "${RYZEN_AI_INSTALLATION_PATH:-}" ]]; then
  add_unique_dir "$RYZEN_AI_INSTALLATION_PATH/deployment/lib"
fi
if [[ -n "${VIRTUAL_ENV:-}" ]]; then
  add_unique_dir "$VIRTUAL_ENV/deployment/lib"
fi

for dir in \
  "$HOME"/.local/ryzenai/*/venv/deployment/lib \
  "$HOME"/.local/ryzenai/*/deployment/lib \
  "$HOME"/ryzen_ai-*/venv/deployment/lib \
  "$HOME"/ryzen_ai-*/deployment/lib \
  /opt/ryzenai/*/venv/deployment/lib \
  /opt/ryzenai/*/deployment/lib \
  /opt/amd/ryzenai/*/venv/deployment/lib \
  /opt/amd/ryzenai/*/deployment/lib; do
  add_unique_dir "$dir"
done

# ldconfig is a last resort; it may know libonnxruntime but not the provider.
if command -v ldconfig >/dev/null 2>&1; then
  while IFS= read -r path; do
    add_dir_from_file "$path"
  done < <(ldconfig -p 2>/dev/null | sed -nE 's/.* => (.*libonnxruntime[^ ]*\.so[^ ]*)$/\1/p')
fi

FOUND_DIR=""
FOUND_ORT=""
FOUND_PROVIDER=""
CANDIDATE_NOTES=()

for dir in "${CANDIDATE_DIRS[@]}"; do
  ort="$(find_ort_in_dir "$dir" 2>/dev/null || true)"
  provider="$(find_provider_in_dir "$dir" 2>/dev/null || true)"
  if [[ -n "$ort" && -n "$provider" ]]; then
    FOUND_DIR="$dir"
    FOUND_ORT="$ort"
    FOUND_PROVIDER="$provider"
    break
  fi
  if [[ -n "$ort" || -n "$provider" ]]; then
    CANDIDATE_NOTES+=("$dir: ort=${ort:-missing} provider=${provider:-missing}")
  fi
done

if [[ -z "$FOUND_DIR" ]]; then
  err "No RyzenAI ONNX Runtime provider found."
  if [[ ${#CANDIDATE_NOTES[@]} -gt 0 ]]; then
    err "Partial candidates:"
    for note in "${CANDIDATE_NOTES[@]}"; do
      err "  $note"
    done
  fi
  err "Install AMD Ryzen AI Software, then source its venv or set RYZEN_AI_INSTALLATION_PATH."
  err "Expected: <venv>/deployment/lib/libonnxruntime.so and libonnxruntime_providers_ryzenai.so"
  if [[ $SOURCED -eq 1 ]]; then return 1; else exit 1; fi
fi

ORT_VERSION="unknown"
ORT_VERSION_NOTE=""
if version="$(ort_version "$FOUND_ORT" 2>/dev/null)"; then
  ORT_VERSION="$version"
  if minor="$(version_minor "$ORT_VERSION" 2>/dev/null)"; then
    if (( minor < 23 )); then
      ORT_VERSION_NOTE="ONNX Runtime $ORT_VERSION is older than ort 2.0.0-rc.11 expects (>= 1.23.x); Spell may need a matching ort crate or backend shim."
    fi
  fi
else
  ORT_VERSION_NOTE="Could not dlopen libonnxruntime.so to read its version."
fi

PROVIDER_NOTE=""
if provider_output="$(provider_dlopen_check "$FOUND_PROVIDER" "$FOUND_DIR" 2>&1)"; then
  :
else
  PROVIDER_NOTE="Provider dlopen failed: $provider_output"
fi

if ! has_npu_hardware; then
  warn "No /dev/accel/accel0 or RyzenAI PCI device detected; libs found but NPU may not run."
fi

if [[ -n "$ORT_VERSION_NOTE" ]]; then
  warn "$ORT_VERSION_NOTE"
fi
if [[ -n "$PROVIDER_NOTE" ]]; then
  warn "$PROVIDER_NOTE"
fi

case "$MODE" in
  env)
    emit_exports "$FOUND_DIR" "$FOUND_ORT" "$FOUND_PROVIDER"
    ;;
  source)
    export ORT_DYLIB_PATH="$FOUND_ORT"
    export RYZENAI_EP_PATH="$FOUND_PROVIDER"
    export LD_LIBRARY_PATH="$FOUND_DIR:${LD_LIBRARY_PATH:-}"
    export PI_KNOWLEDGE_EMBED_BACKEND="${PI_KNOWLEDGE_EMBED_BACKEND:-auto}"
    say "RyzenAI ORT env applied to current shell:"
    say "  ORT_DYLIB_PATH=$ORT_DYLIB_PATH"
    say "  RYZENAI_EP_PATH=$RYZENAI_EP_PATH"
    say "  LD_LIBRARY_PATH prepended with $FOUND_DIR"
    say "  ORT version: $ORT_VERSION"
    ;;
  report)
    say "Found RyzenAI ONNX Runtime provider:"
    say "  lib dir:  $FOUND_DIR"
    say "  ORT:      $FOUND_ORT"
    say "  provider: $FOUND_PROVIDER"
    say "  version:  $ORT_VERSION"
    say ""
    say "To use for this shell:"
    emit_exports "$FOUND_DIR" "$FOUND_ORT" "$FOUND_PROVIDER" | sed 's/^/  /'
    say ""
    say "One-shot:"
    say "  eval \"\$(scripts/detect-ryzenai-ort.sh --env)\""
    ;;
esac

if [[ $RESTART_WORKER -eq 1 ]]; then
  restart_worker
  say "pi-knowledge-worker restarted/killed; next Spell recall will respawn it."
fi

if [[ $PROBE_SPELL -eq 1 ]]; then
  if [[ "$MODE" != "source" ]]; then
    export ORT_DYLIB_PATH="$FOUND_ORT"
    export RYZENAI_EP_PATH="$FOUND_PROVIDER"
    export LD_LIBRARY_PATH="$FOUND_DIR:${LD_LIBRARY_PATH:-}"
    export PI_KNOWLEDGE_EMBED_BACKEND="${PI_KNOWLEDGE_EMBED_BACKEND:-auto}"
  fi
  say "Spell recall_stats probe:"
  probe_spell || warn "Spell probe skipped/failed (bun or repo native TS unavailable)."
fi

if [[ $SOURCED -eq 1 ]]; then return 0; else exit 0; fi
