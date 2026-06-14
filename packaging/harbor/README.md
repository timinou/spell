# Spell × Harbor / Terminal-Bench

Run Spell as a fully-autonomous agent on [Terminal-Bench](https://tbench.ai)
via the [Harbor](https://harborframework.com) harness.

## How it fits together

```
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path packaging.harbor.spell_agent:SpellAgent \
  -m anthropic/claude-opus-4-x -n 8
```

- `spell_agent.py` — Harbor `BaseInstalledAgent`. `install()` stages Spell into
  the task container (`install.sh`); `run()` drives `spell --domain harbor -p`;
  `populate_context_post_run()` harvests the transcript + token usage.
- `spell.autonomous.kdl` (repo root) — the **declarative** autonomous + harbor
  domains. `harbor extends autonomous`, adds the `$HARBOR_MODEL` env contract.
- The `harbor` domain's `surface "none"` routes Spell headless and gates
  interactive tools; `knowledge { embeddings #false }` + env keep org/memory on
  BM25+graph (no fastembed RAM/download).

## The one real risk: native (libc) portability

**Measured 2026-06-14.** The repo's committed `.node` is built on a
bleeding-edge host (glibc 2.43) and **does not load** in realistic TB images:

| image | libc | loads? | blocker |
|---|---|---|---|
| ubuntu:24.04 | glibc 2.39 | ✗ | `GLIBC_2.43 not found` |
| ubuntu:22.04 | glibc 2.35 | ✗ | + `CXXABI_1.3.15`, `GLIBC_2.39` |
| debian:12 | glibc 2.36 | ✗ | same |
| alpine:3.20 | musl | ✗ | no libstdc++/libgcc; ~45 symbol errors |

CPU-ISA (`SIGILL`) is already solved by `TARGET_VARIANT=baseline`. **libc is
the open axis.** Because the agent owns its container image, this is a
build-config task, not research:

1. `build-portable-native.sh` (TARGET=glibc) — build the dist `.node` against
   an old-glibc sysroot (run inside manylinux_2_28 / Debian 11, glibc 2.28
   floor) + static libstdc++/libgcc. One artifact loads on every glibc
   container ≥ 2.28.
2. `build-portable-native.sh TARGET=musl` — optional, for Alpine tasks.
3. `probe-libc.sh dist/spell` — **prove** it: mounts the artifact into the libc
   matrix and fails loud on any unresolved symbol. Run in CI.

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

## First milestone

```
# 1. validate the harness itself
harbor run -d terminal-bench/terminal-bench-2 -a oracle -n 4
# 2. build + prove the portable native
packaging/harbor/build-portable-native.sh
packaging/harbor/probe-libc.sh packaging/harbor/dist/spell
# 3. smoke Spell on a few tasks, cheap model
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path packaging.harbor.spell_agent:SpellAgent \
  -m anthropic/claude-haiku-4-5 -n 4
```
