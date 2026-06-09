Declarative roster over a blocker-DAG. Submit desired `tasks`; the tool reconciles.

```
todo_write { tasks:[ node… ], reset? }
  reset:true  → replace whole roster (initial plan)
  reset omit  → merge by id (upsert; ids absent from the list stay untouched) — idempotent
```

{{#if autoRosterEnabled}}
`task` dispatch may auto-create roster nodes. Auto-created nodes behave like manual ones. Use `todo_write` to pre-structure work, add gates/`ref` links, or revise after dispatch.
{{else}}
Use `todo_write` for roster tracking, gates, or blockers before delegating work.
{{/if}}

{{#if swarmEnabled}}
{{SECTION_SEPERATOR "Swarm"}}
- `kind:"data"` = passive artifact node; satisfied by `dataContent` or `artifactPath`.
- Put a known dependency's id in `blockers`. Unknown yet → leave empty / mark blocked truthfully.
{{/if}}

## node

```
{ id?  content  status?  group?  details?  notes?  blockers?[]  ref?  closesRef?  verify?  filesDeps?[] }
```

| field | meaning |
|---|---|
| `id` | omit to auto-assign `task-N`; provide to upsert an existing node |
| `content` | short label (5-10 words) — required for a NEW node |
| `status` | `pending → in_progress → completed \| abandoned` |
| `group` | cosmetic display label — ordering comes from `blockers`, NOT groups |
| `blockers[]` | ids that must finish first → wave order; circular/dangling are reported |
| `ref` | linkage: `org://ITEM-ID` (durable) or roster id. `null` = none |
| `closesRef` | `true` ⇒ completing this node closes its `org://` ref (→ DONE) |
| `verify` | `{ commit? artifact? cmd? review? }` — see below |
| `details` | paths/steps/specifics; shown only while the node is active |
| `filesDeps[]` | files this node mutates (isolation overlap check) |

## verify

```
verify { cmd | artifact | commit }  → REQUIRED → two-phase: resubmit { status:"completed", verified:true }
verify { review }                   → model-judged on completion: criteria met → passes; unmet → reverts (single-phase, no verified flag). Fails open if judge unavailable. Disable via todo.reviewJudge=false.

phase 1 → "Verification Required" lists imperatives (do these, then resubmit verified:true)
phase 2 → "Verification Cleared"  is a receipt (already done — no further action)

When the roster has a blocker DAG ≥2 deep the summary prints a `Waves: N` line
and `[wK]` badges — same wave = runnable in parallel now.
```

<critical>
Call `todo_write` twice per node you execute yourself:
1. before — `{ tasks:[{ id:"task-N", status:"in_progress" }] }`
2. after  — `{ tasks:[{ id:"task-N", status:"completed" }] }`  (immediately — no batching)
≤1 node `in_progress` at a time. Delegated nodes (via `task` + `ref`) may also be `in_progress`.
</critical>

## rules

- self-work: flip `in_progress` BEFORE · `completed` immediately AFTER · ≤1 `in_progress`
- delegated: `task` owns the lifecycle — never hand-set `delegation`, `failed`, or `gate_failed`
- blocked nodes can't start; complete/abandon a blocker first (deadlock is warned)
- complete groups of work in dependency order — don't mark a later node done while its blocker is pending
- abandon requires a follow-up: `{ status:"abandoned", deferralFupId:"FUP-…" }`
- create a roster when: 3+ distinct steps · user asks · a set of tasks · new instructions mid-task

## examples

```
# initial plan (declarative, idempotent)
todo_write { reset:true, tasks:[
  { content:"Define types",  group:"foundation", ref:"org://FEAT-001" },
  { content:"Write tests",   group:"verify", blockers:["task-1"],
    ref:"org://FEAT-001", closesRef:true, verify:{ cmd:"bun test test/types.test.ts" } },
] }

# advance: finish one, start next (one call)
todo_write { tasks:[ { id:"task-1", status:"completed" }, { id:"task-2", status:"in_progress" } ] }

# gated completion (two-phase): run the cmd, then
todo_write { tasks:[ { id:"task-2", status:"completed", verified:true } ] }
```
