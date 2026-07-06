# A4 loop/continue — the mind authors its own next prompt

> **Status: SHIPPED (single-transport, Session-level).** The self-continuation
> trampoline lives in `SpellAgent.Session`; the verb is `SpellAgent.Loop`.

## The agency ladder

| rung | verb | fuse | re-entry |
|---|---|---|---|
| A2 | `clock/*` | TIME | a scheduled wake re-enters `Session.run` |
| A3 | `black/watch` | CONDITION | a blackboard match fires a wake |
| **A4** | **`loop/continue`** | **SELF** | the mind ends a turn asking to continue |

A2 and A3 are *externally* fused; A4 is the mind deciding, at the end of a turn,
"I am not done — continue with THIS next prompt," with no external trigger.

## Surface

```clojure
(return (tool/loop/continue {:prompt "now do the next part"}))
```

`loop/continue` returns a tagged value `%{"__loop_continue__" => prompt}`. When a
mission's terminal `(return …)` carries that tag, `Session` re-enters `run/2`.

## Design decision: Session-level trampoline, not a ptc_runner loop patch

The FEAT-045 investigation weighed two detonators:

1. **A ptc_runner inner-loop patch** — a new `{:__ptc_loop_continue__, prompt}`
   sentinel handled across all three transports (`ptc_tool_call`, `text_mode`,
   single-shot). Powerful but high-blast-radius: it rewrites the core agentic
   loop's control flow in the vendored runtime, across transports, and interacts
   with the turn-budget check.

2. **A Session-level trampoline** — the mind's `loop/continue` returns a data
   signal; `Session.run` recognizes it in the terminal value and re-enters with
   the next prompt, reusing the EXACT re-entry seam `Clock.fire` already uses
   (a fresh `Session.run` on the same session id).

We chose **(2)**. It reuses one detonator (the mission-boundary re-entry), lives
entirely in the body we own (no vendored-loop surgery), and puts the continue at
the same mission boundary where the reduction rate-controller (FEAT-036) sits —
so a continued tape gets the same reduce/cache decision. The tape continues via
`Hist.continuation`; the def-env carries forward; the new prompt is the next user
turn.

## Safety — the hard rail A4 cannot ship without

A self-continuing loop is the classic runaway. Two independent bounds:

- **Budget (FEAT-043).** Every re-entered `Session.run` enforces the turn +
  token ceiling, and a continued turn carries the same `opts` (so the same
  budget). A child/continue budget clamps to the parent's remaining.
- **Continue-depth cap (`Loop.max_continues/0`, default 25).** Bounds the number
  of self-continues in one chain *independently of the token budget*, so even a
  cheap loop cannot spin forever. Hitting the cap ends the chain with the last
  result plus a `"loop_halted"` note (never a silent stall, never infinite).

## What's shipped vs deferred

- **Shipped:** the `loop/continue` verb, the Session trampoline, the depth cap,
  budget enforcement, re-entry with tape continuation. Verified: a mission that
  continues re-enters with the next prompt; a runaway is bounded at
  `max_continues + 1` missions.
- **Deferred (FUP):** a ptc_runner-native `loop/continue` that can be emitted
  MID-program (not only as the terminal `(return …)` value) — that needs the
  multi-transport sentinel patch and its own review cycle. The terminal-only
  form is the safer subset and covers the "author my next prompt" use case.
