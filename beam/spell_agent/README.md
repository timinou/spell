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

### Default chords

| chord | tree focus | answer / prompt focus | resolved in |
|---|---|---|---|
| `ctrl+j` / `ctrl+k` | next / prev pane | next / prev pane | global (fall-through) |
| `ctrl+l` / `ctrl+h` | expand / collapse the span under the cursor | next / prev turn | focused pane |
| `↑` / `↓` | move the tree cursor | scroll the pane | focused pane |
| `tab` / `shift+tab` | cycle panes | cycle panes | global |
| `enter` | submit the composer | submit the composer | global |
| `esc` / `ctrl+c` | quit | quit | global |

`ctrl+j/k/h/l` are reachable because the vendored ExRatatui NIF enables the
**kitty keyboard protocol** (otherwise `ctrl+j`≡Enter and `ctrl+h`≡Backspace at
the legacy-terminal byte level). The composer's hint line is *derived from the
live keymap*, so it always reflects what is actually bound — including runtime
rebinds.

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

## Tests

```sh
mix test                 # unit tests (no network)
mix test --include live  # also hits the real subscription + network
```

## Status (v0)

Shipped: credential read, subscription adapter (live-proven), homoiconic tool
registry + `define-tool`/`define-config`/`list-tools`, SubAgent wire-up, REPL.

Deferred (follow-ups): OAuth refresh-token grant (token is 1-year, not yet
needed); durable persistence of defined tools (org/memory stored programs);
wiring the Rust `find`/`edit` NIF as native tools; token-streaming to the REPL.
