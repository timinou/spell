Structural code intelligence via Emacs treesit + combobulate. Subcommands: read (resolution-aware), outline, edit, buffers, diff, navigate, languages, install_grammar.

<instruction>
- `code` is the primary tool for reading and editing source files with tree-sitter support (50+ languages)
- Use `code read` (resolution 0-2) for code comprehension before editing
- Use `code outline` to map file structure quickly
- Use `code edit` for structural AST-aware edits
- For non-code files (images, PDFs, internal URLs, directories), use `read` instead
- For creating new files from scratch, use `write` instead
- For text-based line edits (old_text/new_text with hashline anchors), use `edit` instead
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
- `edit`: AST-aware structural editing (9 operations)
  - `replace`: Replace targeted node content
  - `insert-before` / `insert-after`: Insert content relative to a node
  - `kill`: Delete a targeted node
  - `splice`: Remove wrapper, promote children
  - `drag-up` / `drag-down`: Reorder sibling nodes
  - `clone`: Duplicate a node
  - `envelope`: Wrap a node with a template
  - `target`: `{ line, node_type }`, where `line` is 1-indexed and `node_type` filters treesit nodes
  - `save` defaults to true; use `save: false` + `code diff` to preview changes
- `navigate`: In-file navigation
  - `defun-at`: Find enclosing function at a position
  - `parent`: Find parent node at a position
  - `references-local`: Find in-file references to symbol at point
- `buffers`: List currently open managed buffers
- `diff`: Show unsaved changes in a buffer vs disk
- `languages`: List available tree-sitter grammars (`installed_only: true` to filter)
- `install_grammar`: Install a missing grammar by name or custom URL
</operations>

<output>
- `read`: Source code text at requested resolution level
- `outline`: JSON array of symbol entries with position and type information
- `edit`: Diff of changes made, or error details
- `navigate`: Node information at the target position
- `buffers`: List of open buffer metadata
- `diff`: Unified diff of unsaved changes
- `languages`: List of grammar names with installation status
</output>

<critical>
- `code` operates on tree-sitter parse trees; files must have a supported grammar
- For files without tree-sitter support, fall back to `read` + `edit`
- The edit `target` requires an accurate `line` number; use `code outline` or `code read` first to find the right line
- `save: true` (default) writes to disk immediately; use `save: false` + `code diff` to preview before committing
- For non-code resources (internal URLs like `skill://`, `memory://`, `agent://`; images; PDFs; directories), use the `read` tool
</critical>