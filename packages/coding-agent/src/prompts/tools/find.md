Resolve a CodePath. Read · search · list · stat · diff · graph — one verb.

target ::= Locator (Query)? (Qualifier)?
  Locator   path · glob · uri://
  Query     ::Sym  · ::§kind  · ::¶anchor  · ::field:  · A combinator B
  Pred      [N] [a..b] [text~="re"] [attr=val] [size>1M] [mtime>2026-01-01]
            [type_aware] [severity=error|warning|info|hint] [source=graph|semantic|both]
  Combinator  / // ^ ^^ << >> ref→ def→ call→ import→ bind→ implements→ inherits→ dispatches→ | & −
  Qualifier   #body #sig #stat #tree #diff #listing #raw #hover
              #hover_inferred #type_definition #signature #inlay #diagnostics

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
| signature (written) | `foo.ts::Bar.method#hover`                  |
| signature (inferred)| `foo.ts::Bar.method#hover_inferred`         |
| type of expression  | `foo.ts::x#type_definition`                 |
| callable signature  | `foo.ts::handler#signature`                 |
| inlay hints         | `foo.ts::handler#inlay`                     |
| diagnostics         | `src/**/*.ex#diagnostics [severity=error]`  |
| type-narrowed callers | `foo.ts::Bar.method def→ [type_aware]`     |
| force tree-sitter   | `foo.ts::x#hover [source=graph]`            |
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
