# CodePath v3 — Extensions and Cutover Spec

## 0 · Goal

Replace the seven legacy tools (`find`, `read`, `grep`, `ast-grep`, `ast-edit`, `edit`, `write`) and the legacy `code` subcommand surface with four generic tools (`get`, `edit`, `manage`, `create`) backed by a single query algebra (CodePath v3). The algebra is parsed and executed in Rust (`pi-code-path` kernel + `pi-natives` NAPI bridge) and surfaced to TypeScript via `executeCodePath`, `parseCodePath`, and `renderCodePath`.

---

## 1 · Query algebra recap

CodePath v3 grammar (kernel-resident):

```text
CodePath   := Locator "::" Query Qualifier?
Locator    := UriLocator | FsLocator
UriLocator := Scheme "://" UriPath
FsLocator  := <project-relative path; literal + glob segments>
Query      := Step (Combinator Step)*
Combinator := "/" | "//" | "^" | "^^" | "<<" | ">>" | "|" | "&" | "-" | Edge
Edge       := EdgeKind "→"
Step       := Axis? Head Predicate*
Axis       := "§" | ":" | "¶"
Head       := NamePayload | NodeKind | FieldName | AnchorName | "(" Query ")"
Predicate  := "[" PredicateBody "]"
Qualifer   := "#" Ident Args?
```

---

## 2 · The four generic tools

| Tool     | Purpose                              | Example target                              |
| -------- | ------------------------------------ | ------------------------------------------- |
| `get`    | Read / find / grep / AST-search      | `src/api.ts::§function[name="foo"]#body`    |
| `edit`   | Modify source (replace, move, etc.)  | `src/api.ts::foo → rename(#name, "bar")`    |
| `manage` | Lifecycle (index, cache, purge)      | `memory://root #purge`                      |
| `create` | Create files / artifacts             | (lowers to `edit { action: { kind: "create" } }`) |

---

## 3 · NAPI bridge — streaming across the boundary

`executeCodePath` returns NodeRefs as a chunked async iterator on the TypeScript side. NAPI threadsafe-functions emit batches; cancellation via `AbortSignal` propagates to the Rust `CancellationToken`. The NAPI surface carries three commands; `create` is a TS-side ergonomic wrapper that lowers to `edit { action: { kind: "create" } }` before crossing the boundary.

```ts
interface CodePathOptions {
  command: "get" | "edit" | "manage";   // create lowers to edit at the TS tool layer
  target:  string;                       // CodePath or bare path
  // projection options (see §5) flatten here
  limit?: number; head?: number; tail?: number; offset?: number;
  context?: { pre?: number; post?: number };
  content?: "auto" | "none" | "raw" | "text";
  format?:  "node-list" | "locations" | "content-only" | "tree" | "stats";
  root?:    string;
  // edit-only
  operations?: EditOperation[];          // each carries its own target + action + optional children
  // manage-only
  manage?:  ManageCommand;
  // streaming
  chunkSize?: number;                    // NodeRefs per chunk (default 64)
  signal?:    AbortSignal;
}

interface EditOperation {
  target: string;                        // CodePath or bare path
  action: EditAction;                    // see §5 for full action shape (replace, append, prepend,
                                         //   delete, write, findAndReplace, rawTextReplace, wrap,
                                         //   rename, insert*, splice, move, clone, transpose,
                                         //   renameClassToken, renameIdToken, renameCustomProperty,
                                         //   removeDeadStyle, promote, demote, replaceCodeBlock,
                                         //   create, patch)
  children?: EditOperation[];            // nested edits under same root target
  occurrence?: "first" | "last" | "all" | number;
  idempotent?: boolean;
}

interface CodePathChunk {
  nodes:  NodeRef[];
  done:   boolean;
  diagnostics?: Diagnostic[];
}

interface NodeRef {
  locator: string;                       // canonical CodePath of this node
  range?:  { byteStart: number; byteEnd: number; lineStart?: number; lineEnd?: number };
  kind:    string;                       // "ts:method" | "fs:file" | "text:line" | …
  content?:
    | { kind: "text";          text: string }
    | { kind: "bytes";         handle: string /* artifact:// */; size: number }
    | { kind: "image";         handle: string; mimeType: string; width?: number; height?: number }
    | { kind: "extractedText"; sourceKind: "pdf"|"doc"|"docx"|"ppt"|"pptx"|"xls"|"xlsx"|"rtf"|"epub"|"json"|"html"; text: string };
  metadata?: Record<string, unknown>;    // size, mtime, captureGroups, score, leadingLineNumber, …
  diagnostics?: Diagnostic[];
}
```

**Binary content over NAPI:** never inline. The Rust side stages bytes to the artifact store and returns an `artifact://` handle; the tool layer surfaces the handle as a normal file reference.

---

## 4 · Worked examples — does this feel right?

```
# Find all TypeScript test files larger than 10 KiB modified this month
**/*.test.ts[size>10000][mtime>2026-04-01]

# Read lines 50-150 of api.ts
src/api.ts :: §line[50..150]#text

# Grep TODO across the repo with 3 lines of trailing context, types only
**/*.ts :: §line[text~="TODO"] >>[0..3]
       — equivalent —
code get { target: "**/*.ts :: §line[text~=\"TODO\"]", context: { post: 3 } }

# All TS methods that call fetch but do not await (set difference)
src/**/*.ts :: //§method[.//§call_expression[name=fetch]]
                    -  //§method[.//§await_expression]

# Rename callers of parseConfig outside tests in one expression
src/ :: parseConfig/def→ - src/**/*.test.ts :: *
       →  rename(#name, "loadConfig")

# Read a memory section
memory://root :: //§heading[text~="Edit Coordination"] / #body

# Slice into a stored artifact
artifact://14d3.../main/bash/1.txt :: §line[10..50]

# Extract text from a PDF and grep within
docs/api.pdf :: §line[text~="signature"]    # #text auto-applied for PDF host

# List a directory two levels deep
docs/ #tree[depth=2]

# Show metadata for all Cargo.lock files in workspace
**/Cargo.lock #stat
```

Same operators throughout. Payload (FS glob, line regex, code symbol, JSON path, markdown heading) varies by dialect. Predicates and combinators do not.

---

## 5 · Sequencing and impact on the active CodePath v3 PLAN

Foundational scaffolding (parser, AST, renderer, NameLexer trait, NodeRef, Content, dialect contracts, TS NameLexer, FsExistsResolver scaffold) shipped under PLAN-255 wave-1/2 — see commits `b06d5ff70`, `f387aa977`. The successor PLAN folds in: full FS/Text/URI dialect resolvers, 7 remaining code NameLexers, NAPI bridge, and the four-generic-tools cutover. The kernel resolver must know FS, Text, and URI dialects from day 1; the dispatch state machine cannot be retrofitted later without breaking the streaming contract.

The wave structure for the successor PLAN:

```
W1  Spec lock-in       Resolved sigil/grammar (DONE in PLAN-255). Successor PLAN spec edits:
                       4-tool surface, 9 URI schemes, 11 extraction formats, EditAction shapes,
                       crate-boundary architecture (this addendum)

W2  Kernel resolvers   FS resolver (ignore-crate walker, anchors, predicates, qualifiers, suffix-fallback)
    in pi-code-path    Text resolver (line index, regex via grep-regex, qualifiers, extraction routing)
                       Resolver traits (Resolver, CodeResolver, EdgeResolver, UriResolver, SchemeHandler)
                       Set-ops compositor, projection lowering

W3  Code dialects      7 remaining NameLexers (Rust, Python, Go, Haskell, HTML, CSS, Markdown/Org)
                       Wire all 8 dialects into LanguageProfile constructors
                       Cross-dialect smoke test passes

W4  NAPI + URI impls   pi-natives::code_path module + executeCodePath function
                       CodeResolver impl (tree-sitter via LanguageProfile)
                       EdgeResolver impl (pi-code-graph)
                       9 SchemeHandler impls (artifact, memory, skill, agent, jobs, local, pi, rule, mcp)
                       Streaming chunked iterator + AbortSignal bridge + Content marshalling
                       11 extraction handlers via markitdown
                       Image pipeline (auto-resize, threshold, #thumbnail[N], inspect_image hint)

W5  Tool cutover       4 generic tools: get.ts, edit.ts, manage.ts, create.ts
                       Schema lowering (projection → CodePath; create → edit { action: create })
                       Behavioral parity corpus (30–50 invocations per deleted tool)
                       Delete: code.ts, read.ts, find.ts, grep.ts, ast-grep.ts, ast-edit.ts,
                              patch/index.ts (EditTool), write.ts
                       Port write-shrink, parse-regression, force, sandbox/mode-guard
                       enforcement to create/edit tool layer

W6  Prompt + agent     Rewrite tool prompts (get.md, edit.md, manage.md, create.md, code-migration.md)
    cutover            Delete legacy tool prompts (code.md, code-hint-*.md, code-search.md,
                              read.md, find.md, grep.md, ast-grep.md, ast-edit.md)
                       Update AGENTS.md tool-precedence section
                       Update per-agent role files (Tools: lists)
                       Update memory skills referencing deleted tools
                       Orphan-reference scan: zero references to deleted tool names in source/prompts/agents/skills
```

Performance benchmarks (1.2× of `find`, 1.5× of `grep`, 100 MiB RSS on 1 GiB file) are deferred as a follow-up after correctness/parity ships.

---

## 6 · Acceptance for the full vision

- The seven standalone tools `find`, `read`, `grep`, `ast-grep`, `ast-edit`, `edit`, `write` and the legacy `code` subcommand surface are removed from `packages/coding-agent/src/tools/`
- Four generic top-level tools (`get`, `edit`, `manage`, `create`) reproduce every behavior of the deleted tools, verified by a behavioral parity corpus of 30–50 representative invocations per deleted tool (semantic equivalence, not byte-equivalent output)
- All nine internal URI schemes (`artifact`, `memory`, `skill`, `agent`, `jobs`, `local`, `pi`, `rule`, `mcp`) work as Locators in `get { target }`
- All eleven document extraction formats (`pdf`, `doc`, `docx`, `ppt`, `pptx`, `xls`, `xlsx`, `rtf`, `epub`, `json`, `html`) route through markitdown / native extractors via the `#text` qualifier
- Streaming holds: large files (>100 MiB) under `§line[text~=…]` stream incrementally without OOM. Performance benchmarks against `find`/`grep` deferred as follow-up.
- Projection options compile to canonical CodePath syntax round-trip
- Suffix/typo fallback reproduces today's `read` correction behavior with `Diagnostic::SuffixSuggestion`
- Content-bearing return shape is stable: `NodeRef.content` is `Some(_)` iff path includes a content-class qualifier, never otherwise
- write-shrink + parse-regression guards and `force` flag preserved at the `create`/`edit` tool layer (TS wrapper before NAPI)
- Image pipeline (auto-resize threshold, 20 MiB rejection, `inspect_image` hand-off hint, `#thumbnail[N]` preview) is owned by the kernel `#image` qualifier, not the tool layer
- Capture binding `(Q) as $m` for ast-grep `$A`/`$$$A` parity is **deferred** to follow-up; replacement uses `[name=$pattern]` predicate matching
- Resolver traits live in `pi-code-path`; concrete impls (code, edge, URI scheme handlers) live in `pi-natives` to avoid circular crate dependency

---

## 7 · Diagnostics

### `CODE_GRAPH_NOT_INITIALISED`

Emitted by the `EdgeResolver` when the underlying code graph has not yet been built or loaded.

- **Variant:** `DiagnosticVariant::UnsupportedOperation`
- **Message prefix:** `[CODE_GRAPH_NOT_INITIALISED] ...`
- **Remediation:** Run `manage index` to trigger background indexing, or wait for the background indexer to finish and persist the graph.
- **Empty graphs:** A workspace with no indexable files produces an empty graph (zero nodes, zero edges). This is still considered *initialised* and does **not** trigger this diagnostic, provided the graph root path exists.

---

## 8 · NAPI bridge — file-extension dispatch

The `executeCodePath` and `parseCodePath` NAPI functions perform a **two-phase parse** to choose the correct `NameLexer` for the target string.

### Two-phase parse rule

1. **Split** the target on the first `::` occurrence. The left side is the FS prefix; the right side is the query.
2. **Strip** one pair of surrounding backticks from the FS prefix (e.g. `` `foo bar.ts` `` → `foo bar.ts`).
3. **Detect glob magic** in the FS prefix. If any of `* ? [ {` is present, fall back to the generic `DotLexer` and emit a `Diagnostic { variant: UnsupportedOperation, message: "weak NamePayload parse: glob FS prefix uses generic DotLexer" }` on the first returned chunk.
4. **Detect empty prefix** (target starts with `::`). Fall back to `DotLexer`; no diagnostic.
5. **Extension lookup**. Take the *last* extension of the FS prefix and map it to a dialect `NameLexer`:

| Extension(s)                            | Dialect      | NameLexer impl      |
| --------------------------------------- | ------------ | ------------------- |
| `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | TypeScript   | `TsNameLexer`       |
| `.rs`                                   | Rust         | `RustNameLexer`     |
| `.py`                                   | Python       | `PyNameLexer`       |
| `.go`                                   | Go           | `GoNameLexer`       |
| `.hs` `.lhs`                            | Haskell      | `HaskellNameLexer`  |
| `.html` `.htm`                          | HTML         | `HtmlNameLexer`     |
| `.css`                                  | CSS          | `CssNameLexer`      |
| `.md` `.mdx` `.org`                     | Markdown/Org | `MdOrgNameLexer`    |

If the extension is unknown, the path contains non-UTF-8 bytes, or there is no extension, fall back to the generic `DotLexer` silently.

### Edge cases

- **`foo.ts.snap::Snap`** — last extension is `.snap`; falls back to `DotLexer`.
- **`src/Foo.test.ts::Bar`** — last extension is `.ts`; dispatches to `TsNameLexer`.
- **Symlink dangling** — extension is taken from the link name; the path is **not** canonicalised.
- **Quoted FS literal** — `` `foo bar.ts`::Bar `` → backticks stripped before extension scan.
- **Non-UTF-8 paths** — `Path::extension().and_then(|e| e.to_str())` returns `None`; falls back.

### Crate boundaries

- `pi-code-path` defines the `NameLexer` trait and every dialect `NameLexer` implementation.
- `pi-natives::code_path::dialect_registry` maps extensions to `Arc<dyn NameLexer>` via lazy `OnceLock` initialisation.
- `pi-natives::code_path::napi` houses the two-phase split logic (`select_lexer`) and injects fallback diagnostics into `CodePathChunk` results.

## Action surface (PROJ-073)

The kernel exposes a typed action enum and a `MutationResolver` trait for applying edits to resolved targets. This section documents the Rust-side contract; concrete resolver implementations are owned by PROJ-074/075.

### Action enum (25 variants)

```rust
pub enum Action {
    Create  { content: ActionContent, force: bool },
    Write   { content: ActionContent, force: bool },
    Delete,
    Append  { lines: ActionContent },
    Prepend { lines: ActionContent },
    Insert  { pos: Option<String>, line: Option<u32>, lines: ActionContent },
    Replace { pos: Option<String>, end: Option<String>, line: Option<u32>, lines: Option<ActionContent> },
    Patch   { diff: String },
    Rename  { content: String },
    Wrap    { content: ActionContent },
    FindAndReplace { find: ActionContent, content: ActionContent, occurrence: Option<Occurrence> },
    RawTextReplace { find: ActionContent, content: ActionContent },
    Splice  { mode: Option<SpliceMode> },
    Move    { direction: Direction },
    Clone   { direction: Option<Direction> },
    Transpose { line: Option<u32>, column: Option<u32> },
    RenameClassToken  { find: String, content: String },
    RenameIdToken     { find: String, content: String },
    RenameCustomProperty { find: String, content: String },
    RemoveDeadStyle,
    Promote,
    Demote,
    ReplaceCodeBlock { content: ActionContent },
    InsertBefore { lines: ActionContent },
    InsertAfter  { lines: ActionContent },
}
```

`ActionContent` is an untagged union accepting either a single `string` or an array of strings. `Occurrence` is `first | last | all | <uint>`. `SpliceMode` is `self | up | down`. `Direction` is `up | down`.

### MutationResolver trait

```rust
pub trait MutationResolver: Send + Sync {
    fn supports(&self, kind: ActionKind) -> bool { false }
    fn apply(&self, target: &CodePath, action: &Action, cancel: &CancellationToken)
        -> Result<MutationOutcome, Diagnostic>;
}
```

- **Capability discovery**: callers check `MutationResolver::supports(kind)` before dispatch.
- **Default impl**: returns `Diagnostic { variant: UnsupportedOperation, ... }` for every action.
- **Dispatch order**: concrete resolver selection (file-system vs tree-sitter vs markdown) is TBD by FEAT-686.

### MutationOutcome

```rust
pub struct MutationOutcome {
    pub edit_count:    u32,
    pub diff:          Option<String>,
    pub created:       bool,
    pub target_summary: Option<String>,
}
```

The `diff` field is optional and populated only when the resolver supports generating a unified diff of the mutation.
