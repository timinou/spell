# The Elixir/PTC Boundary — Two End-to-End Traces

> **Status: SHIPPED (doctrine + live traces).** The two traces reflect the real
> keystroke→gaze and LLM→tool paths. The doctrine ("Elixir materializes, PTC
> transforms") is aspirational where reducer policy still lives in Elixir
> (FEAT-037 moves it to data).

> **Doctrine** (stated in `lib/spell_agent/hist/lens.ex`): *"Elixir owns
> primitives + invariants; PTC owns policies + lenses."* — *"Elixir
> materializes, PTC transforms."*

This document traces a single agent action end-to-end along both inverse paths,
marking every Elixir↔PTC handoff in sequence. It is the concrete, code-grounded
companion to `freeform-tui-philosophy.md` (the *why*) — here is the *how*, read
straight out of the call chains.

The two traces:
1. **Keystroke → gaze′** — the write-mirror (read+write loop):
   `keystroke → Keys.dispatch → Reaction.Ptc → harness/ verb → %Ui{}`.
2. **LLM emits `(tool/…)` → registry** — the self-extending tool surface:
   `LLM → sandbox → to_callable → ToolRegistry`.

---

# Trace 1 — Keystroke → gaze′ (the *write-mirror*, read+write loop)

User presses `C-l` while focused on the span tree. Goal: produce the next `%Ui{}`.

```
┌─ keystroke "C-l" ────────────────────────────────────────────────────────────┐
│                                                                               │
│  ① App (ExRatatui)            builds the context STACK = [SpanTree, Global]    │  ELIXIR
│     focus_stack/1             (most-specific first)                            │
│        │                                                                       │
│        ▼                                                                       │
│  ② Keys.resolve(chord, stack)   chord ──▶ {:intent, intent, ctx}              │  ELIXIR
│     │  per ctx, LIVE override beats compiled:                                  │  (pure fold,
│     │  KeymapRegistry.lookup_binding(:tree, "C-l")  ← runtime keymap/bind      │   no `if focus`)
│     │     ‖ fallback ‖                                                         │
│     │  ctx.keymap()  ← compiled source list                                   │
│     ▼                                                                          │
│     {:intent, :"span/expand", SpanTree}                                        │
│        │                                                                       │
│        ▼                                                                       │
│  ③ Keys.dispatch({:intent, …}, ui, forest)                                     │  ELIXIR
│     │  PTC reaction wins over compiled:                                        │  (the fork)
│     │  KeymapRegistry.lookup_reaction(:tree, :"span/expand")                   │
│     │       ├── nil ──────────▶ ctx.react/3   (compiled Elixir clause)         │
│     │       └── source(String) ─▶ run_ptc_reaction ─────────────┐              │
│        │                          (apply/3 runtime dispatch,     │             │
│        │                           BUG-006 lazy-load seam)       │             │
└────────┼─────────────────────────────────────────────────────────┼───────────┘
         │                                                          ▼
         │                                  ╔═══════════════════════════════════╗
         │                                  ║  ④ Reaction.Ptc.run(source,ui,    ║
         │                                  ║     forest)                       ║  ELIXIR→PTC
         │                                  ║   context = %{"ui"=>ui_to_map(ui),║   BRIDGE
         │                                  ║              "forest"=>forest}    ║
         │                                  ║   tools   = Harness.tools(forest, ║
         │                                  ║                            ui)    ║
         │                                  ║   PtcRunner.Lisp.run(             ║
         │                                  ║     source, context:, tools:,     ║
         │                                  ║     caller: :in_process_v1)       ║  ← THE one sandbox
         │                                  ╚═══════════════════╤═══════════════╝
         │                                                      ▼
         │   ╔══════════════════════════════════════════════════════════════════╗
         │   ║  ⑤ the reaction body — USERLAND, BEAM-LISP:                        ║  PTC
         │   ║                                                                    ║  (the actual
         │   ║   (reduce harness/expand                                           ║   behavior)
         │   ║           (harness/state)                                          ║
         │   ║           (harness/descendants (harness/cursor-id)))               ║
         │   ║                                                                    ║
         │   ║   data/ui   ─ the gaze handed in                                   ║
         │   ║   data/forest ─ the live span forest                              ║
         │   ╚════════════════════════════╤═══════════════════════════════════════╝
         │                                ▼  each (harness/…) is a tool call
         │                  ╔═════════════════════════════════════════════════════╗
         │                  ║  ⑥ Harness verbs (PTC→ELIXIR per call):              ║  PTC→ELIXIR
         │                  ║   harness/state       → ui_map(to_ui(g.(args)))      ║   per verb
         │                  ║   harness/cursor-id   → SpanTree.cursor_span_id(…)   ║
         │                  ║   harness/descendants → Store.subtree(forest,id)     ║
         │                  ║   harness/expand      → ui_map(Ui.expand(to_ui,id))  ║
         │                  ║                                                      ║
         │                  ║   pure on a Ui VALUE: takes a gaze map, returns a    ║
         │                  ║   gaze map ∴ the reaction is a FOLD over data/ui     ║
         │                  ╚═════════════════════════════╤════════════════════════╝
         │                                                ▼
         │                                  step.return = the final gaze MAP (string-keyed)
         │                                                │
         │                                  ╔═════════════▼══════════════════════╗
         │                                  ║  ⑦ Reaction.Ptc.rehydrate(map, ui) ║  PTC→ELIXIR
         │                                  ║   EVERY field bounded-coerced:     ║   BRIDGE
         │                                  ║   focus→Ui.safe_pane ‖ ui.focus    ║   (back to struct)
         │                                  ║   auto_depth→non_neg_int ‖ prior   ║
         │                                  ║   cursors→known panes only         ║
         │                                  ║   ⇒ a malformed return can't make  ║
         │                                  ║      a %Ui{} that crashes a render ║
         │                                  ╚═════════════╤══════════════════════╝
         ▼                                                ▼
   ctx.react/3  ───────────────────────────────────▶  %Ui{}′  (new gaze)
   (compiled path lands here too)            on ANY failure (rescue) → original ui unchanged
```

**The handoffs (Trace 1):**

| # | from → to | what crosses | direction |
|---|---|---|---|
| ③ | Elixir → (fork) | `lookup_reaction` returns a **String** (PTC source) vs `nil` (compiled) | the homoiconic switch |
| ④ | Elixir → sandbox | `%Ui{}` →`ui_to_map`→ plain map as `data/ui`; tools map injected | struct → data |
| ⑤ | — | the reaction body **is BEAM-Lisp** — the whole behavior is userland | — |
| ⑥ | PTC → Elixir | each `(harness/…)` calls back into a pure Elixir gaze transform | data → struct → data, per call |
| ⑦ | sandbox → Elixir | final gaze map → `rehydrate` → `%Ui{}`, every field bounded | data → struct |

NB the **dual axes** are independent and both live: `keymap/bind` rebinds *which
chord → which intent* (②), `keymap/define-reaction` redefines *what an intent
does* (③→⑤). Neither needs an Elixir deploy.

---

# Trace 2 — LLM emits `(tool/…)` → registry (the *self-extending tool surface*)

Two sub-traces: (A) the agent **defines** a tool, (B) the agent **calls** it. The
payoff is that after (A), (B) is indistinguishable from a built-in.

### 2A — `(tool/define-tool {:name "spend" :source "(hist/cost {})" :scope "durable"})`

```
╔════════════════════════════════════════════════════════════════════════════╗
║  LLM turn body (PTC):  (tool/define-tool {…})                                ║  PTC
╚═══════════════════════════════════╤════════════════════════════════════════╝
                                    ▼  tool/ routes to the tools map entry
┌────────────────────────────────────────────────────────────────────────────┐
│  ① meta_tools()["define-tool"] = &define_tool/1   ← a NATIVE entry           │  ELIXIR
│     (meta-tools are themselves ordinary tool-map entries)                     │
│        │                                                                      │
│        ▼                                                                      │
│  ② Tools.define_tool(args)                                                    │  ELIXIR
│     require_string name/source; normalize_params; normalize_scope("durable") │  (invariants
│     reserved_name?  → raise if shadowing a builtin                            │   only)
│     validate_source → PtcRunner.Lisp.validate(source)   ← parse/analyze/      │
│        │                undefined-var, under heap cap. BAD source → raise     │
│        ▼                (rendered as LLM-facing error, not stored)            │
│  ③ ToolRegistry.put(%{kind: :ptc, name, params, doc, source, scope: :durable})│  ELIXIR
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     ▼  inside Agent.update (serialized)
┌────────────────────────────────────────────────────────────────────────────┐
│  ④ map  := Map.put(tools, "spend", entry)        ← fast in-memory cache       │  ELIXIR
│     sync_store(store, "spend", entry):                                        │
│       durable+:ptc+binary source ⇒ mirror to Hist.Store as %ToolDef{}         │
│       (merge onto any existing → preserves origin/stats provenance)           │
│     best-effort: sick store → silent no-op, map write still proceeds          │
└────────────────────────────────────────────────────────────────────────────┘
     stored as DATA: source text on disk/Khepri, diffable, list-able, re-runnable
```

### 2B — later (even next BEAM sitting): `(tool/spend {})`

```
                       BOOT (next session):
                       ToolRegistry.start_link → rehydrate(store)
                         Store.list(:tool) ▸ durable_map ▸ skip non-durable/
                         source-less/corrupt  ⇒ "spend" back in the map        ELIXIR
                                    │  (store = source of truth, map = cache)
                                    ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  LLM turn body (PTC):  (tool/spend {})                                       ║  PTC
╚═══════════════════════════════════╤════════════════════════════════════════╝
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  ① resolver looks up "spend" in the tools map                                │  ELIXIR
│     build_tools_map(): meta ∪ native ∪ freeform ∪ REGISTRY                    │
│     registry entry "spend" → to_callable(entry)                              │
│        │                                                                      │
│        ▼                                                                      │
│  ② to_callable(%{kind: :ptc, source: "(hist/cost {})"})                       │  ELIXIR→PTC
│     returns fn args ->                                                        │   BRIDGE
│       PtcRunner.Lisp.run(source,                                              │
│         context: stringify_keys(args),   ← call args become data/<param>     │
│         tools:   build_tools_map(),      ← child sees the full surface       │
│         caller:  :in_process_v1)         ← THE same sandbox                   │
│       {:error, step} → raise  (→ LLM-facing error, like a native failure)    │
└────────────────────────────────────┬─────────────────────────────────────────┘
                                     ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  ③ "spend" body runs — USERLAND PTC, which itself calls another PTC lens:    ║  PTC
║       (hist/cost {})                                                          ║
║         └─ hist/cost is ALSO a .ptc file (priv/hist/lenses/cost.ptc)         ║
║            run by Hist.Lens.run/4 over project/3 (Elixir materialize)        ║
╚════════════════════════════════════════════════════════════════════════════╝
            step.return  →  %{"input"… "output"… "total"… "nodes_counted"…}
```

**The handoffs (Trace 2):**

| # | from → to | what crosses | direction |
|---|---|---|---|
| 2A② | PTC → Elixir | `define_tool` enforces invariants (validate/reserved/scope) — **no behavior** | guard only |
| 2A③④ | Elixir | tool stored as **source text** (not a closure) → durable `%ToolDef{}` | code-as-data |
| boot | Elixir | `rehydrate` projects store → map; store is truth, map is cache | data → cache |
| 2B② | Elixir → sandbox | `to_callable` wraps source in the **same `Lisp.run`** every surface uses | the bridge |
| 2B③ | — | a `:ptc` tool calling a `.ptc` lens — **userland all the way down** | — |

---

## What the two traces share (the architectural punchline)

Both inverse paths converge on the **identical Elixir primitive**:

```
PtcRunner.Lisp.run(source, context:, tools:, caller: :in_process_v1)
```

The reaction runner (`Reaction.Ptc.run`) and the tool runner
(`Tools.to_callable`) say so in their own moduledocs — each calls itself the
*dual* of the other: a tool is `args → value`; a reaction is `gaze → gaze`. Same
sandbox, same `caller`, same failure contract.

And the Elixir on each side does only the four transparent jobs, never the
behavior:

1. **materialize** private shapes → JSON-safe data (`ui_to_map`, `project/3`,
   `stringify_keys`),
2. **inject** as `data/*` + hand over the `tools` map,
3. **bound-coerce** the return back to a struct (`rehydrate`, `durable_map`) —
   never interning an atom from untrusted strings (`safe_pane`/`to_existing_atom`),
4. **fail soft** — bad reaction → unchanged gaze; bad tool → LLM-facing error;
   sick store → empty cache. Userland can be wrong; the surface never bricks.

That's the whole bet: **the behavior is data the agent authored (`C-l`'s
reaction, the `spend` tool, every `hist/*` lens), and the compiled Elixir is a
thin, invariant-keeping, fail-soft harness around the one evaluator.**

---

## Source map (where each step lives)

| Step | Module | Function |
|---|---|---|
| T1 ①②③ | `lib/spell_agent/tui/keys.ex` | `resolve/3`, `dispatch/4`, `run_ptc_reaction/3` |
| T1 ④⑦ | `lib/spell_agent/tui/reaction/ptc.ex` | `run/3`, `rehydrate/2`, `ui_to_map/1` |
| T1 ⑤ | `priv/` reaction source (authored via `keymap/define-reaction`) | — |
| T1 ⑥ | `lib/spell_agent/harness.ex` | `tools/2` (`harness/*` + `keymap/*` verbs) |
| T2 ①②③④ | `lib/spell_agent/tools.ex` | `meta_tools/0`, `define_tool/1`, `to_callable/1`, `build_tools_map/0` |
| T2 ③④/boot | `lib/spell_agent/tool_registry.ex` | `put/1`, `sync_store/3`, `rehydrate/1`, `durable_map/1` |
| T2 ③ lens | `lib/spell_agent/hist/lens.ex` + `priv/hist/lenses/*.ptc` | `run/4`, `project/3` |
| both | vendored `ptc_runner` | `PtcRunner.Lisp.run/2`, `PtcRunner.Lisp.validate/1` |

See also: `freeform-tui-philosophy.md` (the boundary-dissolution thesis),
`freeform-tui-architecture.md` (the render mirror), `durable-toolset.md` (the
registry↔store projection).
