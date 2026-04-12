Launches subagents to parallelize workflows.

{{#if asyncEnabled}}
- Use `read jobs://` to inspect state; use `await` to wait until completion.
{{/if}}

Subagents lack your conversation history. Put every decision, file content, and user requirement they need in `context` or `assignment`.

{{#if swarmEnabled}}
{{SECTION_SEPERATOR "Swarm-aware delegation"}}
- Use `task://` and `data://` references in `context`, `assignment`, blockers, and org-linked metadata when work touches shared swarm state.
- Prefer concrete URIs for shared artifacts and cross-agent dependencies.
- Treat `data://` as passive artifacts and `task://` as executable work.
- If a reference is ambiguous or missing, say so instead of fabricating a placeholder.
- Include the exact URIs and blackboard pointers a successor needs.
{{/if}}

<parameters>
- `agent`: Agent type for all tasks
- `phase`: Optional phase name for the auto-created roster phase
- `context`: Shared background prepended to every assignment; keep it session-specific and lean
- `schema`: JTD schema for expected output; do not duplicate it in assignments
- `tasks`: Tasks to execute in parallel
  - `.id`: CamelCase identifier, max 32 chars
  - `.description`: UI display only
  - `.assignment`: Complete self-contained instructions; required unless `todoRef` is set
  - `.blockers`: Task IDs that must complete before this task starts
  - `.todoRef`: Existing todo item ID whose content/details become the assignment
- `isolated`: Run in isolated environment; returns patches; use when tasks edit overlapping files
</parameters>

{{#if autoRosterEnabled}}
Task dispatch auto-creates todo roster entries unless suppressed by `todo.enabled=false`, `task.autoRoster=false`, or agent frontmatter `roster: false`. Omit `.todoRef` to create new roster items automatically. Set `.todoRef` only when linking dispatched work to an existing structured todo item.
{{else}}
Auto-roster is disabled in this session. Use `.todoRef` when you want delegated work linked to todo items you created separately via `todo_write`.
{{/if}}

<critical>
- Do not duplicate shared constraints across assignments; put them in `context`
- Keep payloads lean; avoid long traces, logs, or large JSON in `context` or `assignment`
- For large payloads, write to `local://<path>` and pass the path in `context`
- Prefer `task` agents that investigate and edit in one pass
- Each task must touch at most 3–5 files; no globs or package-wide scope
</critical>

<parallelization>
|Sequential first|Then|Reason|
|---|---|---|
|Types/interfaces|Consumers|Need contract|
|API exports|Callers|Need signatures|
|Core module|Dependents|Import dependency|
|Schema/migration|App logic|Schema dependency|

Safe to parallelize: independent modules, isolated file-scoped refactors, tests for existing code.
</parallelization>

<templates>
**context:**
```
## Goal ← one sentence
## Non-goals ← what tasks must not touch
## Constraints ← MUST/MUST NOT rules and session decisions
## API Contract ← exact types/signatures if tasks share an interface
## Acceptance ← definition of done; build/lint runs after all tasks complete
```
**assignment:**
```
## Target ← exact file paths; named symbols; explicit non-goals
## Change ← what to add/remove/rename; patterns/APIs to use
## Edge Cases ← tricky inputs; behavior that must survive
## Acceptance ← observable result proving the task is done
```
</templates>

<checklist>
- `context` contains only session-specific info
- each `assignment` is self-contained and includes edge cases
- tasks are truly parallel
- file paths are explicit
- `schema` is set if structured output is expected
</checklist>

<example label="Rename exported symbol + update all call sites">
Two tasks with non-overlapping file sets. Neither depends on the other's edits.

<context>
## Goal
Rename `parseConfig` → `loadConfig` in `src/config/parser.ts` and all callers.
## Non-goals
Do not change function behavior, signature, or tests — rename only.
## Acceptance (global)
Caller runs `bun check:ts` after both tasks complete. Tasks must NOT run it.
</context>
<tasks>
  <task name="RenameExport">
    <description>Rename the export in parser.ts</description>
    <assignment>
## Target
- File: `src/config/parser.ts`
- Symbol: exported function `parseConfig`
- Non-goals: do not touch callers or tests

## Change
- Rename `parseConfig` → `loadConfig` (declaration + any JSDoc referencing it)
- If `src/config/index.ts` re-exports `parseConfig`, update that re-export too

## Edge Cases
- If the function is overloaded, rename all overload signatures
- Internal helpers named `_parseConfigValue` or similar: leave untouched
- Do not add a backwards-compat alias

## Acceptance
- `src/config/parser.ts` exports `loadConfig`; `parseConfig` no longer appears as a top-level export in that file
    </assignment>
  </task>
  <task name="UpdateCallers">
    <description>Update import and call sites in consuming modules</description>
    <assignment>
## Target
- Files: `src/cli/init.ts`, `src/server/bootstrap.ts`, `src/worker/index.ts`
- Non-goals: do not touch `src/config/parser.ts` or `src/config/index.ts` — handled by sibling task

## Change
- In each file: replace `import { parseConfig }` → `import { loadConfig }`
- Replace every call site `parseConfig(` → `loadConfig(`

## Edge Cases
- If a file spreads the import and calls `cfg.parseConfig(...)`, update the property access too
- String literals containing `parseConfig` are documentation — leave them
- If any file re-exports `parseConfig` externally, keep the old name via `export { loadConfig as parseConfig }` and add a `// TODO: remove after next major` comment

## Acceptance
- No bare reference to `parseConfig` remains in the three target files
    </assignment>
  </task>
</tasks>
</example>

{{#list agents join="\n"}}
### Agent: {{name}}
**Tools:** {{default (join tools ", ") "All"}}
{{description}}
{{/list}}