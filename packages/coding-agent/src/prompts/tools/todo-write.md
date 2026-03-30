Manages a phased task list. Submit an `ops` array — each op mutates state incrementally.
**Primary op: `update`.** Use it to mark tasks `in_progress` or `completed`. Only reach for other ops when the structure itself needs to change.

<critical>
You **MUST** call this tool twice per task:
1. Before beginning — `{op: "update", id: "task-N", status: "in_progress"}`
2. Immediately after finishing — `{op: "update", id: "task-N", status: "completed"}`

You **MUST** keep exactly one task `in_progress` at all times. Mark `completed` immediately — no batching.
</critical>

<conditions>
Create a todo list when:
1. Task requires 3+ distinct steps
2. User explicitly requests one
3. User provides a set of tasks to complete
4. New instructions arrive mid-task — capture before proceeding
</conditions>

<protocol>
## Operations

|op|When to use|
|---|---|
|`update`|Mark a task in_progress / completed / abandoned, or edit content/notes|
|`replace`|Initial setup, or full restructure when the plan changes significantly|
|`add_phase`|Add a new phase of work discovered mid-task|
|`add_task`|Add a task to an existing phase|
|`remove_task`|Remove a task that is no longer relevant|

## Statuses

|Status|Meaning|
|---|---|
|`pending`|Not started|
|`in_progress`|Currently working — exactly one at a time|
|`completed`|Fully done|
|`abandoned`|Dropped intentionally|

## Rules
- You **MUST** mark `in_progress` **before** starting work, not after
- You **MUST** mark `completed` **immediately** — never defer
- You **MUST** keep exactly **one** task `in_progress`
- You **MUST** complete phases in order — do not mark later tasks `completed` while earlier ones are `pending`
- On runtime impediments: if you hit an unexpected obstacle, keep the current task `in_progress` and add a new task describing the impediment
- Multiple ops can be batched in one call (e.g., complete current + start next)
</protocol>

## Dependency Management

Use `blockers` to express task dependencies when execution order matters beyond phase sequencing.

### When to use `blockers`
- Cross-phase dependencies: a task in Phase B depends on a specific task in Phase A
- Intra-phase parallel work: two tasks in the same phase, but one must complete first
- Wave-based execution: tasks form a dependency DAG across multiple phases

### When phase ordering suffices (no explicit blockers needed)
- Simple linear workflows: Phase 1 tasks all complete before Phase 2 starts
- Tasks within a single phase that are naturally sequential

### Smart gate enforcement
- Setting a blocked task to `in_progress` will be **rejected** with an error listing unresolved blockers
- Setting a blocked task to `completed` or `abandoned` is **allowed** (legitimate out-of-order completion)
- Auto-promotion (`normalizeInProgressTask`) skips blocked tasks
- If all remaining tasks are blocked and no task is `in_progress`, a deadlock warning is shown

### Cross-phase dependency example
```
ops: [{op: "replace", phases: [
  {name: "Foundation", tasks: [
    {content: "Create schema"},
    {content: "Write migrations"}
  ]},
  {name: "Features", tasks: [
    {content: "Build API endpoints", blockers: ["task-1"]},
    {content: "Add UI components", blockers: ["task-1"]},
    {content: "Integration tests", blockers: ["task-3", "task-4"]}
  ]}
]}]
```
task-3 and task-4 both depend on task-1 (schema). task-5 depends on both task-3 and task-4.

## Task Anatomy
- `content`: Short label (5-10 words). What is being done, not how.
- `details`: File paths, implementation steps, edge cases. Shown only when task is active.
- `notes`: Runtime observations added during execution.
- `gateCommit`: Set `true` when the task requires a git commit before proceeding.
- `gateArtifact`: Path to an artifact that must exist after completion (screenshot, build output, etc.).
- `gateCmd`: Command that must pass to verify the task (e.g., `bun test test/foo.test.ts`).
- `gateLlm`: Acceptance criteria the AI should self-review against.
- `verifyCmd`: Recommended (not required) verification command.
- `orgItemId`: Org item ID this task is linked to. When set, completion directives include org item lifecycle updates.
- `blockers`: Array of task IDs that must complete before this task can start.

When implementing plan items, set gate fields to track required deliverables. The tool response will inject directives when gated tasks are completed.

## Verification Protocol

Tasks with **required gates** (`gateCommit`, `gateArtifact`, `gateCmd`, `gateLlm`, or `orgItemId`) use two-phase completion:

1. **First attempt**: marking a gated task `completed` without `verified: true` is **rejected**. The tool returns a verification checklist showing each gate requirement.
2. **After verification**: re-submit the update with `verified: true` to complete the task.

This ensures gates are checked before the task is marked done — not after.

`verifyCmd` alone does **not** trigger two-phase (it is advisory, not required).
<avoid>
- Single-step tasks — act directly
- Conversational or informational requests
- Tasks completable in under 3 trivial steps
</avoid>

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

<example name="add_task">
Add a follow-up task with implementation specifics in `details`:
ops: [{op: "add_task", phase: "Implementation", after: "task-2", task: {content: "Handle retries", details: "Update retry.ts to cap exponential backoff and preserve AbortSignal handling", status: "pending"}}]
</example>

<example name="initial-setup">
Replace is for setup only. Prefer add_phase / add_task for incremental additions.
ops: [{op: "replace", phases: [
  {name: "Investigation", tasks: [{content: "Read source"}, {content: "Map callsites"}]},
  {name: "Implementation", tasks: [{content: "Apply fix", details: "Update parser.ts to handle edge case in line 42"}, {content: "Run tests"}]}
]}]
</example>

<example name="skip">
User: "What does this function do?" / "Add a comment" / "Run npm install"
→ Do it directly. No list needed.
</example>

<example name="gated-task">
Create a task with commit and artifact gates:
ops: [{op: "replace", phases: [
  {name: "Implementation", tasks: [
    {content: "Add gate fields", gateCommit: true, gateArtifact: "packages/coding-agent/test/tools/todo-write-gates.test.ts", verifyCmd: "bun test packages/coding-agent/test/tools/todo-write-gates.test.ts"},
    {content: "Update dashboard", gateCommit: true, blockers: ["task-1"]}
  ]}
]}]
</example>

<example name="gated-completion">
Complete a gated task after verification:
1. First attempt (rejected with checklist):
   ops: [{op: "update", id: "task-1", status: "completed"}]
2. After verification:
   ops: [{op: "update", id: "task-1", status: "completed", verified: true}]
</example>

<example name="org-linked-task">
Create a task linked to an org item:
ops: [{op: "replace", phases: [
  {name: "Implementation", tasks: [
    {content: "Add auth module", orgItemId: "FEAT-001-add-auth", gateCmd: "bun test test/auth.test.ts", gateCommit: true}
  ]}
]}]
</example>