# `task` tool — templates & worked example

Extended reference for the `task` dispatch tool. The operational contract
(fields, recipes, DAG rules) lives in the tool description itself
(`packages/coding-agent/src/prompts/tools/task.md`); this file holds the
authoring templates and a worked example.

## Context template (batch `context`)

```
## Goal       ← one sentence
## Non-goals  ← what no task may touch
## Constraints← MUST/MUST NOT, session decisions, conventions
## Contract   ← exact types/signatures if tasks share an interface
## Acceptance ← global done-condition (you verify post-join)
```

## Assignment template (per-task `assignment`)

```
## Target  ← exact paths, named symbols, explicit non-goals
## Change  ← add/remove/rename; APIs & patterns to use
## Edge    ← tricky inputs, behavior that must survive
## Accept  ← observable proof the task is done
```

## Worked example

Rename `parseConfig`→`loadConfig`. Two disjoint file-sets, no blocker between them.

```yaml
context: |
  ## Goal      Rename parseConfig → loadConfig across config module + callers.
  ## Non-goals No behavior/signature change. Rename only.
  ## Acceptance Orchestrator runs `bun check:ts` after both join. Tasks must NOT.

tasks:
  # ref is REQUIRED on every task — use null when there is no todo/org linkage
  - id: RenameExport
    ref: null
    description: rename the export
    assignment: |
      ## Target  src/config/parser.ts — exported fn `parseConfig`. Non-goal: callers, tests.
      ## Change  rename decl + JSDoc. If src/config/index.ts re-exports it, update there too.
      ## Edge    overloads → rename all sigs. `_parseConfigValue` helper → leave. No compat alias.
      ## Accept  parser.ts exports `loadConfig`; `parseConfig` gone as top-level export.
  - id: UpdateCallers
    ref: null
    description: update import + call sites
    assignment: |
      ## Target  src/cli/init.ts, src/server/bootstrap.ts, src/worker/index.ts. Non-goal: parser.ts/index.ts (sibling task).
      ## Change  `import { parseConfig }`→`loadConfig`; every `parseConfig(`→`loadConfig(`.
      ## Edge    `cfg.parseConfig(…)` property access → update too. Doc strings → leave.
      ## Accept  zero bare `parseConfig` in the three files.
```
