Structural code intelligence via native tree-sitter engine plus cross-file code graph queries. Subcommands: read, outline, edit, buffers, diff, navigate, languages, undo, redo, save, index, status, context, impact, deps, flow, dead_code, clusters, search.

<instruction>
What are you doing? → subcommand:
- Orientation on unknown file → `code outline { file }`
- Understand API surface → `code read { file, resolution: 1 }`
- Understand structure → `code read { file, resolution: 2 }`  [DEFAULT]
- Read specific implementation → `code read { file, resolution: 3, offset, limit }`
- Change specific lines in a declaration → `code edit { file, symbol: "fnName", operation: "patch", patches: [{ find: "old", replace: "new" }] }`
- Replace a declaration body but keep its signature → `code edit { file, symbol: "fnName", operation: "replace-body", content: "{ … }" }`
- Replace an entire declaration → `code edit { file, symbol: "fnName", operation: "replace", content: "…" }`
- Delete a declaration → `code edit { file, symbol: "fnName", operation: "kill" }`
- Wrap a declaration in a template → `code edit { file, symbol: "fnName", operation: "wrap", content: "try {\n  $BODY\n} catch (err) {\n  throw err;\n}" }`
- Rename a declaration in-file → `code edit { file, symbol: "oldName", operation: "rename", content: "newName" }`
- Make multiple changes in one file → `code edit { file, edits: […] }`
- Reorder declarations → `code edit { file, line: N, operation: "drag-down" }`
- Duplicate a declaration → `code edit { file, line: N, operation: "clone" }`
- Unwrap a block → `code edit { file, line: N, operation: "splice" }`
- Preview unsaved edits → `code diff { file }`
- See what's around → `code navigate { file, action: "siblings", line }`
- Inspect children of a class/block → `code navigate { file, action: "children", line }`
- Find enclosing function → `code navigate { file, action: "defun-at", line }`
- Find in-file references → `code navigate { file, action: "references", line, symbol }`
- Build or rebuild the project graph → `code index`
- Check graph cache and semantic index health → `code status`
- Ask how a symbol is connected → `code context { symbol }`
- Ask what breaks if a symbol changes → `code impact { symbol, depth? }`
- Inspect file-level dependencies → `code deps { file }`
- Walk forward call flow → `code flow { symbol, depth? }`
- Find likely dead symbols → `code dead_code { limit? }`
- Find architectural clusters → `code clusters { limit? }`
- Search graph symbols/files → `code search { query, limit?, semantic? }`
- Non-code file → use `read` tool instead

Workflow:
1. File-local structural work stays on file-local commands (`read`, `outline`, `navigate`, `edit`).
2. Cross-file reasoning uses graph commands (`context`, `impact`, `deps`, `flow`, `dead_code`, `clusters`, `search`).
3. If graph results look stale or missing, run `code index` first.
</instruction>

<operations>
- `read`: Resolution-aware file reading
  - Resolution 0: names only
  - Resolution 1: signatures
  - Resolution 2: structure
  - Resolution 3: full source with optional `offset`/`limit`
- `outline`: Structured symbol tree for one file
- `edit`: AST-aware structural editing
- `navigate`: In-file navigation helpers
- `buffers`: Open managed buffers
- `diff`: Buffer diff vs disk
- `languages`: Built-in language profiles (TypeScript, Rust, Python, Elixir)
- `undo`: Undo last edit
- `redo`: Redo last undo
- `save`: Save buffer to disk
- `index`: Build and persist the native project graph under `.spell/graph/`
- `status`: Report graph cache state, semantic index availability, counts, and language coverage
- `context`: Callers, callees, references, imports, and inheritance around one symbol
- `impact`: Reverse dependency / blast-radius traversal grouped by depth
- `deps`: Incoming and outgoing import edges for one file
- `flow`: Forward call traversal grouped by depth
- `dead_code`: Symbols with no inbound semantic usage
- `clusters`: Connected file clusters with symbol counts
- `search`: Keyword or hybrid semantic graph search over symbols and files
</operations>

<examples>
- Patch a function without rewriting the whole declaration:
  ```json
  {
    "command": "edit",
    "file": "src/server.ts",
    "symbol": "handleRequest",
    "operation": "patch",
    "patches": [
      { "find": "const timeout = 5000;", "replace": "const timeout = 30_000;" },
      { "find": "return null;", "replace": "return defaultResponse();" }
    ]
  }
  ```
- Replace only the body of a function:
  ```json
  {
    "command": "edit",
    "file": "src/utils.ts",
    "symbol": "formatDate",
    "operation": "replace-body",
    "content": "{\n  return new Intl.DateTimeFormat('en-US').format(date);\n}"
  }
  ```
- Wrap a declaration with a template:
  ```json
  {
    "command": "edit",
    "file": "src/api.ts",
    "symbol": "fetchData",
    "operation": "wrap",
    "content": "try {\n  $BODY\n} catch (err) {\n  logger.error(err);\n  throw err;\n}"
  }
  ```
- Rename a declaration and its in-file references:
  ```json
  {
    "command": "edit",
    "file": "src/utils.ts",
    "symbol": "parseConfig",
    "operation": "rename",
    "content": "loadConfig"
  }
  ```
- Batch multiple edits in one call:
  ```json
  {
    "command": "edit",
    "file": "src/server.ts",
    "edits": [
      {
        "symbol": "handleRequest",
        "operation": "patch",
        "patches": [
          { "find": "const timeout = 5000;", "replace": "const timeout = 30_000;" }
        ]
      },
      {
        "symbol": "processData",
        "operation": "kill"
      },
      {
        "line": 1,
        "operation": "insert-after",
        "content": "import { x } from './x';\n"
      }
    ]
  }
  ```
</examples>

<output>
- File-scoped commands return compact, model-facing summaries in `content` and preserve the full normalized payload in structured `details`
- `read` returns source text directly in `content`; `outline`, `navigate`, `buffers`, `languages`, `diff`, `undo`, `redo`, `save`, and `edit` summarize the result semantically instead of dumping raw JSON
- `edit` summaries include the annotated diff and edit count; `details` retain version and normalized payload data
- Graph commands return compact text optimized for agent reading with grouped sections and “Next:” hints
</output>

<critical>
- Use file-scoped commands for local syntax work; use graph commands for cross-file reasoning
- Use `symbol` to target declarations. Use `line` only for positional operations such as `drag-up`, `drag-down`, `splice`, `clone`, and `transpose`
- For `patch`, `find` text is matched only within the targeted symbol scope and is indent-insensitive
- If `patch.find` matches multiple locations, the edit fails — provide more specific context in the `find` text
- Edits from `edit`, `undo`, and `redo` are automatically saved to disk. The `save` command is still available but rarely needed.
- `context`, `impact`, and `flow` require `symbol`
- `deps` requires `file`
- `search` requires `query`; optional `semantic` forces hybrid search (`true`) or BM25-only search (`false`)
- `status` reports graph cache and semantic index state without forcing a rebuild
- `index` forces a rebuild; other graph commands auto-build when needed
- Do NOT default to resolution 3 for file reads
- For non-code resources, use the `read` tool
</critical>