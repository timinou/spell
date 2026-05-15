Kernel observability. Read-only.

call ::= status { command, file? }

<commands>
| command       | shows                                              |
|---------------|----------------------------------------------------|
| languages     | loaded tree-sitter grammars + load state           |
| index         | code-graph indexing state (gates def→/ref→/call→)  |
| watcherStatus | FS watcher health + queue                          |
| lockStatus    | per-file lock ownership + waiters                  |
| status        | overall resolver + dialect registry snapshot       |
</commands>

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
