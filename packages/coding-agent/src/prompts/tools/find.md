Resolve a CodePath. Read · search · list · stat · diff · graph — one verb.

target ::= Locator (Query)? (Qualifier)?
  Locator   path · glob · uri://
  Query     ::Sym  · ::§kind  · ::¶anchor  · ::field:  · A combinator B
  Pred      [N] [a..b] [text~="re"] [attr=val] [size>1M] [mtime>2026-01-01]
            [type_aware] [severity=error|warning|info|hint] [source=graph|semantic|both]
  Combinator  / // ^ ^^ << >> ref→ def→ call→ import→ bind→ implements→ inherits→ dispatches→ | & −
  Qualifier   #body #sig #stat #tree #diff #listing #raw
              #hover #type_definition #signature #inlay #diagnostics

<recipes>
| want                | target                                      |
|---------------------|---------------------------------------------|
| read file           | `foo.ts`                                    |
| slice               | `foo.ts:80-130`                             |
| grep one            | `foo.ts::§line[text~="TODO"]`               |
| grep many           | `src/**/*.ts::§line[text~="TODO"]`          |
| find files          | `src/**/*.ts`                               |
| tree                | `src/#tree`                                 |
| size                | `foo.ts#stat`                               |
| diff                | `foo.ts#diff`  ·  `#diff` (workspace)       |
| symbol              | `foo.ts::Bar.method`                        |
| symbol body         | `foo.ts::Bar.method#body`                   |
| any function        | `foo.ts::§function` (universal alias)        |
| any method          | `foo.ts::§method`                            |
| any class           | `foo.ts::§class`                             |
| any call            | `foo.ts::§call`                              |
| any import          | `foo.ts::§import`                            |
| raw TS kind         | `foo.ts::§function_declaration` (per-lang)   |
| callers             | `foo.ts::Bar.method def→`  (trailing → ≡ …def→§*) |
| filter callers      | `foo.ts::Bar.method def→§call_expression` |
| definition          | `foo.ts::useX ref→`                         |
| implementers        | `foo.ts::IThing implements→`               |
| base types          | `foo.py::Cls inherits→`                    |
| signature / type    | `foo.ts::Bar.method#hover` (smart-merge: see below) |
| graph-only signature| `foo.ts::Bar.method#hover [source=graph]`   |
| LSP-only inferred   | `foo.ts::x#hover [source=semantic]`         |
| type of expression  | `foo.ts::x#type_definition`                 |
| callable signature  | `foo.ts::handler#signature`                 |
| inlay hints         | `foo.ts::handler#inlay`                     |
| diagnostics         | `src/**/*.ex#diagnostics [severity=error]`  |
| type-narrowed callers | `foo.ts::Bar.method def→ [type_aware]`     |
| recent              | `src/**/*.ts::§file[mtime>2026-05-01]`     |
| uri                 | `memory://root` · `artifact://…` · `skill://…` |
</recipes>

<!-- @generated:find-recipes -->
## Qualifiers

| qualifier | applies to | args |
|---|---|---|
| #bytes | file | — |
| #captures | file, symbol | N |
| #image | file | — |
| #lines | file | a..b |
| #listing | dir | — |
| #match | file, symbol | — |
| #raw | file | — |
| #stat | file, dir | — |
| #text | file | — |
| #thumbnail | file | N |
| #tree | dir | depth=N |

## Edge kinds

| symbol | name | description |
|---|---|---|
| bind→ | Bind | From a use to its binding site (scope-local) |
| call→ | Call | From a call site to the callee |
| def→ | Definition | From a declaration to its references (set-valued). Trailing `→` is sugar for `…def→§*`. Follows re-export chains. |
| import→ | Import | From an imported name to the source module |
| ref→ | Reference | Follow a reference to its definition |
| implements→ | Implements | From a type to the interface/trait it implements (TS `implements`, Rust `impl Trait for X`) |
| inherits→ | Inherits | From a type to its base type (TS `extends`, Python `class X(Base)`) |
| dispatches→ | Dispatches | From a polymorphic call site to candidate dispatch targets |
<!-- @end -->

<rules>
- one field: `target`. Slicing/grep/range/tree/stat all live in the target string
- errors render at kernel via miette — read & retry
- globs ✗ slice  ·  uri ✗ query  ·  graph edges (def→/ref→/call→/import→/bind→) need `status index` ready
</rules>

## `#hover` smart-merge

`#hover` consults BOTH the graph-side (tree-sitter written signature) AND
the semantic-side (LSP inferred type) backends, then merges:

| graph result    | LSP result    | output                                |
|-----------------|---------------|---------------------------------------|
| `x`             | `x`           | `x`                                   |
| `x`             | —             | `x [source: graph]`                   |
| —               | `y`           | `y [source: semantic]`                |
| `x`             | `y` (≠)       | `written:  x` / `inferred: y`         |
| —               | —             | `unknown`                             |

Default behaviour is `[source=both]` (smart-merge). Use `[source=graph]`
to skip the LSP query (cost-sensitive paths) or `[source=semantic]` to
ignore the written annotation.

The deprecated `#hover_inferred` qualifier was folded into
`#hover [source=semantic]` (FUP-097).

Read-only semantic qualifiers (`#hover`, `#type_definition`, `#type_def`,
`#signature`, `#inlay`, `#diagnostics`) cannot be used as `edit` targets
— they describe a *view* of code, not a region. For editing, use `#body`
or `#sig` to scope to the body or signature region of a symbol. Use
`find { target: "… #qual" }` to inspect any of the read-only views.

## Languages

Semantic qualifiers (`#hover`, `#signature`, `#type_definition`,
`#inlay`, `#diagnostics`) dispatch via the per-workspace
`SemanticBackend`. 17 languages ship wired out of the box:

```
elixir       expert
rust         rust-analyzer
typescript   typescript-language-server
python       pyright-langserver
go           gopls
ruby         ruby-lsp
css          vscode-css-language-server
html         vscode-html-language-server
c / cpp      clangd  (shared)
swift        sourcekit-lsp
kotlin       kotlin-language-server
lua          lua-language-server
nix          nil
haskell      haskell-language-server-wrapper
java         jdtls
clojure      clojure-lsp
```

When an LSP binary is not on PATH, semantic dispatch degrades
gracefully to AnnotationSemanticBackend (tree-sitter `#hover` only); a
stderr warning is emitted on first use carrying the install hint.

Adding a new language is one stanza in
`crates/pi-code-graph/src/semantic/defaults.kdl` — zero Rust code
changes, zero new dependencies. See FUP-094 for the data-driven
fan-out playbook.

