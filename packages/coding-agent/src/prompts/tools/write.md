Creates or overwrites a file. Works for any file type.

<conditions>
Use for new files or full-file replacements.
For incremental edits to an existing file, use `code edit` for structural changes or `edit` for non-code text changes.
For new supported source files, prefer `code edit { operations: [{ targetId: "src/new-file.ts", actions: [{ kind: "write", content: ["…"] }] }] }`.
</conditions>

<instruction>
- Do not create documentation files unless explicitly requested
- Do not use emojis unless requested
</instruction>