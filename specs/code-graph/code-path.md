# CodePath v3 — Shared Query Algebra, Language-Native Steps

## 0 · The correction

```
v1    one grammar, one step syntax, one payload             → too uniform
v2    one kernel, N parsers, N step syntaxes, N payloads    → too fragmented
v3    one grammar, one step syntax, N payload dialects      → the right split
```

Concretely, the split line moves:

```
Shared (written once, learned once, reused everywhere)
  · path concatenation semantics          / // ^ ^^ << >>
  · predicates, quantifiers, slices       [ … ] [n] [n..m]
  · qualifier mechanism                   #body #name #sig ...
  · axis operators (incl. edges)          ref→ def→ call→ bind→
  · set operations over results           | & - (union/intersect/except)
  · path composition + subquery nesting   X/ .(Y) /Z
  · error envelope, stability class, parser, serializer, reference form

Language-specific (in each LanguageProfile's NameLexer + SemanticMap)
  · what counts as a valid `name` token          // TS ident vs CSS class
                                                 //  vs Markdown heading text
  · how sub-identifiers compose inside a name    // a.b.c vs a::b::c vs Mod.fn/2
  · which qualifiers exist and what they produce // #body for TS method
                                                 //  vs #text for HTML element
  · node-kind synonyms and unwrap rules          // export_statement → underlying
  · which anchors the language ships             // ¶return, ¶guard, ¶hook-deps
```

The *interpreter* changes per language. The *grammar* does not.

---

## 1 · The shared grammar — one DSL, winnow-built once

```
CodePath   := Locator "::" Query Qualifier?
Locator    := <file path as written in the project>

Query      := Step ( Combinator Step )*
Combinator := "/"     // direct child (in the "visible children" sense)
           | "//"     // any descendant
           | "^"      // parent
           | "^^"     // nearest matching ancestor (requires predicate)
           | "<<"     // previous sibling
           | ">>"     // next sibling
           | "→"      // edge axis (see §4)
           | "|" | "&" | "-"   // set combinators (see §5)

Step       := Axis? Head Predicate*
Axis       := "§"           // structural (node-kind payload)
           | ":"            // tree-sitter field
           | "¶"            // language-registered anchor
           |                // (none) ⇒ semantic/name payload

Head       := NamePayload   // interpreted by LanguageProfile's NameLexer
           | NodeKind       // after "§"; a tree-sitter kind string
           | FieldName      // after ":"; a grammar field name
           | AnchorName     // after "¶"; a profile-registered identifier
           | "(" Query ")"  // grouping / subquery

Predicate  := "[" Integer "]"                        // ordinal
           |  "[" Range   "]"                        // slice: [0..3] [last] [-1]
           |  "[" "§" NodeKind "]"                   // kind filter
           |  "[" "¶" AnchorName "]"                 // anchor filter
           |  "[" "." Query "]"                      // has-descendant subquery
           |  "[" Attr   "]"                         // attribute / regex / text
Attr       := Ident "=" String                       // id=save
           |  "text~=" Regex                         // text-pattern
           |  "kind=" String

Qualifier  := "#" Ident                              // head: the dialect names which
                                                     //  sub-ranges exist (#body, #name,
                                                     //  #sig, #attr[x], …)
```

Read as:

```
src/api.ts :: Foo/bar                          // direct child, name-payload
src/api.ts :: Foo/bar#body                     // with qualifier
src/api.ts :: Foo/bar/§if[0]:consequence       // mix axes; positional predicate
src/api.ts :: handleClick/§call[name=fetch]/:arguments[0]
                                               // predicate is a language-native
                                               //  attribute on a structural step

src/api.ts :: //§arrow_function[.¶hook-deps]   // descendant + has-anchor predicate
src/api.ts :: Foo/bar^^[§class]                // nearest enclosing class
src/lib.rs :: impl_Write_for_Buffer/write_all  // same grammar, Rust name payload
page.html :: #app//button[.save]               // same grammar, CSS-style payload
README.md :: Installation/"Quick start"#intro  // same grammar, heading-text payload
```

The shape is uniform. What varies is **what's legal inside a step head** and **which qualifier names resolve** — both are LanguageProfile concerns.

---

## 2 · Step head = payload under a named axis

One step, four axes, one payload-per-step. This is the whole addressing model.

```
Axis    Payload type           Source of truth
─────   ─────────────────      ────────────────────────────────
(none)  dialect NamePayload    LanguageProfile::name_lexer
§       NodeKind (string)      tree-sitter grammar
:       FieldName (string)     tree-sitter grammar
¶       AnchorName (string)    LanguageProfile::anchors
```

Predicates are uniform across axes. `[0]`, `[last]`, `[§class_declaration]`, `[name=foo]`, `[.¶guard]`, `[text~="TODO"]` — all composable, all shared-grammar, all winnow-parsed in one place.

**NamePayload is the only dialect-pluggable piece.** It answers three questions for each language:

```rust
pub trait NameLexer: Send + Sync {
    /// Parse a name token from input. TS accepts dotted `Foo.bar.baz`;
    /// Rust accepts `crate::a::b::c`; Elixir accepts `Mod.fn/2`;
    /// CSS accepts `tag#id.class`; Markdown accepts `ident | "quoted text"`.
    fn parse(&self, input: &mut &str) -> PResult<NamePayload>;

    /// Render a NamePayload back to its canonical text form.
    fn render(&self, n: &NamePayload) -> String;

    /// Given a NamePayload and a node, does this node's
    /// (NameExtractor output + AttributeEnrichment) match?
    fn matches(&self, n: &NamePayload, node: Node<'_>, profile: &LanguageProfile, src: &str) -> bool;
}
```

That's the entire language-specific contract for CodePath querying. ~80–150 lines of winnow per language — same rough budget as v2, but now the language's responsibility is narrow and testable in isolation.

The step head `Foo.bar.baz` in TS parses as *one* NamePayload with three dotted segments; the resolver walks the grammar the same way today's `resolve_symbol` does (top-level then member-chain). `Mod::item::method` in Rust parses as *one* NamePayload with `::`-separated segments. The **outer** combinators `/` and `//` and `^^` are still available — you can still descend structurally *after* the semantic name resolves. The semantic run compresses into one step; the structural descent into its body is the next step.

```
src/api.ts :: Foo.bar/§if[0]                // "Foo.bar" is ONE name step
                                            //  then structural descent
src/lib.rs :: crate::util::parse/§match[0]  // same idea, Rust-style dots
```

This is the exact mechanism that made v1's `Foo.bar` shortening correct and v2's TS-specific `.` parser over-ambitious. The `.` in TS names stays TS-local; the `/` between steps stays kernel-global. No conflict.

---

## 3 · Qualifiers — language-named, kernel-shared shape

The `#qualifier` suffix is still universal; its vocabulary per language is:

```rust
pub struct QualifierSpec {
    pub name:       &'static str,       // "body" | "name" | "sig" | "attr[*]" | ...
    pub applies_to: RuleExpr,           // reuses pi-code-engine's RuleExpr
    pub resolve:    QualifierResolver,  // range-within-node producer
}
```

Two things fall out:

```
• ::body on a TS method, an Elixir def, a Rust fn, and a Markdown section
  all spell the same #body. The dialects register independent resolvers;
  the caller says #body.
• #attr[action] (HTML) and #sig (any callable) look different because
  they mean different things in those languages — parametric qualifiers
  are legal for dialects that want them.
```

Qualifier parsing is shared (predicate-bracket grammar already handles `[action]`). Qualifier *dispatch* is dialect.

---

## 4 · Edge axis `→` — first-class, shared

Now that the outer grammar is uniform, edges fit cleanly. You reinstated edge resolution; here's how it lands without fracturing anything.

`→` is an axis combinator just like `/`. It separates steps, and its kind determines the relation:

```
ref→     // follow a reference to its definition
def→     // from a declaration to its references (set-valued)
call→    // from a call site to the callee declaration
bind→    // from a use to its binding site (scope-local)
import→  // from an imported name to the source module's declaration
```

Syntactically identical to `/` — same step grammar on both sides. Semantically different: the resolver consults the **code graph** (your `pi-code-graph`) instead of the syntax tree when it crosses a `→`.

Examples:

```
src/api.ts :: handler/§call[name=fetch]/ref→          // fetch's definition
src/util.ts :: parseConfig/def→                       // all references to parseConfig
                                                       //  (set-valued; see §5)
src/api.ts :: handler/ref→/#body                      // handler's definition, body only
lib/my_app/greeter.ex :: call→/#sig                   // the signature of whatever
                                                       //  the nearest call dispatches to
```

Four payoffs:

```
E1  The C1–C6 contract extends unchanged: a single-valued edge axis still
    resolves to one node. Set-valued edges (def→) return a NodeSet, see §5.

E2  Cross-file paths become legible. `ref→` crosses files; the *result*
    path shows `other/file.ts :: Foo/bar` when rendered canonically.

E3  `pi-code-graph` doesn't need a parallel addressing scheme. Today it
    has its own `GraphNodeSummary`; after v3, a graph node IS a CodePath
    that starts with the symbol's declaration. One type, two code paths
    into it (syntax tree walk vs graph lookup).

E4  The LLM's "rename across the codebase" op becomes
       def→ . { rename(#name, "newName") }
    applied to a NodeSet; same verbs as any other edit.
```

---

## 5 · Smart querying — set algebra and subqueries, shared

Once the outer grammar has predicates and combinators, smart querying is just using them. The primitives needed are:

```
Set combinators on the result type:
  A | B      union
  A & B      intersect
  A - B      difference
  distinct(A)

Subquery predicate: has-descendant / has-ancestor
  [.Q]            matches nodes whose subtree matches query Q
  [.^Q]           matches nodes with an ancestor matching Q

Quantified predicates:
  [§kind count>3]        nodes with more than 3 children of that kind
  [.call[name=fetch] 0]  nodes with zero such descendants

Join-ish: subquery with capture (for refactor pipelines)
  //(Foo/bar) as $m      capture each matched node as $m
  $m/ref→>#name          refer back to captured
```

Examples that are *useful*, not just possible:

```
# All TS methods that call fetch but do not await
// map() ~ §method[.§call[name=fetch]][.^§await_expression 0]
src/api.ts :: //§method[.§call[name=fetch]][.//§await_expression 0]

# Every React component with useState but no useEffect
src/ :: //§function[.//§call[name=useState]] - //§function[.//§call[name=useEffect]]

# All callsites of parseConfig not inside tests
src/ :: parseConfig/def→ - src/**/*.test.ts :: *

# Every Rust fn annotated with #[test] in this crate
crate/ :: //§fn[.^¶test-attr]
```

Everything composes from: combinators (`/`, `//`, `^^`, `→`, `|`, `&`, `-`) + predicates (`[…]`) + axes (`§`, `:`, `¶`) + payloads (dialect). **No query-specific grammar**. The "search and query" facility is emergent from the path grammar plus set ops — which is exactly the resilience you want, because the LLM learns one thing and uses it five ways.

Worth noting what this replaces. Today `code` has (in addition to `targetId`):
```
code symbols { query }      → distinct search DSL
code context { symbol }     → graph lookup
code impact { symbol }      → graph lookup
code flow   { symbol }      → graph lookup
code references { symbol }  → graph lookup
```

In v3 these are **five specializations of one query**:
```
//[name=…]                              symbols
X/def→                                 references
X/def→/*^^[§function]                  context-like (enclosing fn of each ref)
X/def→//§call_expression               impact-like (all calls within refs)
X/ref→ (iterated)                      flow-like
```

They can remain as convenience tools — but they all return CodePaths and accept CodePaths, so the API surface collapses.

---

## 6 · The Dialect trait, narrowed

Compared to v2's `LanguageDialect { parse, render, resolve, generate, suggest }`, v3's obligations shrink dramatically:

```rust
pub struct LanguageDialect {
    pub name_lexer:  Arc<dyn NameLexer>,      // the only truly custom parser
    pub anchors:     Vec<AnchorPattern>,      // ¶name registry
    pub qualifiers:  Vec<QualifierSpec>,      // #name registry
    pub edge_kinds:  EdgeKindSet,             // which → variants this language supports
                                              //   (default: ref, def, call, import)
}
```

No parser per language for the outer grammar. The kernel ships one winnow parser and substitutes the dialect's NameLexer where the `Head` nonterminal lives.

Same for rendering: the outer renderer is kernel, only `NamePayload` rendering is dialect. Same for error messages — the kernel's winnow errors handle combinators; dialect errors handle names. Diagnostic output is composed, not parallel.

This is as far inward as the language-specific pocket can shrink while preserving "feels native in the payload". Anything smaller and TS devs see `@` and `~` and feel they're reading a grammar meta-language; anything larger and Rust and Elixir devs can't share a predicate vocabulary.

---

## 7 · Examples at the level of "does this feel right?"

Same query shape, different dialects, sanity check:

```
# "the body of the method that handles POST"
src/api.ts :: //§method[.§string_literal[text~="^POST"]]#body
src/api.rs :: //§fn[.§attribute[text~="post"]]#body
lib/api.ex  :: //§def[name=handle_post]#body
page.html   :: //form[method=post]#innerHTML
```

What a TS dev reads: "descend to any method whose subtree contains the string POST, take its body". What a Rust dev reads: "descend to any fn with a #[post…] attribute, take its body". The operators are identical; the **name predicate** is dialect (string literal matcher for TS, attribute matcher for Rust). Neither dev has to learn the *other* language's payload to read the operators.

```
# "rename all callers of parseConfig that live outside tests"
src/ :: parseConfig/def→ - src/**/*.test.ts :: *    →  rename(#name, "loadConfig")
```

Single line. Works in any language whose profile registers the `def→` edge. Same grammar; the NameLexer changes what `parseConfig` *means* in each language.

---

## 8 · Existing pi-code-engine DSL plugs in unchanged

The primitives the user named — `RuleExpr`, `SelectorBuilder`, `ActivationBuilder` — become the **Rust-side analogue of predicates**:

```
textual                  Rust builder
──────────────────────   ──────────────────────────────────────
[§if_statement]          rule("if_statement")
[§call][name=fetch]      rule("call_expression") with name filter
[text~="TODO"]           rx("TODO")
[.¶guard]                anchor filter — new, but composable
-§comment                exclude(All, rule("comment"))
```

`matches_rule_expr` is already the semantic engine behind structural predicates. Any textual predicate is a deserialized `RuleExpr`. Any Rust-built path compiles to the same textual form. Round-trip is trivial because the shared grammar is the bridge — no dialect has to teach `RuleExpr` about itself.

---

## 9 · Cutover, reduced

Because v3 pushes most of v2's effort into the kernel (one winnow grammar instead of N), the dialect work is small and parallel:

```
Step 1   Shared grammar in kernel
         - winnow grammar for outer query algebra
         - LegacyNameLexer that parses today's `Foo.bar` for every language
         - Kernel resolver that composes: combinator walker + NameLexer dispatch
         - Zero behavior change at this point.

Step 2   Predicates + axes
         - `§`, `:`, predicates `[…]`, ordinals, has-descendant subquery
         - This unlocks every "unnameable node" use-case in one step.

Step 3   Qualifiers
         - #body/#name/#sig per language via QualifierSpec registry
         - Deprecate `scope: "body"` edit parameter.

Step 4   Edge axis →
         - Wire pi-code-graph as the edge resolver backend.
         - Start with ref→ and def→; others follow as graph coverage grows.

Step 5   Set ops + named captures
         - Turns the query DSL into a refactor language.
         - Replaces code symbols / references / impact as distinct tools
           with one tool that returns NodeSets.

Step 6   NameLexer specialization per language
         - TS: dotted + JSX + private-field + overload signatures
         - Rust: :: paths + turbofish + impl-for
         - Elixir: dotted + arity
         - HTML/CSS: selector-shaped payload
         - Markdown/Org: heading text + list position
```

Each dialect in Step 6 is an *independent* delivery — the grammar is already live from Step 1. A language gets its native feel the day its NameLexer lands, without blocking any other language.

---

## 10 · Why this is the right split, in one paragraph

CodePath is an addressing algebra. An algebra is defined by its operators, not its operands. The operators — concatenation, descent, ancestor, sibling, edge, predicate, set union/intersect/difference, qualifier — are universal because trees are universal. The operands — what a "name" means, which qualifiers exist, what anchors the language recognizes — are local because every language shapes its identifiers to its own grammar. v1 tried to universalize operands; v2 tried to localize operators. v3 localizes operands and universalizes operators, which is what every successful addressing algebra in the wild (XPath, JSONPath, CSS selectors, LDAP, DN notation) has done for the same reason. Predicates and edges come along for free because they are expressed in the shared algebra; "smart querying" is not a new feature but an emergent property of the algebra being well-formed.


---

## §A · Tool surface mapping

The v3 tool surface collapses from twenty-odd `code` subcommands plus seven standalone tools (`find`, `read`, `grep`, `ast-grep`, `ast-edit`, `edit`, `write`) into four generic top-level tools. CodePath addresses span filesystem, text, code, and internal URIs uniformly, so the tool surface drops the `code` prefix.

```
get    { target: <CodePath>, <projection options> }     # reads, queries, navigation, graph traversals, listings
edit   { operations: [{ target: <CodePath>, action: ..., children?: ... }] }    # mutations to existing addresses
manage { command: "save"|"undo"|"redo"|"diff"|"open"|"close"|"buffers"|"languages"|"index"|"watcherStatus"|"lockStatus", ... }   # buffer lifecycle
create { path: <FsLocator>, content: string | { kind: "bytes", artifactUri: string } | { kind: "base64", data: string }, force?: boolean }   # new-file creation; lowers to edit { action: { kind: "create" } }
```

### Command-to-path mapping

| Legacy command | New invocation |
|----------------|----------------|
| `code read { file }` | `get { target: "file.ts" }` |
| `code read { file, symbol }` | `get { target: "file.ts :: Symbol" }` |
| `code outline { file }` | `get { target: "file.ts", resolution: 0 }` |
| `code symbols { query }` | `get { target: "**::query" }` |
| `code context { symbol }` | `get { target: "file.ts :: Symbol", edges: true }` |
| `code impact { symbol }` | `get { target: "**::Symbol/def→", depth: 3 }` |
| `code flow { symbol }` | `get { target: "**::Symbol/call→", depth: 3 }` |
| `code deps { file }` | `get { target: "file.ts/import→" }` |
| `code navigate { defun-at, line }` | `get { target: "file.ts", line: 42 }` |
| `code dead_code` | `get { target: ":dead_code" }` |
| `code clusters` | `get { target: ":clusters" }` |
| `code save` / `undo` / `redo` / `diff` / `buffers` / `languages` / `index` / `watcherStatus` / `lockStatus` | `manage { command: "...", file: "..." }` |

### Special targets

- `:dead_code` — returns the dead-code report as a NodeSet (same rows as the old standalone command, now addressable inside a larger query).
- `:clusters` — returns module-cluster analysis.
- `:status` — resolver health and dialect registry snapshot.
- `:index` — triggers or reports incremental index state.

### Deprecation of `scope: "body"`

The edit parameter `scope: "body"` is replaced by the `#body` qualifier in the target path. A target that previously read `targetId: "file.ts::foo"` with `scope: "body"` now reads `target: "file.ts :: foo#body"`. The qualifier is resolved by the dialect's `QualifierSpec` registry (see §3).

---

## §B · Projection options

Projection options are sugar for canonical CodePath syntax. They are flattened into `CodePathOptions` at the tool layer, lowered to path suffixes in the NAPI bridge, and resolved by the Rust kernel as ordinary combinators. The lowering contract guarantees a round-trip property: a lowered path renders to the same canonical string that parses back to the same AST.

| Option | Sugar for | Canonical CodePath |
|--------|-----------|-------------------|
| `limit: N` | `[0..N]` on result set | `path/[0..N]` |
| `head: N` | first N nodes | `path/[0..N]` |
| `tail: N` | last N nodes | `path/[-N..]` |
| `context: { pre: N, post: M }` | `<<` and `>>` combinators | `path | (path <<[0..N]) | (path >>[0..M])` |
| `content: "auto" \| "none" \| "raw" \| "text"` | qualifier defaults | `path#raw`, `path#text`, or no qualifier |
| `format: "node-list" \| "locations" \| "content-only" \| "tree" \| "stats"` | output shaping | rendering hint, not a path operator |
| `root: path` | working directory override | prefix to FsLocator |

**Lowering pipeline:** tool schema → NAPI `CodePathOptions` → Rust `Projection` struct → appended to parsed `Query` as predicate / combinator / qualifier nodes. The resolver sees only the canonical query.

---

## §C · NodeRef and content-bearing return shape

Every `get` invocation returns a stream of `NodeRef`. Content is present only when the path includes a content-class qualifier; otherwise the node is location and metadata only. This makes the default path cheap and the rich path explicit.

```rust
pub struct NodeRef {
    pub locator:    Locator,                  // canonical CodePath of this node
    pub range:      Option<NodeRange>,        // byte / line range
    pub kind:       NodeKindLabel,            // "ts:method" | "fs:file" | "text:line" | …
    pub content:    Option<Content>,          // populated iff a #content-class qualifier was used
    pub metadata:   BTreeMap<String, Value>,  // dialect-specific: size, mtime, capture groups, score, …
    pub diagnostics: Vec<Diagnostic>,         // per-node soft errors
}

pub enum Content {
    Text(String),
    Bytes(ArtifactHandle),        // binary content staged to artifact store
    Image(ImageHandle),
    ExtractedText { source_kind: ExtractKind, text: String },  // PDF | DOCX | JSON | HTML | …
}
```

**Streaming:** the resolver returns `impl Stream<Item = NodeRef>`. NAPI bridges this as a chunked async iterator with default chunk size 64. Cancellation via `AbortSignal` propagates to the Rust `CancellationToken`.

**Binary content discipline:** bytes are never inlined across the NAPI boundary. The Rust side stages them to the artifact store and returns an `artifact://` handle; the tool layer surfaces the handle as a normal file reference.

Full type definitions and NAPI bridge details: see `code-path-extensions.md` §4 and §6.

---

## §D · Migration table for find / read / grep / ast-grep / ast-edit / edit / write

On cutover the seven standalone tools (`find`, `read`, `grep`, `ast-grep`, `ast-edit`, `edit`, `write`) and the legacy `code` subcommand surface are deleted in one cycle. Every behavior they provided is reproduced by `get` / `edit` / `manage` / `create` with a CodePath target. The table below shows the legacy invocation, the projection-option sugar (when available), and the canonical CodePath syntax.

| Legacy tool | Projection sugar | Canonical CodePath |
|-------------|-----------------|-------------------|
| `find "*.ts"` | `get { target: "**/*.ts" }` | `**/*.ts` |
| `find "*.ts" --hidden=false` | `get { target: "**/*.ts" }` | `**/*.ts -[¶hidden]` |
| `read foo.ts` | `get { target: "foo.ts" }` | `foo.ts#raw` |
| `read foo.ts offset=50 limit=100` | `get { target: "foo.ts", head: 100, … }` | `foo.ts :: §line[50..150]#text` |
| `read dir/` | `get { target: "dir/" }` | `dir/#listing` |
| `read foo.pdf` | `get { target: "foo.pdf" }` | `foo.pdf#text` |
| `read foo.docx` / `.doc` / `.ppt` / `.pptx` / `.xls` / `.xlsx` / `.rtf` / `.epub` | `get { target: "foo.docx" }` | `foo.docx#text` (markitdown extraction) |
| `read img.png` | `get { target: "img.png" }` | `img.png#image` |
| `read artifact://…/1.txt` | `get { target: "artifact://…/1.txt" }` | `artifact://…/1.txt#raw` |
| `read rule://my-rule` / `mcp://server/path` | `get { target: "rule://my-rule" }` | `rule://my-rule#text` |
| `grep "useState" src/` | `get { target: "src/** :: §line[text~=\"useState\"]" }` | `src/** :: §line[text~="useState"]` |
| `grep --post 3 "TODO"` | `get { target: "§line[text~=\"TODO\"]", context: { post: 3 } }` | `§line[text~="TODO"] >>[0..3]` |
| `grep --type ts "x"` | `get { target: "**/*.ts :: §line[text~=\"x\"]" }` | `**/*.ts :: §line[text~="x"]` |
| `grep mode=semantic "parseConfig"` | (no sugar — use edge axis) | `parseConfig/def→` |
| `ast-grep { pat: "console.log($A)" }` | (no sugar — use predicates) | `**/*.ts :: //§call_expression[name=console.log]` |
| `ast-grep { pat, sel }` | sel is contextual selector | `**/*.ts :: //$pat[.$sel]` (has-descendant predicate) |
| `ast-edit { ops: [{pat, out}] }` | (none) | `edit { operations: [{ target: "**/*.ts", action: { kind: "findAndReplace", find: pat, content: out } }] }` |
| `edit foo.txt replace pos=10 end=12 lines=["…"]` | (none) | `edit { operations: [{ target: "foo.txt :: §line[10..12]", action: { kind: "replace", content: "…" } }] }` |
| `edit { input: "--- a/foo.ts\\n+++ b/foo.ts\\n@@…" }` (patch mode) | (none) | `edit { operations: [{ action: { kind: "patch", diff: "…" } }] }` |
| `write foo.ts content` | (none) | `create { path: "foo.ts", content: "…" }` |
| `write img.png { kind: "bytes", artifactUri }` | (none) | `create { path: "img.png", content: { kind: "bytes", artifactUri: "artifact://…" } }` |

The edge axis, predicate system, and set combinators subsume the old "smart query" commands (`context`, `impact`, `flow`, `deps`) without dedicated sugar. See §5 of `code-path.md` for edge-axis examples.

Cross-reference: tool-deletion and prompt-migration items in the active PLAN, `code-path-extensions.md` §5.

---

## §E · Non-code dialects

CodePath v3 ships three baseline non-code dialects alongside the per-language code dialects. Full grammar, predicates, and qualifiers are specified in `code-path-extensions.md` §2; what follows is a summary.

### FS dialect
Filesystem tree addressed with the same operators as code trees.

```
Node kinds   §dir         §file         §symlink

Anchors      ¶hidden      ¶ignored      ¶lockfile      ¶code      ¶doc      ¶image      ¶binary      ¶large

Predicates   [ext=ts]   [lang=rust]   [size>1000]   [mtime>2026-01-01]   [name="*.test.ts"]   [depth=N]   [empty]   [text]

Qualifiers   #listing   #tree[depth=N]   #stat
```

Hidden files are included by default (matches legacy `find`); filter with `-[¶hidden]`. Gitignore is respected by default; opt in to ignored files with `[¶ignored]`. Walker is built on the `ignore` crate.

### Text dialect
Every file has a parallel text view, entered automatically when a `§line`-class axis appears. Bypasses tree-sitter entirely.

```
Node kinds   §line       §chunk       §para       §span

Combinators  <<  >>     adjacent lines (context windows)

Predicates   [text~="re"]   [match="literal"]   [len>80]   [multiline]   [startsWith="…"]   [endsWith="…"]   [10..50]   [last]   [-3..]

Qualifiers   #raw   #text   #match   #captures[N]   #lines[a..b]   #bytes   #image   #thumbnail[N]
```

Multiline regex uses inline `(?m)` / `(?s)` flags. Encoding: UTF-8 default with latin-1 fallback and a `Diagnostic::EncodingFallback`.

### URI dialects
Seven internal URI schemes are registered as `Locator` dialects. After URI resolution, structural queries delegate to a downstream dialect (Markdown, JSON, FS, etc.).

| Scheme | Resolves to | Downstream dialect on `::Query` |
|--------|-------------|-------------------------------|
| `artifact://` | Stored artifact bytes/text | Text or Markdown depending on extension |
| `memory://` | Memory tree files | Markdown / Org |
| `skill://` | Skill files | FS for arbitrary, MD for SKILL.md |
| `agent://` | Agent JSON output | JSON sub-dialect |
| `jobs://` | Job state document | Job sub-dialect |
| `local://` | Plan artifact dir | FS, then resolved file's dialect |
| `pi://` | Internal Spell docs | FS, then resolved file's dialect |

---

## §F · Locator grammar extension

The `Locator` nonterminal extends to cover non-code addressing:

```
Locator    := UriLocator | FsLocator
UriLocator := Scheme "://" UriPath
FsLocator  := <project-relative path; literal and glob segments mixed>
Scheme     := "artifact" | "memory" | "skill" | "agent" | "jobs" | "local" | "pi"
```

FS glob operators (`*`, `**`, `?`, `[abc]`, `{a,b,c}`) are parsed by the `FsLexer`, not the kernel; the kernel sees them as `NamePayload`. The kernel still reserves `::`, `/`, `//`, `^`, `^^`, `<<`, `>>`, `|`, `&`, `-`, `→`, `#`. Literal segments containing these must backtick-quote (Q-1 rule from the dialects README applies).

`Locator` may stand alone with no `::Query` — that yields a NodeSet of files, replacing directory-listing commands.

Full specification: `code-path-extensions.md` §1.

---

## §G · Resolver dispatch state machine

The resolver tracks a *current scope dialect* per step. Transitions are mechanical; the user never declares a dialect, the axis chosen does.

```
Initial scope:                  FsDialect rooted at cwd (or `root` projection option)
After matching §file:           switch to file's code dialect (or stay FS for #listing/#stat)
First §line/§chunk/§para axis:  switch to text dialect for this file
Inside text dialect:            cannot return to code dialect mid-file (text loses tree position)
                                must ^ to file root, then re-enter via code-axis
Across → (edge axis):           cross-file; new file's dialect takes over
URI Locator resolution:         scheme dialect first; then delegate per the URI table
```

**Why no return-to-code from text:** text steps don't carry tree-sitter positions. To go text→code in the same file, the path must explicitly re-anchor: `foo.ts :: §line[42] / ^ / §file :: methodFoo` (re-resolves from file root). This keeps the resolver stateless across step boundaries — preserves the cost discipline and parallelism of streaming.

**Cost discipline:**
- Pure FS query (no `::`)         → walker only, no tree-sitter
- Text-only query (`§line` axes)  → line index only, no tree-sitter
- Code-only query                 → tree-sitter, current behavior
- Edge axis                       → code-graph lookup, current behavior
- Mixed                           → composition; each step picks the cheapest interpreter for its dialect

Full specification: `code-path-extensions.md` §3.