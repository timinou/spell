Resolve a CodePath. Read · search · list · stat · diff · graph — one verb.

target ::= Locator (Query)? (Qualifier)?
  Locator   path · glob · uri://
  Query     ::Sym  · ::§kind  · ::¶anchor  · ::field:  · A combinator B
  Pred      [N] [a..b] [text~="re"] [attr=val] [size>1M] [mtime>2026-01-01]
            [type_aware] [severity=error|warning|info|hint] [source=graph|semantic|both]
  Combinator  / // ^ ^^ << >> ref→ def→ call→ import→ bind→ implements→ inherits→ dispatches→ | & −
  Qualifier   #outline #body #sig #stat #tree #diff #listing #raw
              #hover #type_definition #signature #inlay #diagnostics

<recipes>
|want|target|
|---|---|
|read file (outline)|`foo.ts`  → symbol map, the default for code|
|read full text|`foo.ts#raw`|
|outline depth|`foo.ts#outline[depth=1]` (top-level only)|
|drill into a symbol|`foo.ts::Bar.method#body`  ← paste from outline|
|slice (last resort)|`foo.ts:80-130`|
|grep one|`foo.ts::§line[text~="TODO"]`|
|grep many|`src/**/*.ts::§line[text~="TODO"]`|
|find files|`src/**/*.ts`|
|tree|`src/#tree`|
|size|`foo.ts#stat`|
|diff|`foo.ts#diff`  ·  `#diff` (workspace)|
|symbol|`foo.ts::Bar.method`|
|symbol body|`foo.ts::Bar.method#body`|
|any function|`foo.ts::§function` (universal alias)|
|any method|`foo.ts::§method`|
|any class|`foo.ts::§class`|
|any call|`foo.ts::§call`|
|any import|`foo.ts::§import`|
|raw TS kind|`foo.ts::§function_declaration` (per-lang)|
|callers|`foo.ts::Bar.method def→`  (trailing → ≡ …def→§*)|
|filter callers|`foo.ts::Bar.method def→§call_expression`|
|definition|`foo.ts::useX ref→`|
|implementers|`foo.ts::IThing implements→`|
|base types|`foo.py::Cls inherits→`|
|signature / type|`foo.ts::Bar.method#hover` (smart-merge: see below)|
|graph-only signature|`foo.ts::Bar.method#hover [source=graph]`|
|LSP-only inferred|`foo.ts::x#hover [source=semantic]`|
|type of expression|`foo.ts::x#type_definition`|
|callable signature|`foo.ts::handler#signature`|
|inlay hints|`foo.ts::handler#inlay`|
|diagnostics|`src/**/*.ex#diagnostics [severity=error]`|
|type-narrowed callers|`foo.ts::Bar.method def→ [type_aware]`|
|recent|`src/**/*.ts::§file[mtime>2026-05-01]`|
|uri|`memory://root` · `artifact://…` · `skill://…`|
</recipes>

<symbol-first>
Reading a bare code file returns its `#outline` — a nested map of copy-pasteable
`file::Symbol` CodePaths (with signatures + ● exported / · local markers), NOT
the whole file. Work from those handles: drill a symbol with `file::Sym#body`,
edit it with `edit { target: "file::Sym#body" }`. Reach for `#raw` only when you
truly need the full text, and `:A-B` line slices only as a last resort — they
drift and review worse than symbol targets.
</symbol-first>

<!-- @generated:find-recipes -→
## Qualifiers

|qualifier|applies to|args|
|---|---|---|
|#bytes|file|—|
|#captures|grep|N after [text~="(re)"]|
|#image|file|—|
|#lines|file|a..b|
|#listing|dir|—|
|#match|grep|after [text~="re"]|
|#raw|file|—|
|#stat|file, dir|—|
|#text|file|—|
|#thumbnail|file|N|
|#tree|dir|depth=N|

## Edge kinds

|symbol|name|description|
|---|---|---|
|bind→|Bind|From a use to its binding site (scope-local)|
|call→|Call|From a call site to the callee|
|def→|Definition|From a declaration to its references (set-valued). Trailing `→` is sugar for `…def→§*`. Follows re-export chains.|
|dispatches→|Dispatches|From a polymorphic call site to candidate dispatch targets|
|implements→|Implements|From a type to the interface/trait it implements (TS `implements`, Rust `impl Trait for X`)|
|import→|Import|From an imported name to the source module|
|inherits→|Inherits|From a type to its base type (TS `extends`, Python `class X(Base)`)|
|ref→|Reference|Follow a reference to its definition|
<!-- @end -→

<rules>
- one field: `target`. Slicing/grep/range/tree/stat all live in the target string
- errors render at kernel via miette — read & retry
- globs ✗ slice  ·  uri ✗ query  ·  graph edges (def→/ref→/call→/import→/bind→) need `status index` ready
</rules>

## Semantic notes
- `#hover` smart-merges tree-sitter (written) + LSP (inferred); `[source=graph|semantic]` picks one half. `#hover_inferred` ≡ `#hover [source=semantic]` (deprecated).
- semantic qualifiers (`#hover` `#signature` `#type_definition` `#inlay` `#diagnostics`) are read-only views — ✗ `edit` targets; edit via `#body`/`#sig`.
- missing LSP binary → graceful degrade to tree-sitter `#hover` only.
- deep reference (hover merge matrix, 17-language LSP table): `pi://find-tool-reference.md` — read it when a semantic qualifier behaves unexpectedly.