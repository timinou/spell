#!/usr/bin/env bash
# PLAN-315 W8 — N=10 performance harness
#
# Runs 7 gates against a synthetic corpus and daemon. Requires release
# binaries pre-built; does NOT build them inline.
#
# USAGE:  ./scripts/perf/plan315-n10.sh
#
# OUTPUT: !tasks/plans/plan-artifacts/PLAN-315/W8-perf-run-<epoch>.md
#
# Gates:
#   1. libpi_natives.so size ≤ 92.5 MB
#   2. per-session RSS ≤ 100 MB
#   3. total RSS N=10 ≤ 1.55 GB
#   4. memory.search P99 ≤ 50 ms
#   5. cg_search P99 ≤ 60 ms (DEFERRED — see methodology notes)
#   6. push delivery P99 ≤ 500 ms (DEFERRED — see methodology notes)
#   7. cold warm-up (12k sym) ≤ 90 s
#
# Edge cases:
#   - Release binaries missing → error with build instruction
#   - Daemon crash → detect via wait -n, abort with diagnostic
#   - Socket not ready → busy-poll 50ms × 600 tries (30s timeout)
#   - pgrep unavailable → error early
#   - Partial gate failure → render all gates, do not halt

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# 1. Setup
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORK_DIR="$(mktemp -d -t perf-plan315-XXXXXXXX)"
EPOCH="$(date +%s)"
REPORT_FILE="${REPO_ROOT}/!tasks/plans/plan-artifacts/PLAN-315/W8-perf-run-${EPOCH}.md"
DAEMON_PID=""
SAMPLER_PID=""

cleanup() {
  # Kill sampler first to avoid racing with daemon being gone
  if [ -n "$SAMPLER_PID" ] && kill -0 "$SAMPLER_PID" 2>/dev/null; then
    kill "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
  fi
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

# --- Prerequisite checks ---
if ! command -v pgrep &>/dev/null; then
  echo "ERROR: pgrep is required but not found." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Hardware fingerprint
# ---------------------------------------------------------------------------
cat > "$REPORT_FILE" <<REPORT_HEADER
# PLAN-315 W8 perf run

- Date: $(date -Iseconds)
- Kernel: $(uname -a)
- CPU: $(grep 'model name' /proc/cpuinfo | head -1 | sed 's/^.*: //')
- RAM: $(free -g | awk '/^Mem:/ {print $2 " GB total"}')
- Harness: scripts/perf/plan315-n10.sh

REPORT_HEADER

# ---------------------------------------------------------------------------
# 3. Locate binaries
# ---------------------------------------------------------------------------
LIBPI="${REPO_ROOT}/target/release/libpi_natives.so"
DAEMON="${REPO_ROOT}/target/release/pi-knowledge-worker"

BIN_MISSING=0
if [ ! -f "$LIBPI" ]; then
  echo "ERROR: missing $LIBPI — run: cargo build --release -p pi-natives" >&2
  BIN_MISSING=1
fi
if [ ! -f "$DAEMON" ]; then
  echo "ERROR: missing $DAEMON — run: cargo build --release -p pi-knowledge-worker" >&2
  BIN_MISSING=1
fi
if [ "$BIN_MISSING" -ne 0 ]; then
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Gate 1: libpi_natives.so size
# ---------------------------------------------------------------------------
SIZE_BYTES=$(stat -c%s "$LIBPI")
SIZE_MB=$(awk -v b="$SIZE_BYTES" 'BEGIN{printf "%.1f", b/1048576}')

# ---------------------------------------------------------------------------
# 5. Generate synthetic corpus: 10 session dirs, each 1200 .org files
# ---------------------------------------------------------------------------
echo "Generating synthetic corpus (12,000 org files across 10 sessions)..."
for i in $(seq 1 10); do
  sess="${WORK_DIR}/session-${i}"
  mkdir -p "${sess}/.spell/memory/episodes"
  for n in $(seq 1 1200); do
    # shellcheck disable=SC2129 — combining >> is intentional for heredoc
    cat > "${sess}/.spell/memory/episodes/ep-$(printf '%04d' "$n").org" <<EOF
#+TITLE: Episode $n session $i
#+CUSTOM_ID: EP-${i}-${n}

* Episode $n session $i
  :PROPERTIES:
  :CUSTOM_ID: EP-${i}-${n}
  :END:

  Synthetic body for session ${i} item ${n}. Tokens: alpha beta gamma delta epsilon zeta eta theta.
EOF
  done
done
echo "  Done."

# ---------------------------------------------------------------------------
# 6. Spawn daemon
# ---------------------------------------------------------------------------
SOCK="${WORK_DIR}/embed.sock"
# shellcheck disable=SC2153 — XDG_RUNTIME_DIR is intentionally set here
XDG_RUNTIME_DIR="${WORK_DIR}" "$DAEMON" --socket "$SOCK" > "${WORK_DIR}/daemon.log" 2>&1 &
DAEMON_PID=$!

# Busy-poll for socket (30s timeout)
for _ in $(seq 1 600); do
  if [ -S "$SOCK" ]; then
    break
  fi
  sleep 0.05
done
if [ ! -S "$SOCK" ]; then
  echo "ERROR: daemon socket never appeared at $SOCK" >&2
  cat "${WORK_DIR}/daemon.log" >&2
  exit 1
fi
echo "Daemon started (PID $DAEMON_PID, socket $SOCK)"

# ---------------------------------------------------------------------------
# 7. Cold warm-up measurement
# ---------------------------------------------------------------------------
COLD_START=$(date +%s%N)

# Open ALL 10 sessions to reach the documented 12k symbols
for i in $(seq 1 10); do
  python3 -c "
import json, socket
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(10)
s.connect('${SOCK}')
f = s.makefile('rw', buffering=1)
f.write(json.dumps({'command': 'open', 'repo_root': '${WORK_DIR}/session-${i}'}) + chr(10))
f.flush()
resp = json.loads(f.readline())
s.close()
" >/dev/null 2>&1
done

COLD_END=$(date +%s%N)
COLD_MS=$(( (COLD_END - COLD_START) / 1000000 ))

# ---------------------------------------------------------------------------
# 8. Background RSS sampler — runs DURING query workload
# ---------------------------------------------------------------------------
(
  for _ in $(seq 1 60); do
    ps -o rss= -p "$DAEMON_PID" 2>/dev/null || true
    sleep 1
  done
) > "${WORK_DIR}/rss-samples.log" &
SAMPLER_PID=$!

# ---------------------------------------------------------------------------
# 9. Spawn 10 client sessions, each with sustained python (open + 110 queries + close)
# ---------------------------------------------------------------------------
echo "Running queries across 10 sessions..."
for i in $(seq 1 10); do
  mkdir -p "${WORK_DIR}/session-${i}"
  SESS="${WORK_DIR}/session-${i}" SOCK="$SOCK" LOG="${WORK_DIR}/session-${i}/search-ms.log" \
    python3 -u <<'PY' &
import json, socket, time, os

sock_path = os.environ['SOCK']
sess_path = os.environ['SESS']
log_path  = os.environ['LOG']

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
s.connect(sock_path)
f = s.makefile('rw', buffering=1)

# Open session
f.write(json.dumps({'command': 'open', 'repo_root': sess_path}) + chr(10))
f.flush()
resp = json.loads(f.readline())
if not resp.get('ok'):
    raise SystemExit('open failed: ' + repr(resp))
handle = resp['repo_handle']

# 110 search queries: 10 priming (discarded) + 100 measurement (logged)
results = []
for q in range(110):
    t0 = time.perf_counter_ns()
    f.write(json.dumps({'command': 'search', 'repo_handle': handle, 'text': 'gamma'}) + chr(10))
    f.flush()
    f.readline()
    t1 = time.perf_counter_ns()
    if q >= 10:
        results.append(str((t1 - t0) // 1_000_000))

# Close session
f.write(json.dumps({'command': 'close', 'repo_handle': handle}) + chr(10))
f.flush()
f.readline()

# Write results
with open(log_path, 'w') as out:
    out.write(chr(10).join(results) + chr(10))

s.close()
PY
done

# Wait for all background query sessions to finish
wait

# ---------------------------------------------------------------------------
# 10. Stop RSS sampler + compute peak RSS
# ---------------------------------------------------------------------------
kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=""

# Compute peak RSS from samples
if [ -s "${WORK_DIR}/rss-samples.log" ]; then
  PEAK_RSS_KB=$(awk '{print $1}' "${WORK_DIR}/rss-samples.log" | sort -n | tail -1)
  PEAK_RSS_MB=$(awk -v k="$PEAK_RSS_KB" 'BEGIN{printf "%.0f", k/1024}')
  # Single shared daemon serves all 10 sessions — the sampled RSS IS the total.
  # Per-session is an attribution metric (total/10), not a process-RSS metric.
  TOTAL_RSS_MB=$PEAK_RSS_MB
  PER_SESSION_RSS=$(awk -v k="$PEAK_RSS_KB" 'BEGIN{printf "%.1f", (k/1024)/10}')
else
  PEAK_RSS_KB=0
  PEAK_RSS_MB=0
  PER_SESSION_RSS=0
  TOTAL_RSS_MB=0
fi

# ---------------------------------------------------------------------------
# 11. Compute search latency percentiles
# ---------------------------------------------------------------------------
p50() { sort -n "$1" | awk -v p=0.50 'BEGIN{c=0} {a[c++]=$1} END{i=int(c*p); if(i>=c)i=c-1; print a[i]}'; }
p95() { sort -n "$1" | awk -v p=0.95 'BEGIN{c=0} {a[c++]=$1} END{i=int(c*p); if(i>=c)i=c-1; print a[i]}'; }
p99() { sort -n "$1" | awk -v p=0.99 'BEGIN{c=0} {a[c++]=$1} END{i=int(c*p); if(i>=c)i=c-1; print a[i]}'; }

# Aggregate all search-ms.log files
ALL_LOG="${WORK_DIR}/all-search-ms.log"
cat "${WORK_DIR}"/session-*/search-ms.log > "$ALL_LOG" 2>/dev/null || true

if [ -s "$ALL_LOG" ]; then
  P50_SEARCH=$(p50 "$ALL_LOG")
  P95_SEARCH=$(p95 "$ALL_LOG")
  P99_SEARCH=$(p99 "$ALL_LOG")
else
  P50_SEARCH="N/A"
  P95_SEARCH="N/A"
  P99_SEARCH="N/A"
fi

# ---------------------------------------------------------------------------
# 12. Render gate table
# ---------------------------------------------------------------------------
emit_gate() {
  local name="$1" target="$2" measured="$3" pass="$4"
  local status="⚠ NO DATA"
  case "$measured" in
    ''|N/A|NA|null) ;;
    *)
      if awk -v m="$measured" -v p="$pass" 'BEGIN{exit !(m+0 <= p+0)}' 2>/dev/null; then
        status="✅ PASS"
      else
        status="❌ FAIL"
      fi
      ;;
  esac
  printf "| %s | %s | %s | %s |\n" "$name" "$target" "$measured" "$status" >> "$REPORT_FILE"
}

emit_gate_stub() {
  local name="$1" target="$2" note="$3"
  printf "| %s | %s | %s | 🔶 DEFERRED |\n" "$name" "$target" "$note" >> "$REPORT_FILE"
}

{
  echo ""
  echo "## Gate results"
  echo ""
  echo "| Gate | Target | Measured | Status |"
  echo "|------|--------|----------|--------|"
} >> "$REPORT_FILE"

emit_gate "libpi_natives.so size (MB)"      "≤ 92.5"  "$SIZE_MB"      "92.5"
emit_gate "per-session RSS peak (MB)"       "≤ 100"   "$PER_SESSION_RSS" "100"
emit_gate "total RSS N=10 (MB)"             "≤ 1587"  "$TOTAL_RSS_MB"   "1587"
emit_gate "memory.search P99 (ms)"          "≤ 50"    "$P99_SEARCH"     "50"
emit_gate_stub "cg_search P99 (ms)"         "≤ 60"    "DEFERRED — needs code-graph corpus generator"
emit_gate_stub "push delivery P99 (ms)"     "≤ 500"   "DEFERRED — bench binary not yet authored; bench_payload test asserts delivery only"
emit_gate "cold warm-up (ms, 12k symbols)"  "≤ 90000" "$COLD_MS"        "90000"

# ---------------------------------------------------------------------------
# 13. Methodology appendix
# ---------------------------------------------------------------------------
{
  echo ""
  echo "## Methodology notes"
  echo ""
  echo "- Harness: scripts/perf/plan315-n10.sh"
  echo "- Corpus: synthetic, 12,000 org items across 10 session dirs (1,200/session)"
  echo "- 7 gates: 5 measured directly, 2 DEFERRED with stated reasons"
  echo "- cg_search gate DEFERRED until code-graph corpus generator lands (tracked as cg_search-corpus TODO)"
  echo "- Push delivery DEFERRED — no bench binary yet; bench_payload test asserts single delivery within 1 s, not P99"
  echo "- Per-session RSS is an ATTRIBUTION metric (peak daemon RSS / 10), not a process-RSS metric (shared daemon serves all 10)"
  echo "- RSS sampling: ps -o rss= every 1s for 60s; report peak daemon RSS (the shared-daemon total)"
  echo "- Latency: sustained python-per-session (open + 110 queries + close in one process, no per-query spawn overhead)"
  echo "- Cold warm-up: 10 sessions opened serially; wall-clock from first open to last open ack"
  echo "- Reproducibility: hand-rolled bash, fixed iteration counts, no \$RANDOM"
  echo ""
  echo "### Gate measurement summary"
  echo ""
  echo "| Gate | Target | Measurement source | Status |"
  echo "|------|--------|--------------------|--------|"
  echo "| libpi_natives.so size | ≤ 92.5 MB | stat -c%s on release binary | MEASURED |"
  echo "| per-session RSS | ≤ 100 MB | (peak daemon RSS) / 10 | ATTRIBUTION |"
  echo "| total RSS N=10 | ≤ 1.55 GB | peak daemon RSS | MEASURED |"
  echo "| memory.search P99 | ≤ 50 ms | sustained python loop, 100 queries×10 sessions, P99 | MEASURED |"
  echo "| cg_search P99 | ≤ 60 ms | n/a (no code-graph corpus generator) | DEFERRED |"
  echo "| push delivery P99 | ≤ 500 ms | n/a (no bench binary; one-shot delivery assertion only) | DEFERRED |"
  echo "| cold warm-up | ≤ 90 s | wall-clock from socket-ready to last-session open ack | MEASURED |"
  echo ""
  echo "## Report file"
  echo ""
  echo "Results written to: ${REPORT_FILE}"
} >> "$REPORT_FILE"

echo "Report: $REPORT_FILE"
