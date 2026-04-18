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
  · axis operators (incl. edges)          ref~> def~> call~> bind~>
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
  · which anchors the language ships             // ~return, ~guard, ~hook-deps
```

The *interpreter* changes per language. The *grammar* does not.

---

## 1 · The shared grammar — one DSL, chumsky-built once

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
           | "~>>"    // edge axis (see §4)
           | "|" | "&" | "-"   // set combinators (see §5)

Step       := Axis? Head Predicate*
Axis       := "@"           // structural (node-kind payload)
           | ":"            // tree-sitter field
           | "~"            // language-registered anchor
           |                // (none) ⇒ semantic/name payload

Head       := NamePayload   // interpreted by LanguageProfile's NameLexer
           | NodeKind       // after "@"; a tree-sitter kind string
           | FieldName      // after ":"; a grammar field name
           | AnchorName     // after "~"; a profile-registered identifier
           | "(" Query ")"  // grouping / subquery

Predicate  := "[" Integer "]"                        // ordinal
           |  "[" Range   "]"                        // slice: [0..3] [last] [-1]
           |  "[" "@" NodeKind "]"                   // kind filter
           |  "[" "~" AnchorName "]"                 // anchor filter
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
src/api.ts :: Foo/bar/@if[0]:consequence       // mix axes; positional predicate
src/api.ts :: handleClick/@call[name=fetch]/:arguments[0]
                                               // predicate is a language-native
                                               //  attribute on a structural step

src/api.ts :: //@arrow_function[.~hook-deps]   // descendant + has-anchor predicate
src/api.ts :: Foo/bar^^[@class]                // nearest enclosing class
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
@       NodeKind (string)      tree-sitter grammar
:       FieldName (string)     tree-sitter grammar
~       AnchorName (string)    LanguageProfile::anchors
```

Predicates are uniform across axes. `[0]`, `[last]`, `[@class_declaration]`, `[name=foo]`, `[.~guard]`, `[text~="TODO"]` — all composable, all shared-grammar, all chumsky-parsed in one place.

**NamePayload is the only dialect-pluggable piece.** It answers three questions for each language:

```rust
pub trait NameLexer: Send + Sync {
    /// Parse a name token from input. TS accepts dotted `Foo.bar.baz`;
    /// Rust accepts `crate::a::b::c`; Elixir accepts `Mod.fn/2`;
    /// CSS accepts `tag#id.class`; Markdown accepts `ident | "quoted text"`.
    fn parse<'src>(&self, input: &'src str) -> IResult<'src, NamePayload>;

    /// Render a NamePayload back to its canonical text form.
    fn render(&self, n: &NamePayload) -> String;

    /// Given a NamePayload and a node, does this node's
    /// (NameExtractor output + AttributeEnrichment) match?
    fn matches(&self, n: &NamePayload, node: Node<'_>, profile: &LanguageProfile, src: &str) -> bool;
}
```

That's the entire language-specific contract for CodePath querying. ~80–150 lines of chumsky per language — same rough budget as v2, but now the language's responsibility is narrow and testable in isolation.

The step head `Foo.bar.baz` in TS parses as *one* NamePayload with three dotted segments; the resolver walks the grammar the same way today's `resolve_symbol` does (top-level then member-chain). `Mod::item::method` in Rust parses as *one* NamePayload with `::`-separated segments. The **outer** combinators `/` and `//` and `^^` are still available — you can still descend structurally *after* the semantic name resolves. The semantic run compresses into one step; the structural descent into its body is the next step.

```
src/api.ts :: Foo.bar/@if[0]                // "Foo.bar" is ONE name step
                                            //  then structural descent
src/lib.rs :: crate::util::parse/@match[0]  // same idea, Rust-style dots
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

## 4 · Edge axis `~>` — first-class, shared

Now that the outer grammar is uniform, edges fit cleanly. You reinstated edge resolution; here's how it lands without fracturing anything.

`~>` is an axis combinator just like `/`. It separates steps, and its kind determines the relation:

```
ref~>     // follow a reference to its definition
def~>     // from a declaration to its references (set-valued)
call~>    // from a call site to the callee declaration
bind~>    // from a use to its binding site (scope-local)
import~>  // from an imported name to the source module's declaration
```

Syntactically identical to `/` — same step grammar on both sides. Semantically different: the resolver consults the **code graph** (your `pi-code-graph`) instead of the syntax tree when it crosses a `~>`.

Examples:

```
src/api.ts :: handler/@call[name=fetch]/ref~>          // fetch's definition
src/util.ts :: parseConfig/def~>                       // all references to parseConfig
                                                       //  (set-valued; see §5)
src/api.ts :: handler/ref~>/#body                      // handler's definition, body only
lib/my_app/greeter.ex :: call~>/#sig                   // the signature of whatever
                                                       //  the nearest call dispatches to
```

Four payoffs:

```
E1  The C1–C6 contract extends unchanged: a single-valued edge axis still
    resolves to one node. Set-valued edges (def~>) return a NodeSet, see §5.

E2  Cross-file paths become legible. `ref~>` crosses files; the *result*
    path shows `other/file.ts :: Foo/bar` when rendered canonically.

E3  `pi-code-graph` doesn't need a parallel addressing scheme. Today it
    has its own `GraphNodeSummary`; after v3, a graph node IS a CodePath
    that starts with the symbol's declaration. One type, two code paths
    into it (syntax tree walk vs graph lookup).

E4  The LLM's "rename across the codebase" op becomes
       def~> . { rename(#name, "newName") }
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
  [@kind count>3]        nodes with more than 3 children of that kind
  [.call[name=fetch] 0]  nodes with zero such descendants

Join-ish: subquery with capture (for refactor pipelines)
  //(Foo/bar) as $m      capture each matched node as $m
  $m/ref~>#name          refer back to captured
```

Examples that are *useful*, not just possible:

```
# All TS methods that call fetch but do not await
// map() ~ @method[.@call[name=fetch]][.^@await_expression 0]
src/api.ts :: //@method[.@call[name=fetch]][.//@await_expression 0]

# Every React component with useState but no useEffect
src/ :: //@function[.//@call[name=useState]] - //@function[.//@call[name=useEffect]]

# All callsites of parseConfig not inside tests
src/ :: parseConfig/def~> - src/**/*.test.ts :: *

# Every Rust fn annotated with #[test] in this crate
crate/ :: //@fn[.^~test-attr]
```

Everything composes from: combinators (`/`, `//`, `^^`, `~>`, `|`, `&`, `-`) + predicates (`[…]`) + axes (`@`, `:`, `~`) + payloads (dialect). **No query-specific grammar**. The "search and query" facility is emergent from the path grammar plus set ops — which is exactly the resilience you want, because the LLM learns one thing and uses it five ways.

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
X/def~>                                 references
X/def~>/*^^[@function]                  context-like (enclosing fn of each ref)
X/def~>//@call_expression               impact-like (all calls within refs)
X/ref~> (iterated)                      flow-like
```

They can remain as convenience tools — but they all return CodePaths and accept CodePaths, so the API surface collapses.

---

## 6 · The Dialect trait, narrowed

Compared to v2's `LanguageDialect { parse, render, resolve, generate, suggest }`, v3's obligations shrink dramatically:

```rust
pub struct LanguageDialect {
    pub name_lexer:  Arc<dyn NameLexer>,      // the only truly custom parser
    pub anchors:     Vec<AnchorPattern>,      // ~name registry
    pub qualifiers:  Vec<QualifierSpec>,      // #name registry
    pub edge_kinds:  EdgeKindSet,             // which ~> variants this language supports
                                              //   (default: ref, def, call, import)
}
```

No parser per language for the outer grammar. The kernel ships one chumsky parser and substitutes the dialect's NameLexer where the `Head` nonterminal lives.

Same for rendering: the outer renderer is kernel, only `NamePayload` rendering is dialect. Same for error messages — the kernel's chumsky errors handle combinators; dialect errors handle names. Diagnostic output is composed, not parallel.

This is as far inward as the language-specific pocket can shrink while preserving "feels native in the payload". Anything smaller and TS devs see `@` and `~` and feel they're reading a grammar meta-language; anything larger and Rust and Elixir devs can't share a predicate vocabulary.

---

## 7 · Examples at the level of "does this feel right?"

Same query shape, different dialects, sanity check:

```
# "the body of the method that handles POST"
src/api.ts :: //@method[.@string_literal[text~="^POST"]]#body
src/api.rs :: //@fn[.@attribute[text~="post"]]#body
lib/api.ex  :: //@def[name=handle_post]#body
page.html   :: //form[method=post]#innerHTML
```

What a TS dev reads: "descend to any method whose subtree contains the string POST, take its body". What a Rust dev reads: "descend to any fn with a #[post…] attribute, take its body". The operators are identical; the **name predicate** is dialect (string literal matcher for TS, attribute matcher for Rust). Neither dev has to learn the *other* language's payload to read the operators.

```
# "rename all callers of parseConfig that live outside tests"
src/ :: parseConfig/def~> - src/**/*.test.ts :: *    →  rename(#name, "loadConfig")
```

Single line. Works in any language whose profile registers the `def~>` edge. Same grammar; the NameLexer changes what `parseConfig` *means* in each language.

---

## 8 · Existing pi-code-engine DSL plugs in unchanged

The primitives the user named — `RuleExpr`, `SelectorBuilder`, `ActivationBuilder` — become the **Rust-side analogue of predicates**:

```
textual                  Rust builder
──────────────────────   ──────────────────────────────────────
[@if_statement]          rule("if_statement")
[@call][name=fetch]      rule("call_expression") with name filter
[text~="TODO"]           rx("TODO")
[.~guard]                anchor filter — new, but composable
-@comment                exclude(All, rule("comment"))
```

`matches_rule_expr` is already the semantic engine behind structural predicates. Any textual predicate is a deserialized `RuleExpr`. Any Rust-built path compiles to the same textual form. Round-trip is trivial because the shared grammar is the bridge — no dialect has to teach `RuleExpr` about itself.

---

## 9 · Cutover, reduced

Because v3 pushes most of v2's effort into the kernel (one chumsky grammar instead of N), the dialect work is small and parallel:

```
Step 1   Shared grammar in kernel
         - chumsky grammar for outer query algebra
         - LegacyNameLexer that parses today's `Foo.bar` for every language
         - Kernel resolver that composes: combinator walker + NameLexer dispatch
         - Zero behavior change at this point.

Step 2   Predicates + axes
         - `@`, `:`, predicates `[…]`, ordinals, has-descendant subquery
         - This unlocks every "unnameable node" use-case in one step.

Step 3   Qualifiers
         - #body/#name/#sig per language via QualifierSpec registry
         - Deprecate `scope: "body"` edit parameter.

Step 4   Edge axis ~>
         - Wire pi-code-graph as the edge resolver backend.
         - Start with ref~> and def~>; others follow as graph coverage grows.

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
