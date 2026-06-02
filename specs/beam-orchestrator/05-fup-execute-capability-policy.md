# FUP: `execute` Tool Capability Policy

**Date**: 2026-06-02
**Status**: V1 shipped (read+write default). This doc explains the design and
marks the extension points so future work is a small, obvious edit.
**Owner files**:
- `packages/coding-agent/src/tools/ptc-runtime/effects.ts` — the effect taxonomy + `TOOL_EFFECTS` table
- `packages/coding-agent/src/tools/ptc-runtime/policy.ts` — the policy values + the gate (`enforcePolicy`)
- `packages/coding-agent/src/tools/ptc-runtime/tool-dispatch.ts` — where the gate runs (per tool call)
- `packages/coding-agent/src/tools/ptc-runtime/execute.ts` — pre-filters the advertised catalog to the policy
- `packages/coding-agent/src/tools/ptc-runtime/catalog-check.ts` — `check:catalog` gate forcing a tag per tool

---

## Why this exists

The `execute` tool lets an agent run a sandboxed PTC-Lisp program that calls back
into Spell's **real** tools (find/edit/org/…). The sandbox stops the *program*
from touching fs/net directly, but the bridge could let a program drive any tool
Spell has — including `bash` (arbitrary shell) and `fetch` (network). We need a
deliberate answer to **"which Spell tools may a program invoke?"** That answer is
the *capability policy*.

The user's V1 decision: **read and write are allowed**; the highest-blast-radius
effects (`exec`, `network`) are **off by default** and reached via the direct
tools instead. This doc records that decision and the machinery, and — per the
request — leaves clearly-marked seams so widening/narrowing the policy is easy.

---

## The model: effects are a FLAT SET (not a ladder)

Every program-callable tool is tagged with one **effect**:

```
pure     deterministic compute, no I/O          calc
read     reads repo/project state, no mutation  find, get, status, resolve
write    mutates repo/project/org state         edit, create, org, todo_write, memory
exec     runs external processes / agents        bash, task, ssh
network  reaches the network                     fetch, web_search
```

A **policy** is an *allowlist set* of effects. The gate checks set membership —
there is deliberately **no ordering**. This matters: the V1 default is
`{pure, read, write}`, which must allow writes while denying `exec`+`network`. On
a privilege *ladder* (`write < exec < network`) you could not express "writes yes,
exec no" — so the taxonomy is a set, full stop. (Review Gate 2 caught an earlier
`EFFECT_ORDER` ladder that contradicted this; it was removed.)

> ⚠ **Invariant**: a tool spanning effects by sub-command (e.g. `org` is `read`
> for `query` but `write` for `set`) is tagged at its **highest** effect. This is
> conservative — `org`/`memory` are `write` even though most of their use is read.
> Per-sub-command refinement is an extension point (below), not V1.

### Deny-by-default

`effectOf(unknownTool)` returns `exec` — the boundary the default policy denies.
A newly-added tool with no tag is therefore **blocked** until someone makes a
deliberate decision. The `check:catalog` CI gate fails the build if any
program-callable builtin lacks an explicit tag, so the decision can't be skipped.

---

## Where the gate runs (defense in depth)

Two layers, both sourced from the same policy value:

1. **Catalog pre-filter** (`execute.ts` → `allowedTools`): the runtime is only
   *told about* the tools the policy permits. A denied tool isn't in the catalog,
   so a program can't even name it.
2. **Dispatch-time check** (`tool-dispatch.ts` → `enforcePolicy`): before any
   tool runs, its effect is re-checked against the policy. Even if a tool leaked
   into the catalog, the call is denied here. A `PolicyDeniedError` surfaces to
   the program as a tool error (caught by the sandbox; the runtime is unaffected).

Both layers exist on purpose: the pre-filter keeps the program's mental model
clean; the dispatch check is the actual security boundary.

---

## V1 policy values (policy.ts)

```
DEFAULT_POLICY     {pure, read, write}            ← the V1 default
READONLY_POLICY    {pure, read}                   ← available, not yet wired to a trigger
PERMISSIVE_POLICY  {pure, read, write, exec, net} ← trusted contexts / tests
```

`ExecuteTool` takes the policy in its constructor; today it always receives
`DEFAULT_POLICY`. The seams below change *what policy it receives* and *how the
policy is shaped* — the gate machinery doesn't change.

---

## Extension points — DO THE IMPROVEMENT HERE

Each is a small, localized edit. They are ordered roughly by likely priority.

### EP-1 · Per-session policy selection  ← most likely next step

**Where**: `execute.ts` constructor; `tools/index.ts` factory
`execute: s => new ExecuteTool(s)`.
**Now**: the factory passes no policy, so `DEFAULT_POLICY` is used.
**Do**: resolve a policy from the session — a setting
(`session.settings.get("ptcExecute.policy")`), an env var, or the session's
existing sandbox/approval posture — and pass it:
`new ExecuteTool(s, { policy: resolvePolicy(s) })`. Add a `policyFromName(name)`
helper in `policy.ts` mapping `"read-only" | "read-write" | "all"` → the value.

### EP-2 · Human-in-the-loop for exec/network via the approvals tool

**Where**: `tool-dispatch.ts` `enforcePolicy` call site.
**Status update (Review Gate 3)**: defense-in-depth is now genuine — the
execute.ts lookup resolves instances unconditionally and `enforcePolicy` is the
independent dispatch gate (previously the lookup pre-filtered on the same
`permitted` set, making the re-check dead code). The catalog pre-filter and the
dispatch gate are still both policy-derived but run at different layers.

**Now**: a denied effect throws immediately.
**Do**: when an effect is denied *but escalatable*, route through Spell's existing
`approvals` tool (see `tools/approvals-tool.ts`) for a one-shot human grant rather
than a hard deny. Thread an optional `approve?: (req) => Promise<boolean>` into
`DispatchOptions`; on deny, call it; on `true`, proceed. Keeps the default safe,
adds an opt-in escape valve. (Pairs naturally with EP-1: a "read-write+ask"
policy.)

### EP-3 · Per-argument / per-sub-command effect refinement

**Where**: `effects.ts` `effectOf` (make it `effectOf(name, args?)`),
`tool-dispatch.ts` (pass `args` to the resolver).
**Now**: a tool gets one effect, tagged at its max (`org` → `write` always).
**Do**: refine by argument so `(tool/org {:command "query"})` resolves `read`
while `(tool/org {:command "set" …})` resolves `write`. Lets a read-only policy
permit `org` queries. Requires a per-tool arg→effect classifier; start with the
two highest-value spanners (`org`, `memory`). Document the classifier next to the
`TOOL_EFFECTS` table.

### EP-4 · Tool self-declared effects

**Where**: `AgentTool` interface (`packages/agent/src/types.ts`) + `effects.ts`.
**Now**: effects live in a static `TOOL_EFFECTS` table here (single source of
truth, auditable in one place).
**Do**: add an optional `effect?: EffectTag` field to `AgentTool`; have
`effectOf` prefer the tool's self-declared effect and fall back to the table.
Migrate tags onto the tools incrementally; keep the table as the fallback + the
`check:catalog` gate as the backstop. This is the "right" long-term home but is
deferred so V1 doesn't touch every tool.

### EP-5 · Re-entrancy depth + concurrent-execute resource ceiling

**Where**: `tool-dispatch.ts` denylist (`DEFAULT_DENYLIST`), `peer.ex`
`execute_opts`. Tracked as **PLAN-323**.
**Now**: `execute` is denylisted (no direct recursion), but a program could call
`task`, whose sub-agent could call `execute` (transitive recursion); and there is
no global heap/worker ceiling across concurrent executes.
**Status update (Review Gate 3)**: agent-state / escalation tools (`approvals`,
`checkpoint`, `rewind`, `cancel_job`, `await`, `goals`, `canvas`, `canvas_cast`)
are now in `DEFAULT_DENYLIST` — structurally off-limits to programs regardless of
effect tag or policy. `task` remains `exec` (denied by default policy) but is NOT
yet structurally denylisted (it's a legitimate tool to expose under a permissive
policy).
**Do**: if `exec` is ever allowed, thread a depth counter through
`execute → tool_call → execute` and a session-global worker ceiling into
`execute_opts` (PLAN-323). Revisit when EP-1/EP-2 widen the policy.

### EP-6 · Abort propagation + per-execute signal

**Where**: `client.ts`, `tool-dispatch.ts`. Tracked as **PLAN-324**.
**Now**: in-flight tool_calls aren't aborted when the runtime tears down, and the
dispatcher shares one signal across concurrent executes.
**Do**: give the client an owned `AbortController` (abort on close), and carry an
execute-scoped id through `tool_call` params so the dispatcher selects the right
per-execute signal. Do this when abort is wired end-to-end.

---

## Security review checklist (for any policy change)

- [ ] Does the change allow an effect the user didn't intend? (set membership, not ladder)
- [ ] Is every newly program-callable tool tagged? (`check:catalog` enforces)
- [ ] Are spanning tools tagged at their **max** effect? (or refined per EP-3)
- [ ] Does the dispatch-time check still run? (defense in depth — don't rely on the catalog pre-filter alone)
- [ ] Do denied calls surface as *tool errors* (recoverable), not runtime crashes?

---

## Test coverage (today)

- `policy.test.ts` — gate allows read+write, denies exec/network/unknown,
  read-only denies writes (incl. `memory` write commands), `PolicyDeniedError`
  carries tool/effect/policy, dispatcher enforces at call time.
- `execute.test.ts` (real BEAM) — default policy denies `bash`, allows `org`
  write, signature validation, sandbox-error recovery.
- `catalog-check.test.ts` — every program-callable builtin has an explicit tag.
