## Tool Surface (PLAN-296)

The codebase cut over from 8 legacy tools to 4 generic tools:

| Legacy (removed) | Replacement |
|---|---|
| `code` | `get` (code action) + `edit` (structural) + `manage` (save/undo/diff) |
| `read` | `get` with `read` action |
| `find` | `get` with `find` action |
| `grep` | `get` with `grep` action |
| `ast-grep` | `get` with `ast_grep` action |
| `ast-edit` | `edit` with AST operations |
| `edit` (legacy `patch/index.ts`) | `edit` (native structural) |
| `write` | `create` (full-file write) |

**Tool precedence:**
- Code files: `get` (read/outline), `edit` (structural mutations), `manage` (save/undo/diff)
- Non-code files: `get` with `read` action
- Full-file write: `create`
- Structural edits: `edit`

Legacy tool files were deleted in PLAN-296. Update any lingering references in docs, prompts, and configuration.
