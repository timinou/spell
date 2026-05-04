# CodePath v3 — extensions for full tool subsumption

Companion to `specs/code-graph/code-path.md` and `specs/code-graph/code-path-dialects/README.md`.
Defines the additions that let CodePath v3 absorb the entire `find`/`read`/`grep`/`ast-grep` tool surface
without sacrificing flexibility. Locked in alongside the kernel deliverables (PLAN-255).

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
Scheme     := "artifact" | "memory" | "skill" | "agent" | "jobs" | "local" | "pi"
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
             #text                  format-aware text:  PDF→pdftotext,  DOCX→docx2txt,
                                    JSON→pretty-print, HTML→readable mode (mirrors today's read)
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

---

## 4 · NodeRef — the unified return shape

Every resolver path returns a stream of `NodeRef`. Content is populated only when a content-class
qualifier is in the path; otherwise NodeRef is location + metadata. This keeps `code get` cheap by
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

## 5 · Tool surface — three commands, projection options orthogonal to query syntax

```
code get { 
  target:  <CodePath>,
  // projection options — sugar for query suffixes; equivalent CodePath always works
  limit?:  number,                          ⇔ [0..N]
  head?:   number,                          ⇔ [0..N]
  tail?:   number,                          ⇔ [-N..]
  context?: { pre?: number, post?: number },⇔ << / >> set-union
  content?: "auto" | "none" | "raw" | "text",  // defaults: auto for symbols, none for FS-only
  format?: "node-list" | "locations" | "content-only" | "tree" | "stats",
  root?:   string,                          // override walker root (default: cwd)
}

code edit {
  operations: [{ target: <CodePath>, action: ..., children?: ... }]
}

code manage {
  command: "save" | "undo" | "redo" | "diff" | "open" | "close"
         | "buffers" | "languages" | "index" | "watcherStatus" | "lockStatus",
  ...
}
```

**Projection options are sugar.** Every one is also expressible inside the path:

| Today                           | Sugar                            | CodePath syntax                    |
| ------------------------------- | -------------------------------- | ---------------------------------- |
| `find "*.ts"`                   | `code get { target: "**/*.ts" }` | `**/*.ts` (locator-only)           |
| `find "*.ts" --hidden=false`    | + `code get { target: "**/*.ts", … }` | `**/*.ts -[¶hidden]`          |
| `read foo.ts`                   | `code get { target: "foo.ts" }`  | `foo.ts#raw`                       |
| `read foo.ts offset=50 limit=100` | + `head: 100, ` …              | `foo.ts :: §line[50..150]#text`    |
| `read dir/`                     | `code get { target: "dir/" }`    | `dir/#listing`                     |
| `read foo.pdf`                  | `code get { target: "foo.pdf" }` | `foo.pdf#text`                     |
| `read img.png`                  | `code get { target: "img.png" }` | `img.png#image`                    |
| `read artifact://…/1.txt`       | `code get { target: "artifact://…/1.txt" }` | `artifact://…/1.txt#raw` |
| `grep "useState" src/`          | + via `target`                   | `src/** :: §line[text~="useState"]` |
| `grep --post 3 "TODO"`          | + `context: { post: 3 }`         | `§line[text~="TODO"] | §line[…]>>[0..3]` |
| `grep --type ts "x"`            | + `target` glob                  | `**/*.ts :: §line[text~="x"]`      |
| `grep mode=semantic "parseConfig"` | (no sugar — use edge axis)    | `parseConfig/def→`                 |
| `ast-grep "console.log($A)"`    | (no sugar — use predicates)      | `**/*.ts :: //§call_expression[name=console.log]` |

**`format`** controls the rendering, not the result shape:
- `node-list` (default for symbol queries)
- `locations` — file:line:col triples (grep-style, default for `§line[text~=…]`)
- `content-only` — concatenated `content` blobs (default for `#raw`/`#text`/`#lines`)
- `tree` — directory-tree-style (default for `#tree`/`#listing`)
- `stats` — metadata-only formatted (default for `#stat`)

**The four tools delete on cutover:** `find.ts`, `read.ts`, `grep.ts`, `ast-grep.ts`. No transition
aliases. Migration is taught in `code.md` with the table above.

---

## 6 · NAPI bridge — streaming across the boundary

`executeCodePath` returns NodeRefs as a chunked async iterator on the TypeScript side. NAPI
threadsafe-functions emit batches; cancellation via `AbortSignal` propagates to the Rust
`CancellationToken`.

```ts
interface CodePathOptions {
  command: "get" | "edit" | "manage";
  target:  string;
  // projection options (see §5) flatten here
  limit?: number; head?: number; tail?: number;
  context?: { pre?: number; post?: number };
  content?: "auto" | "none" | "raw" | "text";
  format?:  "node-list" | "locations" | "content-only" | "tree" | "stats";
  root?:    string;
  // edit-only
  actions?: EditAction[];
  children?: CodePathOptions[];
  // manage-only
  manage?:  ManageCommand;
  // streaming
  chunkSize?: number;  // NodeRefs per chunk (default 64)
  signal?:    AbortSignal;
}

interface CodePathChunk {
  nodes:  NodeRef[];
  done:   boolean;
  diagnostics?: Diagnostic[];
}

interface NodeRef {
  locator: string;           // canonical CodePath of this node
  range?:  { byteStart: number; byteEnd: number; lineStart?: number; lineEnd?: number };
  kind:    string;           // "ts:method" | "fs:file" | "text:line" | …
  content?:
    | { kind: "text";          text: string }
    | { kind: "bytes";         handle: string /* artifact:// */ }
    | { kind: "image";         handle: string }
    | { kind: "extractedText"; sourceKind: "pdf"|"docx"|"json"|"html"|"…"; text: string };
  metadata?: Record<string, unknown>;
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

## 8 · Sequencing and impact on PLAN-255

This addendum *folds into* PLAN-255, not after it. The kernel resolver in PROJ-052 must know FS,
Text, and URI dialects from day 1; the dispatch state machine cannot be retrofitted later without
breaking the streaming contract. PROJ-053 (8 code dialects) is unaffected. PROJ-054 (NAPI) gains
the streaming + Content marshalling. PROJ-055 (tool cutover) gains the find/read/grep/ast-grep
deletion plus projection-option surface.

The wave structure becomes:

```
W1  Foundation       FEAT-581 (sigil + non-code dialect spec sections)
                     FEAT-582 (3-command + projection options + tool deletion spec)
                     PROJ-052 start  (crate setup, AST, NameLexer trait, NodeRef, Content,
                                      dialect-switch state machine)

W2  Kernel + non-    PROJ-052 complete  (resolver, edge axis, set ops, streaming, suffix fallback)
    code dialects    PROJ-FS    (filesystem dialect — globs, anchors, predicates, qualifiers, walker)
                     PROJ-TEXT  (text dialect — line/chunk/para axes, regex, slicing, extraction)

W3  Code dialects    PROJ-053  (8 NameLexers + cross-dialect smoke incl. FS+Text+URI baselines)
    + URI schemes    PROJ-URI  (artifact, memory, skill, agent, jobs, local, pi)

W4  NAPI bridge      PROJ-054 (executeCodePath, streaming chunked iterator, Content marshalling)

W5  Tool cutover     PROJ-055 (3-command schema, projection options, delete find/read/grep/ast-grep,
                              prompt rewrites, AGENTS.md migration)
```

---

## 9 · Acceptance for the full vision

- The four tools `find`, `read`, `grep`, `ast-grep` are removed from the codebase
- `code get` reproduces every behavior of those tools, verified by a golden-test corpus
- All seven internal URI schemes work as Locators in `code get { target }`
- Streaming holds: 1 GiB file under `§line[text~=…]` peaks under 100 MiB RSS
- Cross-file glob queries (`src/** :: §line[text~="x"]`) match `grep` performance within 1.5×
- Pure FS queries match `find` performance within 1.2× (walker is the same `ignore` crate)
- `code get` projection options compile to canonical CodePath syntax round-trip
- Suffix/typo fallback reproduces today's `read` correction behavior
- Content-bearing return shape is stable: `NodeRef.content` is `Some(_)` iff path includes a
  content-class qualifier, never otherwise
