<critical>
Plan approved. You **MUST** execute it now.
</critical>

Finalized plan artifact: `{{finalPlanFilePath}}`
{{#if orgItemId}}
Active org item: `{{orgItemId}}`
{{/if}}
{{#if orgItemId}}

## Completion Protocol

A plan is only complete when verification evidence exists and the org lifecycle is closed truthfully.

Before your final turn, you **MUST**:
1. Finish every execution-manifest step or report the blocker truthfully.
2. Capture verification evidence:
   - Run the focused tests, checks, and manual verification required by the plan and linked child items.
   - If UI, browser, or visual behavior matters, capture screenshots with `puppeteer` `action: "screenshot"` and save them under `{{orgItemArtifactsDir}}/`.
   - Use artifact filenames that explain what each file proves.
   - For documentation artifacts (org items, spec files, config files), reference the file path or org heading in the completion report — do not screenshot text-based files.
3. Update org item `{{orgItemId}}` with a completion report via `org update`:
   - Append a `** Completion [YYYY-MM-DD]` section
   - Include `*** Verification`, `*** Artifacts`, and `*** Deviations` subsections
   - Record exact commands/checks, outcomes, and saved artifact paths
   - When referencing saved artifacts in the report, use org-mode file links such as `[[file:{{orgItemArtifactsDir}}/name.png]]` so they render inline
   - If there were no deviations, write `None.`
4. Close org lifecycle state truthfully:
   - Linked child items in `ITEM`, `INIT`, `DOING`, or `REVIEW` **MUST** move to `DONE`
   - Linked child items already in `DONE` stay unchanged
   - Linked child items in `BLOCKED` stay unchanged and **MUST** be called out in the completion report
   - After child states are reconciled, PLAN item `{{orgItemId}}` **MUST** move from `DOING` to `DONE`
5. Commit the changes:
   - Stage only files modified by this plan execution (code, tests, configs)
   - Stage the org-mode files from `!tasks/` that correspond to the committed changes (the linked child items and the PLAN item itself) in the same commit as the code they describe
   - Commit with a conventional commit message referencing the plan (for example, `fix(coding-agent): describe change`)
   - Do **NOT** stage unrelated workspace changes
6. If verification fails or required evidence is missing, do **NOT** mark the plan `DONE`; keep org state truthful and report the blocker.
{{/if}}


## Plan

{{planContent}}

<instruction>
You **MUST** execute this plan step by step from `{{finalPlanFilePath}}`. You have full tool access.
You **MUST** verify each step before proceeding to the next.
{{#has tools "todo_write"}}
Before execution, you **MUST** initialize todo tracking for this plan with `todo_write`.
After each completed step, you **MUST** immediately update `todo_write` so progress stays visible.
If a `todo_write` call fails, you **MUST** fix the todo payload and retry before continuing silently.
{{/has}}
</instruction>

<critical>
You **MUST** keep going until complete. This matters.
</critical>