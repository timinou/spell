# Plan: Autonomous domain + Harbor/Terminal-Bench adapter

## Goal
Run Spell as a fully-autonomous agent (no human present) — first consumer:
Harbor / Terminal-Bench. The autonomy profile re-emerges from a single
declarative KDL spec, not scattered `if(headless)` branches.

## Design decisions (settled)
- **One `SpellDomain` shape, two constructors.** TS manifest (behavioral
  domains: panels/workspaces/custom tools) OR inline KDL block (declarative
  domains: prompt/tools/surface/env/model). Autonomous + harbor are declarative.
- **Inheritance via `extends`** (reuse the mode `extends` mechanism), field-kind
  aware merge. **Composition via `import`** for cross-cutting fragments.
  `harbor extends autonomous`.
- **`surface "none"`** is the keystone invariant: selects headless route +
  gates interactive tools (ask/canvas/send_file/approvals/checkpoint).
  `browser` NOT gated (headless puppeteer is container-safe).
- **`harbor` subdomain** enforces the env contract: `require "HARBOR_MODEL"`
  (fail-loud), pins model roles default+task to `$HARBOR_MODEL`, sets
  `PI_KNOWLEDGE_WORKER` + embeddings-off.
- **Scope-2 calls:** BEAM ships always (execute is core). org/memory kept;
  knowledge-worker gets an embeddings-skip gate → BM25+graph recall, no
  fastembed/OOM. (org recall already self-degrades to lexical when vec index
  empty — `lane_org.rs:176` — so this is a skip gate, not a rewrite.)

## Merge semantics (extends, parent→child)
| field kind | rule |
|---|---|
| scalars (surface, prompt, knowledge.embeddings) | child overrides |
| model.roles map | deep-merge by key, child wins |
| tools.deny/allow lists | union; child allow subtracts from inherited deny |
| env block | union; child require/set append |

## Container portability (de-risked, measured)
Committed `.node` needs GLIBC_2.43 (Arch host) + libstdc++ CXXABI_1.3.15 →
fails on ubuntu/debian (older glibc) and alpine (musl). CPU-ISA already solved
(`TARGET_VARIANT=baseline`). Fix: build dist `.node` against old-glibc sysroot
(manylinux_2_28, glibc 2.28) + static libstdc++/libgcc. Optional musl target via
`CROSS_TARGET=x86_64-unknown-linux-musl`. Agent owns its image → glibc-pin is a
build-config, not research. build-native.ts already supports CROSS_TARGET.

## Build sequence (DAG)
1. types — extend SpellDomain (surface "none", knowledge, env, modelRoles, inline prompt body)
2. parser — KDL domain-block parser + extends resolution (reuse mode parse path)
3. wiring — parseSpellKdl collects domain defs; loadActiveDomain resolves KDL defs before builtins
4. surface — startup route: surface "none" → print/rpc headless
5. activation — main.ts: env require/set enforce, modelRoles override, knowledge env
6. rust — knowledge-worker embeddings skip gate (env-keyed)
7. artifact — spell.autonomous.kdl (autonomous + harbor)
8. packaging — Harbor adapter Dockerfile + entrypoint (drives spell --mode rpc) + portable native build recipe
9. tests + verify — parser/merge/routing/env tests; check:ts; re-run container probe

## Files touched
- domain/growth/src/types.ts (SpellDomain extension)
- packages/coding-agent/src/config/kdl-domains.ts (NEW — domain block parser)
- packages/coding-agent/src/config/spell-kdl.ts (collect domain defs)
- packages/coding-agent/src/domain/loader.ts (resolve KDL domain defs)
- packages/coding-agent/src/domain/startup.ts (surface "none")
- packages/coding-agent/src/domain/policy.ts (env/modelRoles application helper)
- packages/coding-agent/src/main.ts (activation wiring)
- crates/pi-knowledge-worker/src/{lib.rs,lane_org.rs} (embeddings skip gate)
- spell.autonomous.kdl (NEW — the domain spec)
- packaging/harbor/{Dockerfile,entrypoint.ts} (NEW)
- tests under packages/coding-agent/test/

## Acceptance
- `bun run check:ts` green
- domain-kdl tests: KDL block domain parses; harbor extends autonomous merges correctly; surface none routes headless; missing HARBOR_MODEL fails loud
- container probe: glibc-floor `.node` loads on ubuntu:22.04 + debian:12
