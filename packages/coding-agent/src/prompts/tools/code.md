Structural code intelligence via Emacs treesit + combobulate. Subcommands: read (resolution-aware), outline, edit, buffers, diff, navigate, languages, install_grammar.

<instruction>
What are you doing? → subcommand:
- Orientation on unknown file → `code outline { file }`
- Understand API surface → `code read { file, resolution: 1 }`
- Understand structure → `code read { file, resolution: 2 }`  [DEFAULT]
- Read specific implementation → `code read { file, resolution: 3, offset, limit }`
- Verify edit target → `code navigate { file, action: "node-at", line }`
- See what's around (for drag/reorder) → `code navigate { file, action: "siblings", line }`
- Inspect children of a class/block → `code navigate { file, action: "children", line }`
- Find enclosing function → `code navigate { file, action: "defun-at", line }`
- Find in-file references → `code navigate { file, action: "references-local", line, symbol }`
- Delete a declaration → `code edit { operation: "kill", target: { line, node_type } }`
- Replace node content → `code edit { operation: "replace", target: { line }, content }`
- Reorder siblings → `code edit { operation: "drag-up" | "drag-down", target: { line } }`
- Unwrap a wrapper → `code edit { operation: "splice", target: { line } }`
- Unwrap, keep only target → `code edit { operation: "splice-self", target: { line } }`
- Swap adjacent siblings → `code edit { operation: "transpose", target: { line } }`
- Duplicate a node → `code edit { operation: "clone", target: { line } }`
- Insert adjacent → `code edit { operation: "insert-before" | "insert-after", target, content }`
- Preview before saving → `code edit { …, save: false }` then `code diff { file }`
- Non-code file → use `read` tool instead

**Workflow patterns**:
1. *Explore-then-edit*: `outline` → find line → `navigate node-at` → verify → `edit`
2. *Reorder*: `navigate siblings` → identify positions → `edit drag-up`/`drag-down`
3. *Preview*: `edit { save: false }` → `diff` → if good, `edit { save: true }` or re-edit
</instruction>

<operations>
- `read`: Resolution-aware file reading
  - Resolution 0 (names only): Quick scan of what's defined — use for orientation
  - Resolution 1 (signatures): Function/type signatures without bodies — use for API understanding
  - Resolution 2 (structure, default): Class members visible, method bodies stubbed — use for structural understanding
  - Resolution 3 (full source): Complete file content with optional `offset`/`limit` — use when you need implementation details
  - Use `offset` and `limit` with resolution 3 for pagination of large files
- `outline`: Structured JSON with `name`, `type`, `line`, `end_line`, `exported`, `signature`, `children`
  - Use for understanding file structure, locating symbols, and discovering class members
  - `depth` controls nesting depth
- `edit`: AST-aware structural editing (12 operations)
  - `replace`: Replace targeted node content
  - `insert-before` / `insert-after`: Insert content relative to a node
  - `kill`: Delete a targeted node
  - `splice`: Remove wrapper, promote children
  - `splice-self`: Remove wrapper + siblings, keep only targeted node
  - `splice-down`: Remove wrapper + later siblings, keep self + before
  - `drag-up` / `drag-down`: Reorder sibling nodes
  - `clone`: Duplicate a node
  - `envelope`: Wrap a node with a template
  - `transpose`: Swap node with its next sibling
  - `target`: `{ line, node_type }`, where `line` is 1-indexed and `node_type` filters treesit nodes
  - `save` defaults to true; use `save: false` + `code diff` to preview changes
- `navigate`: In-file navigation
  - `defun-at`: Find enclosing function at a position
  - `parent`: Find parent node at a position
  - `references-local`: Find in-file references to symbol at point
  - `node-at`: Inspect the node at a position (type, text, line range, parent)
  - `siblings`: List sibling nodes of the node at position (with current index)
  - `children`: List child nodes of the structural node at position
- `buffers`: List currently open managed buffers
- `diff`: Show unsaved changes in a buffer vs disk
- `languages`: List available tree-sitter grammars (`installed_only: true` to filter)
- `install_grammar`: Install a missing grammar by name or custom URL
</operations>

<output>
- `read`: Source code text at requested resolution level
- `outline`: JSON array of symbol entries with position and type information
- `edit`: Diff of changes made, or error details
- `navigate`: Node information, sibling list, or child list depending on action
- `buffers`: List of open buffer metadata
- `diff`: Unified diff of unsaved changes
- `languages`: List of grammar names with installation status
</output>

<critical>
- `code` operates on tree-sitter parse trees; files must have a supported grammar
- Do NOT default to resolution 3 — start at resolution 2; use 3 only when you need a specific function body
- Do NOT use `read` tool for source files when `code` is available — `code read` understands structure
- Do NOT skip `navigate node-at` before a destructive edit — verify your target first
- The edit `target` requires an accurate `line` number; use `code outline` or `code read` first to find the right line
- `save: true` (default) writes to disk immediately; use `save: false` + `code diff` to preview before committing
- For non-code resources (internal URLs like `skill://`, `memory://`, `agent://`; images; PDFs; directories), use the `read` tool
- For files without tree-sitter support, fall back to `read` + `edit`
</critical>