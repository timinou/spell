# Subagent Envelope v2 — Structured Result Tree for Nested Delegation

> Full-reference design + implementation plan + ADR rationale
> Target: `packages/coding-agent/src/task/`
> Status: DESIGN (pre-implementation)
> Intended for fresh-session consumers (plan execution context is cleared).

---

## 0. Executive Summary

Nested subagent delegation works up to depth=3 today, but the *result envelope* collapses grandchild structure into truncated text. This spec specifies the shift from flat `SingleResult[]` to a tree of structured results with:

1. Canonical `SubagentOutcome` enum replacing 3 fragmented status enums (40+ call sites).
2. Structured `submit_result` passthrough preserving schema-shaped JSON, not re-serialized text.
3. Recursive `children: SingleResult[]` carrying grandchild results up the tree.
4. `agent://` URI on every result (already emitted); always populated even for inline-rendered small results.
5. Streaming bubble-up via `TASK_SUBAGENT_PROGRESS_CHANNEL` to TUI pipelines only (root LLM unchanged).
6. Spawn audit per result; rendered only on non-trivial outcomes (rejection, downgrade).

Cut over the `output: string` field completely; replace with `textPreview?: string` and `structuredResult?: unknown`. No fallback.

---

## 1. Current State (as observed)

### 1.1 Types

`packages/coding-agent/src/task/types.ts:207` — `SingleResult` is flat with 24 fields. Key field `output: string` carries the stringified textual form of child work. Structured `submit_result` data already exists at `extractedToolData.submit_result[]` on both `AgentProgress:203` and `SingleResult:240` but:

- It only carries the *direct child's* submit_result, never grandchild's.
- The envelope rendering at `task/index.ts:1876` truncates `r.output` to 5000 chars and ignores `extractedToolData` for the preview.
- Grandchild submit_result data is lost at the child's flattened output boundary.

`packages/coding-agent/src/task/types.ts:246` — `TaskToolDetails.results: SingleResult[]` is flat; no tree shape.

### 1.2 Status enums (3 fragmented + 1 composed display string)

- `AgentProgress.status` — `pending | running | completed | failed | aborted` — `types.ts:182`
- `AsyncJob.status` — `running | completed | failed | cancelled` — `async/job-manager.ts:17`
- `SwarmNodeStatus` — adds `gate_failed | abandoned` — `swarm-scheduler.ts:33`
- Display string — `completed | failed (exit N) | cancelled | merge failed` composed from exitCode + aborted + error — `task/index.ts:1868-1875`

40+ match sites reading these across: `task/index.ts`, `task/executor.ts`, `task/render.ts`, `task/swarm-scheduler.ts`, `async/job-manager.ts`, `internal-urls/jobs-protocol.ts`, `modes/components/subagent-viewer/viewer-component.ts`, `modes/fluid-mode.ts`.

### 1.3 Streaming

Two pipelines:

- **Pipeline 1 (LLM conversation):** child subprocess → `onProgress` callback → parent `TaskTool.updateProgress` → `progressMap` → `emitProgress()` → `onUpdate({content, details.progress})`. Root LLM sees aggregated progress for its direct children.
- **Pipeline 2 (TUI/display):** child subprocess → `emitProgressNow` → `options.eventBus.enqueue(TASK_SUBAGENT_PROGRESS_CHANNEL, payload)` → subscribers (`SubagentTracker`, `SubagentViewerComponent`, `CanvasTaskManager`).

Grandchild progress reaches Pipeline 2 only when `options.eventBus` is passed into nested `runSubprocess` calls. Currently `task/index.ts:1504` and `:1558` pass `eventBus: undefined` — grandchild events die at Pipeline 2 boundary.

### 1.4 Artifact URIs (already hierarchical)

`AgentOutputManager.allocate(id, { parentPrefix })` creates nested IDs: `0-Parent.0-Child.0-Grandchild`. Files at `{artifactsDir}/{id}.md`. Resolver: `AgentProtocolHandler` (`agent://`) supports `agent://<id>/foo/bar` JSON path extraction. `ArtifactProtocolHandler` handles `artifact://<session-id>/<agent>/<tool>/<number>.<ext>` scoped form.

`task/index.ts:1902` already emits `outputIds` array of `agent://{id}` per task result but only when `!r.aborted || r.output.trim()` — spotty policy. Not recursive to grandchildren.

### 1.5 What's already solved

- `SUBAGENT_WARNING_MISSING_SUBMIT_RESULT` + `hasSubmitResult` detection exists.
- `extractedToolData.submit_result[]` structurally preserved (`render.ts:296`).
- `formatTaskId` renders hierarchy as `0.0.0 Parent>Child>Grandchild`.
- `agent://` URIs resolve into nested artifact tree on disk.
- `TASK_SUBAGENT_PROGRESS_CHANNEL` exists; subscribers exist; only nested publishing is blocked.

---

## 2. Requirements

- **R1 — Tree shape.** Root LLM can navigate grandchild results without string-level guessing.
- **R2 — Enum unification.** One canonical outcome type replaces the three fragmented enums.
- **R3 — Streaming to TUI.** Grandchild progress reaches `SubagentTracker`, subagent viewer, and canvas panels during a run.
- **R4 — Spawn audit.** Policy rejections and downgrades surface structurally.
- **R5 — Output size management.** Small payloads inline in envelope (<5KB); large payloads via `agent://` URI.
- **R6 — Complete cutover, no shims.** `output: string` field removed. All 7 src + 14 test consumers migrate.
- **R7 — Cross-session resumability.** Spec is fresh-session-readable (this file).

---

## 3. Design

### 3.1 Canonical enum

```ts
// packages/coding-agent/src/task/types.ts

export type SubagentOutcome =
  // Active
  | "pending"
  | "running"
  // Successful terminal
  | "completed"
  | "completed-empty"      // ran, returned no submit_result and no output
  // Failure terminal
  | "failed"               // non-zero exit
  | "crashed"              // uncaught subprocess error
  | "timeout"              // exceeded max duration
  // User/system abort
  | "aborted"              // parent abort signal
  | "cancelled"            // user cancelled (async-specific synonym)
  // Structural failures (distinct from 'failed')
  | "policy-rejected"      // spawn denied by parent.spawns
  | "depth-capped"         // tool stripped due to maxRecursionDepth
  | "submit-result-missing" // ran clean but never called submit_result
  | "schema-invalid"       // submit_result produced invalid schema payload
  // Gate/workflow
  | "gate_failed"
  | "abandoned";
```

Semantic decisions:

- `aborted` vs `cancelled`: keep both. `aborted` = AbortSignal-driven (parent-down); `cancelled` = user-initiated (typically async job path).
- `completed-empty` vs `submit-result-missing`: former is no-op task; latter is expected-but-missed.
- `policy-rejected` and `depth-capped` are first-class structural failures (replacing current prose fallthroughs).

### 3.2 New SingleResult shape

Full TS defined in `packages/coding-agent/src/task/types.ts`:

- Identity unchanged (index, id, agent, agentSource, task, assignment, description, lastIntent).
- **New primary outcome field**: `outcome: SubagentOutcome`.
- Retain raw signals: `exitCode`, `error`, `aborted`, `abortReason`, `stderr`.
- **New content carriers**:
  - `structuredResult?: unknown` — schema-shaped `submit_result` payload.
  - `textPreview?: string` — bounded (<=2000 chars) human-readable preview.
  - `children?: SingleResult[]` — recursive grandchild tree.
- **URI handles**:
  - `resultUri: string` — `agent://{id}` (required; enforce ID allocation).
  - `transcriptUri?: string` — artifact://... when sessionFile exists.
- Telemetry unchanged (durationMs, tokens, modelOverride, sessionId, usage, outputMeta).
- Metadata unchanged (todoGroups).
- Isolation unchanged (outputPath, patchPath, branchName, nestedPatches).
- **New**: `spawnAudit?: SpawnAuditEntry`.
- Legacy bucket retained: `extractedToolData?: Record<string, unknown[]>`.
- **DELETED**: `output: string`, `truncated: boolean`, `transcriptPath?: string`.

`SpawnAuditEntry`:
- `requestedAgent: string`
- `parentSpawnPolicy: string` (raw CSV or `*`)
- `allowedAgents: string[]` (resolved allow-list)
- `granted: boolean`
- `reason?: string` (`policy-rejected` | `depth-capped` | `ok`)

### 3.3 AgentProgress alignment

Widen `AgentProgress.status` to `SubagentOutcome`. No other changes — progress is per-level, not tree-shaped. Grandchild progress reaches UI via Pipeline 2 (EventBus), not via parent's `AgentProgress`.

### 3.4 TaskToolDetails

- `results: SingleResult[]` — top-level only; children embedded recursively.
- `totalDurationMs`, `usage`, `progress` unchanged (progress aggregated across tree).
- `isolationDowngraded`, `isolationAutoCoerced` unchanged.
- `async.state` uses `SubagentOutcome`.
- **Removed**: `outputPaths?: string[]` — replaced by per-result `resultUri`.

### 3.5 Envelope rendering policy

`task-summary.md` template shape:

```
<task-summary>
  <header>{successCount}/{totalCount} outcomes{outcomeBreakdown} [{duration}]</header>
  <agent id=... agent=... outcome=...>
    <spawn-audit>...</spawn-audit>            only on non-trivial
    <structured>{inline JSON}</structured>    when <5KB
    <structured-ref>{resultUri}</structured-ref> otherwise; always include resultUri
    <preview>{textPreview}</preview>          if any
    <children count=N>
      <child id=... outcome=... uri=... />    per grandchild
    </children>
  </agent>
</task-summary>
```

Inline threshold: `structuredJson.length < 5000` → inline. Else emit `<structured-ref>` only. `resultUri` is always filled regardless.
`textPreview` bounded at 2000 chars; derived from subprocess rawOutput tail.

### 3.6 Streaming

Change: pass `options.eventBus` into nested `runSubprocess` calls at `task/index.ts:1504` and `:1558`. Single field name, no new plumbing.

Pipeline 1 (LLM) unchanged. Parent LLM continues to see its direct progress. Children/grandchildren appear in the tree only in the final envelope.

Pipeline 2 throttling: trust existing 100ms debounce in `SubagentTracker`. No new throttle. Reassess if TUI flood observed.

### 3.7 Spawn audit

Emit `spawnAudit` on every result. Rendering policy:
- Omit from envelope template when `granted && outcome != 'depth-capped'` (trivial success).
- Include always for `policy-rejected`, `depth-capped`, and any `!granted`.

### 3.8 URI emission policy

- `resultUri`: always populated when `result.id` exists (ID is always allocated pre-execution).
- `transcriptUri`: populated when `sessionFile` exists.
- No more conditional `outputIds` array — URIs are first-class on each result.

---

## 4. Migration

### 4.1 Consumer inventory (read-audit)

- `task/index.ts:413` — `#buildTodoResultSummary` `result.output.trim()` → `{output}` → migrate to `result.structuredResult` if object; else `result.textPreview ?? ""`.
- `task/index.ts:1876` — envelope preview `r.output.trim() || r.stderr.trim()` → `r.textPreview ?? r.stderr.trim()`.
- `task/render.ts:431` — TUI `renderOutputSection(result.output, ...)` → `renderOutputSection(result.textPreview ?? formatStructured(result.structuredResult), ...)`.
- `orchestrators/canvas-orchestrator.ts:149` — escalation output inline → `result.textPreview ?? JSON.stringify(result.structuredResult) ?? "No output."`.
- `task/template.ts:98` — predecessor context `result.output` → prefer `result.structuredResult`; fallback to `result.textPreview`.
- `task/subagent-tracker.ts` — signature hash → drop `output`; include `outcome + textPreview + id`.
- `BashResult.output` (different type, `tools/bash.ts` and `session/agent-session.ts`) — no change.

### 4.2 Test fixture migration (14 files)

- `test/helpers/fluid-test-data.ts:20`
- `test/orchestrators/fluid-drain.test.ts:12`
- `test/task/async-progress.test.ts:22`
- `test/task/auto-roster.test.ts:24`
- `test/task/child-phase-gate-propagation.test.ts:21`
- `test/task/gate-enforcement.test.ts:33`
- `test/task/isolation-downgrade.test.ts:20`
- `test/task/nested-isolation-default.test.ts:22`
- `test/task/plan-mode-tools.test.ts:44`
- `test/task/quick-task-scope.test.ts:33`
- `test/task/subagent-tracker.test.ts:28`
- `test/task/task-blockers.test.ts:22`
- `test/task/task-payload-validation.test.ts:22`
- `test/task/todo-ref-lifecycle.test.ts:21`
- `test/tools/canvas-task-tier.test.ts:57`

Migration per fixture: remove `output: "…"` and `truncated: false`; add `outcome: "completed"`, `resultUri: "agent://test-id"`, optional `textPreview`, optional `structuredResult`.

### 4.3 Enum site migration (FEAT-B, 40+ sites)

Mechanical widen-the-union:
- Union type members → `SubagentOutcome`.
- Existing `status === "completed"` matches stay compatible.
- New sites emit `policy-rejected`, `depth-capped`, etc.

Key transition files:
- `async/job-manager.ts:17,100-150` — fold `cancelled` + `aborted` semantics.
- `swarm-scheduler.ts:33-47,88-99` — `isTerminal` widens.
- `jobs-protocol.ts:100-108` — extend match set.
- `fluid-mode.ts:128-141` — mapping becomes redundant; delete.
- `subagent-viewer/viewer-component.ts:280-283` — widen status-match.

---

## 5. Edge cases

- **5.1 Partial tree on abort** — each subprocess emits `outcome: "aborted"` with whatever `structuredResult` captured. `children[]` carries partial results with own outcomes.
- **5.2 Grandchild submit_result >5KB** — inline threshold per-leaf; omitted structuredResult still has resultUri.
- **5.3 Depth-cap** — child runs but task tool stripped. `outcome: "depth-capped"`, `spawnAudit.reason = "depth-capped"`.
- **5.4 Schema-invalid submit_result** — `outcome: "schema-invalid"`, `structuredResult` = the invalid payload (for debugging), `error` = validation error text.
- **5.5 Streaming flood** — if observed (3-deep × 3 busy leaves → ~20-30 events/sec): fall back to depth-aware throttle. Not in scope for initial cutover.
- **5.6 Missing artifactsDir** — `resultUri` is required, not optional. Tests use stub `agent://test-id`.
- **5.7 Async path** — `AsyncJob.status` canonicalizes to SubagentOutcome; jobs-protocol handler returns outcome-aware response.

---

## 6. Testing

### 6.1 New unit tests

- `test/task/outcome-mapping.test.ts` — exitCode/aborted/error/hasSubmitResult → exact SubagentOutcome.
- `test/task/spawn-rejection.test.ts` — parent with `spawns: "explore"` tries to spawn `oracle` → `outcome: "policy-rejected"`, spawnAudit populated.
- `test/task/fanout-tree.test.ts` — 3 children × 2 grandchildren → `children[0].children.length === 2`.
- `test/task/abort-propagation.test.ts` — abort root mid-run → each level reports `outcome: "aborted"`.
- `test/task/missing-submit.test.ts` — subagent exits without submit_result → `outcome: "submit-result-missing"`.
- `test/task/large-payload-uri.test.ts` — structuredResult >5KB → envelope emits `<structured-ref>`, `agent://` resolves.
- `test/task/depth-cap.test.ts` — depth=maxRecursionDepth child has task tool stripped → `outcome: "depth-capped"`.
- `test/task/nested-progress.test.ts` — grandchild progress events reach subscriber via `TASK_SUBAGENT_PROGRESS_CHANNEL`.

### 6.2 Updated fixtures

14 files migrated per §4.2.

### 6.3 Post-cutover live probes (fresh session)

Copy the following into a prompt after the implementation lands:

```
The envelope v2 refactor shipped. Run these live probes to validate end-to-end:

1. Spawn one oracle subagent with assignment: read specs/subagent-envelope-v2.md lines 1-20, return via submit_result a JSON with {header_text, section_1_title}. Assert envelope contains <structured> block with parsed JSON.

2. Spawn a task parent with spawns=explore that tries to dispatch a reviewer grandchild. Expect envelope to show outcome=policy-rejected with spawnAudit populated.

3. Spawn a 3-level chain (task -> task -> oracle) where the oracle returns a 10KB structuredResult. Confirm inline threshold fires, agent:// URI present, and root can read agent://{oracle-id} to see full payload.

4. Spawn 3 task children, each spawning 2 oracle grandchildren (6 leaves). Confirm TaskToolDetails.results.length === 3 and results[0].children.length === 2.

5. Spawn a 2-deep chain, then abort via Ctrl+C during grandchild execution. Confirm partial tree with outcome=aborted at each level where propagation reached.

6. With task.maxRecursionDepth=2, spawn a 3-level chain. Assert the depth-2 agent's result has outcome=depth-capped and no children.

Report outcomes as a table: probe # | expected outcome | actual outcome | pass/fail.
```

---

## 7. ADR (rationale for contested decisions)

### ADR-1 — Complete cutover of `output` field

**Decision**: remove `output: string`; add `structuredResult?` + `textPreview?`.
**Alternatives**: keep-as-fallback (retains compat, adds ambiguity); rename to `textOutput` (still two text fields).
**Chose cutover**: semantic distinction is exactly what the envelope expresses. Preserving `output` re-muddies the waters.
**Cost**: 21 consumer migrations.

### ADR-2 — Large enum unification (40+ sites)

**Decision**: unify all three enums into `SubagentOutcome`.
**Alternatives**: envelope-only enum; AgentProgress + envelope only.
**Chose Large**: the 3-way fragmentation is the bug. Isolated fixes proliferate edge cases; `fluid-mode.ts:128-141` is pure boilerplate between enums.
**Cost**: ~40 call-site updates, mostly mechanical.
**Backout**: git revert of FEAT-B.

### ADR-3 — Streaming pipeline scope

**Decision**: Pipeline 2 (TUI) only; Pipeline 1 (LLM) unchanged.
**Rationale**: root LLM consumes the *final* envelope (structured + navigable). Live grandchild signals add conversation noise without decision utility.

### ADR-4 — Inline vs URI threshold

**Decision**: 5KB inline boundary.
**Rationale**: matches existing 5000-char output truncation boundary; compatible with median LLM context budgets.
**Escape hatch**: threshold is a single constant at `task/index.ts`.

### ADR-5 — `aborted` vs `cancelled` kept distinct

**Decision**: keep both in SubagentOutcome.
**Rationale**: existing idiom uses `aborted` for AbortSignal and `cancelled` for user-initiated async job halts.

### ADR-6 — Spawn audit always-emit, render conditional

**Decision**: populate `spawnAudit` on every result; template hides trivial success.
**Rationale**: easy to forget when needed; surfacing only for anomalies keeps envelope small.

---

## 8. Implementation plan (wave order)

- **Wave 1 — Types foundation (FEAT-A)**. Adds SubagentOutcome enum, new SingleResult shape, SpawnAuditEntry. TS will fail at all consumer sites (intentional — surfaces every migration).
- **Wave 2 — Enum cutover (FEAT-B), Executor propagation (FEAT-C), Streaming (FEAT-E)** — parallel.
  - FEAT-B mechanically replaces status matches across 40+ sites.
  - FEAT-C populates structuredResult + children + spawnAudit + resultUri from extractedToolData and subprocess result.
  - FEAT-E passes eventBus through to nested calls.
- **Wave 3 — Rendering (FEAT-D)**. Template + render.ts + summary builder. Depends on Wave 2.
- **Wave 4 — Consumer migration + test cutover (FEAT-F)**. Migrate 7 src consumers + 14 test fixtures. Add 8 new test files.

---

## 9. Out of scope

- Per-node cost/latency telemetry tree (deferred).
- New `inspect_agent` tool for tree navigation; LLM uses existing `read agent://...`.
- Performance optimization for deeply nested (>5) chains; assumed uncommon.
- Cross-session transcript replay of nested envelopes.
- Changes to `AgentOutputManager.parentPrefix` hierarchy semantics (already correct).

---

## 10. References

- Exploration artifacts (prior session):
  - `agent://5-MapSingleResult` — full inventory of SingleResult consumers.
  - `agent://6-MapProgressStreaming` — progress streaming pipeline.
  - `agent://7-MapStatusComposition` — status enum fragmentation map.
  - `agent://8-MapArtifactUris` — URI scheme and hierarchy.
- Prior depth-3 probe: task → task → oracle chain returned verbatim marker in 18.3s, proving delegation path works; envelope fidelity was the bottleneck.
- `memory://root/memory_summary.md` — repo-wide patterns (coding-agent package is primary target).