# Spell Loop System Architecture

This is the contributor-facing reference for the loop system internals. For usage, see [TUTORIAL.md](./TUTORIAL.md).

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Directory Map](#directory-map)
3. [State Machine](#state-machine)
4. [LoopSnapshot Data Model](#loopsnapshot-data-model)
5. [Iteration Flow](#iteration-flow)
6. [Gate System](#gate-system)
7. [Domain System](#domain-system)
8. [Persistence Layer](#persistence-layer)
9. [Manifest System](#manifest-system)
10. [Recursion System](#recursion-system)
11. [Safeguards](#safeguards)
12. [Integration Points](#integration-points)
13. [Replay and Debug](#replay-and-debug)
14. [Constants Reference](#constants-reference)

---

## System Overview

The loop system is a state-machine-driven orchestration engine for multi-iteration plan-code-review cycles. It is designed as a self-contained subsystem within the coding agent.

### Design Philosophy

- **Pure state machine kernel**: All state transitions live in `LoopKernel`. No business logic leaks into the kernel -- it only validates transitions and emits events.
- **Event-sourced persistence**: Every state change emits a `LoopEvent` that is appended to an NDJSON log. The event log is the source of truth; checkpoints are an optimization.
- **Gate-based validation**: Quality checks are externalized as configurable gates that fire at specific lifecycle points, not hard-coded into the iteration logic.
- **DAG-based recursion**: Child loops form a directed acyclic graph with depth limits and cycle detection, not a simple parent-child tree.

### Component Inventory

| Component | Responsibility | Key File |
|---|---|---|
| LoopKernel | State machine, transition validation, event emission | `kernel.ts` |
| LoopManager | Orchestration facade, lifecycle management | `loop-manager.ts` |
| LoopRegistry | In-memory loop storage, concurrency enforcement | `loop-registry.ts` |
| PhaseCoordinator | Plan-code-review phase execution | `orchestration/phase-coordinator.ts` |
| LlmSwitcher | Model resolution per role | `orchestration/switcher.ts` |
| GateEvaluator | Gate matching, execution, decision collection | `gates/evaluator.ts` |
| GateRegistry | Per-loop gate config storage | `gates/registry.ts` |
| HumanGateExecutor | Human approval with auto-approve timer | `gates/executors/human.ts` |
| CommandGateExecutor | Shell command execution | `gates/executors/command.ts` |
| ArtifactGateExecutor | File existence + content validation | `gates/executors/artifact.ts` |
| LlmReviewGateExecutor | LLM-based criteria assessment | `gates/executors/llm-review.ts` |
| LoopDomainRegistry | Domain definition storage | `domains/registry.ts` |
| ChildSpawner | Child loop creation with depth enforcement | `recursion/spawner.ts` |
| LoopDag | Cycle detection, edge tracking | `recursion/dag.ts` |
| Checkpoint | Snapshot persistence to `state.json` | `persistence/checkpoint.ts` |
| EventLog | NDJSON event sourcing | `persistence/event-log.ts` |
| OrgSync | Bidirectional org item synchronization | `persistence/org-sync.ts` |
| SessionHooks | Restore loops on startup | `persistence/session-hooks.ts` |
| DashboardBridge | UI event channel binding | `dashboard-bridge.ts` |
| PromptBuilder | Handlebars template rendering | `prompt-builder.ts` |
| TicketLifecycleManager | Manifest ticket state transitions and dependency cascade | `ticket-lifecycle.ts` |
| ManifestWriter | Writes manifest snapshot + ticket files to org format | `persistence/manifest-writer.ts` |
| ManifestReader | Reads manifest snapshot + tickets from org files | `persistence/manifest-reader.ts` |
| OrgDependParser | Parses BLOCKER/TRIGGER/GATE_* properties and builds dependency graph | `ingestion/org-depend.ts` |
| MetisBuilder | Builds Metis gap-analysis input from spec and manifest | `ingestion/metis-builder.ts` |
| MomusBuilder | Builds Momus validation input for pre-launch quality checks | `ingestion/momus-builder.ts` |
| TicketGateDerivation | Derives per-ticket gates from spec properties and acceptance criteria | `gates/ticket-gates.ts` |
| ManifestDriftDetector | Detects spec file changes and merges manifest preserving completed tickets | `git/manifest-drift.ts` |
| TuiManifestDisplay | TUI rendering for manifest approval, dependency tree, gate overview | `tui/manifest-display.ts` |

---

## Directory Map

```
loop/
  kernel.ts                  # State machine (ALLOWED_TRANSITIONS, start/done/pause/resume/kill/fail)
  loop-manager.ts            # Orchestration facade
  loop-registry.ts           # In-memory storage with concurrency limits
  loop-tools.ts              # loop_prepare, loop_launch, and loop_done tool definitions
  loop-commands.ts            # Slash command dispatcher
  prompt-builder.ts           # Handlebars template rendering
  types.ts                    # Core type definitions (LoopSnapshot, gate configs, etc.)
  constants.ts                # Default values and limits
  hash.ts                     # Content hashing (Bun.hash) for progress detection
  ids.ts                      # Loop ID generation (LOOP-{timestamp}-{slug})
  index.ts                    # Public re-exports
  ticket-lifecycle.ts         # Manifest ticket state transitions and dependency cascade
  dashboard-bridge.ts         # UI panel lifecycle and event subscription

  contracts/
    enums.ts                  # LOOP_STATES, GATE_TRIGGERS, FAILURE_POLICIES, etc.
    gate-decision.ts          # GateDecision TypeBox schema
    handoff-artifact.ts       # HandoffArtifact TypeBox schema
    iteration-checkpoint.ts   # IterationCheckpoint TypeBox schema
    loop-event.ts             # LoopEvent TypeBox schema
    child-completion.ts       # ChildCompletionSignal TypeBox schema

  orchestration/
    phase-coordinator.ts      # Three-phase iteration runner
    switcher.ts               # LLM role -> model resolution
    handoff.ts                # HandoffArtifact construction

  gates/
    evaluator.ts              # Gate matching and execution pipeline
    registry.ts               # Per-loop gate config storage (sorted by priority)
    trigger.ts                # shouldFire() trigger matching logic
    config.ts                 # Gate config normalization (defaults)
    dedup.ts                  # FindingDedup for repeated gate results
    ticket-gates.ts           # Per-ticket gate derivation from spec properties
    clock.ts                  # Clock interface (RealClock, VirtualClock for tests)
    timer.ts                  # GateTimer for auto-approve timeouts
    types.ts                  # GateExecutor, GateExecutionContext, LoopReviewer
    executors/
      command.ts              # Shell command gate
      human.ts                # Human approval gate
      artifact.ts             # File/content validation gate
      llm-review.ts           # LLM criteria assessment gate

  domains/
    registry.ts               # LoopDomainRegistry with 6 built-in domains
    code.ts                   # code domain (compile + lint gates)
    test.ts                   # test domain (test suite gate)
    architecture.ts           # architecture domain (LLM review gate)
    ui.ts                     # ui domain (artifact gate)
    security.ts               # security domain (command gate)
    docs.ts                   # docs domain (artifact + LLM review gates)

  persistence/
    checkpoint.ts             # state.json read/write
    event-log.ts              # events.ndjson append/read/replay
    org-sync.ts               # Org item sync and state mapping
    reconcile.ts              # Checkpoint-vs-org reconciliation
    manifest-writer.ts        # Writes ManifestSnapshot + ticket files to org format
    manifest-reader.ts        # Reads ManifestSnapshot + tickets from org files
    session-hooks.ts          # Startup restore flow

  recursion/
    spawner.ts                # Child loop creation with validation
    dag.ts                    # LoopDag cycle detection and edge storage
    depth-guard.ts            # Depth limit enforcement
    completion-handler.ts     # Child completion policy application

  safeguards/
    budget.ts                 # Wall-clock and iteration budget checks
    runaway.ts                # Idle iteration / stall detection
    kill-switch.ts            # Cascading kill tree traversal
    config.ts                 # Budget limit resolution with defaults

  git/
    dirty-check.ts            # Pre-start git cleanliness check
    drift.ts                  # Spec file change detection
    worktree.ts               # Git worktree creation/removal
    manifest-drift.ts         # Spec drift detection and manifest-aware merge

  ingestion/
    parser.ts                 # Org file parsing (CUSTOM_ID, [[id:]] links)
    validator.ts              # Parsed spec validation (missing IDs, broken links)
    org-depend.ts             # BLOCKER/TRIGGER/GATE_* property parsing, dependency graph
    metis-builder.ts          # Metis gap-analysis input builder
    momus-builder.ts          # Momus validation input builder
    readiness.ts              # Pre-start readiness evaluation
    ancillary.ts              # Domain guideline file existence check
    importer.ts               # Spec file import to !tasks/drafts/

  replay/
    replayer.ts               # Reconstruct snapshot at any iteration
    formatter.ts              # Timeline and status formatting
    commands.ts               # Debug command handlers

  prompts/
    iteration.md              # Iteration prompt template
    reflection.md             # Reflection prompt template
    plan-handoff.md           # Plan -> code handoff template
    code-handoff.md           # Code -> review handoff template
    review-handoff.md         # Review -> plan handoff template
    preparation-workflow.md   # Pre-start validation checklist
    loop-start-tool.md        # loop_start tool description (deprecated)
    loop-done-tool.md         # loop_done tool description
    loop-prepare-tool.md      # loop_prepare tool description
    loop-launch-tool.md       # loop_launch tool description
```

  tui/
    manifest-display.ts       # TUI manifest approval display with dependency tree

  qml/
    ManifestViewer.qml        # QML manifest viewer canvas for real-time monitoring

---

## State Machine

The state machine lives in `kernel.ts`. `LoopKernel` owns all state transitions and emits `LoopEvent`s via an `onEvent` callback.

### States

Defined in `contracts/enums.ts` as `LOOP_STATES`:

| State | Description |
|---|---|
| `idle` | Initial state before `start()` is called |
| `manifest_building` | Manifest decomposition and approval; entered via `loop_prepare`, exits to `planning` via `loop_launch` |
| `planning` | Plan phase active; waiting for `done()` to move to `iterating` |
| `iterating` | Code/review phases active; `done()` triggers next transition |
| `reflecting` | Mid-loop reflection; entered every `reflectEvery` iterations |
| `validating` | Final validation; entered at `maxIterations` or `forceValidate` |
| `complete` | Terminal: all work done, validation passed |
| `failed` | Terminal: unrecoverable error |
| `paused` | Suspended by user or safeguard; can `resume` |
| `cancelled` | Terminal: user cancellation |
| `killed` | Terminal: emergency stop (cascades to children) |
### ALLOWED_TRANSITIONS

This is the complete transition table from `kernel.ts`:

| From State | Allowed Target States |
|---|---|
| `idle` | `planning`, `manifest_building` |
| `manifest_building` | `planning`, `paused`, `failed`, `killed`, `cancelled` |
| `planning` | `iterating`, `paused`, `failed`, `killed`, `cancelled` |
| `iterating` | `planning`, `reflecting`, `validating`, `paused`, `failed`, `killed`, `cancelled` |
| `reflecting` | `planning`, `validating`, `paused`, `failed`, `killed`, `cancelled` |
| `validating` | `complete`, `failed`, `paused`, `killed`, `cancelled` |
| `complete` | *(none -- terminal)* |
| `failed` | *(none -- terminal)* |
| `paused` | `iterating`, `planning`, `manifest_building`, `killed`, `cancelled` |
| `cancelled` | *(none -- terminal)* |
| `killed` | *(none -- terminal)* |

### How `done()` Routes State

The `done()` method on `LoopKernel` implements the core iteration advancement logic. Its behavior depends on the current state:

```
done() in state:
  paused     -> resume (transitions to iterating or planning)
  planning   -> iterating
  reflecting -> planning
  validating -> complete (sets completedAt, emits loop.completed)
  iterating  -> one of:
                 validating  (if forceValidate or iteration >= maxIterations)
                 reflecting  (if reflectEvery > 0 and iteration % reflectEvery == 0)
                 planning    (otherwise, next iteration)
```

When in the `iterating` state, `done()` also:
1. Increments `iteration`, `totalTreeIterations`, `budgetStatus.treeIterations`
2. Updates `budgetStatus.elapsedMs`
3. Records `changedFiles`, `openFindings`, `lastSummary`, `taskContent` (if provided)
4. Computes `lastProgressHash` from `{task, files, summary}`
5. Emits `loop.iteration_completed`

Calling `done()` on a terminal state (`complete`, `failed`, `killed`) throws.

---

## LoopSnapshot Data Model

`LoopSnapshot` (defined in `types.ts`) is the complete runtime state of a loop:

### Identity Fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique ID: `LOOP-{timestamp}-{slug}` |
| `name` | `string` | Human-readable name |
| `orgItemId` | `string` | Associated org item ID |
| `parentLoopId` | `string?` | Parent loop ID (if child) |
| `depth` | `number` | Nesting depth (0 = root) |

### Timing Fields

| Field | Type | Description |
|---|---|---|
| `createdAt` | `number` | Creation timestamp (ms) |
| `updatedAt` | `number` | Last update timestamp (ms) |
| `startedAt` | `number` | When the loop started executing |
| `pausedAt` | `number?` | When last paused |
| `completedAt` | `number?` | When completed (terminal) |

### Iteration State

| Field | Type | Description |
|---|---|---|
| `state` | `LoopState` | Current FSM state |
| `iteration` | `number` | Current iteration number |
| `maxIterations` | `number` | Maximum before forced validation |
| `reflectEvery` | `number` | Reflect after every N iterations |
| `currentRole` | `LoopRole` | Current phase role (`plan`/`code`/`review`) |
| `totalTreeIterations` | `number` | Iterations across this loop + all descendants |

### Task and Progress

| Field | Type | Description |
|---|---|---|
| `taskFilePath` | `string?` | Path to task specification file |
| `taskFileHash` | `string` | Hash of task content |
| `taskContent` | `string?` | Current task description |
| `lastSummary` | `string?` | Summary from last `done()` call |
| `changedFiles` | `string[]` | Files changed in last iteration |
| `openFindings` | `string[]` | Unresolved findings |
| `lastProgressHash` | `string` | Hash for stall detection |
| `statusReason` | `string?` | Human-readable status explanation |
| `specPaths` | `string[]` | Tracked specification file paths |
| `domainNames` | `string[]` | Active domain names |

### Children

| Field | Type | Description |
|---|---|---|
| `childLoopIds` | `string[]` | All child loop IDs |
| `requiredChildLoopIds` | `string[]` | Required children that must succeed |
| `pendingChildLoopIds` | `string[]` | Children not yet completed |

### Gates

| Field | Type | Description |
|---|---|---|
| `gateConfigs` | `LoopGateConfig[]` | Registered gate configurations |
| `gateResults` | `GateDecision[]` | Historical gate execution results |
| `pendingGates` | `string[]` | Gate IDs awaiting resolution |

### Budget

| Field | Type | Description |
|---|---|---|
| `budgetLimits` | `LoopBudgetLimits` | Configured limits (wallClockMs, maxTreeIterations, maxIdleIterations) |
| `budgetStatus` | `LoopBudgetStatus` | Current usage (elapsedMs, treeIterations, idleIterations) |

### Accumulated History

| Field | Type | Description |
|---|---|---|
| `checkpoints` | `IterationCheckpoint[]` | Saved iteration checkpoints |
| `handoffs` | `HandoffArtifact[]` | Phase transition artifacts |

### Runtime Flags

| Field | Type | Description |
|---|---|---|
| `autoApproveEnabled` | `boolean` | Whether human gates auto-approve |
| `reviewModelConfigured` | `boolean` | Whether a review model is available |
| `gitAvailable` | `boolean` | Whether git commands work |
| `worktreePath` | `string?` | Git worktree path if enabled |

---

## Iteration Flow

### PhaseCoordinator.runIteration()

Located in `orchestration/phase-coordinator.ts`. This is the per-iteration execution pipeline:

```
1. onBeforePhase("plan", loop)
2. Build iteration prompt via buildIterationPrompt(context)
3. responder.run("plan", prompt, loop) -> plan result
4. Create planToCode HandoffArtifact {fromRole: "plan", toRole: "code"}

5. onBeforePhase("code", loop)
6. responder.run("code", plan.summary, loop) -> code result
7. Create codeToReview HandoffArtifact {fromRole: "code", toRole: "review"}

8. onBeforePhase("review", loop)
9. Build reflection prompt via buildReflectionPrompt(context)
10. responder.run("review", reviewPrompt, loop) -> review result
11. Create reviewToPlan HandoffArtifact {fromRole: "review", toRole: "plan"}

Return: { handoffs: [3], changedFiles, findings, reviewSummary }
```

### HandoffArtifact

Defined in `contracts/handoff-artifact.ts`. Flows between phases:

```typescript
{
  fromRole: LoopRole,      // "plan" | "code" | "review"
  toRole: LoopRole,
  iteration: number,
  changedFiles: string[],
  gateResults: GateDecision[],
  openFindings: string[],
  summary: string,
}
```

Three handoffs per iteration: plan->code, code->review, review->plan.

### LoopRoleResponder

The interface that connects the loop system to actual LLM execution:

```typescript
interface LoopRoleResponder {
  run(role: LoopRole, prompt: string, loop: LoopSnapshot): Promise<LoopRoleResponse>;
}

interface LoopRoleResponse {
  summary: string;
  changedFiles?: string[];
  findings?: string[];
}
```

### LlmSwitcher

Located in `orchestration/switcher.ts`. Maps each `LoopRole` to a model:

| Role | Resolution |
|---|---|
| `review` | Validates prerequisites, returns `resolver.getReviewModel()` |
| `plan` | `resolver.getPlanModel()` or falls back to `resolver.getCurrentModel()` |
| `code` | `resolver.getCurrentModel()` |

### Prompt Templates

Located in `prompts/`. Rendered via Handlebars.

**iteration.md** -- Used for plan and code phases:
- Variables: `name`, `loopId`, `iteration`, `state`, `taskContent`, `changedFiles`, `openFindings`, `pendingGates`
- Conditionally renders task section, changed files list, open findings list, pending gates list

**reflection.md** -- Used during reflecting state and for review phase:
- Variables: `name`, `loopId`, `iteration`, `state`, `summary`
- Renders latest summary section

**Handoff templates** (plan-handoff.md, code-handoff.md, review-handoff.md):
- Each captures the transition context between two phases
- Variables: `loopId`, `iteration`, `changedFiles`, `openFindings`, `summary`

---

## Gate System

### Architecture

```
GateEvaluator
  |-- GateRegistry (per-loop gate config storage)
  |-- shouldFire() (trigger matching)
  |-- Executors (one per gate type):
       |-- CommandGateExecutor
       |-- ArtifactGateExecutor
       |-- HumanGateExecutor
       |-- LlmReviewGateExecutor
  |-- FindingDedup (duplicate detection)
```

### GateEvaluator

Located in `gates/evaluator.ts`. Core evaluation loop:

1. List all gates for the loop (sorted by priority ascending, then ID)
2. Filter gates where `shouldFire(gate, event)` returns true
3. For each matching gate, look up the executor by `gate.type`
4. Execute the gate, catch errors, produce `GateDecision`
5. Return all decisions

If no executor is registered for a gate type, a `fail` decision is produced with reason "No executor registered for gate type {type}".

### GateRegistry

Located in `gates/registry.ts`. Storage is `Map<loopId, Map<gateId, LoopGateConfig>>`. Gates are sorted by `priority` (ascending), ties broken by `localeCompare` on gate ID.

### Trigger Logic

Located in `gates/trigger.ts`. `shouldFire(gate, event)`:

| Trigger Kind | Fires When |
|---|---|
| `every-iteration` | `event.state === "iterating"` |
| `every-n` | `gate.trigger.every > 0 && event.iteration > 0 && event.iteration % gate.trigger.every === 0` |
| `on-reflection` | `event.state === "reflecting"` |
| `on-completion` | `event.state === "validating"` |
| `on-child-complete` | `event.childSignal !== undefined` |

### Gate Config Normalization

Located in `gates/config.ts`. `normalizeGateConfig()`:
- `maxAttempts` defaults to `1`
- `priority` defaults to `0`
- Validates that `every-n` trigger has a positive `every` value

### CommandGateExecutor

Located in `gates/executors/command.ts`.

- Spawns `bash -lc <command>` via `Bun.spawn`
- Supports `timeoutMs` via `Promise.race`
- Supports `passPattern` regex match on stdout
- Supports custom `cwd`
- Returns `fail` on: non-zero exit, timeout, pattern mismatch
- Evidence: `[stdout, stderr]`

### ArtifactGateExecutor

Located in `gates/executors/artifact.ts`.

- Checks file existence via `fs.stat()`
- Path resolved as absolute, or relative to `cwd`
- Optional `regex` match on file content
- Optional `jsonSchema` validation via `@sinclair/typebox` `Value.Check()`
- Evidence: `[artifactPath]`

### HumanGateExecutor

Located in `gates/executors/human.ts`.

Uses `Promise.withResolvers()` to suspend execution until an external call to `approve()` or `reject()`.

Auto-approve timeout resolution order:
1. `gate.autoApproveAfterMs` (per-gate)
2. `settings.getAutoApproveTimeoutMs()` (global)
3. `DEFAULT_HUMAN_GATE_TIMEOUT_MS` (300,000 ms = 5 minutes)

The timer is managed by `GateTimer` (wraps `Clock` interface for testability). When the timer fires, it resolves the promise with `{ approved: true, reason: "Auto-approved after timeout" }`.

Key methods:
- `execute(gate, context)` -- Create pending gate, start timer, await resolution
- `approve(loopId, gateId)` -- Resolve with approved=true
- `reject(loopId, gateId)` -- Resolve with approved=false
- `setAutoApprove(loopId, gateId, enabled)` -- Modify auto-approve for a specific gate
- `listPending(loopId?)` -- Query pending gates

### LlmReviewGateExecutor

Located in `gates/executors/llm-review.ts`.

Delegates to an injected `LoopReviewer` interface:

```typescript
interface LoopReviewer {
  review(gate: LlmReviewGateConfig, context: GateExecutionContext): Promise<ReviewResult>;
}

interface ReviewResult {
  pass: boolean;
  summary: string;
  findings: string[];
}
```

Maps `result.pass` to `GATE_OUTCOMES.pass` / `GATE_OUTCOMES.fail`. Returns `fail` on malformed response or thrown error.

### FindingDedup

Located in `gates/dedup.ts`. Tracks normalized finding hashes per gate ID. Detects when a gate produces the same findings as its previous run, which indicates the loop hasn't made progress on the gate's concern.

---

## Domain System

### LoopDomainRegistry

Located in `domains/registry.ts`. Pre-registers six built-in domains in its constructor. Methods:

- `register(domain)` -- Adds a domain; rejects duplicates
- `get(name)` -- Retrieves by name; returns cloned `defaultGates` to prevent mutation
- `list()` -- Returns all registered domains

### LoopDomainDefinition

```typescript
interface LoopDomainDefinition {
  name: string;
  description: string;
  guidelinesTemplate: string;
  defaultGates: LoopGateConfig[];
  evidenceCollector?: (loop: LoopSnapshot) => Promise<string[]> | string[];
}
```

### Built-in Domains

| Domain | Description | Default Gates |
|---|---|---|
| `code` | Compile, lint, and formatting validation | `code-compile`: command `bun check:ts` (on-completion), `code-format`: command `bun lint:ts` (on-completion) |
| `test` | Focused test validation | `test-suite`: command `bun test` (on-completion) |
| `architecture` | Contract and dependency review | `architecture-review`: llm-review (on-reflection), criteria: "Validate architecture invariants" |
| `ui` | Visual artifact validation | `ui-artifacts`: artifact at `artifacts/ui.png` (on-completion) |
| `security` | Secret and dependency hygiene | `security-scan`: command `git grep -n SECRET` (on-completion) |
| `docs` | Documentation and changelog validation | `docs-artifacts`: artifact at `CHANGELOG.md` (on-completion), `docs-review`: llm-review (on-completion) |

Each domain's `guidelinesTemplate` is loaded from a Markdown file via `import ... with { type: "text" }`.

---

## Persistence Layer

Three tiers of persistence, all under `.local/!tracks/loops/{loopId}/`:

### Tier 1: Checkpoint (`state.json`)

Located in `persistence/checkpoint.ts`.

Format:
```typescript
interface PersistedLoopState {
  snapshot: LoopSnapshot;       // Full runtime state
  checkpoint: IterationCheckpoint;  // Compact iteration marker
}
```

`IterationCheckpoint` schema:
```typescript
{
  loopId: string,
  iteration: number,           // >= 0
  state: LoopState,
  timestamp: number,
  taskFileHash: string,
  orgItemId: string,
  childLoopIds: string[],
  pendingGates: string[],
}
```

Path: `{cwd}/.local/!tracks/loops/{loopId}/state.json`

Written by `saveLoopState()` on every state change. Read by `loadLoopState()` on startup.

### Tier 2: Event Log (`events.ndjson`)

Located in `persistence/event-log.ts`.

Format: NDJSON (one JSON object per line), each line is a `LoopEvent` with an embedded snapshot:

```typescript
{
  version: "1.0.0",            // LOOP_SCHEMA_VERSION
  type: string,                // e.g., "loop.created", "loop.state_changed", "loop.iteration_completed"
  loopId: string,
  parentLoopId?: string,
  timestamp: number,
  payload: { snapshot: LoopSnapshot, ...eventData },
}
```

Path: `{cwd}/.local/!tracks/loops/{loopId}/events.ndjson`

Key functions:
- `appendLoopEvent(cwd, event, snapshot)` -- Appends a line with the event + embedded snapshot
- `readLoopEvents(cwd, loopId)` -- Parses all events; skips invalid JSON with a warning
- `replayLoopEvents(events, atIteration?)` -- Reconstructs the snapshot by iterating events, optionally stopping at a specific iteration

### Tier 3: Org Sync

Located in `persistence/org-sync.ts`.

Syncs loop state to org items at `!tasks/projects/{loopId}.org`.

State mapping (`mapLoopStateToOrgState`):

| Loop State | Org Keyword |
|---|---|
| `complete` | `DONE` |
| `paused` | `BLOCKED` |
| `failed` | `BLOCKED` |
| `cancelled` | `DONE` |
| `killed` | `DONE` |
| All others | `DOING` |

Org item body includes these properties:
- `LOOP_STATE` -- raw loop state value
- `ITERATION` -- current iteration number
- `MAX_ITERATIONS` -- configured maximum
- `DEPTH` -- nesting depth
- `PARENT_LOOP` -- parent loop ID (if child)
- `LAST_GATE_OUTCOME` -- most recent gate result outcome
- `LOOP_CHILDREN` -- comma-separated child loop IDs

### Recovery Flow

Located in `persistence/session-hooks.ts`. On startup, `restoreLoopSnapshots(cwd)`:

1. Scans `.local/!tracks/loops/` directory for loop subdirectories
2. For each loop directory:
   a. Attempts `loadLoopState()` (checkpoint)
   b. Falls back to `replayLoopEvents()` if checkpoint missing
3. Calls `reconcileLoopState()` to sync with org item state
4. Returns restored `LoopSnapshot[]`

`reconcileLoopState()` (in `persistence/reconcile.ts`) reads the org item state and overrides the snapshot's `state` and `taskContent` if they differ, setting `statusReason` to explain the override.

---

## Manifest System

The manifest system adds spec-driven loop orchestration. Instead of starting a loop directly, users call `loop_prepare` to ingest specs, decompose work into tickets, and build a manifest for approval before launching iteration via `loop_launch`.

### Data Model

**ManifestTicket** represents a single unit of work:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Ticket ID (from org CUSTOM_ID) |
| `title` | `string` | Human-readable ticket title |
| `state` | `TicketState` | `ITEM` \| `DOING` \| `DONE` \| `BLOCKED` \| `HOLD` |
| `blockedBy` | `string[]` | IDs of tickets that must complete first |
| `triggers` | `string[]` | IDs of tickets to unblock on completion |
| `gates` | `TicketGate[]` | Per-ticket quality gates derived from spec properties |
| `effort` | `string?` | Estimated effort (e.g., `"2h"`, `"1d"`) |
| `acceptance` | `string[]` | Acceptance criteria extracted from spec |
| `specPath` | `string` | Path to the source spec file |

**ManifestSnapshot** is the top-level manifest state:

| Field | Type | Description |
|---|---|---|
| `tickets` | `ManifestTicket[]` | All tickets in dependency order |
| `rootTicketIds` | `string[]` | Tickets with no dependencies (entry points) |
| `completedTicketIds` | `string[]` | Tickets in terminal `DONE` state |
| `activeTicketId` | `string?` | Currently executing ticket |
| `specHash` | `string` | Hash of ingested spec content for drift detection |

### manifest_building State

The `manifest_building` state is entered via `loop_prepare` from `idle`. During this state:

1. Specs are ingested and parsed via `ingestion/org-depend.ts`
2. The agent decomposes work into `ManifestTicket`s with dependencies
3. The manifest is displayed for approval via TUI or QML canvas
4. `loop_launch` validates the manifest and transitions to `planning`

Transitions: `idle -> manifest_building -> planning` (or `manifest_building -> failed/cancelled/killed`).

### Ticket Lifecycle

Tickets follow a state machine managed by `ticket-lifecycle.ts`:

```
ITEM -> DOING -> DONE
  |       |
  v       v
HOLD   BLOCKED -> DOING (when blockers resolve)
```

- **ITEM**: Initial state; ticket is defined but not started
- **DOING**: Actively being worked on
- **DONE**: Completed; triggers dependency cascade
- **BLOCKED**: Waiting on upstream tickets (auto-set when `blockedBy` is non-empty)
- **HOLD**: Manually paused by user

When a ticket transitions to `DONE`, the `TicketLifecycleManager` cascades:
1. Removes the completed ticket from all downstream `blockedBy` arrays
2. Fires `TRIGGER` properties (e.g., unblocking specific tickets)
3. Transitions newly-unblocked tickets from `BLOCKED` to `ITEM`

### Manifest Persistence

Manifest state persists as org files under `.local/!tracks/loops/{loopId}/manifest/`:

- `manifest.org` -- Top-level manifest metadata (spec hash, root ticket IDs)
- `tickets/{ticketId}.org` -- Individual ticket files with full state and properties

`ManifestWriter` serializes the snapshot; `ManifestReader` reconstructs it. Round-trip fidelity is guaranteed: `read(write(snapshot)) === snapshot`.

### Dependency Graph and Topological Sort

`ingestion/org-depend.ts` parses org properties:

- `BLOCKER: ticket-id-1, ticket-id-2` -- This ticket is blocked by the listed tickets
- `TRIGGER: ticket-id-3` -- Completing this ticket unblocks the target
- `GATE_TYPE: command|artifact|llm-review` -- Gate type for this ticket
- `GATE_COMMAND: bun test` -- Gate-specific configuration

The parser builds a dependency graph and produces a topological sort for execution ordering. Cycles are detected and rejected at parse time.

### Gate Derivation

`gates/ticket-gates.ts` derives per-ticket gates from spec properties:

1. Explicit `GATE_*` org properties define gates directly
2. Acceptance criteria are converted to `artifact` or `llm-review` gates
3. Domain default gates are inherited when a ticket specifies domain membership

### Spec Drift Detection

`git/manifest-drift.ts` detects when spec files change after manifest building:

1. Compares current spec file hashes against `ManifestSnapshot.specHash`
2. On drift, performs a manifest-aware merge:
   - Completed tickets are preserved (work already done)
   - New spec items become new tickets
   - Modified spec items update ticket metadata but preserve state
   - Removed spec items mark tickets as `HOLD` (not deleted)

### Metis/Momus Integration

**MetisBuilder** (`ingestion/metis-builder.ts`): Builds input for Metis gap-analysis review. Collects spec content, existing ticket coverage, and acceptance criteria to identify gaps in the manifest before launch.

**MomusBuilder** (`ingestion/momus-builder.ts`): Builds input for Momus pre-launch validation. Assembles the full manifest with dependency graph, gate configurations, and effort estimates for quality review.


---

## Recursion System

### ChildSpawner

Located in `recursion/spawner.ts`. Validates child creation:

1. `enforceDepthLimit(parentDepth, limit)` -- Checks `nextDepth <= limit` (default limit: 4). Returns `{ allowed, nextDepth, escalate, reason }`. If exceeded, `escalate` is set to request human approval.
2. `dag.createsCycle(parentId, childId)` -- DAG cycle check (DFS)
3. If both pass, `registerChild()` adds an edge to the DAG

### LoopDag

Located in `recursion/dag.ts`. Stores edges as `Map<parentLoopId, LoopTreeEdge[]>`.

```typescript
interface LoopTreeEdge {
  parentLoopId: string;
  childLoopId: string;
  required: boolean;
  failurePolicy: LoopRetryPolicy;
  attempts: number;
}
```

Key methods:
- `addEdge(parent, child, required, failurePolicy)` -- Checks for cycle, then pushes edge
- `createsCycle(parent, child)` -- DFS from child through existing edges; returns true if it reaches parent
- `childrenOf(loopId)` -- Returns cloned edges for a parent
- `topologicalOrder(rootLoopId)` -- Depth-first traversal from root

### Child Completion

Located in `recursion/completion-handler.ts`. `applyChildCompletionPolicy(signal, policy, attempts)`:

| Child Outcome | Action |
|---|---|
| `success` | `continue` |
| Non-success + policy `retry` + attempts < retries | `retry` |
| Non-success + policy `skip` | `skip` |
| Non-success + policy `escalate` | `escalate` |
| Non-success + anything else (including `block`) | `block` |

Default child policy in `LoopManager`: `{ policy: "retry", retries: 2 }`

---

## Safeguards

### Budget Checking

Located in `safeguards/budget.ts`. `checkBudget(loop, now)`:

Two independent checks:
1. **Wall-clock**: `now - loop.startedAt > loop.budgetLimits.wallClockMs`
2. **Tree iterations**: `loop.totalTreeIterations >= loop.budgetLimits.maxTreeIterations`

Returns `{ exceeded: boolean, reason?: string }`.

### Runaway Detection

Located in `safeguards/runaway.ts`. `detectRunaway(loop, progressHash)`:

Compares `progressHash` against `loop.lastProgressHash`. If identical, the loop's `budgetStatus.idleIterations` increments. When `idleIterations >= loop.budgetLimits.maxIdleIterations` (and `maxIdleIterations > 0`), returns `{ runaway: true }`.

Progress hash is computed by `hashTaskContent(JSON.stringify({ task, files, summary }))` using `Bun.hash()`.

### Kill Switch

Located in `safeguards/kill-switch.ts`. `collectKillTree(rootLoopId, loops)`:

1. Builds a `Map<parentLoopId, childIds[]>` from all loops
2. DFS from `rootLoopId`, collecting all descendants
3. Returns ordered list (root first, then children depth-first)

Used by `LoopManager.kill()` to transition every loop in the tree to `killed`.

### Budget Limit Resolution

Located in `safeguards/config.ts`. `resolveBudgetLimits(overrides?)`:

Merges user-provided overrides with `DEFAULT_BUDGET_LIMITS`, returning complete `LoopBudgetLimits`.

---

## Integration Points

### Session Wiring

`LoopManager` is constructed in the session setup and attached to the tool session. It receives:
- `cwd` -- Working directory
- `settings` -- Session settings (model roles, auto-approve timeout)
- `roleResolver` -- For LLM model selection
- `reviewer` -- For LLM review gate execution
- `eventBus` -- For dashboard and UI event publishing
- `concurrencyLimit` -- Max simultaneous active loops (default: 2)

### Tool Registration

In `tools/index.ts`, loop tools are conditionally registered:

```typescript
// Loop tools registered only when LoopManager is available
loop_prepare: loopManager ? new LoopPrepareTool(loopManager) : undefined,
loop_launch: loopManager ? new LoopLaunchTool(loopManager) : undefined,
loop_done: loopManager ? new LoopDoneTool(loopManager) : undefined,

### Slash Command Dispatch

`loop-commands.ts` exports `executeLoopCommand(manager, text)`. It parses the input text into `command` and `args`, then calls `manager.handleCommand(command, args)`.

Supported commands: `start`, `pause`, `resume`, `status`, `list`, `kill`, `approve`, `reject`.

### Dashboard Bridge

Located in `dashboard-bridge.ts`. `LoopDashboardBridge`:

- `buildSnapshot(loopId)` -- Produces `LoopDashboardPayload` with loop state, child tree, gate results, pending gate info, auto-approve status
- `registerPanel(loopId, name)` -- Emits `shell:add_panel` event
- `unregisterPanel(loopId)` -- Emits `shell:remove_panel` event
- `subscribe(loopId, callback)` -- Listens on three EventBus channels:
  - `loop:{loopId}:state`
  - `loop:{loopId}:iteration`
  - `loop:{loopId}:gate`
- `handleControl(payload)` -- Dispatches UI actions: `pause`, `resume`, `approve`, `reject`, `toggle-auto-approve`, `kill`

### Prerequisites

Located in `config/loop-prerequisites.ts`. `validateLoopPrerequisites(settings)`:

Checks that `settings.getModelRole('review')` returns a truthy value. Returns `{ ok, missing[], message }`. Called before loop start and by `LlmSwitcher` for the review role.

### Ingestion

Located in `ingestion/`. Pre-start validation pipeline:

1. `parseSpecDirectory(rootDir)` -- Collects `.org` files, extracts `CUSTOM_ID` and `[[id:]]` links
2. `validateParsedSpecs(parsed)` -- Checks for missing/duplicate IDs, broken links
3. `evaluateLoopReadiness(parsed, settings, domains)` -- Validates specs, model, domains, gates. Returns `LoopReadinessResult` with required and advisory checks:
   - Required: spec-validation, review-model, domain-guidelines, gates-defined
   - Advisory: acceptance-criteria, effort-estimates, dependencies

---

## Replay and Debug

### replayLoopState

Located in `replay/replayer.ts`. Reads the event log and replays events up to an optional iteration number, returning the reconstructed `LoopSnapshot`.

### formatLoopTimeline

Located in `replay/formatter.ts`. Formats events as tab-separated rows: `timestamp\ttype\tpayload`. Used for debug output.

### formatLoopStatus

Also in `replay/formatter.ts`. Produces a condensed status string with state, iteration, and elapsed time.

### handleLoopDebugCommand

Located in `replay/commands.ts`. Reads the event log, optionally filters by a `typeFilter` substring, and returns `formatLoopTimeline()` output.

### handleLoopReplayCommand

Also in `replay/commands.ts`. Replays to a specific iteration via `replayLoopState()` and returns `formatLoopStatus()`.

---

## Constants Reference

All constants from `constants.ts`:

| Constant | Value | Description |
|---|---|---|
| `LOOP_SCHEMA_VERSION` | `"1.0.0"` | Schema version stamped on every `LoopEvent` |
| `DEFAULT_LOOP_MAX_ITERATIONS` | `200` | Maximum iterations before forced validation |
| `DEFAULT_LOOP_REFLECT_EVERY` | `3` | Reflect every N iterations |
| `DEFAULT_LOOP_DEPTH_LIMIT` | `4` | Maximum child loop nesting depth |
| `DEFAULT_LOOP_CONCURRENCY_LIMIT` | `2` | Maximum simultaneously active loops |
| `DEFAULT_HUMAN_GATE_TIMEOUT_MS` | `300000` (5 min) | Auto-approve timeout for human gates |
| `DEFAULT_BUDGET_LIMITS.wallClockMs` | `14400000` (4 hours) | Maximum wall-clock time per loop |
| `DEFAULT_BUDGET_LIMITS.maxTreeIterations` | `200` | Maximum iterations across loop tree |
| `DEFAULT_BUDGET_LIMITS.maxIdleIterations` | `5` | Consecutive no-progress iterations before stall |

### Registry Constants

From `loop-registry.ts`:

| Constant | Value | Description |
|---|---|---|
| `ACTIVE_STATES` | `{planning, iterating, reflecting, validating}` | States counted toward concurrency limit |

### Manager Constants

From `loop-manager.ts`:

| Constant | Value | Description |
|---|---|---|
| `DEFAULT_CHILD_POLICY` | `{ policy: "retry", retries: 2 }` | Default failure policy for child loops |
| `WORKTREE_BASE` | `".local/!tracks/worktrees"` | Base directory for git worktrees |

### Gate Defaults

From `gates/config.ts`:

| Default | Value | Description |
|---|---|---|
| `maxAttempts` | `1` | Default gate execution attempts |
| `priority` | `0` | Default gate priority (lower = earlier) |
