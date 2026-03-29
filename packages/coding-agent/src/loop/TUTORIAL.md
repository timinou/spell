# Spell Loop System Tutorial

A loop is a multi-iteration orchestration workflow. You give it a name and a task, and it drives a plan-code-review cycle until the work is done or a safeguard trips. Loops are persistent, pausable, killable, and can spawn child loops.

This tutorial covers usage. For implementation internals, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

1. [Getting Started](#getting-started)
2. [The Manifest Workflow](#the-manifest-workflow)
3. [The Plan-Code-Review Cycle](#the-plan-code-review-cycle)
4. [Domains](#domains)
5. [Gates](#gates)
6. [Safeguards](#safeguards)
7. [Child Loops](#child-loops)
8. [Slash Commands Reference](#slash-commands-reference)
9. [Tool Parameters Reference](#tool-parameters-reference)
10. [Practical Examples](#practical-examples)

---

## Getting Started

### Prerequisites

- A **review model** must be configured in your model roles. The loop system validates this before start and will reject the request if missing.
- A **clean git tree** is recommended. The system runs `git status --porcelain` at start and warns if uncommitted changes exist. Git is not strictly required -- the system degrades gracefully without it, but spec drift detection and worktrees are disabled.

### Preparing a Loop

Loops use a two-step prepare-then-launch flow. First, call `loop_prepare` to ingest specs and enter manifest building mode:

**Via tool call:**

```
loop_prepare({
  name: "auth-refactor",
  taskContent: "Refactor the authentication module to use JWT tokens",
  domains: ["code", "test"]
})
```

**Via slash command:**

```
/loop prepare auth-refactor
```

This creates a loop in `manifest_building` state, assigns it a unique ID (format: `LOOP-{timestamp}-{slug}`), persists state to disk, and creates an org item for tracking. You then decompose the work into tickets.

### Building the Manifest

During `manifest_building`, you decompose the task into tickets with dependencies:

```
// The agent creates tickets from specs, sets up dependencies,
// and presents the manifest for approval via TUI or canvas.
// Each ticket has: title, acceptance criteria, effort estimate,
// blockers, triggers, and gates.
```

### Launching the Loop

Once the manifest is approved, call `loop_launch` to begin iteration:

```
loop_launch({
  loopId: "LOOP-1711721600000-auth-refactor"
})
```

This validates the manifest (all tickets have valid dependencies, gates are configured) and transitions to `planning` state. The first ticket in topological order becomes active.

### Completing an Iteration

After doing the work for an iteration, call `loop_done` to advance the loop:

```
loop_done({
  loopId: "LOOP-1711721600000-auth-refactor",
  summary: "Replaced session-based auth with JWT token flow",
  changedFiles: ["src/auth/jwt.ts", "src/auth/middleware.ts"],
  findings: ["Need to update the refresh token endpoint"]
})
```

This increments the iteration counter, records your summary, evaluates gates, checks safeguards, and transitions the loop to its next state.

### Checking Status

```
/loop status LOOP-1711721600000-auth-refactor
```

Or list all loops:

```
/loop list
```

---

## The Plan-Code-Review Cycle

Each iteration has three phases, each handled by a different LLM role:

```
plan --> code --> review --> plan --> code --> review --> ...
```

1. **Plan phase** -- The planner receives the iteration prompt (loop context, task, changed files, open findings, pending gates) and produces a plan for the next chunk of work.
2. **Code phase** -- The coder receives the plan summary and executes it, producing changed files.
3. **Review phase** -- The reviewer examines the code phase output and produces findings.

Context flows between phases via **handoff artifacts**. Each handoff captures:
- The source and target role
- The current iteration number
- Changed files, gate results, open findings, and a summary

### Reflection

Every `reflectEvery` iterations (default: **3**), the loop pauses its normal cycle and enters a `reflecting` state. During reflection, the system reviews overall progress, identifies drift from the original task, and resets priorities before resuming.

You can control this with the `reflectEvery` parameter:
- `reflectEvery: 3` -- reflect every 3 iterations (default)
- `reflectEvery: 0` -- disable reflection entirely
- `reflectEvery: 1` -- reflect after every iteration

### Validation

When the loop reaches `maxIterations` (default: **200**) or `forceValidate` is set on a `loop_done` call, the loop enters a `validating` state. Completion gates (gates with trigger `on-completion`) fire during validation. If validation passes, the loop transitions to `complete`.

---

## Domains

Domains define the quality standards for a loop. Each domain contributes a guidelines template and a set of default gates that are automatically registered when the loop starts.

### Built-in Domains

| Domain | Description | Default Gates |
|---|---|---|
| `code` | Compile, lint, and formatting validation | `code-compile` (`bun check:ts`, on-completion), `code-format` (`bun lint:ts`, on-completion) |
| `test` | Focused test validation | `test-suite` (`bun test`, on-completion) |
| `architecture` | Contract and dependency review | `architecture-review` (llm-review, on-reflection) |
| `ui` | Visual artifact validation | `ui-artifacts` (artifact check for `artifacts/ui.png`, on-completion) |
| `security` | Secret and dependency hygiene | `security-scan` (`git grep -n SECRET`, on-completion) |
| `docs` | Documentation and changelog validation | `docs-artifacts` (artifact check for `CHANGELOG.md`, on-completion), `docs-review` (llm-review, on-completion) |

### Selecting Domains

Pass the `domains` parameter at loop prepare:

```
loop_prepare({
  name: "feature-x",
  domains: ["code", "test", "security"]
})
```

When domains are specified, the system:
1. Looks up each domain in the registry
2. Registers that domain's default gates for the loop
3. Makes the domain's guidelines template available to iteration prompts

If no domains are specified, none are applied by default -- you get a loop with no automatic gates.

---

## Gates

Gates are validation checkpoints that run at specific points during a loop's lifecycle. They evaluate conditions and produce pass/fail decisions that influence how the loop proceeds.

### Gate Types

| Type | What It Does | Key Config |
|---|---|---|
| `command` | Runs a shell command (`bash -lc`). Passes on exit code 0. | `command`, optional `passPattern` (regex), `timeoutMs`, `cwd` |
| `llm-review` | Sends the loop context to an LLM for criteria-based assessment. | `criteria` (string describing what to evaluate) |
| `artifact` | Checks that a file exists, optionally validates content via regex or JSON schema. | `path`, optional `regex`, `jsonSchema` |
| `human` | Pauses the loop and waits for human approval. Auto-approves after timeout. | `prompt`, optional `autoApproveAfterMs` |

### Gate Triggers

Gates fire based on trigger conditions:

| Trigger | When It Fires |
|---|---|
| `every-iteration` | After every completed iteration (when state is `iterating`) |
| `every-n` | Every N iterations (configurable via `every` field) |
| `on-reflection` | When the loop enters the `reflecting` state |
| `on-completion` | When the loop enters the `validating` state (end of all iterations) |
| `on-child-complete` | When a child loop completes |

### Failure Policies

When a gate fails, the `onFail` policy determines what happens:

| Policy | Behavior |
|---|---|
| `retry` | Re-run the gate up to `maxAttempts` times |
| `block` | Pause the loop until the issue is resolved |
| `skip` | Log the failure and continue |
| `escalate` | Surface the failure for human intervention |

### Gate Defaults

- `maxAttempts`: 1
- `priority`: 0 (lower priority gates run first; ties broken by ID)

### Human Gates

Human gates pause the loop and wait for manual approval. The operator can:

- **Approve**: `/loop approve <loopId> <gateId>`
- **Reject**: `/loop reject <loopId> <gateId>`

If no action is taken, the gate auto-approves after a timeout:
1. Per-gate `autoApproveAfterMs` (if set on the gate config)
2. Global auto-approve timeout from settings
3. Default: **5 minutes** (`DEFAULT_HUMAN_GATE_TIMEOUT_MS = 300000`)

---

## Safeguards

Safeguards prevent loops from running away with resources. Three independent checks run after each iteration:

### Budget Limits

| Limit | Default | What It Checks |
|---|---|---|
| Wall-clock time | **4 hours** (14,400,000 ms) | Elapsed time since `startedAt` |
| Tree iterations | **200** | `totalTreeIterations` across the loop and all its descendants |
| Idle iterations | **5** | Consecutive iterations with no progress (same `lastProgressHash`) |

Budget limits can be customized at loop start:

```
loop_prepare({
  name: "long-refactor",
  budgetLimits: {
    wallClockMs: 8 * 60 * 60 * 1000,  // 8 hours
    maxTreeIterations: 500,
    maxIdleIterations: 10
  }
})
```

### Runaway Detection

After each iteration, the system hashes the loop's task content, changed files, and summary into a `lastProgressHash`. If this hash hasn't changed for `maxIdleIterations` consecutive iterations (default: 5), the loop is considered stalled and pauses.

### Kill Switch

The `/loop kill <id>` command performs a cascading kill: it collects the target loop and all its descendants via depth-first traversal, then kills each one. This is the emergency stop.

---

## Child Loops

A parent loop can spawn child loops to decompose work. This creates a tree of loops tracked by a directed acyclic graph (DAG).

### Constraints

- **Depth limit**: 3 levels (parent -> child -> grandchild). Attempts to go deeper are escalated for human approval.
- **Cycle prevention**: The DAG checks for cycles before adding any edge. An attempt to create a cycle is rejected.
- **Concurrency limit**: At most 2 active loops simultaneously (across all loops, not per-parent).

### Child Completion Policies

When a child loop completes, the parent applies a failure policy based on the child's outcome:

| Child Outcome | Policy: `retry` | Policy: `block` | Policy: `skip` | Policy: `escalate` |
|---|---|---|---|---|
| `success` | Continue | Continue | Continue | Continue |
| `failed` | Retry (up to N) | Pause parent | Log and continue | Surface error |
| `cancelled` | Retry (up to N) | Pause parent | Log and continue | Surface error |
| `skipped` | Retry (up to N) | Pause parent | Log and continue | Surface error |

Default child failure policy: `{ policy: "retry", retries: 2 }`

---

## Slash Commands Reference

All commands use the `/loop` prefix:

| Command | Usage | Description |
|---|---|---|
| `prepare` | `/loop prepare <name>` | Create a loop and enter manifest building mode |
| `launch` | `/loop launch <id>` | Validate manifest and start iteration |
| `pause` | `/loop pause <id>` | Pause an active loop |
| `resume` | `/loop resume <id>` | Resume a paused loop |
| `status` | `/loop status [id]` | Show status of a specific loop, or all loops if no ID given |
| `list` | `/loop list` | List all loops with their current states |
| `kill` | `/loop kill <id>` | Kill a loop and all its descendants |
| `approve` | `/loop approve <loopId> <gateId>` | Approve a pending human gate |
| `reject` | `/loop reject <loopId> <gateId>` | Reject a pending human gate |

---

## Tool Parameters Reference

### `loop_prepare`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | -- | Loop name (used in ID generation and display) |
| `taskContent` | `string` | No | -- | Description of the task to accomplish |
| `maxIterations` | `integer` | No | 200 | Maximum iterations before forced validation |
| `reflectEvery` | `integer` | No | 3 | Reflect every N iterations (0 to disable) |
| `domains` | `string[]` | No | -- | Domain names to activate (e.g., `["code", "test"]`) |

### `loop_launch`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `loopId` | `string` | Yes | -- | ID of the loop to launch (must be in `manifest_building` state) |
### `loop_done`

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `loopId` | `string` | Yes | -- | ID of the loop to advance |
| `summary` | `string` | No | -- | Summary of work done this iteration |
| `changedFiles` | `string[]` | No | -- | Files modified in this iteration |
| `findings` | `string[]` | No | -- | Issues or observations found |
| `forceValidate` | `boolean` | No | `false` | Force transition to validating state |
| `taskContent` | `string` | No | -- | Updated task content (replaces existing) |
| `completedTickets` | `string[]` | No | -- | Ticket IDs completed in this iteration |
| `activeTickets` | `string[]` | No | -- | Ticket IDs currently active |

---

## The Manifest Workflow

The manifest system adds a pre-launch phase where work is decomposed into tickets with dependencies, gates, and acceptance criteria.

### Ticket Structure

Each ticket represents a discrete unit of work with:
- **Dependencies**: `blockedBy` lists upstream tickets that must complete first
- **Triggers**: Completing a ticket can automatically unblock downstream tickets
- **Gates**: Per-ticket quality checks derived from spec properties
- **Acceptance criteria**: Concrete, testable conditions for completion
- **Effort estimate**: Expected time investment

### Workflow

1. **Prepare**: `loop_prepare` ingests specs and enters `manifest_building` state
2. **Decompose**: Agent breaks task into tickets with dependencies and gates
3. **Review**: Manifest displayed via TUI (`tui/manifest-display.ts`) or QML canvas (`qml/ManifestViewer.qml`)
4. **Approve**: User reviews dependency tree, gate configuration, and effort estimates
5. **Launch**: `loop_launch` validates manifest integrity and starts the plan-code-review cycle

### Ticket Management During Iteration

During iteration, tickets track progress:
- `loop_done` accepts `completedTickets` and `activeTickets` arrays
- Completing a ticket triggers dependency cascade (unblocks downstream tickets)
- Spec drift is detected automatically; manifest merges preserve completed work


---

## Practical Examples

### Example 1: Simple Code-and-Test Loop

A basic loop for implementing a feature with type checking and tests:

```
loop_prepare({
  name: "add-user-search",
  taskContent: "Add full-text search to the user list endpoint with pagination",
  domains: ["code", "test"],
  maxIterations: 10,
  reflectEvery: 3
})

// Build manifest: decompose into tickets, set dependencies...

loop_launch({
  loopId: "LOOP-1711721600000-add-user-search"
})

This creates a loop that:
- Runs up to 10 plan-code-review iterations
- Reflects on progress every 3 iterations
- On completion, runs `bun check:ts` (code-compile gate) and `bun lint:ts` (code-format gate) from the `code` domain
- On completion, runs `bun test` (test-suite gate) from the `test` domain

Each iteration:
1. You call `loop_done` with a summary and changed files
2. The system checks for reflection (every 3 iterations) or max iterations
3. If neither, it transitions back to `planning` for the next iteration

When all iterations are done (or you call with `forceValidate: true`):
1. The loop enters `validating` state
2. All `on-completion` gates fire: `bun check:ts`, `bun lint:ts`, `bun test`
3. If all gates pass, the loop transitions to `complete`

### Example 2: Loop with Security and Architecture Review

A loop for sensitive work that needs security scanning and architecture validation:

```
loop_prepare({
  name: "payment-gateway",
  taskContent: "Integrate Stripe payment processing with webhook handling",
  domains: ["code", "test", "security", "architecture"],
  maxIterations: 20,
  reflectEvery: 5
})

// Build manifest with tickets for: webhook handler, payment flow, error handling...

loop_launch({
  loopId: "LOOP-1711721600000-payment-gateway"
})

This adds:
- `security-scan` gate: runs `git grep -n SECRET` on completion to catch leaked secrets
- `architecture-review` gate: an LLM review that fires on reflection (every 5 iterations) to validate architecture invariants

The reflection cadence is set to 5 to give more room between reviews for a larger feature.

### Example 3: Loop with Manual Checkpoints

For high-stakes work requiring human oversight, you can force validation at key milestones:

```
// Prepare the loop
loop_prepare({
  name: "database-migration",
  taskContent: "Migrate user table schema from v2 to v3 with zero downtime",
  domains: ["code", "test"],
  maxIterations: 30
})

// Build manifest, get approval, then launch
loop_launch({
  loopId: "LOOP-1711721600000-database-migration"
})

// ... several iterations of work ...

// At a critical milestone, force validation
loop_done({
  loopId: "LOOP-1711721600000-database-migration",
  summary: "Schema migration scripts complete, ready for review",
  changedFiles: ["migrations/003_user_v3.sql", "src/models/user.ts"],
  completedTickets: ["TICKET-001-schema-migration"],
  forceValidate: true
})

Setting `forceValidate: true` transitions the loop to `validating` regardless of iteration count, triggering all `on-completion` gates. This is useful when you reach a natural checkpoint and want validation before continuing.

If the loop was started with human gates configured, the operator would need to `/loop approve` before the loop can complete.

---

## Loop States

For reference, a loop moves through these states during its lifecycle:

```
idle -> manifest_building -> planning -> iterating -> planning -> iterating -> ...
                                                        |
                                                        v
                                                   reflecting -> planning -> ...
                                                        |
                                                        v
                                                   validating -> complete
```

Control states that can be entered from most active states:
- `paused` -- manually paused, can resume
- `failed` -- unrecoverable error
- `cancelled` -- user cancellation
- `killed` -- emergency stop (cascades to children)

Terminal states (no transitions out): `complete`, `failed`, `cancelled`, `killed`.

For the full state transition table, see [ARCHITECTURE.md](./ARCHITECTURE.md#state-machine).

---

## Persistence

Loop state survives process restarts. The system persists to `.local/!tracks/loops/{loopId}/`:

- `state.json` -- Latest snapshot + iteration checkpoint
- `events.ndjson` -- Full event history (append-only)

On startup, the system restores loops from disk: it loads the checkpoint first, falls back to replaying the event log if the checkpoint is missing, then reconciles with org item state.

Loops also sync to org items at `!tasks/projects/{loopId}.org` with state mapping:
- Active states (planning, iterating, reflecting, validating) -> `DOING`
- Paused, failed -> `BLOCKED`
- Complete, cancelled, killed -> `DONE`
