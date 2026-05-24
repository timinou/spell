Resolve a CodePath. Read · search · list · stat · diff · graph — one verb.

target ::= Locator (Query)? (Qualifier)?
  Locator   path · glob · uri://
  Query     ::Sym  · ::§kind  · ::¶anchor  · ::field:  · A combinator B
  Pred      [N] [a..b] [text~="re"] [attr=val] [size>1M] [mtime>2026-01-01]
  Combinator  / // ^ ^^ << >> ref→ def→ call→ import→ bind→ | & −
  Qualifier   #body #sig #stat #tree #diff #listing #raw

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
| callers             | `foo.ts::Bar.method def→`                   |
| definition          | `foo.ts::useX ref→`                         |
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
| def→ | Definition | From a declaration to its references (set-valued) |
| import→ | Import | From an imported name to the source module |
| ref→ | Reference | Follow a reference to its definition |
<!-- @end -->

<rules>
- one field: `target`. Slicing/grep/range/tree/stat all live in the target string
- errors render at kernel via miette — read & retry
- globs ✗ slice  ·  uri ✗ query  ·  graph edges (def→/ref→/call→/import→/bind→) need `status index` ready
</rules>
