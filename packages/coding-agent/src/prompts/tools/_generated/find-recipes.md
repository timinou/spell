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

## Language dialects

| dialect | extensions | capabilities |
|---|---|---|
| clojure | clj, cljs, cljc, bb | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| css | css | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| edn | edn | outline, read, navigate, edit |
| elixir | ex, exs | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| html | html, htm | outline, outline_enrichment, read, navigate, resolve, edit, graph, embed:css, embed:javascript |
| markdown | md, mdx, markdown | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| org | org | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| python | py, pyi | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| rust | rs | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| text | — | — |
| typescript | ts, tsx, js, jsx, mjs, cjs, mts, cts | outline, outline_enrichment, read, navigate, resolve, edit, graph |
| typst | typ | outline, outline_enrichment, read, navigate, resolve, edit, graph |
