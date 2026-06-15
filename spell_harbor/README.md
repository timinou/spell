# Spell × Harbor / Terminal-Bench

Run Spell as a fully-autonomous agent on [Terminal-Bench](https://tbench.ai)
via the [Harbor](https://harborframework.com) harness.

## Run a single task locally — three commands

```bash
# 1. one-time: build the portable dist (binary + domain spec). ~10–20 min first run.
spell_harbor/build-portable-native.sh

# 2. sanity: prove the harness + task work with the oracle (no model, no Spell).
uv run harbor run --dataset terminal-bench@2.0 --task build-pov-ray --agent oracle --n-concurrent 1

# 3. run Spell on the task. Run from the REPO ROOT and put it on PYTHONPATH so
#    Harbor's importlib can find the agent module. Login travels in automatically.
cd /home/user/code/ora/spell
PYTHONPATH="$PWD" SPELL_DIST_DIR="$PWD/spell_harbor/dist" \
  uv run harbor run --dataset terminal-bench@2.0 --task build-pov-ray \
  --agent-import-path spell_harbor.spell_agent:SpellAgent \
  --model anthropic/claude-opus-4-x --n-concurrent 1
```

NB:
- Module name is `spell_harbor` (NOT `packaging` — that collides with the
  ubiquitous PyPI `packaging` library, which always shadows a local dir).
- Harbor resolves `--agent-import-path module:Class` via `importlib` against
  `sys.path` — it does NOT add the cwd. So `PYTHONPATH="$PWD"` (repo root) is
  required for the import to resolve.
- Flags (confirmed against `harbor run -h`): `--dataset terminal-bench@2.0`,
  single task `--task <name>` (NOT `--task-id`), `--agent-import-path`, `--model`.

## Your login survives the run (no re-auth)

Spell stores credentials — **OAuth subscription tokens AND API keys** — in
`~/.spell/agent/agent.db`. The adapter's `install()` `upload_file`s that db into
the container and points Spell at it via `PI_CODING_AGENT_DIR`, so your existing
login is used with zero re-authentication. Override the source db with
`SPELL_AGENT_DB=/path/to/agent.db`. (If you instead rely on an env API key,
`harbor run` forwards `ANTHROPIC_API_KEY` and the db upload is simply skipped.)

## How it fits together

- `spell_agent.py` — Harbor `BaseInstalledAgent`. `install()` uploads the dist +
  your `agent.db` and fail-loud-verifies the binary loads; `run()` drives
  `spell --domain harbor -p`; `populate_context_post_run()` harvests the
  transcript + token usage.
- `spell.autonomous.kdl` (repo root) — the **declarative** autonomous + harbor
  domains. `harbor extends autonomous`, adds the `$HARBOR_MODEL` env contract.
- The `harbor` domain's `surface "none"` routes Spell headless and gates
  interactive tools; `knowledge { embeddings #false }` + env keep org/memory on
  BM25+graph (no fastembed RAM/download).

### Native addon: shipped as a SIDECAR, not embedded

`bun --compile` records the addon in the binary's manifest but does **not**
embed `.node` as an fs-readable blob — at runtime Spell extracts/loads it from
`~/.spell/natives/<version>/`. So the dist ships the `.node` as a separate file
and the adapter uploads it to `/root/.spell/natives/<version>/`. Verified
end-to-end in ubuntu:24.04: binary runs, addon loads (no GitHub download
fallback), `--domain harbor` resolves from the KDL spec, and the
`HARBOR_MODEL` env contract fails loud when unset.

Container layout the adapter creates (mirrors a real install):
```
/opt/spell/spell                          # binary
/root/.spell/spell.kdl                     # imports the domain spec
/root/.spell/spell.autonomous.kdl          # autonomous + harbor domains
/root/.spell/agent/agent.db                # your login (PI_CODING_AGENT_DIR)
/root/.spell/natives/<version>/*.node      # native addon sidecar
```

## Native (libc) portability — RESOLVED, proven

**The committed repo `.node` does NOT work in TB containers** (measured
2026-06-14): built on an Arch host (glibc 2.43), it fails to load on every
realistic image — `GLIBC_2.43 not found` on ubuntu/debian, no libstdc++ at all
on Alpine/musl. CPU-ISA (`SIGILL`) was already handled by baseline; **libc was
the open axis.**

**Fix built + proven (2026-06-14).** `build-portable-native.sh` compiles
pi-natives inside `manylinux_2_28` (glibc 2.28) with baseline ISA. The
resulting addon was verified to not just resolve symbols but to `require()` +
initialize (exporting `executeCodeGraph`/`executeOrg`/`executeCodeBuffer`):

| image | libc | committed `.node` | manylinux_2_28 `.node` |
|---|---|---|---|
| ubuntu:24.04 | glibc 2.39 | ✗ `GLIBC_2.43` | ✓ loads |
| ubuntu:22.04 | glibc 2.35 | ✗ `GLIBC_2.43`+`CXXABI_1.3.15` | ✓ loads |
| debian:12 | glibc 2.36 | ✗ same | ✓ `require()` + init verified |
| alpine:3.20 | musl | ✗ ~45 symbol errors | (use `TARGET=musl`) |

GLIBC floor dropped **2.43 → 2.28**; backward-compatible up to latest. Because
the agent owns its container image, this is a settled build step, not research.

```
spell_harbor/build-portable-native.sh                  # glibc (default)
spell_harbor/build-portable-native.sh TARGET=musl      # Alpine tasks
spell_harbor/probe-libc.sh dist/pi_natives.*.node      # CI gate (exit 1 on fail)
```

`install.sh` re-verifies the addon loads in the actual task container
(`spell --version`) before the benchmark starts — a libc mismatch fails the
install, not a tool call mid-run.

## Scope-2 runtime decisions (settled)

- **BEAM ships always** — `execute` (PTC-Lisp) is core; no degrade path.
- **org/memory kept** — knowledge worker runs with `PI_KNOWLEDGE_WORKER_EMBEDDINGS=0`
  (set by the harbor domain): BM25 + graph recall, no embedding model. The
  recall pipeline already self-degrades to lexical when the vector lane is empty.

## Cost (per the TB paper + our arithmetic)

- TB 2.0 = 89 tasks. One full pass: **$1–10** cheap model, **$50–100** frontier.
- Leaderboard-grade (5 trials) frontier: **~$250–500 API + cloud infra**.
- Smoke run (5 tasks, cheap model, local Docker): **<$5**.

## Scale up

Once a single task passes, widen the run — drop `--task`, raise concurrency, pick
a cheaper model for a full smoke pass:

```bash
uv run harbor run --dataset terminal-bench@2.0 \
  --agent-import-path spell_harbor.spell_agent:SpellAgent \
  --model anthropic/claude-haiku-4-5 --n-concurrent 4
```

Prove native portability across the libc matrix in CI:
`spell_harbor/probe-libc.sh spell_harbor/dist/spell` (exits 1 on any
unresolved-symbol failure).
