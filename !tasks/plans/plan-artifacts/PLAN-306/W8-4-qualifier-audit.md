# Qualifier Coverage Audit (PLAN-306 W8.4)

**Audit scope**: 12 registered languages × 12 find-tool qualifiers.
**Analysis method**: read each language's dialect definition (`dialects/<lang>.rs` → `xxx_dialect()` `qualifiers` vec), qualifier test files (`code_resolver/<lang>_qualifier_tests.rs`), FS/text/diff qualifier implementations.

---

## 1. Coverage Matrix

### Legend
| Symbol | Meaning |
|--------|---------|
| ✓ | Supported and tested |
| ⚠️ | Declared in dialect but untested (no test coverage) |
| — | Not applicable (qualifier semantics don't match language structure) |
| ✗ | Semantic gap — qualifier expected but not wired |

### Rows

| Language | `dialect` | `#body` | `#sig` | `#stat` | `#tree` | `#listing` | `#raw` | `#diff` | `#lines[a..b]` | `#match` | `#captures[N]` | `#image` | `#thumbnail[SIZE]` |
|----------|-----------|---------|--------|---------|---------|------------|--------|---------|----------------|----------|---------------|----------|--------------------|
| TypeScript (`.ts/.tsx/.js/.jsx`) | `typescript_dialect()` | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Rust (`.rs`) | `rust_dialect()` | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Python (`.py/.pyi`) | `python_dialect()` | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| HTML (`.html/.htm`) | `html_dialect()` | — | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| CSS (`.css`) | `css_dialect()` | — | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Typst (`.typ`) | `None` | — | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Markdown (`.md/.mdx`) | `markdown_dialect()` | ✓ | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Elixir (`.ex/.exs`) | `elixir_dialect()` | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Clojure (`.clj/.cljs/.cljc/.bb`) | `None` | — | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| EDN (`.edn`) | `None` | — | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Org (`.org`) | `markdown_dialect()` (shared) | ✓ | — | ✓ | ✓ | ✓ | ⚠️ | ✓ | ⚠️ | ⚠️ | ✗ | ✓ | ✓ |
| Text (fallback, no ext) | `None` | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Notes on universals

`#stat`, `#tree`, `#listing`, `#diff` → dispatched through **FS resolver** (or special `diff_qualifier.rs`), not through language dialect. These work on **any file/directory target** regardless of language. Tests exist in `fs/qualifiers.rs` and `diff_qualifier.rs`.

`#raw`, `#lines[a..b]`, `#match`, `#image`, `#thumbnail[SIZE]` → dispatched through **Text resolver** on bare file targets. **On symbol targets** (`foo.ts::Foo#raw`) these fall back to the language dialect's qualifier specs — and no language dialect declares them, so they produce `unknown qualifier` diagnostics. This is a known architectural limitation: text qualifiers are not wired into any non-text language dialect. ✓ for Text language because it has no symbol resolver needed; ⚠️ for others because they work on bare files but fail if used after a `::Symbol` query.

### Test coverage detail

| Language | Qualifiers tested | Tests |
|----------|-------------------|-------|
| TypeScript | body ✓, sig ✓, return-type ✓, decorators ✓, type-params ✓ | `ts_qualifier_tests.rs` (10 tests) |
| Rust | body ✓, sig ✓, name ✓, generics ✓, attrs ✓ | `qualifier_tests.rs` (shared, 10+ tests) |
| Python | body ✓, sig ✓, docstring ✓, decorators ✓, return-annotation ✓, base-classes ✓ | `py_qualifier_tests.rs` (6 tests) |
| CSS | selector ✓, declaration ✓, value ✓, specificity ✓, prelude ✓ | `css_qualifier_tests.rs` (8 tests) |
| HTML | innerHTML ✓, outerHTML ✓, text ✓, attr ✓, tag ✓ | `html_qualifier_tests.rs` (8 tests) |
| Markdown/Org | body ✓, intro ✓, first-para ✓, level ✓, tags ✓; ⚠️ frontmatter, title, todo-state, properties, deadline (ignored, FEAT-678) | `mdorg_qualifier_tests.rs` (11+ tests, 6 ignored) |
| Elixir | body ⚠️, sig ⚠️ (declared but no qualifier test file; walker tests verify name resolution only) | `walker.rs` (2 elixir name tests) |
| Haskell | body ✓, sig ✓, name ✓, where-clause ✓, guards ✓, exports ✓, pragmas ✓ | `hs_qualifier_tests.rs` (9 tests) |
| Go | ∅ placeholder — no tests | `go_qualifier_tests.rs` (single placeholder comment) |

---

## 2. Gap Summary

| # | Language | Qualifier | Issue | Proposed FUP |
|---|----------|-----------|-------|-------------|
| 1 | **All** (via symbol query) | `#captures[N]` | Text dialect declares `#captures` for use after `#[text-match:~/(...)/]` predicate. Not wired into any language dialect's `qualifiers` vec, so `foo.ts::Foo#captures[0]` fails with "unknown qualifier" when routing through the code resolver. Workaround: use bare file target `foo.ts#captures[0]` (routes to TextResolver). | `FUP-001` |
| 2 | **All** (via symbol query) | `#raw` | Same architecture: text qualifiers are only dispatchable via `is_text_qualifier_only()` branch (bare file + qualifier). When combined with `::Symbol`, the code resolver rejects `#raw` as unknown. Workaround: pipe raw content through `#body` instead. | `FUP-002` |
| 3 | **All** (via symbol query) | `#lines[a..b]` | Same architecture gap as `#raw`/`#captures`. Symbol + `#lines` fails through code resolver. | `FUP-003` |
| 4 | **All** (via symbol query) | `#match` | Same architecture gap. Text dialect's `#match` requires a preceding `TextMatch` predicate in metadata, which the code resolver never populates. | `FUP-004` |
| 5 | **All** (via symbol query) | `#image` / `#thumbnail` | Same architecture gap. Image qualifiers only route through TextResolver. Symbol-targeted image extraction is unsupported. | `FUP-005` |
| 6 | **Elixir** | All qualifiers | Elixir declares `body`, `sig`, `name`, `docstring` in `elixir_dialect()` but has **zero qualifier tests**. Walker tests verify name resolution (`Calc.add`) only. Assertions are informational — tests pass but don't exercise qualifiers. | `FUP-006` |
| 7 | **Go** | All qualifiers | Go dialect declares 9 qualifiers (`body`, `sig`, `name`, `receiver`, `returns`, `type-params`, `struct-tag`, `interface-method-set`, `named-returns`) but `go_qualifier_tests.rs` is an empty placeholder. Go is also **not registered** in `with_builtins()` — test-only. | `FUP-007` |
| 8 | **Haskell** | All qualifiers | Haskell dialect has 8 qualifiers and full test coverage, but is **not registered** in `with_builtins()`. Test-only, like Go. | `FUP-008` |
| 9 | **Markdown/Org** | `#title`, `#frontmatter`, `#todo-state`, `#properties`, `#deadline` | Declared in `markdown_dialect()` but 6+ tests `#[ignore]`d due to `FEAT-678` tree-sitter grammar mismatch between markdown and org grammars. The org grammar (`tree_sitter_org`) tags nodes differently than md (`tree_sitter_md`), breaking the shared dialect's qualifier resolvers. | `FUP-009` |
| 10 | **CSS** | `#body`, `#sig` | CSS has its own concept of "body" (declaration block) and "sig" (selector + prelude), but uses different qualifier names: `#selector`, `#specificity`, `#prelude`, `#value`, `#declaration[prop]`. No CSS-specific `#body`/`#sig` aliases exist. Intentional design choice, not a regression. | *won't fix* |

---

## 3. Universal Qualifiers

These qualifiers work on **any file target** regardless of language, via dispatch to FS/Text resolvers:

| Qualifier | Dispatch Path | Test Coverage |
|-----------|--------------|---------------|
| `#stat` | `FsResolver` | `fs/qualifiers.rs` — 5 tests (metadata, lineCount, binary sniff) |
| `#tree` | `FsResolver` | `fs/qualifiers.rs` — 1 test (depth cap) |
| `#listing` | `FsResolver` | `fs/qualifiers.rs` — 1 test (one-level children) |
| `#diff` | `diff_qualifier.rs` (intercepted in napi.rs before FsResolver) | `diff_qualifier.rs` — 8 tests (clean tree, modified, new, deleted, workspace, historical, non-git, since date) |
| `#raw` | `TextResolver` (bare file only) | `text/qualifiers.rs` — 2 tests (utf8, latin1 fallback) |
| `#bytes` | `TextResolver` | `text/qualifiers.rs` — 1 test |
| `#lines[a..b]` | `TextResolver` (bare file only) | `text/qualifiers.rs` — 1 test |
| `#match` | `TextResolver` (bare file only, needs preceding TextMatch predicate) | `text/qualifiers.rs` — 1 test |
| `#captures[N]` | `TextResolver` (bare file only, needs `captures` metadata) | `text/qualifiers.rs` — 2 tests (valid index, OOB) |
| `#image` | `TextResolver` (bare file only) | `text/qualifiers.rs` — 2 tests (PNG dims, large file) |
| `#thumbnail[SIZE]` | `TextResolver` (bare file only) | `text/qualifiers.rs` — 1 test (resize) |

**Key restriction**: These are safe bets for the recipe table in `find.md` when the target is a **bare file or directory**. They **cannot** be composed with `::Symbol` queries (e.g. `foo.ts::Foo#body#raw` fails because the code resolver doesn't understand text qualifiers).

### Non-universal: `#body`, `#sig`

These are **language-scoped** — only work on languages whose dialect declares them:

| Has `#body` | Has `#sig` |
|-------------|------------|
| TypeScript ✓ | TypeScript ✓ |
| Rust ✓ | Rust ✓ |
| Python ✓ | Python ✓ |
| Markdown ✓ | — |
| Org ✓ (shared md dialect) | — |
| Elixir ✓ | Elixir ✓ |
| Haskell ✓ (test-only) | Haskell ✓ (test-only) |
| Go ✓ (test-only) | Go ✓ (test-only) |

No `#body`/`#sig`: HTML, CSS, Typst, Clojure, EDN, Text.

---

## 4. Language-Specific Quirks

### TypeScript
- **Arrow function unwrapping**: `variable_declarator` with arrow value unwraps to access arrow's body/sig/return-type. Tests cover `const handler = (x: number): Promise<void> => { return x; }`.
- **JSX qualifiers**: `#jsx-children` and `#jsx-attrs` are not in the 12-column matrix but exist in the dialect. They work on `jsx_element`/`jsx_self_closing_element` nodes.

### Rust
- **Richest anchor set** (10 anchors): test-body, bench-body, unsafe, return, guard, error-path, first-use, last-use, mod-side-effect, doc-comment.
- **Turbofish-aware name lexer**: `Vec::<T>::new` parses as `turbofish("T")` segment.
- **9 qualifiers**: body, sig, name, generics, where, attrs, visibility, match-arm, unsafe-block.

### Python
- **Decorator handling**: `decorated_definition` wraps the target definition; `#decorators` qualifier walks up to the parent decorated_definition node.
- **6 anchors**: return, guard, async, default-param, first-import, last-import.

### CSS
- **No `#body`/`#sig`** — uses `#selector`, `#prelude`, `#value`, `#declaration[prop]`, `#specificity`, `#important`.
- **Pseudo-element anchor filters**: `¶important`, `¶custom-prop`, `¶vendor-prefix` — these are predicate-time filters, not qualifiers.

### HTML
- **No `#body`/`#sig`** — uses `#innerHTML`, `#outerHTML`, `#text`, `#attr[name]`, `#tag`.
- **Self-closing elements**: `#innerHTML` on `<br/>` emits a diagnostic about empty range (tested).
- **Single anchor**: `¶landmark-by-role` matches `<header>`, `<nav>`, `<main>`, `<footer>`, `<aside>`, `<section>`, `<article>` or any element with `role="…"` attribute.

### Markdown / Org
- **Shared dialect** — both `.md` and `.org` use `markdown_dialect()`. This causes tree-sitter grammar mismatches (FEAT-678): the org grammar's node kind names differ from markdown's, so qualifier resolvers written for markdown node kinds fail on org AST shapes.
- **6 ignored tests** (FEAT-678): title, frontmatter, todo-state, properties, deadline — all declared and implemented but failing on org grammar.
- **14 qualifiers** — the most of any dialect.

### Elixir
- **4 qualifiers, zero tests**: body, sig, name, docstring declared but no qualifier test file exists. Walker tests only check name-based symbol resolution.
- **Arity-aware name lexer**: `Foo.bar/2` parses as `Quoted("Foo.bar/2")`.

### Clojure / EDN / Typst
- **`dialect: None`** — no language-specific qualifiers at all. Only FS/text universals work.
- **Typst** has heading procedures (promote/demote) but no qualifier resolvers.

### Go / Haskell
- **Not registered** in `with_builtins()`. Go has 9 qualifiers (0 tested), Haskell has 8 qualifiers (fully tested). Both are test-only; production registration is a separate task.

### Text (fallback)
- **Only language** where `#raw`, `#lines`, `#match`, `#captures`, `#image`, `#thumbnail` work on both bare files and any composition, since the text dialect has no symbol resolver. This is the "last resort" resolver for unknown file types.
