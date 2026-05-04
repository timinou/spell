Management commands for code buffers and workspace state: save, undo, redo, diff, buffers, languages, index, watcherStatus, lockStatus, status, context.

<instruction>
- `command` selects the operation:
  - `save` — persist all modified buffers to disk.
  - `undo` — revert the last edit transaction.
  - `redo` — re-apply the most recently undone transaction.
  - `diff` — show changes for a specific file or the whole workspace.
  - `buffers` — list open code buffers with dirty state.
  - `languages` — list registered tree-sitter languages and their load status.
  - `index` — trigger or report incremental index state.
  - `watcherStatus` — report file-system watcher health and state.
  - `lockStatus` — report lock ownership, queue, and timeout state for live edit contention.
  - `status` — show resolver health and dialect registry snapshot.
  - `context` — retrieve workspace context summary (open files, recent edits, active symbols).
- `file` is required for file-scoped commands (`diff`, `undo`, `redo`) and optional for global commands (`buffers`, `save`, `status`).
</instruction>

<output>
- Returns workspace state as a structured node list.
- `watcherStatus` and `lockStatus` include diagnostic metadata when unhealthy.
</output>

<examples>
```
manage { command: "save" }
manage { command: "diff", file: "src/server.ts" }
manage { command: "buffers" }
manage { command: "languages" }
manage { command: "index" }
manage { command: "watcherStatus" }
manage { command: "status" }
```
</examples>
