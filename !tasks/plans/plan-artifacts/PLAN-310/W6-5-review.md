# PLAN-310 W6.5 — Review of the memory tool surface

> Reviewer: forward-looking surface audit (read-only). W6 landed a
> `memory` builtin (7 actions: search/about/neighbors/note/save/link/since),
> a `memory://` URL router (root/search/item/since/browse), a 33-line prompt,
> and removed five org subcommands (recall/remember/subgraph/timeline/link
> are no longer reachable via the org tool). All TS tests pass; `since` is
> stubbed for W7. Question on the table: does this surface hold for W7
> (producers wire-up), W8 (TUI panel), W9 (personal store), W10 (loop
> tests)?

Findings ranked by confidence × severity. The action factoring (four
archetypes ↔ seven actions) is sound and the URI router covers the
agent-facing read paths cleanly. The issues below cluster on two themes:
(a) the W6 schema and the W10 loop fixtures speak two different
languages — `kind` vs `save_kind`, `text` vs `note_text`, `ts: number` vs
`ts: string` — so every T10 test is RED for the wrong reason today; and
(b) the producer-side contract is leaky in three places that W7 will
inherit (cmd_remember only knows two of four `save_kind` values; no
enum validation on `link_kind`/`scope`/`kinds`; the consolidation
pipeline still owns `memory_summary.md` and `MEMORY.md` writes alongside
a dead `renderSessionStartSummary`).

---

### F1 — W10 loop fixtures use field names that do not exist on the W6 tool surface; every T10.* test will fail-on-shape, not on missing impl
**File:** `tests/memory-loop.test.ts:42-150`
**Confidence:** HIGH
**Severity:** BLOCKER (for W10)
**Class:** CONTRACT / CROSS-WAVE

Audit of `tests/memory-loop.test.ts` against `packages/coding-agent/
src/tools/memory.ts::memorySchema`:

| Test  | Loop call                                                                                  | W6 expects                                                          |
|-------|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------|
| T10.4 | `memory({ action:"save", kind:"concept", title, body })`                                   | `save_kind`, not `kind`                                             |
| T10.4 | `hits[0].id === "CON-test-concept"`                                                        | `dispatchMemoryAction` returns `{hits}` (✓) — but slug is from title; ok |
| T10.5 | `memory({ action:"link", from, to, kind:"ABOUT" })`                                        | `link_kind`, not `kind`                                             |
| T10.5 | `(await memory({action:"about", id})) as { neighbors: [{id, kind}] }`                      | `about` returns `{nodes, edges}` (subgraph shape) — no `neighbors`  |
| T10.6 | `memory({ action:"since", ts: Date.now() })`                                               | `ts: Type.String` (ISO-8601), not number                            |
| T10.6 | `memory({ action:"link", from, to, kind:"RELATED" })`                                      | `RELATED` is not in `EdgeKind` — see F5                             |
| T10.7 | `memory({ action:"about", id:"_projection", repoRoot: tmp })`                              | `repoRoot` is not an arg; comes from session.cwd                    |
| T10.8 | `memory({ action:"note", text:"build failed: ENOENT /tmp/foo" })`                          | `note_text`, not `text`                                             |
| T10.10| `memory({ action:"search", text, include_personal:true })`                                 | `includePersonal` (camelCase), not `include_personal`               |
| T10.10| `memory({ ..., scope_personal_only:true })`                                                | field does not exist                                                |
| T10.10| `repoHits[0].source === "repo"`                                                            | `RecallHit` carries no `source` field today                         |
| T10.9 | `(await memory({action:"about", id})) as { lineage: string[] }`                            | `about` returns `{nodes, edges}`, no `lineage`                      |
| T10.11| `step2.neighbors[0].id`                                                                    | same `about` shape mismatch                                         |

All 11 tests are RED today because the W0 stub at line 10 throws —
**so the mismatch is invisible**. The day W7 lands and someone wires the
stub to the real tool, every test will fail with field-shape errors, not
the producer-pipeline failures W10 actually tests for. Worst case: a W7
engineer "fixes" the loop tests by mutating them to match the schema
without understanding that the schema itself encodes a producer
contract that hasn't been validated against the loop semantics — and
the lessons W10 was supposed to enforce (deterministic projection,
distillation lineage, personal-store shadow) get re-litigated.

**Suggested fix:** reconcile now while both files are still hot. Two
options, equally cheap:

(a) Make the schema match T10 by dropping the snake-prefix and the
camelCase outlier:

```ts
// packages/coding-agent/src/tools/memory.ts:32  (after F4 lands this falls out for free)
export const memorySchema = Type.Object({
    action: Type.Union([...]),
    text: Type.Optional(Type.String()),
    id:   Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),         // formerly save_kind / link_kind / note_kind
    title: Type.Optional(Type.String()),
    body:  Type.Optional(Type.String()),
    from:  Type.Optional(Type.String()),
    to:    Type.Optional(Type.String()),
    scope: Type.Optional(Type.Array(Type.String())),
    focus: Type.Optional(Type.String()),
    hops:  Type.Optional(Type.Number()),
    kinds: Type.Optional(Type.Array(Type.String())),
    limit: Type.Optional(Type.Number()),
    profile: Type.Optional(Type.String()),
    include_personal: Type.Optional(Type.Boolean()),
    scope_personal_only: Type.Optional(Type.Boolean()),
    ts: Type.Optional(Type.Union([Type.String(), Type.Number()])),   // accept ISO or ms-epoch
    about:    Type.Optional(Type.Array(Type.String())),
    involved: Type.Optional(Type.Array(Type.String())),
    distilled_from: Type.Optional(Type.Array(Type.String())),
    relations:      Type.Optional(Type.Array(Type.Object({ kind: Type.String(), target: Type.String() }))),
});
```

(b) Rewrite the T10.* fixtures to match the W6 schema today — same
work, but every field rename in W7+ then propagates twice.

Either way, also reshape `about` to return `{node, neighbors: [{id,
kind, via}], lineage: string[]}` (T10.5, T10.9, T10.11 all expect this)
— see F3.

---

### F2 — `save_kind: "playbook"` and `save_kind: "decision"` are documented + schema-allowed, but `cmd_remember` rejects them
**File:** `crates/pi-natives/src/org_buffer.rs:929-952`, `packages/coding-agent/src/tools/memory.ts:62-64`, `packages/coding-agent/src/prompts/tools/memory.md:21`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / CROSS-WAVE (W7)

`memory.md` line 21: *"`save_kind` ∈ {concept, playbook, decision,
episode}"*. The TypeBox schema accepts any string. The native
`cmd_remember` at `org_buffer.rs:946-952`:

```rust
let (file_path, item_id, slug_str) = match kind {
    "episode" => { /* …writes .spell/memory/episodes/<date>.org… */ }
    "concept" => { /* …writes .spell/memory/concepts/<slug>.org… */ }
    other     => return Err(org_err(format!("Unknown kind: {other}"))),
};
```

Calling `memory.save { save_kind: "playbook", title: "…" }` propagates
`kind="playbook"` to executeOrg, native returns `{error: true, output:
"Unknown kind: playbook"}`, the TS tool re-throws as
`Error("Unknown kind: playbook")`, the agent gets a runtime failure on a
documented surface. Same for `decision`. W7's consolidation pipeline is
explicitly supposed to distil **playbooks** out of episodes (per
`docs-index.generated.ts:21` and `memories/layout.ts:7`) — the first
write will fail.

The W6 prompt also leaks the asymmetry: it says concepts are
slug-keyed (`title → kebab-id`) but episodes use `generate_id("EP",
summary)` (4-char hash suffix) and ignore the slug entirely. The
slug-vs-hash rule is a function of `kind`, not a universal rule.

**Suggested fix:** extend `cmd_remember` to honour the two missing
kinds; the file-path policy is the same shape as `concept`:

```rust
// crates/pi-natives/src/org_buffer.rs:946 (replacement)
let (file_path, item_id, slug_str) = match kind {
    "episode" => { /* unchanged */ },
    "concept" => { /* unchanged */ },
    "playbook" => {
        let slug = make_slug(summary);
        let id   = format!("PB-{}", slug);
        let file = repo_root.join(".spell/memory/playbooks").join(format!("{slug}.org"));
        (file, id, slug)
    }
    "decision" => {
        let slug = make_slug(summary);
        let id   = format!("DEC-{}", slug);
        let file = repo_root.join(".spell/memory/decisions").join(format!("{slug}.org"));
        (file, id, slug)
    }
    other => return Err(org_err(format!("Unknown kind: {other}"))),
};
```

Plus a unit test per kind asserting (id-prefix, file-stem) pair.

Alt fix if landing now is too heavy: trim the prompt + schema to the
supported pair (`concept | episode`) with a comment that W7 grows it.
Documenting a surface that doesn't work is the worst of both worlds.

---

### F3 — `memory.about` returns `{nodes, edges}` (full subgraph) but the prompt + W10 fixtures treat it as "get one node"
**File:** `packages/coding-agent/src/tools/memory.ts:170-184`, `packages/coding-agent/src/prompts/tools/memory.md:9`, `tests/memory-loop.test.ts:67-83, 117-127, 167-180`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / CROSS-WAVE (W8/W10)

`dispatchMemoryAction.about` delegates to `executeOrg("subgraph",
{root:id, hops:1})` — returning the canonical subgraph shape
`{nodes:[{id, title, …}], edges:[{from, to, kind}]}`. Three problems:

1. **Prompt says "resolve one node + its 1-hop neighbourhood"** —
   plausible reading is "*node-shaped* with neighbours attached", not
   "two arrays". The W10 tests reach for `.neighbors[0]`, `.lineage`,
   `.neighbors.find(n => n.id===…&&n.kind===…)` — none of these exist on
   `{nodes, edges}`.
2. **It's the same as `neighbors(hops:1)`** modulo a `kinds` filter.
   Two actions returning the same shape, distinguished only by whether
   you pass `kinds`. The W6 README archetype #2 ("about to see the
   node, then neighbors to walk outward") assumes `about` returns
   *less* than `neighbors`, but it returns the same data.
3. **No way to fetch just the seed node.** `subgraph(hops:0)` isn't
   in `cmd_subgraph`'s vocabulary, so the cheapest read of "one node's
   body+properties" is to ask for its 1-hop neighbourhood. For W8
   (TUI panel rendering a single concept) this is wasteful; for the
   agent prompt's *"`about` to see the node"* (line 9), it's wrong.

`memory://item/<id>` inherits the same shape, also returning a full
subgraph as JSON.

**Suggested fix:** reshape `about` server-side and split the two
verbs:

```ts
// dispatchMemoryAction.about (replacement)
case "about": {
    const id = params.id ?? params.focus;
    if (!id) throw new Error("memory.about requires `id`");
    const sub = executeOrg({ command:"subgraph", root:id, hops:1, repoRoot });
    if (sub.error) throw new Error(String(sub.output));
    const { nodes, edges } = sub.output as { nodes: NodeT[]; edges: EdgeT[] };
    const seed = nodes.find(n => n.id === id);
    if (!seed) throw new Error(`memory.about: id not found: ${id}`);
    const neighbors = edges.map(e => {
        const otherId = e.from === id ? e.to : e.from;
        return { id: otherId, kind: e.kind, via: e.from === id ? "out" : "in" };
    });
    return { node: seed, neighbors, lineage: lineageFrom(nodes, edges, id) };
}
```

`lineage` is the transitive closure of `DISTILLED_FROM` edges
(T10.9 invariant). Reshape `memory://item/<id>` to return the same
`{node, neighbors, lineage}` payload — drop the redundant `edges`
array.

Document `neighbors` action as "n-hop walk, with `kinds[]` filter",
`about` as "one node + 1-hop attached, with distillation lineage".

---

### F4 — Schema has three field-naming conventions in 21 fields (snake + snake-with-action-prefix + camel) — LLM will get half of args wrong
**File:** `packages/coding-agent/src/tools/memory.ts:23-78`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / ERGONOMICS

In one `Type.Object`:

| Convention                       | Fields                                                                 |
|----------------------------------|------------------------------------------------------------------------|
| snake_case, no prefix            | `text`, `scope`, `focus`, `hops`, `kinds`, `limit`, `profile`, `title`, `body`, `relations`, `distilled_from`, `from`, `to`, `id`, `ts` |
| snake_case + action prefix       | `note_text`, `note_about`, `note_involved`, `save_kind`, `link_kind`   |
| camelCase, no prefix             | `includePersonal`                                                      |

The prefix-or-not rule is "prefix when the bare name would collide
across actions" — e.g. `kind` would mean three different things
(save_kind, link_kind, relations[].kind), so it gets prefixed in the
top-level schema but **not** inside `relations`. `text` collides
(search text vs note body), so `note` gets `note_text` but `save` uses
`title+body`. `about` and `involved` *don't* collide with any other
action and could be bare, but they got prefixed too. Then
`includePersonal` is the lone camelCase escapee, presumably because it
mirrors the native param name (`includePersonal:` in executeOrg).

For the LLM serialising args this is a memorisation tax — and the
errors it produces are silent (TypeBox `lenientArgValidation = true`,
line 92, accepts unknown fields). An agent passing `{kind:"concept"}`
to `save` gets a runtime `requires save_kind` (caught), but an agent
passing `{include_personal:true}` (the casing T10 uses; the casing
*every other field uses*) gets silently ignored — the boolean never
reaches executeOrg.

Two clean alternatives:

(a) **Discriminated union** — typed sub-objects per action. TypeBox
supports it; the JSON-schema render the LLM sees is the cleanest
possible: each action shows only its own fields. Cost: ~30 LOC, plus
a `MemoryParamsByAction<A>` helper for the dispatcher type-narrowing.

```ts
const SearchArgs   = Type.Object({ action: Type.Literal("search"), text: Type.Optional(...), ... });
const SaveArgs     = Type.Object({ action: Type.Literal("save"),   kind: Type.String(),  title: Type.String(), ... });
const LinkArgs     = Type.Object({ action: Type.Literal("link"),   from: Type.String(),  to: Type.String(),    kind: Type.String() });
// …
export const memorySchema = Type.Union([SearchArgs, AboutArgs, NeighborsArgs, NoteArgs, SaveArgs, LinkArgs, SinceArgs]);
```

(b) **Flat + canonical** — keep flat, but pick *one* convention. Drop
the action prefix everywhere; rename `includePersonal` → `include_personal`.
Document the per-action field set in the prompt's `<actions>` table.
Smaller diff than (a), but the LLM still has to memorise per-action
applicability.

If sticking with flat, at minimum: `includePersonal` → snake;
`note_text`/`note_about`/`note_involved` → drop prefix (no
collisions); `save_kind` → `kind` (collision with `relations[].kind`
is structural, not naming); `link_kind` → `kind` (same). Then T10's
calls work as-written.

---

### F5 — No server-side enum validation on `link_kind` / `scope` / `kinds` / `relations[].kind` → writes accepted that the recall graph can never traverse
**File:** `packages/coding-agent/src/tools/memory.ts:46, 67, 75`, `crates/pi-knowledge-core/src/graph.rs:27` (`EdgeKind`)
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** API / DATA-INTEGRITY

The schema declares:

```ts
scope:     Type.Optional(Type.Array(Type.String())),
kinds:     Type.Optional(Type.Array(Type.String())),
link_kind: Type.Optional(Type.String()),
relations: Type.Optional(Type.Array(Type.Object({ kind: Type.String(), target: Type.String() }))),
save_kind: Type.Optional(Type.String()),
```

Every kind field is `Type.String()` — no server-side enum guard.
Concrete failures:

1. T10.6 issues `memory.link { kind:"RELATED" }`. `RELATED` is not an
   `EdgeKind` variant (per W1.5 F1 the canonical set is `Imports |
   References | Definition | Calls | Contains | Involved | About |
   Produced | DistilledFrom | Mentions | Supersedes | DerivedFrom |
   Blocks | Action`). `cmd_link` happily writes
   `:RELATIONS:\nRELATED:: B\n:END:` into the org file; the next
   ingest sees `RELATED`, fails to parse it as `EdgeKind`, and the
   row is **silently dropped from the graph**. The link is on disk;
   the recall lane can never traverse it. The agent sees "link ok",
   the search lane sees nothing.
2. `scope: ["sermon"]` (typo'd kind). `recall()` filters by string
   prefix, returns empty, agent re-derives.
3. `relations:[{kind:"INVOLVES", target:"X"}]` (singular vs plural —
   `INVOLVED` vs `INVOLVES`): drawer writes the typo, same silent
   drop.
4. `save_kind:"recipe"`: caught by F2's `Unknown kind` error (only
   safe link in the chain).

Add enum schemas mirroring `EdgeKind` / `RecallKind`:

```ts
const EdgeKindLit = Type.Union(
    ["Imports","References","Definition","Calls","Contains",
     "Involved","About","Produced","DistilledFrom","Mentions",
     "Supersedes","DerivedFrom","Blocks","Action"].map(k => Type.Literal(k))
);
const NodeKindLit = Type.Union(
    ["episode","concept","playbook","decision","entity","actor","workflow"].map(k => Type.Literal(k))
);

// …
scope:     Type.Optional(Type.Array(NodeKindLit)),
kinds:     Type.Optional(Type.Array(EdgeKindLit)),
link_kind: Type.Optional(EdgeKindLit),
relations: Type.Optional(Type.Array(Type.Object({ kind: EdgeKindLit, target: Type.String() }))),
save_kind: Type.Optional(NodeKindLit),
```

Single source of truth: export the literal arrays from
`@oh-my-pi/pi-knowledge-core` (or `pi-natives`) so the TS schema
tracks Rust automatically; otherwise every `EdgeKind` addition in
Rust silently desynchronises.

Bonus: with `lenientArgValidation:true` (line 92, applied to TypeBox
in `executeTool`) unknown *fields* still pass — but enum-typed fields
*do* fail on bad values. This is the right strictness ratchet.

---

### F6 — `dispatchMemoryAction` is silent (no per-call telemetry, no arg digest, no timing) and ships one biome formatter violation
**File:** `packages/coding-agent/src/tools/memory.ts:131-237, 32-78`
**Confidence:** HIGH
**Severity:** MEDIUM
**Class:** OPERATIONAL / SMELL

Only the error path logs (`logger.error("memory tool error", {...})`).
The success path is silent. W7's consolidation pipeline will fire
batches of `save`/`note`/`link` calls per session-end; W8's TUI panel
will subscribe-then-poll (see deferred-FUP); W10's loop assertions
need a per-call timing histogram (T10.4 budgets 250ms end-to-end).
Without an action+arg-digest log line, none of these are observable.

```ts
// packages/coding-agent/src/tools/memory.ts:131 (execute(), top of try block)
const t0 = performance.now();
const argDigest = digestMemoryArgs(params);   // small helper: {action, scope?, kind?, hasText, hasFocus, …}
try {
    const output = await dispatchMemoryAction(params, repoRoot);
    logger.debug("memory.dispatch", { ...argDigest, durationMs: performance.now() - t0 });
    return ...;
} catch (err) {
    logger.error("memory.dispatch.error", { ...argDigest, durationMs: performance.now() - t0, error: msg });
    return ...;
}
```

The arg digest must not log free-text content (`text`, `body`,
`note_text`) — that leaks user prompts into the log stream. Log
booleans + lengths only.

**Plus a real biome violation** in the file as-shipped:

```
$ bunx biome check packages/coding-agent/src/tools/memory.ts
× Formatter would have printed the following content:
  62  │ - → save_kind:·Type.Optional(
  63  │ - → → Type.String({·description:·"Kind:·concept·|·playbook·|·decision·|·episode·(save)"·}),
  64  │ - → ),
  62  │ + → save_kind:·Type.Optional(Type.String({·description:·"…"·})),
  …
Found 1 error.
```

Pre-commit hook didn't run, or biome was bypassed. One-liner fix
(`bunx biome check --write packages/coding-agent/src/tools/memory.ts`).

---

### F7 — `renderSessionStartSummary` is dead code (0 production callers); consolidation pipeline still writes `MEMORY.md` and competing `memory_summary.md` → W7 inherits a bifurcated producer story
**File:** `packages/coding-agent/src/memories/projection.ts:20`, `packages/coding-agent/src/memories/index.ts:935-936`, `packages/coding-agent/src/memories/layout.ts:7`
**Confidence:** HIGH
**Severity:** MAJOR
**Class:** CROSS-WAVE (W7) / DEAD-CODE

State of the world:

- `memories/projection.ts:20` exports `renderSessionStartSummary(cwd)`
  — runs `executeOrg("recall", { profile:"session-start" })` + two
  `query` calls, renders a Handlebars template, writes
  `<cwd>/.spell/memory/cache/memory_summary.md`. Production callers:
  **0** (`grep -rn renderSessionStartSummary packages/ — only its own
  test file and the export).
- `memories/index.ts:935`: `writeConsolidationArtifacts` writes
  `MEMORY.md` (the LLM-consolidated long-form) and
  `memory_summary.md` (the LLM-summarised version). Both writes
  always fire.
- `memories/layout.ts:7` doc says: *"cache/memory_summary.md —
  deterministic projection (replaces MEMORY.md)"*. The replacement
  hasn't happened. `MEMORY.md` is still written every consolidation
  (also referenced in `memories-runtime.test.ts:215, 302, 321`).
- W6's `memory://root` URL resolves to `memory_summary.md` (the
  cache copy if it exists, the consolidation copy otherwise). Which
  authority wins depends on which pipeline ran last.

The W7 plan calls for the deterministic projection
(`renderSessionStartSummary`) to be the session-start authority for
`memory_summary.md`, deriving from the recall graph at startup —
which is exactly what the function does. The consolidation pipeline
should then write only `MEMORY.md` or (better) nothing to the summary
slot. Today both writers exist and neither is called from session
start.

When W7 wires producers, the engineer has three options: (a) discover
`projection.ts`, call it from session start, leave consolidation
alone — now two summaries fight; (b) discover `projection.ts`, call
it, *remove* `consolidated.memorySummary` write — silent removal of
the LLM summary an existing user depends on; (c) miss `projection.ts`
entirely (it's dead code; `grep -rn renderSessionStartSummary
packages/src` returns only the export), reimplement the projection
from scratch.

**Suggested fix (one rev of W6.5 producer wiring):**

1. **Hook `renderSessionStartSummary` into the session-start path.**
   Call site: `sdk.ts` somewhere near `MemoryProtocolHandler`
   construction (line 1054), or whatever spawns the
   `consolidationManager` for the session.
2. **Cut `consolidated.memorySummary` write at `index.ts:936`** — let
   projection own that file; consolidation owns `MEMORY.md` only.
3. **Decide MEMORY.md's fate.** Either keep it as the LLM-curated
   long-form (and update `layout.ts:7` comment to match), or sunset
   it and let `memory://root/<id>.org` be the navigation surface
   (per the prompt's URI design). The current doc-vs-code mismatch
   is a follow-up bug magnet.
4. **Delete dead-test coupling.** `projection.test.ts` is the only
   caller of the function — once production wires it, the test
   becomes an integration assertion, not a dead-export pinning.

If W6.5 isn't the wave for this, file an explicit FUP item with a
deadline before W7 starts so the producer engineer inherits the
decision, not the question.

---

## Summary — HIGH-confidence findings ranked

| # | Title                                                                                              | Severity | Class                       |
|---|----------------------------------------------------------------------------------------------------|----------|-----------------------------|
| F1 | W10 loop fixtures + W6 memory tool schema speak different field names (7 mismatches across 11 tests) | BLOCKER  | CONTRACT / CROSS-WAVE       |
| F2 | `save_kind` ∈ {playbook, decision} reach cmd_remember which rejects → runtime failure on documented surface | MAJOR    | API / CROSS-WAVE (W7)       |
| F3 | `memory.about` returns subgraph `{nodes, edges}` but prompt + W10 expect `{node, neighbors, lineage}` | MAJOR    | API / CROSS-WAVE (W8/W10)   |
| F4 | Three field-naming conventions in 21 schema fields → LLM args silently dropped (includePersonal etc.) | MAJOR    | API / ERGONOMICS            |
| F5 | No enum validation on link_kind/scope/kinds/relations[].kind → bad writes silently dropped from graph | MAJOR    | API / DATA-INTEGRITY        |
| F6 | Silent dispatch (no telemetry); ships one biome formatting violation                                | MEDIUM   | OPERATIONAL / SMELL         |
| F7 | renderSessionStartSummary is dead code; MEMORY.md + memory_summary.md dual-writer → W7 bifurcated   | MAJOR    | CROSS-WAVE (W7) / DEAD-CODE |

**The factoring itself is right.** Seven actions covering four
archetypes is a clean compaction over the deleted five org subcommands;
the URI router slots cleanly into `find { target: 'memory://…' }`; the
session-scoped `MemoryTool` has a focused `execute` path; the prompt is
the right size (33 lines). The HIGH findings cluster on two themes:

- **Contract drift** (F1, F3, F5) — the W6 schema, the native
  `cmd_remember`/`cmd_link`, the W10 loop fixtures, and the
  agent prompt each encode part of the contract; no single source of
  truth pins them together. Fix shape: pick *one* (recommend the schema)
  and rewrite the other three against it before W7 lands.
- **Producer story not wired** (F2, F7) — W6 shipped the read side
  (`search`/`about`/`neighbors`/URI router) but the producer side
  (`save`/`note`/`link` → `cmd_remember` → `memory_summary.md`
  projection → session-start injection) is half-implemented and
  half-deleted. W7 inherits a wave-shape decision instead of a wave-shape
  execution. Landing F2 + F7 in W6.5 collapses that decision.

F4/F5/F6 are all addressable inside `tools/memory.ts` + a small
helper module; F3 needs ~15 LOC in `dispatchMemoryAction.about` plus
`memory-protocol.ts`'s `#resolveItem`; F2 is ~20 LOC in
`crates/pi-natives/src/org_buffer.rs` + two unit tests; F1 is a rename
pass across one schema and one test file; F7 is wiring at
`sdk.ts`-creation time.

## Deferred to FUP

- **`memory://browse` is a one-shot string sentinel (`{browse:true,
  hint:"…"}`).** W8 TUI panel will need either an event-emitter on
  `memory.{save,note,link,since}` writes (preferred) or a polling
  scheme over `memory://since`. Neither exists. Today the panel can
  only render at construction time and never updates. Pick one: add
  `MemoryEvents.on("write", cb)` to the protocol handler and have the
  panel subscribe; or document the polling interval in `memory.md`
  and accept the latency floor. Class: API / W8.
- **`memory://since/<ts>` payload shape (`{ts, added:[], modified:[],
  deleted:[], note}`) is suggestive but not committed.** Per-item
  shape is unspecified — string ids? full `{id, kind, file}`? full
  `RecallHit`? Personal-source attribution? Timestamp inclusivity
  (`> ts` vs `>= ts`)? Pin the contract before W7 builds against it;
  every wave that touches it without a written shape forks. Class: API
  / W7.
- **`includePersonal` default is `undefined` → executeOrg native
  default applies (today: `false`).** Prompt doesn't mention personal
  store; agent has no way to learn it exists short of reading the
  schema. Once W9 lands and personal corpora have content, the
  `false` default means agents won't surface their own cross-repo
  knowledge. Add a one-line in `memory.md` under `<rules>`:
  `*include_personal*: false default; set true to union with your
  personal store (W9+)`. Class: DOCS / W9.
- **`memory.note` and `memory.save` share the same native handler
  (`cmd_remember` with `kind:"episode"` vs other).** The TS-side
  branch builds `summary` differently (note uses raw `note_text`;
  save uses `${title}\n\n${body}`). Two ways to spell "write an
  episode": `memory.note { note_text }` and `memory.save {
  save_kind:"episode", title }`. Document which one wins for what
  case in the prompt's archetype 3 (dedup); currently the rules say
  "shorthand" but don't say *why* an agent would pick one over the
  other (e.g., note = in-flight, no explicit title; save = curated,
  worth a slug). Class: DOCS.
- **`logger.error("memory tool error")` at `tools/memory.ts:142` logs
  the raw error message** which may include user text (`note_text`,
  `body`) reflected back in the native error. Sanitise before log. Class:
  PRIVACY / OPERATIONAL.
- **`memory:// URI` parsing accepts `text` and `focus` as raw query
  params with no length/encoding guard.** A 50KB recall query
  (`memory://search?text=<entire-pasted-log>`) reaches `executeOrg`
  unbounded. Add a `MAX_QUERY_LEN` (~2KB) guard in `#resolveSearch`.
  Class: ROBUSTNESS.
- **`recall` lane returns `{ hits }` — the formatter at
  `formatMemoryResult` line 339 hard-codes `result.hits` access.** When
  W7 producers grow the response to `{ hits, why: [], facets: {} }`
  (per W5.5 deferred F:WhyHit contribution), the formatter quietly
  ignores. Make the formatter switch on a `_format_version` field or
  parse defensively now. Class: FORWARD-COMPAT.
- **`renderCall.preview` (`tools/memory.ts:251-296`) truncates `text`
  to `TRUNCATE_LENGTHS.CONTENT` (probably ~80 chars) which is fine,
  but doesn't show `_i` (intent) anywhere.** Agent's intent string is
  parsed but never surfaced in the status line. Either drop the
  field from the schema (it's already global on every tool) or render
  it as the meta prefix. Class: UX.
- **`memory_summary.md` is the documented default file at `memory://root`,
  but if the file is missing the handler throws `Memory file not found:
  memory://root`** — instead of falling back to an empty stub or
  rendering a "memory not yet built" hint. Agents on a fresh repo get
  a hard error on first `read memory://root`. Make the fallback an
  empty content with a `notes:["memory not yet built; run /memory
  rebuild"]` resource. Class: UX.
- **`memory.md` prompt does not warn against using `memory.search`
  for code symbols, file paths, or identifier lookups** (which
  `find`/`lsp` already do better). Without the negative example, the
  agent will route every query through memory and pollute the recall
  signal. Add to `<rules>`: `*search*: project knowledge only — for
  code symbols, paths, error strings use **find**, **lsp**,
  **bash**`. Class: PROMPT.
- **`memory.md` `<archetypes>` block teaches the read side
  (priors / neighbours / dedup / since) but not the producer side**
  (when to note, when to save, when to link). Add a 5th archetype:
  *"5. **commit** — finished a task with a non-obvious lesson? `save`
  a concept or playbook, link it back to the source episode/task
  with `link kind=DISTILLED_FROM`."*. Class: PROMPT.
- **Two `"not yet implemented (PLAN-310 W7)"` constants** exist in
  parallel: `tools/memory.ts:91` `SINCE_STUB_NOTE` and
  `internal-urls/memory-protocol.ts:16` `SINCE_STUB_NOTE`. Same
  string, two locations. When W7 lands and the stub leaves, two file
  edits will be required. Hoist to one shared export
  (`memories/since.ts::SINCE_STUB_NOTE` or similar). Class: DRY.
- **`docs-index.generated.ts:21` (memory.md doc embed) describes
  `MEMORY.md` + `memory_summary.md` + `read_path.md` as the legacy
  consolidation model** — predates W6's `memory://` and the seven
  actions. The doc the user sees via `/help memory` (or a Pi docs
  surface) is stale. Regenerate after F7 lands. Class: DOCS.
- **`MemoryTool.lenientArgValidation = true`** (line 92) — TypeBox
  ignores unknown fields. Useful for forward-compat, dangerous for
  drift detection (F4's `include_personal` silently dropped is a
  direct consequence). Consider `lenient: warn` mode that logs but
  doesn't fail on unknown fields, surfacing the typo class of bug
  without breaking forward-compat. Class: VALIDATION.
