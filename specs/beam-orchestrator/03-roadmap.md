# Roadmap: From V1 Compute Coprocessor to the BEAM Orchestrator

**Date**: 2026-05-30
**Status**: Sequencing plan. Phase 1 (= V1 in `02`) is the only committed scope.
**Reads with**: `01-vision.md` (destination), `02-v1-compute-coprocessor.md` (V1).

---

## The shape of the journey

```
P1  Compute coprocessor          ← COMMITTED (this is V1)
P2  Headless seam hardening       ← parallel, cheap, unlocks everything
P3  find-as-NIF proof             ← derisks the load-bearing WS-B hypothesis
P4  BEAM orchestrator (goals lane)← thin OTP supervisor, TS still executes
P5  Tool surface → BEAM/NIF       ← the big cutover; needs P3 green
P6  Subagents as BEAM processes   ← "remove all task execution" realized
P0' LSP completeness in pi-code-graph ← independent prereq, gates P5's lsp tool
```

## Dependency graph

```
        P1 (compute coprocessor) ───────────────┐
                                                 │ catalogs + bridge reused
        P2 (headless seam) ──────────────┐       │
                                         ▼       ▼
                                   P4 (orchestrator: goals lane)
                                         │
        P3 (find-as-NIF proof) ──────────┤  must be GREEN (3 acceptance gates)
                                         ▼
                                   P5 (tool surface → NIF) ──► P6 (subagents on BEAM)
                                         ▲
        P0' (MERGE fup-095-nuke-lsp-tool) ─────┘  gates ONLY the lsp tool slice of P5
```

Critical path to the maximalist goal ("remove ALL task execution"):
**P3 → P5 → P6**. P1/P2/P4 deliver standalone value and de-risk in parallel.
P0' runs independently and only blocks the `lsp` slice of P5.

---

## P1 — Compute coprocessor (V1, committed)

See `02-v1-compute-coprocessor.md`. Delivers PtcRunner + generated tool/provider
catalogs + boot hydration + tool/call bridge + worked examples.

```
Value      replaces a measurable slice of the 82k pure-query Bash calls with
           sandboxed, schema-validated PTC-Lisp pipelines
Risk       low — no kernel changes, no supervision, reuses existing executors
Proves     "tool-call pipelines to answer questions" is real and ergonomic
Exit       acceptance 1-5 in 02 pass; ≥3 examples replace real Bash idioms
```

## P2 — Headless seam hardening (parallel, cheap)

Make `coding-agent/src/modes/rpc/` the ONE drivable contract: prove a Spell agent
runs fully headless — prompt → stream → tool calls → gate → exit — over JSON-lines.
This is Spell's equivalent of Codex `app-server`; WS-B's orchestrator drives it.

```
Value      a clean, tested headless protocol is independently useful (CI, embeds)
Risk       low — surface largely exists (rpc-types.ts defines the commands)
Proves     orchestrator can drive a Spell agent as a subprocess without the TUI
Exit       a script drives one agent through a full task over rpc, no in-proc deps
```

## P3 — `find`-as-NIF proof (derisks WS-B)

A single tool (`find`, the pure-kernel path) exposed to a BEAM runtime via rustler,
over the SAME `execute_code_path_inner` that NAPI uses. Not shipped; a spike.

```
Must demonstrate ALL THREE (this is the real acceptance, not "find works"):
  1. correctness   NIF find returns same chunks as the NAPI path
  2. panic-safety  a deliberately panicking find → {:error, …}; the NODE SURVIVES
  3. lock-liveness owning BEAM proc killed mid-op → file lock reclaimed
                   (process monitor + ResourceArc Drop)
Also produce:
  · kernel-cleanliness audit: confirm no orchestration/state logic leaked into the
    NAPI layer (if it did, extract to core first) — the "kernel_truth: unsure" item
  · scheduler classification: which kernel ops are <1ms / DirtyCpu / must-not-NIF
Risk       medium — first NIF; blast-radius + lock-liveness are new contracts
Proves     clean-core + safe-boundary + concurrency hypotheses that ALL of P5/P6 rest on
Exit       3 gates green + audit says core is clean (or lists exactly what to extract)
```

## P0' — MERGE `fup-095-nuke-lsp-tool` (independent prereq, ALREADY BUILT)

The work is DONE on branch `fup-095-nuke-lsp-tool` (FUP-095, STATE: DONE). It
**deletes the entire TS `lsp/` tree** (~9,000 LOC: `index.ts` −1672, `client.ts`
−876, `utils.ts` −807, `render.ts` −679, `config.ts`, `defaults.json`, all clients)
and replaces it with the Rust `SemanticBackend` wired into find/edit dispatch
(`semantic_dispatch.rs`, `semantic_cache.rs`, `semantic_live_e2e.rs`). The `lsp`
tool is NUKED, not migrated — semantics already flow through find/edit qualifiers
(`#hover`, `#diagnostics`, def→/ref→). So there is NO pi-code-graph build work
remaining for this prereq; it is purely a branch merge.

```
Value      consolidates ALL semantic ownership in Rust; removes 9k LOC of TS
Risk       low — work complete + tested on branch; risk is merge/rebase only
Gates      ONLY the lsp slice of P5; everything else in P5 proceeds without it
Action     MERGE fup-095-nuke-lsp-tool (track FUP-102 tsgo gate as the open follow-up)
```

## P4 — BEAM orchestrator: goals lane (thin OTP, TS still executes)

Replace `spell-server`'s `GoalScheduler` with an OTP supervision tree that drives
headless Spell agents (P2) as supervised subprocesses. Thin Elixir, Symphony-style:
GenServer owns scheduling state; TS/Rust still does the actual work.

```
Scope      poll org/work → dispatch eligible → spawn `spell --rpc` → stream → retry
           dispatch policy: plain Elixir first; PtcRunner policy (P1 runtime) where
           P1/P2/P3/P4 properties hold (repo/operator/agent-authored — see 01 rule)
Value      crash-isolated, supervised long-running lane; conceptual unification begins
Risk       medium — orchestrator rewrite, but bounded (no kernel changes yet)
Exit       goals run under OTP supervision; a killed run is supervised-restarted;
           parity with current GoalScheduler behavior
```

## P5 — Tool surface → BEAM/NIF (the big cutover)

With P3 green, migrate tools to their BEAM homes (per `01-vision.md` table):

```
pure-kernel (find/edit/parse/render/code-graph) → rustler NIF over shared per-node kernel
bash                                             → BEAM Port
network (fetch/web_search)                       → Finch/Req
lsp (rich)                                       → ALREADY find/edit semantic surface (post fup-095 merge)
compute/policy                                   → PtcRunner (already native from P1)
```

```
Value      tools defined ONCE, BEAM-side; warm kernel shared across a node's agents
Risk       high — broad surface; each tool needs parity tests + scheduler classification
Sequencing find first (proven in P3), then edit, then the rest; lsp last (gated on P0')
Exit       each migrated tool passes parity + panic-safety + (for kernel tools) lock-liveness
```

## P6 — Subagents as BEAM processes (goal realized)

Subagents become supervised BEAM processes whose tools are the P5 set, sharing the
per-node warm kernel via NIF. The TS schedulers (batch/swarm/mutable-dag/retry/
heartbeat) are deleted; OTP supervision + GenServer state replace them.

```
Value      "remove ALL task execution from this codebase" — by RELOCATING the seam
           (TS↔Rust → BEAM↔Rust), not by deleting capability
Win        "all" is justified independent of per-workload NIF benchmarks: offloading
           ALL task-concurrency management (the schedulers/DAG/retry/backoff/heartbeat)
           to OTP supervision is itself the win. rustler kernel-sharing per node is
           additive gravy, not the gating justification.
Risk       high — concurrency at scale; lock-liveness under many agents per node
Exit       a multi-subagent task runs entirely under OTP; TS schedulers removed;
           distribution (multi-node) demonstrable as the capstone
```

---

## What gates what (one-glance table)

```
P1  gated by: nothing                         → START NOW (V1)
P2  gated by: nothing                         → parallel with P1
P3  gated by: nothing (needs kernel access)   → parallel; derisks P5/P6
P0' gated by: nothing (work DONE on branch)   → MERGE early; gates only P5.lsp
P4  gated by: P2 (headless seam)              → after P2
P5  gated by: P3 GREEN (+ P0' for lsp slice)  → after P3
P6  gated by: P5                              → last
```

## Honest risk ledger

```
two-runtime tax        mitigated by rustler (one core, two skins) — NOT eliminated
                       until P6; P1-P4 do live with TS+Elixir coexisting
NIF blast radius       a real regression in failure semantics (node-wide vs proc-wide);
                       P3 gate #2 is the explicit guard
lock liveness          new responsibility BEAM must own; P3 gate #3
scope creep            P5/P6 are quarters of work; P1 must deliver value ALONE so the
                       effort is justified incrementally, not all-or-nothing
LSP drift              none — fup-095 already replaced the lsp tool with find/edit
                       semantics; prereq is a MERGE, tracked so it lands early
```

## Recommended immediate next actions

1. Build **P1** per `02` (committed scope).
2. Spin up **P2** and **P3** in parallel (both cheap, both de-risk the horizon).
3. Open **P0'** as an independent pi-code-graph task (start early, gates P5.lsp).
4. Defer P4-P6 until P1 ships value and P3's three gates are green.
