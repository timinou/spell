## Quick Reference

**Tool precedence (PLAN-296):**
- Code files: `get` (read/outline), `edit` (structural mutations), `manage` (save/undo/diff)
- Non-code files: `get` with `read` action, or `read` tool via `get`
- Full-file write: `create`
- Structural edits: `edit`

**PLAN-296 cutover:** Legacy 8 tools (`code`, `read`, `find`, `grep`, `ast-grep`, `ast-edit`, `edit` from `patch/`, `write`) are removed. Use the 4 generic tools (`get`, `edit`, `manage`, `create`) instead.
