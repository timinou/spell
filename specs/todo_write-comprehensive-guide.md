# Todo_Write Comprehensive Guide

## Overview
`todo_write` is the central task orchestration and verification tool in coding-agent. It manages:
- **Task lifecycle**: pending → in_progress → completed/abandoned/failed/gate_failed
- **Dependency graphs**: blocker-based DAG execution with intelligent ready-task promotion
- **Verification gates**: two-phase completion with commit/artifact/command/LLM validation
- **Org lifecycle hooks**: auto-transition linked org items to DOING/DONE states
- **Delegation tracking**: subagent metadata and gate verification delegation
- **Policy-based gates**: layer-driven automatic gate injection based on project policies

---

## File Locations

### Implementation
- **Tool Implementation**: `packages/coding-agent/src/tools/todo-write.ts` (1565 lines)
  - Core operations: `applyOps()`, `promoteReadyTasks()`, verification pipeline
  - Gate verification: `verifyDirectWorkCompletions()`, two-phase protocol
  - Formatting: `formatSummary()`, UI rendering
  - Org lifecycle: `applyOrgLifecycleHooks()`, org item state transitions

### Types & Schema
- **Task Types**: `packages/coding-agent/src/task/types.ts`
  - `TodoItem`, `TodoGroup`, `TodoStatus`, `TodoKind`
  - Delegation metadata structures
  - Gate verification failure types

- **Gate Verification**: `packages/coding-agent/src/task/gate-verification.ts`
  - `verifyGates()` — artifact, commit, command validation
  - `GateFailure`, `GateVerificationResult` types
  - Command normalization and execution tracking

### Prompts & Instructions
- **Tool Prompt/Docs**: `packages/coding-agent/src/prompts/tools/todo-write.md`
  - Comprehensive agent instructions with examples
  - Operation reference, gate protocol, dependency management
  - Examples: gated tasks, wave-based plans, org-linked items

- **Task Tool Integration**: `packages/coding-agent/src/prompts/tools/task.md`
  - How `task` tool uses `todoRef` to link subagents to todos
  - Auto-roster behavior and linkage patterns

- **System Prompts**: `packages/coding-agent/src/prompts/system/`
  - `system-prompt.md` — main agent instructions
  - `subagent-system-prompt.md` — subagent-specific context
  - `plan-mode-approved.md` — plan execution context

### Tests
- `packages/coding-agent/test/tools/todo-write*.test.ts` (multiple files)
  - Gate validation, deferral, delegation, org hooks, DAG validation

---

## TodoItem Schema (Full Field Reference)

### Core Fields
| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `id` | string | Unique task ID | `"task-1"`, `"CheckSchema"` |
| `content` | string | Short description (5-10 words) | `"Update API schema"` |
| `status` | TodoStatus | Current state | `"pending"`, `"in_progress"`, `"completed"`, `"abandoned"`, `"failed"`, `"gate_failed"` |
| `uri` | string | Canonical URI (auto-built) | `"task://session-id/main/task-1"`, `"data://..." for data nodes` |
| `kind` | TodoKind | Node type | `"work"` (default), `"data"` (passive artifact) |

### Content & Context
| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `notes` | string? | Runtime observations during execution | `"Found edge case in retry logic"` |
| `details` | string? | Implementation steps (shown when in_progress) | File paths, line numbers, specific steps |
| `filesDeps` | string[]? | Files this task mutates; used for isolation overlap checks | `["src/schema.ts", "src/api.ts"]` |

### Data Node Fields (kind="data")
| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `dataContent` | string? | Inline satisfied data | `"{ ... json response ... }"` |
| `artifactPath` | string? | Path to artifact that satisfies node | `"build/output.json"`, `"artifacts/123.txt"` |

*Data nodes are auto-marked `completed` when ANY of: `status=completed`, `dataContent` set, `artifactPath` exists, or `delegation.result.outputPath` exists.*

### Gate Fields (Verification Protocol)
| Field | Type | Purpose | Controls Two-Phase? | Notes |
|-------|------|---------|---------------------|-------|
| `gateCommit` | boolean? | Require git commit | **YES** | Detects HEAD movement or isolation worktree commit |
| `gateArtifact` | string? | Require file to exist | **YES** | Path resolved relative to session cwd |
| `gateCmd` | string? | Require command success | **YES** | Matched against bash history or worktree execution |
| `gateLlm` | string? | Advisory review criteria | **NO** | Does not trigger two-phase (appears in reminders only) |
| `verifyCmd` | string? | Recommended verification | **NO** | Advisory only; use in completion message |

**Two-phase flow**: Task marked `completed` without `verified: true` → rejected with checklist → re-submit with `verified: true` after gates validated.

### Dependency & Organization
| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `blockers` | string[]? | Task IDs/URIs that must complete first | `["task-1", "task-2"]` |
| `orgItemId` | string? | Org item for lineage (non-gating) | `"FEAT-001-add-auth"` |
| `orgItemClosingId` | string? | Org item to auto-close on verified completion | `"FEAT-001-add-auth"` |
| `deferralFupId` | string? | FUP org item when abandoning | `"FUP-008-handle-retries"` |

**Org lifecycle hook behavior**:
- When task enters `in_progress` with `orgItemId` → org item auto-transitions to `DOING`
- When task marked `completed` with `orgItemClosingId` → org item auto-transitions to `DONE`
- When task `abandoned` with `deferralFupId` → tracks deferred work in FUP item

### Layer & Policies
| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `layer` | string? | Layer for policy-based gate injection | `"frontend"`, `"api"`, `"database"` |

**Policy gates**: When `layer` is set and task policies are active, matching policy gates are auto-injected. Explicit gates take precedence.

### Verification State (Internal)
| Field | Type | Purpose |
|-------|------|---------|
| `gitBaseline` | GitBaseline \| null? | Git HEAD recorded when direct task enters in_progress (used for gateCommit verification) |
| `verified` | boolean? | Two-phase completion flag (set in update op to prove gates were validated) |

### Delegation (Subagent Linkage)
| Field | Type | Purpose |
|-------|------|---------|
| `delegation` | TodoDelegation? | Metadata when task is delegated to subagent |
| `delegation.sessionId` | string | Subagent session ID |
| `delegation.agent` | string? | Agent type (e.g., "task") |
| `delegation.transcriptPath` | string? | Path to subagent transcript |
| `delegation.childGroups` | TodoGroup[]? | Roster items created by subagent |
| `delegation.result` | TodoDelegationResult? | Subagent output and gate failures |
| `delegation.result.outputPath` | string? | Output path if subagent produced result |
| `delegation.result.gateFailures` | GateFailure[]? | Gate verification failures from subagent |

---

## TodoGroup Structure

```typescript
interface TodoGroup {
  id: string;           // "group-1", "group-2", ...
  name: string;         // Display name: "Investigation", "Implementation", etc.
  tasks: TodoItem[];    // Array of tasks in this group (order is cosmetic only)
}
```

**Semantics**:
- Groups are **cosmetic grouping only** — task execution order is determined by blockers/DAG, not group position
- Groups auto-complete when all tasks are `completed` or `abandoned`
- Group completion triggers summary showing gating requirements

---

## Operation Types (ops parameter)

### 1. `replace` — Full Reset
```typescript
{ op: "replace", groups: [{ name: "...", tasks: [...] }] }
// OR legacy: { op: "replace", phases: [...] }
```
- Clears all existing tasks and rebuilds from input
- Use for **initial setup or complete restructuring**
- IDs auto-generated: `group-1`, `task-1`, `task-2`, ...
- Prefer `add_group`/`add_task` for incremental changes

### 2. `add_group` / `add_phase` (legacy alias)
```typescript
{ op: "add_group", name: "Implementation", tasks: [...] }
```
- Appends a new group to the current todo list
- Auto-generates new group ID
- Tasks within: auto-numbered `task-N`

### 3. `add_task` — Append to Existing Group
```typescript
{ op: "add_task", group: "group-1", slug: "optional-id", content: "...", details: "...", gateCommit: true }
// OR legacy: { op: "add_task", phase: "group-1", ... }
```
- Appends task to specified group
- `group`/`phase` are interchangeable (phase is legacy name)
- All TodoItem fields supported

### 4. `update` — Modify Single Task
```typescript
{ op: "update", id: "task-2", status: "in_progress" }
{ op: "update", id: "task-2", status: "completed", verified: true }
{ op: "update", id: "task-2", content: "...", notes: "...", details: "..." }
```
- Finds task by ID, slug, or URI
- Partial updates: only specified fields change
- **Special handling**:
  - `status: "in_progress"` with unresolved blockers → **rejected with error**
  - `status: "completed"` with required gates and no `verified: true` → **rejected with checklist**
  - `status: "abandoned"` without `deferralFupId` → **rejected (requires follow-up tracking)**

---

## Validation & Processing

### Operation Application (`applyOps()`)
1. **Parse ops sequentially**: Apply each op to the current file state
2. **Block gate enforcement**:
   - Cannot set `in_progress` if task has unresolved blockers
   - Can set `completed` or `abandoned` out-of-order (legitimate)
   - Missing blocker references logged as warnings
3. **Gate enforcement**:
   - If `hasRequiredGate(task)` and status is `completed` without `verified: true` → add to `pendingVerificationTasks` and reject
4. **Deferral enforcement**:
   - If status is `abandoned` without `deferralFupId` → add to `pendingDeferralTasks` and reject
5. **Policy gate injection**:
   - If task has `layer` set, merge matching policy gates before returning

### Post-Operation Checks
After all ops applied:
1. **Ready-task promotion** (`promoteReadyTasks()`):
   - Auto-complete data nodes that are satisfied (isSatisfiedDataNode)
   - Auto-revert `in_progress` tasks with unresolved blockers back to `pending`
   - Auto-promote pending tasks whose blockers are all completed/abandoned
   - Respects isolation mode: only one direct work task `in_progress` unless isolation allows parallel (filesDeps non-overlapping)

2. **Blocker graph validation**:
   - Detect dangling blocker references (logged as warnings)
   - Detect cycles (logged as warnings)
   - Prune unresolvable blockers from arrays

3. **Group completion tracking**:
   - Identify groups that just became fully completed (all tasks completed/abandoned)
   - Track completed gated tasks (for verification protocol summary)

### Verification Pipeline
**For direct tasks (not delegated)**:
1. Capture git baseline when task enters `in_progress` with `gateCommit`
2. On completion with `verified: true`, check gates against bash history or git state
3. If gates fail: revert status to previous state, add to `gateVerificationFailures`

**For delegated tasks**:
- Subagent reports gate failures in `delegation.result.gateFailures`
- Tool formats them in summary with guidance

---

## Response Format

### Success (formatSummary)
Returns text summary containing:
1. **Errors/Warnings**: Any validation failures or issues
2. **Remaining items**: List of pending/in_progress/failed tasks grouped by status
3. **Current progress**: "Group 2/4 '...' — 3/5 tasks complete"
4. **Task grid**: Tree view of all groups and tasks with status symbols
5. **Gate requirements**: If any gated tasks just completed
6. **Gate failures**: If any delegated tasks failed gates
7. **Deferral instructions**: If abandonment rejected, step-by-step FUP creation

### Details Object
```typescript
{
  groups: TodoGroup[];      // Current todo state
  storage: "session" | "memory";  // Where todos are persisted
}
```

---

## Gate Verification Protocol

### Two-Phase Completion Pattern

**Phase 1: Initial attempt (rejected)**
```javascript
{op: "update", id: "task-1", status: "completed"}
// Response: "task-1 requires verification before completion: [ ] Run `bun test ...` ..."
```

**Phase 2: After verification (accepted)**
```javascript
{op: "update", id: "task-1", status: "completed", verified: true}
// Response: "✓ task-1 complete. Commit changes. Verify artifacts."
```

### Verification Details

**gateCmd**: Command must match bash history
- Whitespace-normalized command comparison
- ENV var prefixes and CWD changes stripped for matching
- Exit code must be 0
- Resolves CWD from command preamble

**gateArtifact**: File path must exist
- Resolved relative to session cwd (or isolation worktree if present)
- Verified via `fs.stat()`

**gateCommit**: Git HEAD must advance
- For direct work: detects commit in bash history
- For isolation worktree: checks if HEAD moved past baseline captured when task entered in_progress

**gateLlm**: Advisory (no enforcement)
- Appears in summaries and reminders
- Does not block completion

### Org Item Auto-Closure
When task marked `completed` with `orgItemClosingId`:
- Tool auto-finds org item by ID
- Transitions it to `DONE` state (if not already in DONE/BLOCKED)
- Graceful no-op if item not found (logged as warning)

---

## Blocking & Dependency Management

### Blocker Resolution
Blockers resolved by:
1. Exact task ID match (e.g., `"task-1"`)
2. URI match (e.g., `"task://session/main/task-1"`)
3. Slug match (e.g., `"CheckSchema"`)

Missing references treated as unresolvable (warning logged).

### Smart Gate Enforcement
- `in_progress` with unresolved blockers → **rejected** (prevent out-of-order execution)
- `completed` or `abandoned` with blockers → **allowed** (legitimate skipping)
- Auto-promotion skips blocked tasks
- Deadlock detection: if all remaining tasks blocked and none `in_progress` → warning

### Isolation Mode (filesDeps Tracking)
When `task.isolation.mode=true`:
- Multiple direct tasks can be `in_progress` if they don't share file dependencies
- Tasks without `filesDeps` or with empty array block parallel execution
- Overlapping `filesDeps` trigger automatic demotion to `pending`

---

## Patterns & Best Practices

### Sniper/Precision Task Creation
**Pattern**: Create targeted todos for exact work with rich context and verification gates.

**Example** (from task.md):
```javascript
ops: [{op: "replace", groups: [{
  name: "Implementation",
  tasks: [
    {
      slug: "AddGateFields",
      content: "Add gate fields",
      gateCommit: true,
      gateArtifact: "packages/coding-agent/test/tools/todo-write-gates.test.ts",
      verifyCmd: "bun test packages/coding-agent/test/tools/todo-write-gates.test.ts"
    },
    {
      slug: "UpdateDashboard",
      content: "Update dashboard",
      gateCommit: true,
      blockers: ["AddGateFields"]
    }
  ]
}]}]
```

**Characteristics**:
- Explicit `slug` for stable task references
- Rich `details` field for implementation context
- Combined `gateCommit` + `gateArtifact` for verification
- `blockers` for sequencing when needed
- Short `content` (5-10 words, "what not how")

### Wave-Based Plan Execution
**Pattern**: Multiple groups representing waves, with cross-group dependencies expressed via `blockers`.

```javascript
ops: [{op: "replace", groups: [
  {name: "foundation", tasks: [
    {content: "Define type interfaces", orgItemId: "FEAT-001", details: "Sub-outline FEAT-001::define-types"},
    {content: "Define parser schema", orgItemId: "FEAT-002", details: "Sub-outline FEAT-002::define-schema"}
  ]},
  {name: "verify", tasks: [
    {content: "Write type tests", orgItemClosingId: "FEAT-001", blockers: ["task-1"], gateCmd: "bun test test/types.test.ts"},
    {content: "Write parser tests", orgItemClosingId: "FEAT-002", blockers: ["task-2"], gateCmd: "bun test test/parser.test.ts"}
  ]}
]}]
```

**Benefits**:
- Org items auto-transition as work progresses
- `blockers` enforce wave ordering across groups
- Final group tasks gate completion on tests passing

### Delegation with todoRef Linkage
**Pattern**: Use `task` tool's `todoRef` field to link subagents to pre-structured todo items.

```javascript
// First: create todo structure
todo_write: [{op: "add_task", group: "group-1", slug: "ParseRefactor", content: "Refactor parser", 
  gateCmd: "bun test test/parser.test.ts", gateCommit: true}]

// Then: delegate with reference
task: {
  agent: "task",
  tasks: [{
    id: "RefactorParser",
    assignment: "## Target\nFile: src/parser.ts\n...",
    todoRef: "ParseRefactor"  // Links to the todo
  }]
}
```

**Subagent receives**:
- Automatic injection of `ParseRefactor` gate requirements into context
- Knows verification will be two-phase when marking done

### Deferral with Follow-Up Tracking
**Pattern**: Abandon task with linked FUP org item for continued work.

```javascript
// Step 1: Create FUP
org create category=followups title="Follow-up: Handle retries" body="Deferred from task-3: Handle retries"

// Step 2: Abandon with FUP ID
todo_write: [{op: "update", id: "task-3", status: "abandoned", deferralFupId: "FUP-008"}]
```

**Result**: Task marked `abandoned`, FUP tracks continued work, original task context preserved.

---

## Lifecycle & Auto-Clearing

### Session Persistence
- Todos stored in session file under `toolResult.details.groups`
- `writeJournal()` logs todos to `~/.spell/journals/` for auditing
- Auto-clear timer (default 60s): completed tasks auto-removed after specified delay

### Recovery
- `getLatestTodoGroupsFromEntries()` reconstructs latest todo state from session transcript
- Org lifecycle hooks are idempotent: repeated transitions are no-ops if already in target state

---

## System Prompt Integration

### Agent Instructions (from tool prompt)
- **Must** call `todo_write` twice per direct task:
  1. Before starting: `{op: "update", id: "task-N", status: "in_progress"}`
  2. After finishing: `{op: "update", id: "task-N", status: "completed"}`
- **Must** keep at most one direct task `in_progress` at a time (delegated tasks via `task` + `todoRef` exempt)
- **Must** complete groups in order (smart promotion handles gaps)
- Mark `completed` immediately — no batching
- Use `blockers` for cross-group dependencies
- Use `gateCommit`/`gateArtifact`/`gateCmd` for verification requirements
- Use `orgItemClosingId` for org item lifecycle integration
- Use `layer` for policy-based gate auto-injection

### Subagent Instructions (from task.md)
- Use `todoRef` when delegating to a pre-structured todo item
- Tool auto-injects linked todo's gates and org context
- Omit `todoRef` when auto-roster creates new tracking items
- Set `blockers` for intra-batch DAG scheduling

---

## Error Cases & Handling

### Operation Rejections
1. **Missing group ID** (add_task without group) → error, op skipped
2. **Group not found** (add_task to non-existent group) → error, op skipped
3. **Task not found** (update non-existent task) → error, op skipped
4. **Blocked task starting** (in_progress with unresolved blockers) → error with blocker list
5. **Gated task incomplete** (completed without verified: true) → rejected, task remains in previous state, verification checklist returned
6. **Abandoned without FUP** (abandoned without deferralFupId) → rejected, task remains pending, deferral instructions returned
7. **Dangling blockers** → warning logged, blocker reference pruned

### Soft Failures (Warnings, Not Rejections)
- Unresolvable blocker references → pruned, warning logged
- Circular blocker dependencies → warning logged, task still executable
- Org item not found for transition → warning logged, transition skipped
- Gate verification evidence unavailable → task status reverted, failure logged

---

## Performance & Concurrency

### Mutation Queuing
- `queueTodoMutation()` ensures exclusive sequential access
- Uses `AsyncLocalStorage` to detect nested mutations (same async context)
- Prevents interleaving of concurrent todo_write calls

### DAG Operations
- `MutableDag` class manages blocker graph with file overlap detection
- Ready-task promotion via topological sort
- Cycle detection during blocker validation (warnings only, doesn't block)

---

## Summary

`todo_write` is the backbone of task orchestration in coding-agent, providing:
- **Rich task model** with gates, org linking, and delegation metadata
- **Smart dependency graph** with ready-task auto-promotion and cycle detection
- **Two-phase verification** ensuring gates are validated before completion
- **Org lifecycle integration** for automatic state transitions
- **Isolation-aware execution** for parallel work with file-level conflict detection
- **Comprehensive validation** with clear error messages and recovery paths

Key design principles:
- **Correctness first**: All gate verifications are required; two-phase prevents silent failures
- **Explicit dependencies**: Blockers are mandatory; auto-promotion is smart but visible
- **Org integration**: One source of truth across tools (todo_write and org)
- **Delegation transparency**: Subagent metadata preserved for auditing and re-execution
