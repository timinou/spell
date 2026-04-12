Interacts with Language Server Protocol servers for code intelligence.

<operations>
- diagnostics: Get errors/warnings for file, glob, or workspace.
- definition: Go to symbol definition → file path + position + 3-line source context.
- type_definition: Go to symbol type definition → file path + position + 3-line source context.
- implementation: Find concrete implementations → file path + position + 3-line source context.
- references: Find references → locations with 3-line source context (first 50), remaining location-only.
- hover: Get type info and documentation → type signature + docs.
- symbols: List symbols in file, or search workspace with query and no file.
- rename: Rename symbol across codebase → preview or apply edits.
- code_actions: List quick-fixes/refactors/import actions; apply one when `apply: true` and `query` matches title or index.
- status: Show active language servers.
- reload: Restart the language server.
</operations>

<parameters>
- `file`: File path; for diagnostics it may be a glob pattern.
- `line`: 1-indexed line number for position-based actions.
- `symbol`: Substring on the target line used to resolve column automatically.
- `occurrence`: 1-indexed match index when `symbol` appears multiple times on the same line.
- `query`: Symbol search query, code-action kind filter, or code-action selector.
- `new_name`: Required for rename.
- `apply`: Apply edits for rename/code_actions.
- `timeout`: Request timeout in seconds, clamped to 5-60, default 20.
</parameters>

<caution>
- Requires running LSP server for target language.
- Some operations require file to be saved.
- Diagnostics glob mode samples up to 20 files per request to avoid long stalls.
- When `symbol` is provided for position-based actions, missing symbols or out-of-bounds `occurrence` values return an explicit error instead of silently falling back.
</caution>