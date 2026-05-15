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
