# The durable toolset — how a script you write becomes a tool you keep

> PLAN-011 W3. The third of the three promises: **write** (`sh::`), **compose**
> (`->>`/`pmap`), and now **remember**. A tool the agent authors at runtime
> should outlive the session that authored it — without the agent learning a new
> verb, and without a second storage system bolted on the side.

---

## 0. The one-paragraph version

A runtime tool is already PTC-Lisp source-as-data in `ToolRegistry`. W3 makes
that registry **durability-aware**: when a tool is defined as *durable*, the
registry mirrors it to the history substrate (`Hist.Store`) as a `ToolDef`, and
on boot it **rehydrates** every stored `ToolDef` back into the live map. The
registry stays a fast in-memory cache; `Hist.Store` is the source of truth. No
new store, no new protocol — the substrate already had a `{:tool, name}` slot
waiting.

```
define a durable tool ──put──▶ ToolRegistry (Agent, in-mem cache)
                                     │ mirror
                                     ▼
                               Hist.Store  {:tool, name} => %ToolDef{}
                                     │ rehydrate on boot
                                     ▼
                          every future session sees the tool
```

---

## 1. Why this shape, and not a new store

The temptation is to give the registry its own database. That would be a second
source of truth to keep in sync with the history substrate — and the substrate
*already models tools*:

```elixir
# SpellAgent.Hist.Store key space (pre-existing):
{:tool, name}    => %ToolDef{}     # cross-session
{:crystal, id}   => %Crystal{}     # long-term, distilled
```

`ToolDef` even carries the right field for this exact decision:

```elixir
scope :: :session | :durable
#         ^ authored & used here    ^ promoted: resolves in every future session, like a built-in
```

So the design writes itself from the substrate that exists:

> **One source of truth per concern.** The registry and the store are not two
> systems to reconcile — the registry is a *projection* of the store's `:tool`
> kind into a fast lookup map. Collapse, don't synchronize.

This is the same posture `Hist` itself takes: capability logic talks to a
`Store` *behaviour*, tested against `Store.Memory` (ETS, zero infra) and run in
production against `Store.Khepri` (durable, on-disk). The toolset inherits that
test/prod split for free.

---

## 2. The durability ladder (three rungs, increasing permanence)

```
rung   where it lives                 survives…                    set by
────   ──────────────────────────     ─────────────────────────    ─────────────────────
 0     ToolRegistry only (Agent map)  …this session only           scope: :session  (default)
 1     + Hist.Store.Memory            …across runs in ONE BEAM      scope: :durable, store=Memory (default)
 2     + Hist.Store.Khepri            …across BEAM restarts          scope: :durable, store=Khepri (config)
```

- **Rung 0** is today's behaviour: a quick, throwaway tool. Gone on restart. The
  right default for an experiment.
- **Rung 1** is the everyday "remember": the tool survives across missions
  within one running BEAM (the same win `Hist.Store.Memory` gives conversation
  history). Zero infra — the default store.
- **Rung 2** is true cross-restart durability, opt-in exactly like durable
  history: `config :spell_agent, SpellAgent.Hist, store: SpellAgent.Hist.Store.Khepri`.
  App boot never *depends* on Khepri being healthy — the default stays Memory.

The agent never picks a rung by learning new machinery; it picks `scope` (and
the operator picks the store). The same `define-tool` call lands on whatever
rung is configured.

---

## 3. What persists, what doesn't

```
:ptc  tool (source-as-data)   → PERSISTS   (it IS data; rehydrates verbatim)
:native tool (an Elixir fn)   → NEVER       (it's code; re-registered at boot from native_tools/0)
```

A `:native` entry holds a function reference — not serializable, and not
*needed*: native tools (`sh`, the meta-tools, the freeform surface) are
re-registered deterministically every boot. Only the agent-authored `:ptc`
tools are knowledge worth persisting. The registry mirrors and rehydrates
**only** `:ptc` entries.

> A `sh::` script is the archetypal durable tool: `(tool/define-tool {:name
> "todo-files" :source "(:lines (sh:: rg -l TODO ~data/dir))"})` is `:ptc`
> source — so it persists, rehydrates, and resolves next session as if it were
> always built in.

---

## 4. Rehydration: the registry as a projection

On `ToolRegistry.start_link/1` the registry asks the store for every `:tool`
value and seeds its map:

```
start_link → Hist.Store.list(store, :tool) → [%ToolDef{}, …]
           → Map.new(name => registry_entry(tool_def))
```

A `ToolDef` is mapped back to a registry `:ptc` entry (`name`, `params`, `doc`,
`source`). Because resolution checks the registry first, a rehydrated tool is
**indistinguishable from a built-in** — which is the whole homoiconic point:
nothing in the call site knows whether `todo-files` was authored 10 seconds ago
or 10 sessions ago.

Boot safety follows the existing rule: rehydration is **best-effort**. If the
store is unavailable, the registry boots empty rather than crashing the app —
the same degradation ladder every live-data surface here uses ("never brick the
surface").

---

## 5. Promotion to a Crystal (the next permanence tier)

`scope: :durable` keeps a tool's *source*. A **Crystal** keeps a tool's *proven
provenance*: a distilled, LLM-free program with a `DISTILLED_FROM` lineage back
to the turns that earned it (`Hist.Crystal`). Promotion is therefore not "save
harder" — it's "this durable tool proved useful; attach its evidence chain and
move it to long-term memory."

```
:session tool  ──used, proved useful──▶  :durable tool  ──distilled w/ provenance──▶  Crystal
   (rung 0)                                  (rung 1/2)                                  (long-term)
```

W3 ships rungs 0–2 (the `scope`/store ladder). The Crystal promotion path is
wired in a later wave; this doc names it so the seam is visible now.

---

## 6. Contract summary

| operation | rung 0 | rung 1/2 (durable) |
|---|---|---|
| `define-tool` (`:ptc`, `:session`) | in-mem only | — |
| `define-tool` (`:ptc`, `:durable`) | in-mem | + mirror to `Hist.Store` |
| `remove` | drop from map | + delete from store |
| boot | empty map | + rehydrate every `:tool` |
| `:native` tool | re-registered | never persisted |

Invariants:
- the registry is a **cache**; `Hist.Store` is the **truth** for durable tools.
- persistence touches **only** `:ptc` durable entries — code stays code.
- boot is best-effort: a sick store yields an empty registry, never a crash.

---

## 7. Verified substrate facts this builds on

| fact | evidence |
|---|---|
| store models tools already | `Hist.Store` key `{:tool, name} => %ToolDef{}` |
| durable-vs-session is a field | `ToolDef.scope :: :session \| :durable` |
| Memory + Khepri behind one behaviour | `Hist.Store.{Memory,Khepri}` impls |
| Khepri path for tools exists | `Store.Khepri` `path({:tool, name})` |
| default store is Memory, Khepri opt-in | `Hist.default_store/0` + app boot comment |
| registry resolves before natives | `ToolRegistry` moduledoc |
