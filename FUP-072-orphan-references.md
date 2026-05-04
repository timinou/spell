# FUP-072: Orphan References to Legacy Tools After PLAN-296

PLAN-296 removes 8 legacy tools (`code`, `read`, `find`, `grep`, `ast-grep`, `ast-edit`, `edit` from `patch/`, `write`) and replaces them with 4 generic tools (`get`, `edit`, `manage`, `create`).

This document catalogs **non-trivial orphan references** that remain in docs, specs, prompts, configuration, and runtime code after the legacy tool files are deleted. Historical task records (`!tasks/`) and the legacy tool files themselves are excluded.

## 1. Documentation (`docs/`)

| File | Reference | Action |
|---|---|---|
| `docs/resolve-tool-runtime.md` | `ast_edit` cited as built-in producer example (lines 36-41) | Update example to use `edit` preview/apply flow |
| `docs/spell-server/telegram-bridge.md` | Tool modes list `read`, `grep`, `find`, `ast_grep`, `edit`, `write`, `ast_edit` (lines 45-51) | Rewrite tool lists to use `get`, `edit`, `manage`, `create` |

## 2. Specifications (`specs/`)

| File | Reference | Action |
|---|---|---|
| `specs/system-prompt-rewrite.md` | Template conditionally renders `ast_grep` / `ast_edit` guidance (lines 257-262) | Update template to reference `get` (ast_grep action) and `edit` |
| `specs/clojure-code-tool-first-party-integration.md` | `ast_grep lang=clojure` in acceptance checklist (lines 902, 1145) | Update to `get` with `ast_grep` action |
| `specs/rust-ast-editing-research.md` | `language.ast_grep(source)` — Rust library API, not our tool (line 193) | Verify whether this is a false positive; likely okay |

## 3. Agent Prompts (`packages/coding-agent/src/prompts/agents/*.md`)

Multiple agent frontmatters list legacy tool names in `tools:` metadata:

- `aphrodite.md` — `read`, `grep`, `find`
- `athena.md` — `read`, `grep`, `find`
- `daedalus.md` — `read`, `grep`, `find`, `ast_grep`
- `librarian.md` — `read`, `grep`, `find`, `ast_grep` (also body text line 90)
- `metis.md` — `read`, `grep`, `find`, `ast_grep`
- `momus.md` — `read`, `grep`, `find`, `ast_grep`
- `oracle.md` — `read`, `grep`, `find`, `ast_grep`
- `plan.md` — `read`, `grep`, `find`, `ast_grep`
- `reviewer.md` — `read`, `grep`, `find`, `ast_grep`

**Action:** Replace with `get` (and specific actions) and `edit`.

## 4. Tool Prompts (`packages/coding-agent/src/prompts/tools/`)

| File | Reference | Action |
|---|---|---|
| `bash.md` | Conditional examples for `ast_edit` and `ast_grep` (lines 25-26) and mandate lines for `ast_grep`/`ast_edit` | Update examples to use `edit` and `get` |

## 5. Mode Definitions (`packages/coding-agent/src/modes/builtins/`)

| File | Reference | Action |
|---|---|---|
| `explore/MODE.md` | Lists `grep`, `find`, `ast_grep` as read tools; lists `write`, `edit`, `ast_edit` as blocked writes | Replace with `get` for reads, `edit`/`create` for blocked writes |

## 6. Configuration (`packages/coding-agent/src/config/`)

| File | Reference | Action |
|---|---|---|
| `settings-schema.ts` | `astGrep.enabled` and `astEdit.enabled` boolean settings (lines 1095-1105) | Remove or remap to generic tool settings |

## 7. Runtime Code (non-test, non-legacy)

| File | Reference | Action |
|---|---|---|
| `orchestrators/canvas-task-manager.ts` | `DEFAULT_TOOLS` includes `read`, `grep`, `find`, `edit`, `ast_grep`, `ast_edit` (line 31) | Replace with `get`, `edit`, `manage`, `create` |
| `session/spill-policy.ts` | `PRECISION_SPILL_EXEMPT_TOOLS` includes `read`, `grep`, `find`, `code`, `ast_grep`, `ast_edit` (lines 37-44) | Update to new tool names |
| `sdk.ts` | Re-exports `FindTool`, `GrepTool`, `ReadTool`, `WriteTool` from `./tools` (lines 121-122) | Remove legacy re-exports or redirect to generic equivalents |
| `task/index.ts` | Imports `isCodeToolSupportedPath` from `../tools/code-supported-files` (line 30) | Verify if still needed; may be obsolete |
| `extensibility/hooks/types.ts` | Imports `FindToolDetails`, `GrepToolDetails`, `ReadToolDetails` from `../../tools` (line 24); defines `ReadToolResultEvent` (line 480) | Move types to generic tool modules or remove |
| `extensibility/extensions/types.ts` | `FindToolDetails` (lines 46-47) | Update import source |
| `modes/components/read-tool-group.ts` | `ReadToolSuffixResolution`, `ReadToolResultDetails` (lines 14, 19) | Rename to generic read-group types |
| `modes/components/subagent-viewer/event-handler.ts` | `ReadToolGroupComponent` import (line 5) | Rename component |
| `modes/controllers/event-controller.ts` | `ReadToolGroupComponent` import (line 6) | Rename component |
| `modes/utils/ui-helpers.ts` | `ReadToolGroupComponent` import (line 11) | Rename component |

## 8. Additional Source References (inside legacy tool files)

The following files are **themselves** scheduled for deletion in PLAN-296; references inside them are not counted as orphans:
- `packages/coding-agent/src/tools/ast-edit.ts`
- `packages/coding-agent/src/tools/ast-grep.ts`
- `packages/coding-agent/src/tools/code.ts`
- `packages/coding-agent/src/tools/find.ts`
- `packages/coding-agent/src/tools/grep.ts`
- `packages/coding-agent/src/tools/read.ts`
- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/patch/index.ts` (legacy edit)

However, `tools/index.ts` (the registry) still imports and exports all legacy tools. That registry update is tracked under PLAN-296 separately.

## Acceptance Criteria for This FUP

- [ ] All docs/specs references updated to generic tool names
- [ ] All agent and tool prompts updated
- [ ] `settings-schema.ts` no longer references `astGrep`/`astEdit`
- [ ] `canvas-task-manager.ts` `DEFAULT_TOOLS` uses new names
- [ ] `spill-policy.ts` exempt list uses new names
- [ ] `sdk.ts` no longer re-exports legacy tool classes
- [ ] `extensibility/hooks/types.ts` imports resolved
- [ ] `modes/components/read-tool-group.ts` and consumers renamed/updated
