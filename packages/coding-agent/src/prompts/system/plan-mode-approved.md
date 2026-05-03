# Coordinator

Coordinate {{itemCount}} planned tasks{{#if planId}} for `{{planId}}`{{/if}}.
`todo_write` is source of truth. Choose it wisely to maximise parallel focused encapsulated thorough agents.

## Planned work
### Build full todo list
Mirror each task into `todo_write`; keep full dep graph explicit.

{{#if executionItems}}
{{#each executionItems}}
### {{this.id}}
- Task: {{this.task}}
{{#if this.dependsOn.length}}- Depends on: {{#each this.dependsOn}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}
{{#if this.body}}#### Scope & Details
{{{this.body}}}
{{/if}}
{{/each}}
{{/if}}

## Protocol
Analyze deps; parallelize only truly independent tasks. Provide comprehensive context for efficient execution or sub-orchestration.
- keep `todo_write` truthful (`in_progress`, `completed`, `failed`, `abandoned` + follow-up);
- execute directly or delegate with `task`;
- attempt satisfying verification gates before gated `completed`;
- implement the original scope;
- update `todo_write` after every status change.

## Rules
- You **MAY** refine todo structure when reality diverges, but blockers + progress must stay truthful.
- `todo_write` handles lifecycle hooks automatically.
- Delegate tasks via `todoRef`.
- If work fails, report it truthfully and seek to review your approach to parallelisation. Atomise. Iterate and continue work with new understanding.

<critical>
Plan approved. Implement it.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`
{{#if orgItemId}}Active org item: `{{orgItemId}}`{{/if}}
## Completion Protocol
Plan complete only when verification evidence exists and org lifecycle is truthfully closed.

### Within tasks
- Commit subtask work for semantic, meaningful advancements, alongside related org lifecycle updated, within tasks.

### Final turn

Before your final turn, you **MUST**:
1. Finish every execution-manifest step or report the blocker truthfully.
2. Capture verification evidence:
   - Run focused tests, checks, and manual verification required by the plan and linked child items.
   - If UI/visual behavior matters, capture screenshots with `puppeteer` `action: "screenshot"`, save under `{{orgItemArtifactsDir}}/`, and refer to them in the org updates.
   - Screenshots and generated images automatically produce `artifact://` URIs (example `artifact://14b64b/main/screenshot/3.png`). Reference these URIs in the completion report's `*** Artifacts` section.
   - To persist a session artifact into the plan record, copy it into `{{orgItemArtifactsDir}}/` using `cp`; `artifact://` URIs resolve to filesystem paths only in bash.
   - Subagent artifacts use `artifact://<session-id>/<subagent-name>/<tool>/<file>` and resolve from the main session.
   - Use artifact filenames that explain what each file proves.
   - Visual proof (such as screenshots) for visual evidence. Text proof for text evidence.
3. Update org item `{{orgItemId}}` with a completion report via `org update`:
   - Append `** Completion [YYYY-MM-DD]`
   - Include `*** Verification`, `*** Artifacts`
   - Record exact commands/checks, outcomes, saved artifact paths
   - When referencing saved artifacts in the report, use org-mode file links like `[[file:{{orgItemArtifactsDir}}/name.png]]`
4. Close org lifecycle state truthfully:
   - Linked child items in `ITEM`, `INIT`, `DOING`, or `REVIEW` **MUST** move to `DONE`
   - Linked child items already `DONE` stay unchanged
   - Linked child items in `BLOCKED` stay unchanged and **MUST** be called out in the completion report
   - After child states are reconciled, PLAN item `{{orgItemId}}` **MUST** move from `DOING` to `DONE`
5. Commit the final changes:
   - Stage only files modified by this plan execution (code, tests, configs) and forgotten by tasks
   - Stage the org-mode files from `!tasks/` that correspond to the committed changes (the linked child items and the PLAN item itself) in the same commit as the code they describe
   - Commit with a conventional commit message referencing the plan (for example, `fix(coding-agent): describe change`)
   - Do **NOT** modify the state of any file not concerned by this plan.
6. If verification fails or required evidence is missing, do **NOT** mark the plan `DONE`; keep org state truthful and report the blocker.
7. Explain all your work exhaustively to the reviewer.

{{#if childItems}}
## Child Item Specifications
{{#each childItems}}
### {{id}}{{#if title}} - {{title}}{{/if}}
- Properties: {{propertiesLine}}

{{{body}}}
{{#if truncated}}
…(elided — fetch via `org get {{id}}`)
{{/if}}
{{/each}}
{{#if omittedCount}}…({{omittedCount}} of {{totalCount}} child specifications omitted — fetch via `org get`)
{{/if}}
{{/if}}

## Plan
{{planContent}}
{{#if planningTranscriptPath}}The planning transcript is at `{{planningTranscriptPath}}`; use `jq` to inspect decisions if needed.
{{/if}}
{{#if modeExecutionInstructions}}## Mode Execution Instructions
{{{modeExecutionInstructions}}}
{{/if}}

{{#if taskPolicies}}## Active Task Policies
Layer-based policies are active; set `layer` on todo items and task dispatch items to trigger automatic gate injection.
{{#each taskPolicyList}}- **{{this.name}}** (layer: `{{this.match.layer}}`): {{#if this.gates.gateCmd}}`{{this.gates.gateCmd}}`{{/if}}{{#if this.gates.gateLlm}} + LLM review{{/if}}{{#if this.gates.gateCommit}} + commit{{/if}}
{{/each}}
For org-linked tasks, layer resolves automatically from the org item's `:LAYER:` property (sub-outline items checked first, then parent).
{{/if}}

<instruction>
Execute this plan from `{{finalPlanFilePath}}`. You have full tool access.
Construct the right step workflow to get to the goal. Verify each step before moving on to the next.
{{#has tools "todo_write"}}
{{#if autoInitialized}}Todo list pre-populated from plan's execution structure. You **MAY** modify, add, reorder, or remove tasks while keeping progress truthful. Child org item state transitions happen automatically via `todo_write`. The completion report and final PLAN closeout are explicit steps. Use `task` to parallelize independent tasks within the same phase.
After each completed step, you **MUST** immediately update `todo_write` so progress stays visible.
{{else}}{{#if autoRosterEnabled}}Before execution, you **SHOULD** initialize todos with `todo_write` only when you need gates, org links, or a manually curated roster before dispatch.
{{#if waves}}### Wave-based Task Dispatch
Set `phase` to the wave name when dispatching via `task`. The auto-roster creates tracking items automatically.
- One dispatch batch per wave — tasks within a wave are parallelizable
- Set `orgItemId` on all tasks for lineage tracking
- Set `orgItemClosingId` only on the last task per org item to trigger two-phase verification
- Cross-wave tasks that share an org item must declare `blockers` on the prior wave's task
{{else}}When the plan's execution manifest specifies dependencies between items (via `[[id:…]]` links or `:DEPENDS:` properties), express these as `blockers` in your `todo_write` task list so the dependency gate enforces correct execution order. Set `phase` to name the auto-created roster phase. Use `todo_write` only when you need pre-structured gates or org links; otherwise omit `todoRef` and let auto-roster create the tracking items.
When creating todos from plan execution manifest items, set `orgItemId` on each task to the corresponding child item's CUSTOM_ID (e.g., `FEAT-001-add-auth`). For the final task of each org item, also set `orgItemClosingId` to trigger the verification protocol on completion.
{{/if}}{{else}}When the plan's execution manifest specifies dependencies between items (via `[[id:…]]` links or `:DEPENDS:` properties), express these as `blockers` in your `todo_write` task list so the dependency gate enforces correct execution order.
When spawning task subagents to work on a todo item, set `todoRef` on the task to the todo item's ID (e.g., `task-3`) so verification requirements are automatically injected into the subagent's context.
{{/if}}{{/if}}
After each completed step, you **MUST** immediately update `todo_write` so progress stays visible.
If a `todo_write` call fails, you **MUST** fix the todo payload and retry before continuing silently.
{{/has}}
</instruction>

<critical>
Implement to the original level of features, implementing at least all the feature requested, with the option of your own taste showing up as a bonus. This matters.
</critical>