# Vision: Spell on the BEAM

**Date**: 2026-05-30
**Status**: Brainstorm → vision. Not a commitment; a destination to reason toward.
**Companions**: `00-evidence-bash-usage.md` (why), `02-v1-compute-coprocessor.md`
(what to build first), `03-roadmap.md` (how to get from here to there),
`04-where-ptcrunner-shines.md` (worked example programs).

---

## One sentence

Move Spell's **orchestration and supervision** onto the BEAM, keep the **Rust
kernel** as the single execution engine (exposed to the BEAM via rustler NIFs the
same way it's exposed to Node via NAPI today), and use **PtcRunner / PTC-Lisp** as
the sandboxed language for two jobs: agent-facing deterministic *compute*, and
orchestrator-side *dispatch policy*.

## The two workstreams (kept separate on purpose)

```
WS-A  Compute coprocessor (build first, small, high ROI)
      PtcRunner embedded as a tool. Agents write small sandboxed programs to
      query/reshape/aggregate instead of hand-wiring grep|sed|awk in Bash.
      Independent of any BEAM-orchestrator work. Ships as an MCP server / tool.

WS-B  BEAM orchestrator (the long horizon)
      Spell's task execution relocated onto an OTP supervision tree. Subagents
      become supervised BEAM processes. The Rust kernel is a NIF shared per node.
      PtcRunner additionally serves orchestrator dispatch policy as data.
```

WS-A is a *standalone deliverable* and the V1 we commit to now. WS-B is the
architecture WS-A is designed to slot into without rework.

---

## Why BEAM, honestly

Ranked by the value the user actually wants (their words: distribution is
*lowest*; the real prizes are reliability, conceptual unification, parallelism):

```
conceptual    one OTP substrate; delete hand-rolled TS schedulers
              (batch-scheduler, swarm-scheduler, mutable-dag, retry-state,
               progress-heartbeat) → replaced by supervision + GenServer state
reliability   crash isolation + supervised restart per run/subagent
parallelism   bounded concurrency via slot budget / process pools
              (PtcRunner's ParallelBudget is a worked example of the model)
distribution  multi-node agent fleets — the thing TS genuinely can't do well,
              but explicitly NOT the primary driver
```

## Why this is *reachable* and not a fork: the kernel is already clean

Verified topology (see `specs/codegraph-architecture.md`, `docs/natives-*`):

```
            ┌──────── ONE Rust core ────────┐
            │ pi-code-path   (19,851 LOC)    │  ← the brain: parse · resolve · edit · edges
            │ pi-code-graph  (12,567 LOC)    │  ← semantic/LSP, owns hover/diag/def/ref
            │ pi-natives     (36,240 LOC)    │  ← kernel + 223 #[napi] marshalling skin
            └───────────────▲────────────────┘
                            │ marshal (DTOs)
                  napi.rs ≈ 1,200 LOC = #[napi(object)] DTOs + marshal/* + async wrapper
                            │
                       TS harness  (find/edit/lsp tool handlers, schedulers)
```

`napi.rs` is a *marshalling skin*, not logic. `execute_code_path` delegates
straight to `execute_code_path_inner` → `pi_code_path`. ∴ rustler is a **second
skin over the same core**, not a reimplementation. The kernel never JS-assumed;
its lock table (`lockStatus`: per-file owner + waiters over the process-global
`buffer_registry`) is runtime-neutral — owner identity simply moves from a Node
async-context to a BEAM pid.

## Target architecture (WS-B end state)

```
                      ┌─────────────────────────────────────────┐
   org graph / work → │  BEAM Orchestrator (OTP supervision tree) │
                      │   GenServer scheduling state              │
                      │   PtcRunner.run(dispatch_policy, ctx)     │ ← policy as DATA
                      └───────────────┬───────────────────────────┘
                                      │ spawns + supervises
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
          Subagent (BEAM proc)  Subagent (BEAM proc)  Subagent (BEAM proc)
                  │  tools = Elixir modules            │
                  ▼                                    ▼
          Spell.Kernel (rustler NIF)  ── shared, warm, per node ──►  pi_code_path / pi_code_graph
                  │                                                   (one kernel, many agents,
          PtcRunner (compute, sandboxed)                               arbitrated by lock table)
```

Tool homes after the move (most tools get a *better* home than TS):

```
pure-kernel   find · edit · parse · render · code-graph   → rustler NIF over shared kernel
process-spawn bash                                         → BEAM Port (better supervision than child_process)
external-proc lsp (rich actions)                           → ALREADY a Rust concern. FUP-095 (branch
                                                             `fup-095-nuke-lsp-tool`, STATE: DONE) DELETES the
                                                             entire TS lsp/ tree (~9,000 LOC) and replaces it with
                                                             the Rust SemanticBackend wired into find/edit. The
                                                             `lsp` tool is NUKED, not migrated. Prereq for this
                                                             slice = MERGE that branch, no new work.
network       fetch · web_search                           → Finch/Req in Elixir (trivial, better backpressure)
llm-backed    task · oracle · plan (subagents)             → these BECOME the supervised processes, not tools
compute       org/memory aggregation, dispatch policy      → PtcRunner (WS-A) — already BEAM-native
```

## Where PtcRunner earns its place (and where it does NOT)

Decision rule, derived not asserted:

```
Is the policy/compute author the SAME entity that compiles the orchestrator?
  YES → plain Elixir.   (core scheduler, DAG ready-set, backoff arithmetic — infra)
  NO  → PtcRunner.      (repo WORKFLOW rules, operator live-override, agent self-policy,
                         agent-authored compute) — sandboxed, hot-swappable, ships as a value
```

Properties that make Lisp-as-data worth its untyped boundary — it pays only when
≥1 holds: **P1** authored by a non-recompiler (repo/operator/agent); **P2** changes
faster than deploy cadence; **P3** must be sandboxed from the orchestrator;
**P4** must travel as a value (ship to N nodes, store in org, diff in a PR).

```
core slot/concurrency math        P1✗ P2✗ P3✗ P4✗  → plain Elixir
DAG ready-set / wave compute      P1✗ P2✗ P3✗ P4✗  → plain Elixir (infra, not policy)
retry/backoff formula             P1✗ P2~ P3✗ P4✗  → plain Elixir
repo WORKFLOW dispatch rules      P1✓ P2✓ P3~ P4✓  → PtcRunner
operator live-tuning              P1✓ P2✓ P3✓ P4✗  → PtcRunner
agent-authored sub-policy/compute P1✓ P2✓ P3✓ P4✓  → PtcRunner (only sandbox is safe)
```

Crucially the **agent compute coprocessor (WS-A)** and **agent-authored dispatch
policy (WS-B)** are the *same capability* — one embedded PtcRunner, two callers
(the agent in a turn, the orchestrator at a tick). WS-A is therefore the honest
first slice of WS-B's most defensible use of the language.

## The non-negotiable contracts (must hold from V1, not bolted on later)

```
NIF blast radius   NAPI panic kills 1 Node proc; NIF panic kills the WHOLE BEAM node.
                   → every NIF boundary catch_unwind → {:error, …}; panics are bugs,
                     errors are values (kernel already returns Result<_, Diagnostic>).
scheduler safety   <1ms ops → regular sched; resolve/edit/graph → DirtyCpu;
                   external-proc (LSP) → never a blocking NIF (port or async-yield).
lock liveness      subagent BEAM proc dies mid-edit holding a file lock →
                   monitor + ResourceArc Drop reclaims it. TS gets this free via
                   async-context teardown; BEAM needs it explicit.
schema discipline  every PtcRunner policy/compute call carries output_schema →
                   malformed return is a typed rejection the caller falls back from,
                   never a crash.
```

The `find`-as-NIF proof-of-concept must demonstrate **all three** of correctness,
panic-safety, and lock-liveness — not just "find works." Those three derisk the
clean-core + safe-boundary + concurrency hypotheses that the whole of WS-B rests on.

## What we are explicitly NOT doing

- Not porting Symphony. Symphony is a Linear-polling PR-landing daemon; its value
  to us is the *substrate pattern* (OTP supervisor driving headless agents over a
  protocol), not its application. Spell already has the headless surface
  (`coding-agent/src/modes/rpc/`, JSON-lines stdin/stdout — the app-server analog).
- Subscriptions (knowledge push-frames, task EventBus) are consumed at the Elixir
  HOST boundary and snapshotted into PtcRunner `context`. PTC-Lisp programs stay
  synchronous/sandboxed — they never subscribe. This is by design, not a gap.
- Not running coding agents *inside* PtcRunner. PTC-Lisp has no fs/net/shell by
  construction; it is a compute language, never an agent host.
- Not writing core scheduling in Lisp. Infra stays typed Elixir.
- Not committing to WS-B now. We commit to WS-A (compute coprocessor) and design
  it to slot into WS-B without rework.
