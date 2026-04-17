Structural code intelligence via tree-sitter and cross-file graph queries. What are you doing? → subcommand:
- Orientation on unknown file → `code outline { file }`
- Understand API surface → `code read { file, resolution: 1 }`
- Understand structure → `code read { file, resolution: 2 }` [DEFAULT]
- Read specific implementation → `code read { file, resolution: 3, offset, limit }`
- Create a new supported file → `code edit { file, operation: "create", content: ["..."] }`
- Change specific lines in a declaration → `code edit { file, symbol: "fnName", operation: "patch", patches: [{ find: "old", replace: "new" }] }`
- Replace a declaration body → `code edit { file, symbol: "fnName", operation: "replace-body", content: ["{", "  …", "}"] }`
- Replace an entire declaration (symbol-targeted) → `code edit { file, symbol: "fnName", operation: "replace", content: ["…"] }`
- Replace an entire existing file → `code edit { file, operation: "replace", content: ["…"] }`
- Delete a declaration → `code edit { file, symbol: "fnName", operation: "kill" }`
- Wrap a declaration in a template → `code edit { file, symbol: "fnName", operation: "wrap", content: ["try {", "  $BODY", "} catch (err) {", "  throw err;", "}"] }`
- Rename a declaration in-file → `code edit { file, symbol: "oldName", operation: "rename", content: "newName" }`
- Make multiple changes in one file → `code edit { file, edits: […] }`
- Reorder declarations → `code edit { file, line: N, operation: "drag-down" }`
- Duplicate a declaration → `code edit { file, line: N, operation: "clone" }`
- Unwrap a block → `code edit { file, line: N, operation: "splice" }`
- Preview unsaved edits → `code diff { file }`
- See what's around → `code navigate { file, action: "siblings", line }`
- Inspect children of a class/block/container → `code navigate { file, action: "children", line }`
- Find enclosing semantic container → `code navigate { file, action: "defun-at", line }`
- Find in-file references → `code navigate { file, action: "references", line, symbol }`
- Build or rebuild the project graph → `code index`
- Check graph cache and semantic index health → `code status`
- Ask how a symbol is connected → `code context { symbol }`
- Ask what breaks if a symbol changes → `code impact { symbol, depth? }`
- Inspect file-level dependencies → `code deps { file }`
- Walk forward call flow → `code flow { symbol, depth? }`
- Find likely dead symbols → `code dead_code { limit? }`
- Find architectural clusters → `code clusters { limit? }`
- Exact or ranked declaration lookup → `code symbols { query, limit? }`
- Exact or ranked file lookup → `code files { query, limit? }`
- Broad lexical or hybrid exploration → `code search { query, limit?, semantic? }`
- Non-code file → use `read` tool instead

<operations>
- `read`: Resolution-aware file reading; 0 names, 1 signatures, 2 structure, 3 source
- `outline`: Structured symbol tree for one file
- `edit`: AST-aware structural editing
- `navigate`: In-file navigation helpers
- `buffers`: Open managed buffers
- `diff`: Buffer diff vs disk
- `languages`: Built-in language profiles with extensions, semantic capabilities, and embedded guest languages
- `undo` / `redo`: revert or reapply last edit
- `save`: Save buffer to disk
- `index`: Build the native project graph under `.spell/graph/`
- `status`: Report graph cache and semantic index health
- `context`: Callers, callees, references, imports, inheritance around one symbol
- `impact`: Reverse dependency / blast-radius traversal
- `deps`: Incoming and outgoing import edges for one file
- `flow`: Forward call traversal
- `dead_code`: Symbols with no inbound semantic usage
- `clusters`: Connected file clusters with symbol counts
- `symbols`: Exact or ranked declaration lookup
- `files`: Exact or ranked file lookup
- `search`: Keyword or hybrid semantic graph search
</operations>

<examples>
- Patch a function without rewriting the whole declaration:
  ```json
  {
    "command": "edit",
    "file": "src/server.ts",
    "symbol": "handleRequest",
    "operation": "patch",
    "patches": [{ "find": ["const timeout = 5000;"], "replace": ["const timeout = 30_000;"] }]
  }
  ```
- Replace an existing file wholesale:
  ```json
  {
    "command": "edit",
    "file": "src/server.ts",
    "operation": "replace",
    "content": [
      "export function handleRequest() {",
      "  return new Response(\"ok\");",
      "}"
    ]
  }
  ```
- Create a new supported file in one call:
  ```json
  {
    "command": "edit",
    "file": "src/new-module.ts",
    "operation": "create",
    "content": [
      "export function newModule() {",
      "  return 42;",
      "}"
    ]
  }
  ```
- HTML/CSS local semantics:
  ```json
  {
    "command": "outline",
    "file": "src/site/index.html"
  }
  ```
  → HTML/CSS support is semantic but conservative: element/rule lookup, read, navigate, and graph linkage are supported for provable static structure; ambiguous dynamic template/runtime styling cases must explain limits instead of pretending proof.
- Batch multiple edits in one call:
  ```json
  {
    "command": "edit",
    "file": "src/server.ts",
    "edits": [
      { "symbol": "handleRequest", "operation": "patch", "patches": [{ "find": ["const timeout = 5000;"], "replace": ["const timeout = 30_000;"] }] },
      { "symbol": "processData", "operation": "kill" },
      { "line": 1, "operation": "insert-after", "content": ["", "import { x } from './x';"] }
    ]
  }
  ```
  → Line-target insertions operate at AST/node boundaries. Include an explicit separator newline in `content`, or target a declaration/symbol instead of treating them like raw line appends.
- Edit a markdown section by heading name:
  ```json
  {
    "command": "edit",
    "file": "README.md",
    "symbol": "Installation",
    "operation": "replace-body",
    "content": "Updated installation instructions.\n\n```bash\nbun install\n```"
  }
  ```
</examples>

<output>
- File-scoped commands return compact, hashline-style summaries in `content` and preserve normalized payload in `details`
- `read` returns source text directly
- `edit` returns a status line (`Created …` or `Edited …`), formatting status, change counts (`Changes: +N -M`), and a compact diff preview
- `create` is whole-file only and missing-file only; if the path already exists, use `replace` or `replace-body` instead
- `languages` includes per-language extensions plus semantic capability/embedded-language metadata when available
- Graph commands return compact text with grouped sections and Next hints
- Full normalized payload remains available in `details` for TUI rendering
</output>

<critical>
- Use file-scoped commands for local syntax work; use graph commands for cross-file reasoning
- `operation: "create"` accepts only `file`, `operation`, and `content`; do not combine it with `symbol`, `line`, `patches`, or `edits`
- Use `symbol` to target declarations; use `line` only for positional operations
- Line-target edits resolve semantic/node boundaries; they are not generic text splices
- If a line-target edit fails on a code-supported file, re-read/navigate, tighten the symbol/line/node target, and retry narrowly instead of switching to text `edit` or `write`
- `operation: "replace"` uses `symbol` for declaration replacement, `line` for positional replacement, and omitting both replaces the entire existing file
- Whole-file `replace` edits existing supported files only; use `create` for missing files
- For `patch`, `find` matches only within the targeted symbol scope and is indent-insensitive
- If `patch.find` matches multiple locations, the edit fails; provide more specific context
- Edits from `edit`, `undo`, and `redo` are automatically saved to disk; `save` is rarely needed
- `context`, `impact`, and `flow` require `symbol`
- `deps` requires `file`
- `symbols`, `files`, and `search` require `query`; use `symbols` / `files` for declaration or path discovery before falling back to broad `search`; optional `semantic` forces hybrid or BM25-only search
- `status` reports graph cache and semantic index state without forcing a rebuild
- `index` forces a rebuild; other graph commands auto-build when needed
- Do NOT default to resolution 3 for file reads
- For markdown files, section headings are declarations: use `symbol: "Heading Text"` to target sections
- For HTML/CSS, local semantics and style graph linkage are available for static structure; unsafe/dynamic rename or dead-style conclusions must be treated as uncertain rather than silently mutated
- Language-specific operations (promote, demote, replace-code-block, etc.) are shown on first use of a supported file type
- For non-code resources, use `read`
</critical>