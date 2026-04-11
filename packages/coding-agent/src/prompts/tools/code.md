Structural code intelligence via Emacs treesit + combobulate plus native cross-file code graph queries. Subcommands: read, outline, edit, buffers, diff, navigate, languages, install_grammar, index, status, context, impact, deps, flow, dead_code, clusters, search.

<instruction>
What are you doing? → subcommand:
- Orientation on unknown file → `code outline { file }`
- Understand API surface → `code read { file, resolution: 1 }`
- Understand structure → `code read { file, resolution: 2 }`  [DEFAULT]
- Read specific implementation → `code read { file, resolution: 3, offset, limit }`
- Verify edit target → `code navigate { file, action: "node-at", line }`
- See what's around → `code navigate { file, action: "siblings", line }`
- Inspect children of a class/block → `code navigate { file, action: "children", line }`
- Find enclosing function → `code navigate { file, action: "defun-at", line }`
- Find in-file references → `code navigate { file, action: "references-local", line, symbol }`
- Delete a declaration → `code edit { operation: "kill", target: { line, node_type } }`
- Replace node content → `code edit { operation: "replace", target: { line }, content }`
- Preview before saving → `code edit { …, save: false }` then `code diff { file }`
- Build or rebuild the project graph → `code index`
- Check graph cache/index health → `code status`
- Ask how a symbol is connected → `code context { symbol }`
- Ask what breaks if a symbol changes → `code impact { symbol, depth? }`
- Inspect file-level dependencies → `code deps { file }`
- Walk forward call flow → `code flow { symbol, depth? }`
- Find likely dead symbols → `code dead_code { limit? }`
- Find architectural clusters → `code clusters { limit? }`
- Search graph symbols/files → `code search { query, limit? }`
- Non-code file → use `read` tool instead

Workflow:
1. File-local structural work stays on Emacs-backed commands (`read`, `outline`, `navigate`, `edit`).
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
- `diff`: Unsaved buffer diff
- `languages`: Installed tree-sitter grammars
- `install_grammar`: Install a missing grammar
- `index`: Build and persist the native project graph under `.spell/graph/`
- `status`: Report graph cache state, counts, and language coverage
- `context`: Callers, callees, references, imports, and inheritance around one symbol
- `impact`: Reverse dependency / blast-radius traversal grouped by depth
- `deps`: Incoming and outgoing import edges for one file
- `flow`: Forward call traversal grouped by depth
- `dead_code`: Symbols with no inbound semantic usage
- `clusters`: Connected file clusters with symbol counts
- `search`: BM25-style graph search over symbols and files
</operations>

<output>
- File-scoped commands return structured JSON or diffs from the Emacs backend
- Graph commands return compact text optimized for agent reading with grouped sections and “Next:” hints
</output>

<critical>
- Use file-scoped commands for local syntax work; use graph commands for cross-file reasoning
- `context`, `impact`, and `flow` require `symbol`
- `deps` requires `file`
- `search` requires `query`
- `status` reports cache state without forcing a rebuild
- `index` forces a rebuild; other graph commands auto-build when needed
- Do NOT default to resolution 3 for file reads
- Do NOT skip `navigate node-at` before destructive edits
- For non-code resources, use the `read` tool
</critical>
