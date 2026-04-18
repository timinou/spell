# CodePath Dialects — Overview

Companion to `specs/code-graph/code-path.md`. That document defines the shared query algebra; this directory defines each language's `NameLexer`, qualifier/anchor/edge registries, edge cases, and test suites.

---

## 0 · Sigil revision

The kernel sigils have been re-keyed to eliminate collisions with in-language syntax. Wherever `code-path.md` uses `@`, `~`, or `~>`, substitute:

```
old    new    role                                   why the change
@   →  §      node-kind axis (structural)            `@` collides with XPath attributes,
                                                     Python/Rust decorators/attributes,
                                                     Haskell pragmas
~   →  ¶      anchor axis (language landmarks)       `~` collides with Haskell lazy
                                                     patterns and is the prefix of the
                                                     old edge axis
~>  →  →      edge axis (code-graph traversal)        single grapheme; not decomposable;
                                                     reads as "references-arrow" in prose
:      :      field axis                             unchanged — safe in Step position
#      #      qualifier suffix                       unchanged — bracket-isolated
```

Full kernel grammar with the new sigils:

```
CodePath   := Locator "::" Query Qualifier?
Query      := Step ( Combinator Step )*
Combinator := "/" | "//" | "^" | "^^" | "<<" | ">>"
           |  "|" | "&" | "-"
           |  Edge                             // ref→  def→  call→  import→  bind→ ...
Step       := Axis? Head Predicate*
Axis       := "§"           // structural (node-kind payload)
           |  ":"           // tree-sitter field
           |  "¶"           // language-registered anchor
           |                // (none) ⇒ semantic/name payload
Predicate  := "[" Integer "]"
           |  "[" Range   "]"
           |  "[" "§" NodeKind "]"
           |  "[" "¶" AnchorName "]"
           |  "[" "." Query "]"
           |  "[" Attr   "]"
Qualifier  := "#" Ident Args?
```

Examples re-read as:

```
src/api.ts :: Foo/bar#body
src/api.ts :: handleClick/§call[name=fetch]/:arguments[0]
src/api.ts :: //§arrow_function[.¶hook-deps]
src/api.ts :: Foo/bar^^[§class]
src/api.ts :: parseConfig/def→ - src/**/*.test.ts :: *
lib/my_app/greeter.ex :: call→/#sig
```

All dialect documents in this directory assume this scheme.

---

## 1 · Dialect trait recap

```rust
pub struct LanguageDialect {
    pub name_lexer:  Arc<dyn NameLexer>,
    pub anchors:     Vec<AnchorPattern>,
    pub qualifiers:  Vec<QualifierSpec>,
    pub edge_kinds:  EdgeKindSet,
}

pub trait NameLexer: Send + Sync {
    fn parse<'s>(&self, input: &'s str) -> IResult<'s, NamePayload>;
    fn render(&self, n: &NamePayload) -> String;
    fn matches(&self, n: &NamePayload, node: Node<'_>,
               profile: &LanguageProfile, src: &str) -> bool;
}
```

One file per dialect, each structured as:

```
A  NamePayload shape + composition rules
B  Qualifier, anchor, edge registries
C  Worked examples (5–8 realistic paths)
D  Edge cases
E  Test suite (stubs the dialect implementation must pass)
```

---

## 2 · Dialect index

```
01  TypeScript / JavaScript / TSX    01-typescript.md
02  Rust                              02-rust.md
03  Python                            03-python.md
04  Go                                04-go.md
05  Haskell                           05-haskell.md
06  HTML  (vendored XPath)            06-html.md
07  CSS   (vendored cssparser)        07-css.md
08  Markdown / Org                    08-markdown-org.md
```

---

## 3 · Shared NameLexer conventions

These apply to every dialect unless its own document overrides:

```
Q-1  Quoting: any NamePayload segment that would otherwise tokenize
     ambiguously MUST be quotable with backticks. The NameLexer
     unquotes on parse; renderer re-quotes on round-trip.
         src/api.ts :: `weird/name with spaces`
Q-2  Round-trip: parse → render → parse is identity on the AST,
     even if whitespace or quoting differs textually.
Q-3  Precedence: the payload parser is greedy up to the first
     unquoted kernel operator (`/`, `//`, `^`, `^^`, `<<`, `>>`,
     `|`, `&`, `-`, `→`, `#`, or end-of-input).
Q-4  Unicode: NameLexer identifiers accept the language's own
     identifier grammar verbatim, including Unicode where the
     language allows (e.g. TS, Rust, Haskell, Python all do).
Q-5  Ambiguity: if two declarations share a payload, the resolver
     returns an AmbiguousName diagnostic with the candidate list
     rendered in dialect syntax — never a silent pick.
```

---

## 4 · Cross-dialect contract test (shared)

One fixture per language containing the same conceptual program; one query shape applied to each; the result set must agree in cardinality and semantic role:

```
Query intent:  "every definition whose body contains the literal TODO"

src/**/*.ts   :: //[.§string_literal[text~="TODO"]]#body
src/**/*.rs   :: //[.§string_literal[text~="TODO"]]#body
src/**/*.py   :: //[.§string[text~="TODO"]]#body
pkg/**/*.go   :: //[.§interpreted_string[text~="TODO"]]#body
src/**/*.hs   :: //[.§string[text~="TODO"]]#body
styles/*.css  :: //[.§declaration[text~="TODO"]]#block
*.html        :: //*[contains(text(), 'TODO')]           -- XPath native
*.md          :: //[.§inline[text~="TODO"]]^^
```

Operator skeleton identical. Payload predicates localized. The dialect's test suite must include this cross-dialect case as a smoke test against the operator semantics.

---

## 5 · Registration checklist for new languages

```
R-1  Implement NameLexer (parse/render/matches)
R-2  Declare AnchorPattern list with stable ¶ names
R-3  Declare QualifierSpec list with #names, applies_to RuleExpr,
     and QualifierResolver implementations
R-4  Declare EdgeKindSet subset of (ref, def, call, import, bind, type)
     plus any language-specific edges
R-5  Ship round-trip corpus:  100+ real CodePath strings from the
     language, parsed → rendered → parsed, AST equality asserted
R-6  Ship resolver corpus:  each example in the dialect doc as a
     (fixture, path, expected-node-range) triple
R-7  Ship negative corpus:  malformed paths, ambiguous names,
     unreachable targets, each mapped to expected diagnostic variant
R-8  Wire into LanguageProfile registry; grammar binding unchanged
R-9  Cross-dialect smoke test (§4) must pass
```

The dialect is ready to ship when R-1 through R-9 are green.
