Kernel observability. Read-only.

call ::= status { command, file? }

<commands>
|command|shows|
|---|---|
|languages|loaded tree-sitter grammars + load state|
|index|code-graph indexing state (gates def→/ref→/call→)|
|watcherStatus|FS watcher health + queue|
|lockStatus|per-file lock ownership + waiters|
|status|overall resolver + dialect registry snapshot|
|history|this session's edit history, newest-first (`file?` narrows)|
</commands>

<history>
`status { command: "history" }` lists every edit this session made, newest
first, across ALL workspaces it touched (one unified log per session). Each
entry: `id` (use for id-precise undo), `file`, `workspace`, `groupId` (edits
sharing one undo group, e.g. a cross-file rename), `reverted`, `committed`
(live git state — undo of a committed file declines unless forced), `commit`.
Payload also has `total` / `undoable` / `redoable` counts.
- inspect before undoing      → `status { command: "history" }`
- one file's edit timeline     → `status { command: "history", file: "src/app.ts" }`
- undo a SPECIFIC past edit     → take its `id` → `edit { operations: [{ target: "", action: { kind: "undo", id: "<id>" } }] }`
</history>

<when>
- graph queries return empty/error      → `status { command: "index" }`
- edit hits unexpected lock contention   → `status { command: "lockStatus" }`
- language not recognized                → `status { command: "languages" }`
- general "why does kernel disagree?"    → `status { command: "status" }`
</when>

<rules>
- read-only; no mutations
- undo/redo live in `edit` — `edit { operations: [{ target: "", action: { kind: "undo" }}] }`
- workspace diff lives in `find` — `find { target: "#diff" }`  (post-kernel-rebuild)
</rules>