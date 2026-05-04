# CodePath v3 — extensions for full tool subsumption

Companion to `specs/code-graph/code-path.md` and `specs/code-graph/code-path-dialects/README.md`.
Defines the additions that let CodePath v3 absorb the entire `find` / `read` / `grep` / `ast-grep` / `ast-edit` / `edit` / `write` tool surface plus the legacy `code` subcommand surface
without sacrificing flexibility. Locked in alongside the kernel deliverables of the active CodePath v3 PLAN.

---

## 0 · Why this is a kernel concern, not a tool layer

`find`, `read`, `grep` exist because today's CodePath addresses *only* code structures inside files.
Once the addressing algebra also covers (a) the filesystem itself, (b) the raw-text view of any file,
and (c) internal URI schemes, those tools become five specializations of one query — exactly the way
the existing graph commands collapse into edge-axis queries (§5 of `code-path.md`).

The pieces below must land in `crates/pi-code-path` from day 1 because the resolver is dialect-aware
state-machine and retrofitting non-code dialects breaks that machine. They are *not* opt-in dialect
registrations — they are baseline kernel components alongside the per-language code dialects.

```
v3 baseline:    kernel + 8 code dialects + edge axis + set ops               [ PLAN-255 today ]
v3 with full
tool subsume:   + FS dialect + Text dialect + URI scheme dialects
                + content-bearing NodeRef + projection options                [ this addendum ]
```

---

## 1 · Locator grammar extension

```
Locator    := UriLocator | FsLocator
UriLocator := Scheme "://" UriPath
FsLocator  := <project-relative path; literal segments and glob segments mixed>
Scheme     := "artifact" | "memory" | "skill" | "agent" | "jobs" | "local" | "pi" | "rule" | "mcp"
```

**FS glob operators in `FsLocator`:** `*`, `**`, `?`, `[abc]`, `{a,b,c}`. These are *parsed by the
FsLexer*, not the kernel; the kernel sees them as a `NamePayload`. The kernel still reserves `::`,
`/`, `//`, `^`, `^^`, `<<`, `>>`, `|`, `&`, `-`, `→`, `#` — paths containing these as literal segments
must backtick-quote (Q-1 rule from the dialects README applies).

`Locator` may stand alone (no `::Query`) — that yields a NodeSet of files, replacing `find`.

---

## 2 · The three baseline non-code dialects

### 2.1 FS dialect (always present)

```
Node kinds   §dir           directory
             §file          regular file
             §symlink       symbolic link

Anchors      ¶hidden        leading-dot file/dir
             ¶ignored       matches .gitignore (excluded by default; this anchor opts in)
             ¶lockfile      bun.lock, Cargo.lock, package-lock.json, etc.
             ¶code          extension belongs to a registered code LanguageProfile
             ¶doc           md, org, txt, rst, adoc
             ¶image         png, jpg, jpeg, gif, webp, svg
             ¶binary        not detected as text (UTF-8 sniff fails)
             ¶large         size > 1 MiB

Predicates   [ext=ts]               extension match (no dot)
             [lang=rust]            registered language match
             [size>1000]            byte size compare; <, >, <=, >=, =
             [mtime>2026-01-01]     RFC3339 or YYYY-MM-DD
             [name="*.test.ts"]     glob match against leaf name
             [depth=N]              walk depth from root (root = 0)
             [empty]                empty file (size=0) or empty dir
             [text]                 (synonym for ¬¶binary)

Qualifiers   #listing               one-level child NodeRefs
             #tree[depth=N]         recursive listing capped at N (default unbounded)
             #stat                  metadata only: size, mtime, kind, optional hash
```

**Hidden default:** included (matches today's `find`). Filter with `-[¶hidden]`.
**Gitignore default:** respected (matches today's `grep`/`find`). Override with `[¶ignored]` / projection option.

**Walker:** built on the `ignore` crate (already a workspace dep). Streams `NodeRef`s; cancellation via
`CancellationToken` mid-walk. No eager directory load.

**Suffix/typo fallback:** when an exact `FsLocator` resolves to zero NodeRefs, the FS dialect
runs a fuzzy match against the project file index and emits a `Diagnostic::SuffixSuggestion {
tried, suggestion: NodeRef }`. Reproduces today's `read` typo correction.

### 2.2 Text dialect (always present, parallel to every file's code dialect)

Every file regardless of code dialect has a parallel text view, available the moment a `§line`-class
axis is used. The text dialect bypasses tree-sitter entirely.

```
Node kinds   §line          1-indexed line; carries leading-line-number metadata
             §chunk         N-line block; defaults to N=20, override with [n=…]
             §para          blank-line-separated block
             §span          regex-match span (start byte..end byte)

Combinators  <<  >>         adjacent lines (context windows). Applies to §line.

Predicates   [text~="re"]           regex (PCRE-ish, ripgrep parity)
             [match="literal"]      literal match (escaped)
             [len>80]               byte length compare
             [multiline]            spans more than one line (for §chunk/§para/§span)
             [startsWith="…"]
             [endsWith="…"]
             [10..50]               line slice (1-indexed, inclusive end optional)
             [last]                 last line
             [-3..]                 last three lines

Qualifiers   #raw                   whole-file bytes as text (UTF-8; latin-1 fallback)
             #text                  format-aware text via markitdown / native extractors:
                                    PDF/DOC/DOCX/PPT/PPTX/XLS/XLSX/RTF/EPUB → markitdown,
                                    JSON → pretty-print, HTML → readable mode (mirrors today's `read`)
             #match                 just the matched span (string, not the §line)
             #captures[N]           Nth regex capture group from the matching predicate
             #lines[a..b]           line slice content (1-indexed)
             #bytes                 ArtifactHandle (no inline transfer; binary safe)
             #image                 ImageHandle (uses existing image pipeline)
             #thumbnail[N]          generated preview at size N
```

**Multiline regex:** inline `(?m)` / `(?s)` flags rather than a dedicated knob.
**Encoding:** UTF-8 default; emit `Diagnostic::EncodingFallback` on latin-1 fallback (matches today).
**Streaming:** lazy line index; no full file load except under `#raw`/`#bytes`/`#text`.

### 2.3 URI scheme Locator dialects (always present)

Each scheme is a tiny `LanguageDialect` registered in the `Locator` parser's scheme table. After
URI resolution, structural queries delegate to a downstream dialect (Markdown for memory/skill md
files, JSON for agent payloads, FS for arbitrary files, etc.).

```
Scheme        Resolves to                          Downstream dialect on `::Query`
artifact://   Stored artifact bytes/text           Text or Markdown depending on extension
memory://     Memory tree files                    Markdown/Org
skill://      Skill files                          FS for arbitrary, MD for SKILL.md
agent://      Agent JSON output                    JSON sub-dialect (see below)
jobs://       Job state document                   Job sub-dialect (see below)
local://      Plan artifact dir                    FS, then resolved file's dialect
pi://         Internal Spell docs                  FS, then resolved file's dialect
rule://       Rule definition by name              Markdown/Org for rule body content
mcp://        MCP-discovered tool/resource         Per-MCP-tool dialect (defaults to JSON or text)
```

**JSON sub-dialect (for `agent://`):**
```
Node kinds:  §object, §array, §field, §array-elem, §string, §number, §bool, §null
Field axis:  :prop-name           JSON property accessor
Predicate:   [N]                  array index
jq-like:     agent://id/.foo.bar[0]    reuses kernel combinators (/) and predicates ([0])
```

**Job sub-dialect (for `jobs://`):**
```
Node kinds: §job (root), §status, §stdout, §stderr, §result, §error, §duration_ms
```

---

## 3 · Resolver dispatch — the dialect-switch state machine

This is the load-bearing piece. The resolver tracks a *current scope dialect* per step. Transitions
are mechanical and explicit; the user never declares a dialect, the axis chosen does.

```
Initial scope:                  FsDialect rooted at cwd (or `root` projection option)
After matching §file:           switch to file's code dialect (or stay FS for #listing/#stat)
First §line/§chunk/§para axis:  switch to text dialect for this file
Inside text dialect:            cannot return to code dialect mid-file (text loses tree position)
                                must `^` to file root, then re-enter via code-axis
Across `→` (edge axis):         cross-file; new file's dialect takes over
URI Locator resolution:         scheme dialect first; then delegate per the table in §2.3
```

**Why no return-to-code from text:** text steps don't carry tree-sitter positions. To go
text→code in the same file, the path must explicitly re-anchor: `foo.ts :: §line[42] / ^ / §file
:: methodFoo` (re-resolves from file root). This keeps the resolver stateless across step
boundaries — preserves the cost discipline and parallelism of streaming.

**Cost discipline:**
- Pure FS query (no `::`)         → walker only, no tree-sitter
- Text-only query (`§line` axes)  → line index only, no tree-sitter
- Code-only query                 → tree-sitter, current behavior
- Edge axis                       → code-graph lookup, current behavior
- Mixed                           → composition; each step picks the cheapest interpreter for its dialect

**Crate boundary (architecture):** `pi-code-path` ships the resolver *traits* (`Resolver`, `CodeResolver`, `EdgeResolver`, `UriResolver`, `SchemeHandler`) and the FS + Text resolver impls (no engine deps). `pi-natives` implements `CodeResolver` against `pi-code-engine::LanguageProfile` + tree-sitter, implements `EdgeResolver` against `pi-code-graph::neighbors_by_kind`/`bfs_levels`, and registers all 9 `SchemeHandler` impls (artifact, memory, skill, agent, jobs, local, pi, rule, mcp). This avoids the cyclic crate dep that would arise if `pi-code-path` depended on `pi-code-engine`/`pi-code-graph`.

---

## 4 · NodeRef — the unified return shape

Every resolver path returns a stream of `NodeRef`. Content is populated only when a content-class
qualifier is in the path; otherwise NodeRef is location + metadata. This keeps `get` cheap by
default and rich when asked.

```rust
pub struct NodeRef {
    pub locator:    Locator,                  // file path or URI of the host
    pub range:      Option<NodeRange>,        // byte/line range; None = whole locator
    pub kind:       NodeKindLabel,            // dialect-tagged: "ts:method" | "fs:file" | "text:line" | …
    pub content:    Option<Content>,          // populated iff a #content-class qualifier was used
    pub metadata:   BTreeMap<String, Value>,  // size, mtime, lang, capture groups, score, …
    pub diagnostics: Vec<Diagnostic>,         // per-node soft errors (e.g. permission denied, encoding fallback)
}

pub enum Content {
    Text(String),
    Bytes(ArtifactHandle),
    Image(ImageHandle),
    ExtractedText { source_kind: ExtractKind, text: String },  // PDF | DOCX | JSON | HTML | …
}

pub struct NodeRange {
    pub byte_start: u32,
    pub byte_end:   u32,
    pub line_start: Option<u32>,    // populated for text-dialect nodes
    pub line_end:   Option<u32>,
}
```

**Content-class qualifiers that populate `content`:** `#raw`, `#text`, `#match`, `#captures[N]`,
`#lines[a..b]`, `#bytes`, `#image`, `#thumbnail[…]`, `#body`, `#sig`, `#name`, `#docstring`, etc.
Anything that does *not* select a sub-range or content stays content-`None`.

**Streaming:** the resolver returns `impl Stream<Item = NodeRef>`. NAPI bridges this as a chunked
async iterator (see §6).

---

## 5 · Tool surface — four generic commands, projection options orthogonal to query syntax

The v3 tool surface drops the `code` prefix because CodePath addresses now span filesystem, text, code, and internal URIs uniformly. Four top-level tools replace twenty-odd `code` subcommands plus seven standalone tools (`find`, `read`, `grep`, `ast-grep`, `ast-edit`, `edit`, `write`).

```ts
get { 
  target:  <CodePath> | <bare path>,         // bare path = FsLocator with no ::Query
  // projection options — sugar for query suffixes; equivalent CodePath always works
  limit?:  number,                          // ⇔ [0..N]
  head?:   number,                          // ⇔ [0..N]
  tail?:   number,                          // ⇔ [-N..]
  context?: { pre?: number, post?: number },// ⇔ << / >> set-union
  content?: "auto" | "none" | "raw" | "text",  // defaults: auto for symbols, none for FS-only
  format?: "node-list" | "locations" | "content-only" | "tree" | "stats",
  root?:   string,                          // override walker root (default: cwd)
  offset?: number,                          // 1-indexed line start (sugar for §line[offset..])
}

edit {
  operations: [{
    target: <CodePath> | <bare path>,        // file-level, symbol-level, or line-range CodePath
    action: EditAction,
    children?: EditOperation[],              // nested edits under same root target
    occurrence?: "first" | "last" | "all" | number,
    idempotent?: boolean                     // allow no-op edits to succeed
  }]
}

manage {
  command: "save" | "undo" | "redo" | "diff" | "open" | "close"
         | "buffers" | "languages" | "index" | "watcherStatus" | "lockStatus",
  file?: string,
  ...
}

create {
  path: <FsLocator>,                          // bare path required
  content: string                              // text content (UTF-8)
         | { kind: "bytes", artifactUri: string }     // binary by handle (no inline transfer)
         | { kind: "base64", data: string },           // binary inline (small files only)
  force?: boolean                             // bypass write-shrink + parse-regression guards
}
```

### EditAction shape — ergonomic edit forms preserved

Every operation supported by today's `edit`, `code edit`, `ast-edit`, and `write` tools has a direct shape in the new `edit`. Bare-string file paths and `LINE#ID` stale-detection anchors are preserved verbatim; CodePath targets unlock structural addressing.

```ts
type EditAction =
  // line-anchored text edits (replaces today's `edit` tool with LINE#ID)
  | { kind: "replace";   pos?: string; end?: string; content: string | string[] }
  | { kind: "append";    pos?: string; content: string | string[] }   // pos? = file-level append at EOF if absent
  | { kind: "prepend";   end?: string; content: string | string[] }
  | { kind: "delete" }

  // structural code edits (replaces today's `code edit` action kinds)
  | { kind: "write";              scope?: "target" | "body"; content: string | string[] }
  | { kind: "findAndReplace";     find: string | string[]; content: string | string[] }
  | { kind: "rawTextReplace";     find: string; content: string }
  | { kind: "wrap";               content: string | string[] }                    // template uses $BODY
  | { kind: "rename";             content: string }
  | { kind: "insertBefore";       content: string | string[]; line?: number; nodeType?: string }
  | { kind: "insertAfter";        content: string | string[]; line?: number; nodeType?: string }
  | { kind: "splice";             mode?: "self" | "up" | "down" }
  | { kind: "move";               direction: "up" | "down" }
  | { kind: "clone" }
  | { kind: "transpose";          line?: number; column?: number }
  | { kind: "renameClassToken";   content: string }
  | { kind: "renameIdToken";      content: string }
  | { kind: "renameCustomProperty"; content: string }
  | { kind: "removeDeadStyle" }
  | { kind: "promote" }                                                            // markdown heading up-level
  | { kind: "demote" }                                                             // markdown heading down-level
  | { kind: "replaceCodeBlock";   content: string; index?: number; language?: string }

  // file lifecycle (replaces today's `write` tool)
  | { kind: "create"; content: string | { kind: "bytes"; artifactUri: string } | { kind: "base64"; data: string }; force?: boolean }

  // unified-diff edits (replaces today's `edit` patch mode)
  | { kind: "patch"; diff: string }                                                // git-style unified diff, may span multiple files via target

  // sibling cleanup escape hatch
  | { allowSiblingDelete?: boolean; ... };
```

**LINE#ID stale-detection** stays a first-class concept on `replace`/`append`/`prepend` actions: pass `pos` and/or `end` as `LINE#ID` strings copied verbatim from a recent `get` resolution-3 read. The kernel re-validates the hash before applying; on mismatch the action fails with `Diagnostic::StaleAnchor { current: "<fresh LINE#ID>" }`. This is the same contract today's `edit` tool ships.

**Bare-string file paths**: `target: "foo.ts"` parses as an `FsLocator` with no `::Query`, the cheapest path. The kernel never re-parses bare paths as CodePaths. Use bare strings for plain-text edits; use CodePath syntax only when you want structural addressing (`foo.ts :: Bar.baz#body`).

**Projection options are sugar.** Every one is also expressible inside the path. The lowering contract guarantees a round-trip property: a lowered path renders to the same canonical string that parses back to the same AST.

| Today                           | Sugar                            | CodePath syntax                    |
| ------------------------------- | -------------------------------- | ---------------------------------- |
| `find "*.ts"`                   | `get { target: "**/*.ts" }`      | `**/*.ts` (locator-only)           |
| `find "*.ts" --hidden=false`    | + `get { target: "**/*.ts" }`    | `**/*.ts -[¶hidden]`               |
| `read foo.ts`                   | `get { target: "foo.ts" }`       | `foo.ts#raw`                       |
| `read foo.ts offset=50 limit=100` | + `head: 100,` …               | `foo.ts :: §line[50..150]#text`    |
| `read dir/`                     | `get { target: "dir/" }`         | `dir/#listing`                     |
| `read foo.pdf`                  | `get { target: "foo.pdf" }`      | `foo.pdf#text`                     |
| `read foo.docx` (or `.doc`/`.ppt`/`.pptx`/`.xls`/`.xlsx`/`.rtf`/`.epub`) | `get { target: "foo.docx" }` | `foo.docx#text` (markitdown extraction) |
| `read img.png`                  | `get { target: "img.png" }`      | `img.png#image`                    |
| `read artifact://…/1.txt`       | `get { target: "artifact://…/1.txt" }` | `artifact://…/1.txt#raw` |
| `read rule://my-rule`           | `get { target: "rule://my-rule" }` | `rule://my-rule#text`            |
| `read mcp://server/path`        | `get { target: "mcp://server/path" }` | `mcp://server/path#raw`        |
| `grep "useState" src/`          | + via `target`                   | `src/** :: §line[text~="useState"]` |
| `grep --post 3 "TODO"`          | + `context: { post: 3 }`         | `§line[text~="TODO"] >>[0..3]` |
| `grep --type ts "x"`            | + `target` glob                  | `**/*.ts :: §line[text~="x"]`      |
| `grep mode=semantic "parseConfig"` | (no sugar — use edge axis)    | `parseConfig/def→`                 |
| `ast-grep "console.log($A)"`    | (no sugar — use predicates)      | `**/*.ts :: //§call_expression[name=console.log]` |
| `ast-edit { ops: [{pat, out}] }` | (no sugar — use edit kind)       | `edit { operations: [{ target: "**/*.ts", action: { kind: "findAndReplace", find: pat, content: out } }] }` |
| `edit foo.txt replace pos=10#AB end=12#CD lines=["…"]` | (none) | `edit { operations: [{ target: "foo.txt", action: { kind: "replace", pos: "10#AB", end: "12#CD", content: "…" } }] }` |
| `edit { input: "<unified diff>" }` (patch mode) | (none) | `edit { operations: [{ action: { kind: "patch", diff: "…" } }] }` |
| `write foo.ts content`          | (none)                           | `create { path: "foo.ts", content: "…" }` |
| `write img.png` (binary)        | (none)                           | `create { path: "img.png", content: { kind: "bytes", artifactUri: "artifact://…" } }` |

**`format`** controls the rendering, not the result shape:
- `node-list` (default for symbol queries)
- `locations` — file:line:col triples (grep-style, default for `§line[text~=…]`)
- `content-only` — concatenated `content` blobs (default for `#raw`/`#text`/`#lines`)
- `tree` — directory-tree-style (default for `#tree`/`#listing`)
- `stats` — metadata-only formatted (default for `#stat`)

**The cutover deletes seven tools and the legacy `code` subcommand surface in one cycle:** `find.ts`, `read.ts`, `grep.ts`, `ast-grep.ts`, `ast-edit.ts`, `edit.ts` (in `patch/index.ts`), `write.ts`, and the legacy `code.ts`. No transition aliases. Migration is taught in `get.md` / `edit.md` / `manage.md` / `create.md` and `code-migration.md` with the table above.

---

## 6 · NAPI bridge — streaming across the boundary

`executeCodePath` returns NodeRefs as a chunked async iterator on the TypeScript side. NAPI
threadsafe-functions emit batches; cancellation via `AbortSignal` propagates to the Rust
`CancellationToken`. The NAPI surface carries three commands; `create` is a TS-side ergonomic
wrapper that lowers to `edit { action: { kind: "create" } }` before crossing the boundary.

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

**Binary content over NAPI:** never inline. The Rust side stages bytes to the artifact store and
returns an `artifact://` handle; the tool layer surfaces the handle as a normal file reference.

---

## 7 · Worked examples — does this feel right?

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

Same operators throughout. Payload (FS glob, line regex, code symbol, JSON path, markdown
heading) varies by dialect. Predicates and combinators do not.

---

## 8 · Sequencing and impact on the active CodePath v3 PLAN

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

## 9 · Acceptance for the full vision

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