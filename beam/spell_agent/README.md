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

Requires a logged-in Anthropic subscription in `~/.spell/agent/agent.db` (run the
TypeScript `spell` once to log in, or point `SPELL_AGENT_DB` at another db).

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
