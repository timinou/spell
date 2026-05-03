Manages a phased task list. Submit an `ops` array; each op mutates state incrementally.

{{#if autoRosterEnabled}}
Task dispatch may auto-create groups and delegated items in this roster. Auto-created items behave the same as manual ones. Use `todo_write` to pre-structure work, add gates or org links, or revise the auto-created plan after dispatch.
{{else}}
Use `todo_write` when you want roster tracking, gates, or blockers before delegating work.
{{/if}}

{{#if swarmEnabled}}
{{SECTION_SEPERATOR "Swarm-aware roster entries"}}
- Use URI-shaped identifiers when the task is part of a swarm DAG: `task://` for executable work, `data://` for passive artifacts, and `::` for structured sub-outline refs.
- Put the canonical URI in `blockers` when a dependency is already known.
- Record blackboard artifacts and successor context with concrete `data://` pointers.
- If a dependency or artifact URI is not yet known, leave the field empty or mark the task blocked truthfully.
{{/if}}

<critical>
You **MUST** call this tool twice per direct task you execute yourself:
1. Before beginning — `{op: "update", id: "task-N", status: "in_progress"}`
2. Immediately after finishing — `{op: "update", id: "task-N", status: "completed"}`
You **MUST** keep at most one direct task `in_progress` at a time. Additional `in_progress` tasks are only valid when delegated through the `task` tool with `todoRef`. Mark `completed` immediately — no batching.
</critical>

Create a todo list when task requires 3+ distinct steps, user explicitly requests one, user provides a set of tasks, or new instructions arrive mid-task.

<protocol>
## Operations
|op|When to use|
|---|---|
|`update`|Mark a task in_progress / completed / abandoned, or edit content/notes|
|`replace`|Initial setup, or full restructure when the plan changes significantly|
|`add_phase`|Legacy alias for `add_group`|
|`add_task`|Add a task to an existing group|

## Statuses
|Status|Meaning|
|---|---|
|`pending`|Not started|
|`in_progress`|Currently working; delegated tasks may also be `in_progress` when linked via `todoRef`|
|`completed`|Fully done|
|`abandoned`|Deferred with follow-up — requires `deferralFupId` linking to a FUP org item|
|`failed`|Delegated work failed and needs operator attention before dependent work can continue|
|`gate_failed`|Delegated work completed but required verification gates were not satisfied|

## Rules
- You **MUST** mark `in_progress` before starting direct work, not after
- You **MUST** mark `completed` immediately — never defer
- You **MUST** keep exactly one direct task `in_progress`; delegated tasks linked via `task` + `todoRef` may also remain `in_progress`
- You **MUST NOT** set delegation metadata manually unless you are implementing internal system behavior; the `task` tool owns delegation lifecycle updates
- You **MUST** complete groups in order — do not mark later tasks completed while earlier ones are pending
- On runtime impediments: if you hit an unexpected obstacle, keep the current task `in_progress` (or mark delegated work `failed` truthfully) and add a new task describing the impediment
- Multiple ops can be batched in one call
</protocol>

<dependency-management>
- Use `blockers` for cross-group dependencies, intra-group prerequisites, and wave-based DAG execution
- Group ordering alone is enough for simple linear workflows or naturally sequential tasks inside one group
- Blocked tasks cannot be set to `in_progress`; blocked completion or abandonment is allowed
- Auto-promotion skips blocked tasks; if all remaining tasks are blocked and none are `in_progress`, a deadlock warning is shown
- Example DAG: task-3/task-4 depend on task-1; task-5 depends on task-3 and task-4
</dependency-management>

<task-anatomy>
|Field|Meaning|
|---|---|
|`content`|Short label (5-10 words). What is being done, not how.|
|`details`|File paths, implementation steps, edge cases. Shown only when task is active.|
|`notes`|Runtime observations added during execution.|
|`gateCommit`|Set `true` when the task requires a git commit before proceeding.|
|`gateArtifact`|Path to an artifact that must exist after completion.|
|`gateCmd`|Command that must pass to verify the task.|
|`gateLlm`|Advisory self-review criteria; does not trigger enforced two-phase verification.|
|`verifyCmd`|Recommended verification command.|
|`layer`|Layer for policy-based gate injection; explicit gates take precedence.|
|`orgItemId`|Org item ID for lineage tracking. Non-gating.|
|`orgItemClosingId`|Org item ID that triggers verification.|
|`blockers`|Array of task IDs that must complete before this task can start.|
|`deferralFupId`|FUP org item ID required when abandoning a task.|
</task-anatomy>

When implementing plan items, set gate fields to track required deliverables.

<sniper-pattern>
When creating tasks as a subagent, write sniper todos: each task must be precise enough to execute mechanically — no exploration, no questions.

### Fields
- `content`: Ultra-terse verb + target (5-10 words)
- `details`: Exact file paths, exact change description, exact acceptance criteria, edge cases or constraints

### Verification Protocol
Tasks with required gates (`gateCommit`, `gateArtifact`, `gateCmd`, or `orgItemClosingId`) use two-phase completion: first attempt without `verified: true` is rejected with a checklist; re-submit with `verified: true` to complete. `gateLlm` remains advisory and does not trigger two-phase verification. `verifyCmd` alone does not trigger two-phase.

### Examples
<example name="start-task">
Mark task-2 in_progress before beginning work:
ops: [{op: "update", id: "task-2", status: "in_progress"}]
</example>
<example name="complete-and-advance">
Finish task-2 and start task-3 in one call:
ops: [
  {op: "update", id: "task-2", status: "completed"},
  {op: "update", id: "task-3", status: "in_progress"}
]
</example>
<example name="gated-task">
Create a task with commit and artifact gates:
ops: [{op: "replace", groups: [{name: "Implementation", tasks: [{content: "Add gate fields", gateCommit: true, gateArtifact: "packages/coding-agent/test/tools/todo-write-gates.test.ts", verifyCmd: "bun test packages/coding-agent/test/tools/todo-write-gates.test.ts"}, {content: "Update dashboard", gateCommit: true, blockers: ["task-1"]}]}]}]
</example>
<example name="wave-based-plan">
Create wave-based todo list from a plan's Execution Manifest. Each wave is a group; tasks within a group are parallelizable. `orgItemId` tracks lineage (non-gating). `orgItemClosingId` on the final group task per org item triggers verification.
ops: [{op: "replace", groups: [{name: "foundation", tasks: [{content: "Define type interfaces", orgItemId: "FEAT-001", details: "Sub-outline FEAT-001::define-types"}, {content: "Define parser schema", orgItemId: "FEAT-002", details: "Sub-outline FEAT-002::define-schema"}]}, {name: "verify", tasks: [{content: "Write type tests", orgItemId: "FEAT-001", orgItemClosingId: "FEAT-001", blockers: ["task-1"], gateCmd: "bun test test/types.test.ts"}, {content: "Write parser tests", orgItemId: "FEAT-002", orgItemClosingId: "FEAT-002", blockers: ["task-2"], gateCmd: "bun test test/parser.test.ts"}]}]}]
</example>
</sniper-pattern>