# Plan Mode Prompt Guidance 2026

## Goal

Re-shape plan mode so plans remain high-context and full-resolution, but execution surfaces become implementation-first: child items and PLAN manifests must tell a fresh execution agent exactly what to do, in what order, and how to verify it.

## Scope

In scope:
- `packages/coding-agent/src/prompts/system/plan-mode-active.md`
- `packages/coding-agent/src/prompts/system/plan-mode-approved.md`
- `packages/coding-agent/src/prompts/system/plan-mode-subagent.md`
- related prompt/render/test surfaces that define plan validation and execution handoff
- planner orchestration guidance across `org`, `exit_plan_mode`, `todo_write`, and `task` usage

Out of scope:
- changing the org storage model itself
- removing rationale/context sections from plans
- reducing resolution of any section

## Primary Sources

2026 / official / primary-weighted inputs used for this spec:
- OpenAI, GPT-4.1 Prompting Guide — explicit planning, tool usage, persistence reminders, prompt placement
- OpenAI Prompt Engineering guide — authority layers, eval-driven prompt iteration, reusable prompts
- Anthropic, 2026 Agentic Coding Trends Report — engineers as orchestrators; long-running agent teams need high-quality supervision artifacts
- Liu et al. 2026, *From Plan to Action: How Well Do Agents Follow the Plan?* — standard plans help; periodic reminders help; bad plans hurt; extra misaligned phases can degrade outcomes
- Ghoshal & Al-Bustami 2026, *When Do Tools and Planning Help LLMs Think?* — planning/tooling must be task-shaped and cost-aware

## Current Repo Surfaces

### Prompt / mode surfaces
- `packages/coding-agent/src/prompts/system/plan-mode-active.md`
- `packages/coding-agent/src/prompts/system/plan-mode-approved.md`
- `packages/coding-agent/src/prompts/system/plan-mode-subagent.md`
- `packages/coding-agent/src/modes/definitions/plan.md`
- `packages/coding-agent/src/prompts/system/system-prompt.md`
- `packages/coding-agent/src/prompts/system/eager-todo.md`

### Validation / tests
- `packages/coding-agent/src/tools/exit-plan-mode.ts`
- `packages/coding-agent/test/tools/exit-plan-mode-validation.test.ts`
- `packages/coding-agent/test/tools/exit-plan-mode.test.ts`
- `packages/coding-agent/test/tools/exit-plan-mode-waves.test.ts`
- `packages/coding-agent/test/plan-mode/plan-mode-approved-prompt.test.ts`
- `packages/coding-agent/test/prompts/plan-mode-tdd.test.ts`
- `packages/coding-agent/test/system-prompt-templates.test.ts`

### Orchestration surfaces
- `packages/coding-agent/src/prompts/tools/todo-write.md`
- `packages/coding-agent/src/prompts/tools/task.md`
- `packages/coding-agent/src/tools/todo-write.ts`

## Diagnosis: why recent plans skew toward findings over implementation

### Observed bias
1. Child-item bodies are forced to contain `Implementation`, but PLAN items are only forced to contain `Context`, `Verification`, and `Execution Manifest`.
2. The active prompt strongly emphasizes self-contained context, decisions, findings, and fresh-session handoff quality. That is good, but PLAN-level execution instructions are under-specified relative to that context burden.
3. The PLAN-writing guidance says `Recommended approach only` + `Critical file paths` + `Verification` + manifest links; it does not force step-by-step implementation headings at PLAN level.
4. The subagent prompt for plan work ends with `Critical Files for Implementation`, which biases investigation summaries toward file identification rather than explicit execution sequencing.
5. Recent plan artifacts show dense rationale/context sections and short execution manifests. The manifests identify work, but often do not provide enough procedural guidance for a fresh execution agent.

### Root cause
- Structure exists, but the strongest constraints apply to child-item metadata correctness, not to PLAN-level implementation sequencing.
- Validation currently checks for body size, properties, child links, `CUSTOM_ID`, `DEPENDS`, namespace correctness, and acyclic graphs. It does not require PLAN-level implementation headings or executable TODO-outline steps.
- Planning prompts optimize for correctness of decomposition more than usability of handoff.

## Settled Design Decisions

1. Preserve full-resolution `Scope`, `Existing Patterns`, `Tests`, `Implementation`, `Edge Cases`, and rationale sections. No section gets shortened or dropped.
2. Keep plans balanced: findings/rationale stay explicit, but execution manifest and implementation sub-steps must dominate handoff usability.
3. Every implementation sub-step heading inside child items uses TODO-outline form with `ITEM`, e.g. `** ITEM Define TypeScript interfaces`.
4. PLAN items must evolve from link registries into implementation guides: keep `* Context` and `* Verification`, but add explicit plan-level implementation headings that explain how to execute the child DAG.
5. Prompt text, tests/validation, and planner orchestration surfaces all change in the same initiative. No prompt-only partial fix.
6. Changes must remain org-native. `org wave`, `CUSTOM_ID`, `DEPENDS`, `todo_write`, and `task` stay canonical.

## Target Behavior

A good final plan after this initiative should let a fresh execution agent answer all of these without re-deriving intent:
- What changed?
- What are the exact workstreams?
- Which files / tests belong to each workstream?
- What order do I execute them in?
- What are the first concrete edits?
- What verification gates close each workstream?
- What failure modes or replan triggers must I watch for?

## Recommended Changes

### 1. `plan-mode-active.md`
Add / strengthen:
- explicit distinction between `research context` and `execution instructions`
- PLAN-level requirement for implementation headings beyond `Execution Manifest`
- instruction that PLAN `Context` records findings, while PLAN implementation headings record how to execute those findings
- rule that wave sections are not enough by themselves; each wave entry must be paired with executable notes or delegated task instructions
- stronger anti-pattern callout: a plan that only summarizes findings is incomplete even if decomposition is correct
- explicit requirement that child-item implementation headings use `ITEM` TODO keyword

### 2. `plan-mode-approved.md`
Add / strengthen:
- interpret plan artifact as instruction source, not just a tracking artifact
- require execution agent to consume PLAN-level implementation headings before dispatching work
- wire todo/task orchestration to plan sub-outline IDs and verification steps, not just wave headings
- keep rationale visible, but prioritize direct execution instructions when there is tension

### 3. `plan-mode-subagent.md`
Add / strengthen:
- require planning subagents to report not only critical files, but also `Implementation Outline` / `Execution Risks` / `First Edits`
- avoid summaries that stop at architecture findings
- preserve read-only nature

### 4. Validation / tests
Extend validation to catch missing execution usability, not just missing structure:
- child sub-step headings missing `ITEM` keyword
- PLAN item missing explicit implementation-oriented headings or equivalent execution instructions
- manifests that only link items but omit execution notes when required by the new contract
- prompt rendering tests that assert balanced guidance remains present
- regression tests using thin-context / rich-context plan fixtures to prove execution usability

### 5. Orchestration surfaces
Align:
- `todo_write` examples with wave + sub-outline execution semantics
- `task` prompt guidance so delegated work inherits exact execution details, not just abstract child-item IDs
- eager todo and approved-plan prompts so roster creation mirrors the implementation DAG truthfully

## Proposed PLAN-Level Shape

Required PLAN headings after this initiative:
- `* Context`
- `* Verification`
- `* Implementation Strategy`
- `* Execution Manifest`

Recommended contents:
- `Context` → findings, decisions, rationale, source-backed constraints
- `Verification` → exact commands, artifacts, manual proofs
- `Implementation Strategy` → step-by-step operator guidance for the execution agent; how to traverse waves, when to parallelize, where to update prompts/tests/orchestration together
- `Execution Manifest` → `:wave:` headings with `[[id:...]]` links and dependency notes

## Proposed Child-Item Shape

Inside `* Implementation`, every sub-step heading should look like:

```org
** ITEM Write prompt rendering tests
 :PROPERTIES:
 :CUSTOM_ID: PROJ-001::prompt-tests
 :DEPENDS: PROJ-001::define-contract
 :LAYER: test
 :END:
- File(s): packages/coding-agent/test/system-prompt-templates.test.ts
- Scenarios: assert ITEM TODO headings; assert PLAN-level implementation guidance; assert balanced rationale persists.
```

## Acceptance Criteria for the implementation initiative

1. Planning prompts explicitly distinguish research context from execution instructions.
2. Child-item implementation sub-steps require `ITEM` TODO headings and continue to require `CUSTOM_ID` / `DEPENDS`.
3. PLAN-level guidance requires explicit implementation-oriented headings in addition to wave manifests.
4. Prompt tests cover the new wording and fail if plan mode regresses to findings-only output.
5. Exit / validation tests cover the new TODO-outline and execution-guidance invariants.
6. Approved-plan / orchestration prompts route execution through the new implementation contract without dropping rationale context.
7. A fresh execution agent can act from the PLAN artifact without reconstructing missing steps from context sections alone.

## Notes for org planning

When turning this spec into org items:
- use separate child items for prompt contract, validation/tests, and orchestration handoff
- keep scopes non-overlapping
- reference this spec from each child item
- ensure every implementation sub-step heading uses `ITEM`
- include wave-level execution notes in the PLAN item, not only links
