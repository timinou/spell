# V1 Spec: PtcRunner Compute Coprocessor with Auto-Hydrated Tool/Provider Catalog

**Date**: 2026-05-30
**Status**: Proposed V1. Implementation scope is intentionally bounded HERE.
**Goal (user's words)**: "a basic version of PtcRunner + some codegen-ed tool list
+ provider list that Spell automatically hydrates the BEAM runtimes it spins out,
so that we can see what using PtcRunner to create pipelines of tool calls to
answer questions looks like."

This is **WS-A** from `01-vision.md`. It is a standalone deliverable that does not
require the BEAM orchestrator (WS-B), but is designed to become its compute lane.

---

## What V1 delivers

A Spell-spawned BEAM runtime that boots **pre-hydrated** with:

1. **PtcRunner** (the Elixir lib) running PTC-Lisp programs in its per-call sandbox.
2. A **codegen'd tool catalog** — Spell's tool surface (find/edit/bash/org/memory/…)
   described as PTC-Lisp-callable `tool/call` targets with signatures + output hints.
3. A **codegen'd provider catalog** — the model/provider registry (for any
   `llm_query` the program wants to make), as PtcRunner model aliases.

The observable outcome: an agent (or a human at a REPL) can write a single
PTC-Lisp program that **chains tool calls** — probe a shape, fetch, filter,
aggregate — and get back one small validated answer, instead of N Bash turns.

```
;; the thing we want to SEE working:
(let [items (:value (tool/call {:tool "org" :args {:command "query" :query "todo:DOING"}}))]
  (->> items
       (group-by #(get % "layer"))
       (map-vals (fn [g] {:open (count g) :hi (count (filter #(= 1 (get % "priority")) g))}))))
;; → {"kernel" {:open 12 :hi 4} "ui" {:open 5 :hi 1}}   one call, exact, ~30 tokens back
```

---

## Architecture

```
Spell session (Node)                         BEAM runtime (spawned by Spell)
─────────────────────                        ───────────────────────────────
                                             ┌──────────────────────────────────┐
  spawn + hydrate  ───── stdio/socket ─────► │ ptc_runner (Elixir)                │
  (tool catalog +                            │   MCP server `ptc_lisp`            │
   provider catalog                          │   tool: lisp_eval {program, ctx,   │
   as boot payload)                          │                    output_schema}  │
                                             │                                    │
  tool/call bridge ◄──── JSON-RPC ─────────► │   tool/call → back to Spell's REAL │
  (PtcRunner asks Spell                      │     tool executors over the bridge │
   to run a real tool)                       │   llm_query → provider catalog     │
                                             └──────────────────────────────────┘
```

Two channels between Spell and the BEAM runtime:

- **Boot hydration** (Spell → BEAM, once at spawn): the generated catalogs.
- **tool/call bridge** (BEAM → Spell, per program): when a PTC-Lisp program calls
  `(tool/call …)`, the sandbox cannot touch fs/net itself, so the call is
  *mediated* back to Spell's real tool executor and the result returned as a value.
  This is exactly PtcRunner **aggregator mode** (`tool/mcp-call`), pointed at Spell
  rather than arbitrary MCP upstreams.

> Design note: the bridge is what keeps the sandbox honest. PTC-Lisp computes;
> Spell performs effects. The program orchestrates; it never reaches the disk.

---

## The codegen: single source of truth → two catalogs

Spell already defines every tool once (TypeBox schemas in `coding-agent`, NAPI
DTOs in Rust). V1 adds a generator that emits a PtcRunner-shaped catalog from that
existing source — **no second hand-maintained list**.

### Tool catalog (generated)

Each Spell tool → a catalog entry the planner/agent can discover with
`(apropos …)`, `(dir 'tool)`, `(doc 'tool/org)` and call with `(tool/call …)`:

```
;; generated from TypeBox tool schemas
org(command: string, query: string?, ...) -> {items [:map], ...}
find(target: string, content: bool?) -> {chunks [:map]}
memory(action: string, text: string?, ...) -> {hits [:map]}
bash(command: string) -> {stdout :string, exit :int}   ; effectful → mediated
...
```

Output hints follow PtcRunner's JSON-Schema→PTC convention (string/int/bool/array/
map; unknown → `:any`/`:map`; absent → `:unknown_content`). These are *planner
guidance*, not runtime validation — same contract PtcRunner already documents.

### Provider catalog (generated)

The model registry → PtcRunner model aliases for `llm_query` / SubAgent use:

```
;; generated from Spell's provider/model config
alias "fast"     -> "anthropic/claude-haiku-4-5"
alias "smart"    -> "anthropic/claude-sonnet-4-6"
alias "cheap"    -> "openrouter:google/gemini-3.1-flash-lite"
```

### Generator contract

```
INPUT   Spell tool schemas (TypeBox)  +  provider/model registry
OUTPUT  catalog payload (JSON) injected at BEAM boot:
          { tools: [{name, sig, output_hint, effectful}], providers: [{alias, model}] }
RULE    generated, never hand-edited; regenerated on tool/provider change
        (a check:catalog CI gate keeps it in sync, like other Spell codegen)
```

This is the "Spell automatically hydrates the BEAM runtimes it spins out" piece:
the catalogs are a **boot artifact**, produced by Spell from its own definitions,
handed to every BEAM runtime it launches.

---

## Why this composes with WS-B (no rework later)

```
V1 (WS-A)                              becomes in WS-B
──────────                             ────────────────
spawn BEAM runtime + hydrate           orchestrator spawns supervised nodes,
                                       hydrates each with the same catalogs
tool/call bridge → Spell executors     tool/call → rustler NIF (in-node kernel),
                                       no bridge hop for pure-kernel tools
lisp_eval (agent compute)              SAME runtime ALSO serves dispatch policy
                                       (PtcRunner.run at the orchestrator tick)
provider catalog for llm_query         SAME catalog drives subagent model routing
```

Nothing in V1 is throwaway: the catalogs, the bridge protocol, and the sandbox
contract are the WS-B compute lane verbatim. WS-B *adds* the supervision tree and
swaps the bridge for in-process NIF calls on the pure-kernel tools.

---

## Scope boundary (what V1 is and is NOT)

```
IN  · embed ptc_runner; expose lisp_eval to Spell agents (MCP tool or native tool)
    · generator: TypeBox tool schemas + provider registry → catalog JSON
    · boot hydration of a Spell-spawned BEAM runtime with the catalogs
    · tool/call bridge (aggregator-mode) → Spell's real tool executors
    · 3-5 worked example programs (org rollup, memory rerank, multi-tool fan-out)
      proving "pipelines of tool calls to answer questions"

OUT · NO OTP supervision tree / orchestrator (that is WS-B)
    · NO rustler NIFs (bridge uses existing executors; NIF is WS-B Phase 2)
    · NO subagents-as-BEAM-processes
    · NO dispatch-policy-as-Lisp wired to a live scheduler (design only, in vision)
    · NO LSP migration needed — fup-095 already replaced the lsp tool with the
      Rust find/edit semantic surface; prereq is a branch merge, not new work
```

## Acceptance (definition of done for V1)

1. A Spell agent can call a `lisp_eval`-style tool and receive a schema-validated
   result computed from a PTC-Lisp program.
2. That program can `(tool/call …)` at least two distinct Spell tools and combine
   their results (the fan-out/aggregate pattern) in one turn.
3. The tool + provider catalogs are **generated** from Spell's existing
   definitions and injected at BEAM boot; a CI check fails if they drift.
4. Sandbox guarantees observable: a non-terminating / oversized program is killed
   with a recoverable error message, the BEAM runtime survives, Spell is unaffected.
5. ≥3 documented example programs reproduce real patterns from
   `00-evidence-bash-usage.md` (i.e., replace a real grep|sed|awk Bash idiom).

## Open questions for V1 (flag, don't block)

- **Transport**: reuse Spell's MCP client (PtcRunner ships an MCP server) vs. a
  thinner native bridge? MCP is the lower-friction start; it matches the precedent
  (`mcp_tidewave_project_eval` already works this way).
- **Bridge auth/scope**: which Spell tools are exposed to `tool/call`, and are
  effectful ones (bash/edit) allowed in V1 or read-only-first? Recommend
  **read-only-first** (mirrors `--aggregator-read-only`), matching the 31%
  pure-query population we're targeting.
- **Lifecycle**: one long-lived BEAM runtime per Spell session (session reuse →
  cheap evals, per the author's perf note) vs. ephemeral per-call. Recommend
  **per-session**, stateful sessions off unless needed.
