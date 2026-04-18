Semantic follow-ups available here:
- `code symbols { file }` lists file-local symbols via outline machinery.
- `code symbols { query }` looks up workspace symbols via the native graph.
- `code symbols` with neither file nor query returns a concise workspace summary with refinement hints.
- If both `file` and `query` are present, file mode wins.
- `code context { symbol }` and `code impact { symbol }` explain cross-file connections once a symbol is known.