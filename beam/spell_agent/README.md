# spell_agent — a node-free coding agent on the BEAM

A coding agent that runs with **zero Node**. It is authed by a Claude Pro/Max
**subscription** credential read directly from Spell's existing
`~/.spell/agent/agent.db`, runs the **PtcRunner** agentic loop on the BEAM, and
uses the Rust kernel (via NIF, future) for code tools.

Its defining capability is **homoiconicity**: the agent authors new tools at
runtime, as PTC-Lisp values (code-as-data), and calls them immediately — the
seed of a live self-coding environment.

This app is built **in parallel** beside the existing TypeScript Spell, which is
untouched. See `PLAN-344` (and `FEAT-824..827`) in `!tasks/`.

## Architecture

```
~/.spell/agent/agent.db ──(read-only)──▶ SpellAgent.Credentials   (FEAT-824)
                                              │  OAuth token
                                              ▼
                                         SpellAgent.OAuth          (FEAT-825)
                                              │
   prompt ──▶ SpellAgent.Session ──▶ PtcRunner.SubAgent ──llm──▶ SpellAgent.Anthropic
                       │                    (agentic loop)        (direct Req adapter,
                       │                                           subscription mode)
                       ▼
              SpellAgent.Tools.build_tools_map()   (FEAT-826)
                  │ native: define-tool / define-config / list-tools
                  │ :ptc  : tools authored at runtime, stored as PTC-Lisp source
                  ▼
              SpellAgent.ToolRegistry  ◀── the homoiconic surface
```

Every `(tool/name …)` the model writes resolves through one map. A `:ptc` tool's
body is stored **source text**, re-run via `PtcRunner.Lisp.run/2` with the call's
args bound as `data/<param>` — so a tool defined mid-conversation is
indistinguishable from a built-in on the next call.

## The subscription adapter (`SpellAgent.Anthropic`)

Claude Pro/Max OAuth is not just "a different auth header". The request must
present as Claude Code. All adaptations are application-layer (no TLS/JA3 spoof):

- `authorization: Bearer <token>` + the Claude Code `anthropic-beta` set + the
  `claude-cli/<ver> (external, cli)` user-agent.
- Two prepended system blocks: a billing header carrying `cch=<sha256(body)[:5]>`
  and the identity line `"You are a Claude agent, built on Anthropic's Claude
  Agent SDK."`
- Tool names prefixed `proxy_` on the wire, stripped on the way in.
- Tool results mapped to Anthropic's `tool_result` blocks on a `user` message.
- `cache_control` capped at 4 breakpoints.

A direct `Req` adapter was chosen over `req_llm` because v0 targets one provider
and needs full request-body control; `req_llm` is the right move when porting
many providers later.

## Run it

```sh
cd beam/spell_agent
mix deps.get
iex -S mix
```

```elixir
# one-shot
SpellAgent.run("What is 17 + 25? Reply with just the number.")
#=> {:ok, "42"}

# interactive
SpellAgent.repl()
```

### Live inspector TUI

A terminal UI (PLAN-345) to type a mission and watch everything happening inside
the run — turns, llm calls, tools, and (when a tool is itself a sub-agent) its
nested run, arbitrarily deep — with the final answer in the header. Launch it
directly, NOT from iex (the TUI must own the terminal; iex would corrupt the
display — BUG-489):

```sh
mix spell.tui
```

Type a prompt, press Enter to run; navigate with the chords below; `esc` (or
ctrl-c) quits and restores the terminal.

Requires a logged-in Anthropic subscription in `~/.spell/agent/agent.db` (run the
TypeScript `spell` once to log in, or point `SPELL_AGENT_DB` at another db).

## The Reaction DSL — intent-based, homoiconic keybindings (PLAN-346)

Input is the **write-mirror dual** of the inspector's read side. PLAN-345 made a
pane a READ mirror (`project/2 : forest → view-model`, telemetry-clocked). The
Reaction DSL adds the WRITE mirror (`react/3 : gaze → gaze'`, keystroke-clocked).
Both are pure, both colocate in the pane, and both are **live data you can
rewrite mid-session**.

The keystone is two-stage indirection — three orthogonal, live-data axes:

```
chord ──[keymap]──▶ intent ──[reaction]──▶ gaze'
      ↑ rebind keys        ↑ redefine behaviour
      (independent)        (independent)
```

Rebinding a key never touches behaviour; redefining a reaction never touches
keys; adding a context (focused pane / global) touches neither. Resolution is
**contextual** — the *same* chord names a *different* intent depending on focus,
via a context cascade (focused pane first, then global), with no `if focus ==`
anywhere.

### Modal navigation (W5)

The inspector is **modal**, like vim. Launch lands on the prompt in **NORMAL**
mode; press `enter` to enter **INSERT** mode and type a mission, `enter` again to
submit (which returns to NORMAL and moves focus to the tree so you can explore the
run as it streams). The layout is the span **tree** on the left and a **detail**
inspector on the right that shows the FULL content of whatever the tree cursor is
on — so navigating IS inspecting (a clipped turn row expands in the detail pane).

| chord | mode | tree focus | detail focus | prompt focus |
|---|---|---|---|---|
| `j` / `k` | NORMAL | next / prev row | scroll down / up | — |
| `l` | NORMAL | descend into the node (expand + first child) | — | — |
| `h` | NORMAL | ascend to the parent | — | — |
| `ctrl+j` / `ctrl+k` | NORMAL | cycle pane focus | cycle pane focus | cycle pane focus |
| `tab` / `shift+tab` | NORMAL | cycle panes | cycle panes | cycle panes |
| `enter` | NORMAL | — | — | enter INSERT (type) |
| `enter` | INSERT | — | — | submit the mission |
| `esc` | INSERT | — | — | back to NORMAL |
| `esc` / `ctrl+c` | NORMAL | quit | quit | quit |
| `C-l` / `C-h` | NORMAL | expand / collapse (explicit) | — | — |

`ctrl+j/k` (and the explicit `C-l`/`C-h`) are reachable because the vendored
ExRatatui NIF enables the **kitty keyboard protocol** (otherwise `ctrl+j`≡Enter
and `ctrl+h`≡Backspace at the legacy-terminal byte level). In NORMAL mode a plain
key is a chord, never text — which is exactly why `j/k/h/l` are free to navigate.
The composer's hint line + the `NORMAL`/`INSERT` indicator are *derived from the
live keymap + mode*, so they always reflect what is actually bound — including
runtime rebinds.

### Reshape the editor at runtime, in PTC-Lisp

Two namespaces sit beside `tool/` (split by effect profile):

- **`harness/`** — pure gaze transforms + forest queries used INSIDE a reaction
  (`harness/expand`, `harness/collapse`, `harness/cursor`, `harness/focus`,
  `harness/turn`, `harness/cursor-id`, `harness/descendants`, …).
- **`keymap/`** — live-rebinding meta-ops (`keymap/bind`, `keymap/unbind`,
  `keymap/show`, `keymap/intents`, `keymap/define-reaction`).

```clojure
;; rebind a key — takes effect on the next keystroke, no recompile
(keymap/bind {:chord "l" :intent "span/expand" :context "tree"})

;; author a NEW behaviour as data, then bind a chord to it
(keymap/define-reaction
  {:context "tree" :intent "span/expand-all"
   :doc "expand the whole subtree under the cursor"
   :source "(reduce (fn [acc id] (harness/expand {:ui acc :id id}))
                    data/ui (harness/descendants {:id (harness/cursor-id)}))"})
(keymap/bind {:chord "E" :intent "span/expand-all" :context "tree"})
```

A reaction runs through the SAME sandboxed `PtcRunner.Lisp.run` as every other
program, with the gaze bound as `data/ui` and the forest as `data/forest`,
returning the next gaze. So **a reaction is a tool whose param is your gaze and
whose return is your next gaze** — the inspector becomes editable by the thing it
inspects, in the language it inspects it with. (Reaction strings are untrusted:
all gaze coercion is funnelled through a bounded vocabulary so a reaction can
never grow the BEAM atom table — PLAN-346 W3r.)

Concepts: **Chord** (a normalized keystroke) · **Intent** (`domain/verb`, the
vocabulary) · **Keymap** (chord→intent, per context) · **Reaction**
(intent→gaze', compiled OR PTC source) · **Context** (a resolution layer) ·
**Gaze** (`%Ui{}`, the serializable navigation state a reaction transforms).

## The homoiconic demo (verified live, zero Node)

```elixir
SpellAgent.run("""
1. Call (tool/define-tool {:name "triple" :params [:n] :doc "multiply by 3"
                           :source "(* 3 data/n)"}) to define a new tool.
2. Then call (tool/triple {:n 14}) and (return) its result.
Report only the final number.
""")
#=> {:ok, "42"}

SpellAgent.ToolRegistry.all() |> Enum.map(& &1.name)
#=> ["triple"]      # a tool the model wrote at runtime, now callable
```

The agent authored a tool that did not exist when the session started, stored it
as data, and invoked it — the self-coding loop, working.

## Agency: the self-wake scheduler (A2, PLAN-014)

The agent loop is otherwise purely reactive — a human hands `SpellAgent.run/2` a
prompt, the mind runs a bounded loop, returns, and goes dark. `SpellAgent.Clock`
is the first **agency organ**: the mind schedules its own future awakening, and
when the timer fires the Clock **re-enters `SpellAgent.run/2` on the mind's
behalf**. A fired wake is a *synthetic caller* — the keystone the rest of the
agency ladder composes on (A3 `black/watch` swaps the time-fuse for a
condition-fuse; A4 `loop/continue` lets the mind author its own next prompt; A6
`self/spawn` aims a wake at a child session). See `docs/body-and-mind.md` for the
body/mind freedom argument this realizes.

Four `clock/*` verbs are merged into the agent's tool map (beside `hist/*` and
`black/*`), so the mind schedules itself in the language it thinks in:

```clojure
;; one-shot: wake me in 10 minutes to advance a goal
(tool/clock/at {:in "10m" :prompt "Re-read my open goals; advance the oldest one step."})

;; repeating: sweep for stuck work every hour, with a turn budget
(tool/clock/every {:every "1h"
                   :prompt "Sweep the mesh for stuck goals; summarize."
                   :budget {:turns 20}})

;; introspect + cancel
(tool/clock/pending {})              ;; => {"wakes" [...] "dropped" 0 "fired" 3}
(tool/clock/cancel {:id "wake-..."})
```

`:in` / `:at` / `:every` accept a ms integer or a duration string (`"500ms"`,
`"90s"`, `"10m"`, `"2h"`, `"1d"`). A wake defaults to running in the **calling
session** (override with `:session_id` to wake a different conversation). The
optional `:budget` (`{:turns N :cost_ceiling F}`) is threaded into the woken
`run/2` and clamped to a body ceiling the mind cannot raise.

**Durable + safe by construction.** A wake is persisted to `Hist.Store` at
`{:clock, id}` and **rehydrated + re-armed on boot** (same projection pattern as
the durable tool registry), so a wake scheduled in a prior sitting fires again —
on `Store.Khepri`, even across a BEAM restart. A **wake budget** caps fires per
rolling window: a runaway `clock/every` is throttled (it backs off to the budget
rate, records the drop, and **never crashes the scheduler**). This is the body
buying the mind more rope by making each rope safe — the mind is free to
self-schedule *because* the schedule provably cannot run away.

```elixir
# drive the scheduler directly (the verbs wrap these)
SpellAgent.Clock.at(%{"in" => "10m", "prompt" => "check goals"})
#=> %{"ok" => true, "id" => "wake-…", "fire_at" => 1750000000000}
SpellAgent.Clock.pending()
#=> %{"wakes" => [...], "dropped" => 0, "fired" => 0}
```

### Condition-fused wakes: `black/watch` (A3, FEAT-021)

`clock/at` fires on a *time* fuse; `black/watch` fires on a *condition* fuse — a
record posted to the stigmergic blackboard. Both detonate the **same charge**: a
Clock wake re-entering `run/2`. So the mind acts in response to events no human
relayed, and there is still exactly one detonator (the Clock) with one wake budget.

```clojure
;; wake me when a sibling posts a finished finding to my region
(tool/black/watch
  {:when {:kind "finding" :where {:status "done"}}
   :wake {:prompt "A sibling finished; fold the region and decide my next step."}
   :ttl_ms 3600000})

;; fan-in: wake me once THREE findings exist
(tool/black/watch {:when {:kind "finding" :count 3}
                   :wake {:prompt "Three findings are in; black/fold and summarize."}})
```

`black/watch` registers a durable `:intention` on the blackboard; the per-node
`SpellAgent.Mesh.Watcher` tails mesh writes and, on a matching `black/post`,
schedules an immediate Clock wake. A `:once` watch (default) retires after firing;
`:ttl_ms` bounds a never-satisfied watch; the Clock budget bounds a cascade. This
is the single-node, agency core of the watcher — the full distributed engine
(per-node claim-deduped exactly-once + inline actions) is FEAT-013.

## Tests

```sh
mix test                 # unit tests (no network)
mix test --include live  # also hits the real subscription + network
```

## Status

> Reconciled against code 2026-07-05 (PLAN-025 Wave 0). Each row is cite-checked;
> `PARTIAL` rows name the consolidation item that finishes them.

**Shipped (real + tested):**

| Capability | Notes |
|---|---|
| Credential read + subscription adapter | Live-proven against `agent.db`. |
| Homoiconic tool registry + `define-*` | `define-tool`/`define-config`/`list-tools`. |
| **Durable tool persistence** | Durable `:ptc` tools mirror to `Hist.Store`, rehydrate on boot (`test/tool_registry_durability_test.exs`). *(Previously mislabelled "deferred".)* |
| **Shell-as-data** | `sh` / `sh-pipe` / `sh-parse` / `sh-unparse` — bash ↔ `form_tree` round-trip, inject-proof argv. |
| Parse-gated code edit | `code-parse`/`unparse`/`edit`/`apply` — unparse → re-parse → reject-if-broken → atomic write. |
| A2 self-wake clock | `SpellAgent.Clock` + `clock/*`, durable + budget-bounded (PLAN-014). |
| A3 condition-fused wakes | `black/watch` — single-node (see below). |
| `spawn-session`/`await-session` | Budget-bounded child sessions, capability attenuation. |
| Inspector TUI + Reaction DSL | `mix spell.tui`; chord→intent→reaction, live-rebindable (~70%, see PARTIAL). |

**Partial (built, being consolidated — PLAN-025):**

| Capability | State | Finishes in |
|---|---|---|
| History reduction/compaction | Engine built + tested but **dormant** (not wired into the live loop) | FEAT-036 |
| Reducer policy as data | Policy hardcoded in Elixir (should be PTC) | FEAT-037 |
| Namespace registration | Three inconsistent conventions; drift-prone allowlist | BUG-026 / FEAT-035 |
| Capability prompt | Hand-maintained; omits most namespaces | FEAT-034 |
| Reaction write-mirror | System intents hardcoded; `lens/*` 6-of-10; lossy gaze round-trip | FEAT-039 |
| Layout defaults | Hardcoded pane constraints (should be BEAM Lisp) | FEAT-040 |
| Incremental reproject | Suffix-dirty only; no path-radius | FEAT-038 |
| Multi-session cockpit | Read-only browser + solid primitives; no live concurrent view / human spawn | FEAT-044 |
| Budget enforcement | Threaded, not enforced as early-exit | FEAT-043 |

**Single-node only (multi-node is a separate track, NOT this alpha):**

- Mesh watcher exactly-once, `black/decide` consensus — single-BEAM correct;
  multi-node exactly-once (FUP-021) + distributed consensus (FUP-020) deferred.
  The single-human-many-sessions capability (FEAT-044) needs single-BEAM only.

**Deferred (follow-ups):**

- OAuth refresh-token grant (FEAT-825 / BUG-025) — token is 1-year; Wave 0 ships
  an actionable expiry error, the full grant is later.
- Rust `find`/`edit` NIF as native tools (FEAT-042) — kernel NIF hosts
  parse/unparse today; find/edit still stubbed.
- A4 `loop/continue` (FEAT-045, design-gated), token-streaming to the REPL.
- Multi-provider LLM (`req_llm`) — single-provider Anthropic by design;
  default model `claude-sonnet-5`.
