# `find` tool — deep reference

Extended reference for the `find` CodePath tool. The operational grammar,
recipes, and kernel-generated qualifier/edge tables live in the tool
description itself (`packages/coding-agent/src/prompts/tools/find.md`);
this file holds the lookup material that rarely changes a decision mid-task.

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
or `#sig` to scope to the body or signature region of a symbol.

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
