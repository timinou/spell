# W4 Review — Universal `#hover` qualifier

## Files reviewed
- `crates/pi-natives/src/code_path/code_resolver/walker.rs` (hover branch L170–188; SymbolSlice interaction L167–169; outline branch L102–134 for comparison)
- `crates/pi-natives/tests/hover_qualifier_e2e.rs`
- Confirmed no existing dialect registers a `hover` qualifier (searched `crates/pi-code-path/src/dialects/**`).

## Verdict
**needs-fix** — the universal hover scanner has correctness gaps that the e2e suite cannot catch. Range/UTF-8 arithmetic is sound; truncation heuristic and SymbolSlice interaction are not.

## Findings

### F1 [HIGH] walker.rs:178–182 — multi-line signatures truncate at first `\n`
`sig_end = decl_text.find(|c| c == '{' || c == '\n').or_else(|| decl_text.find("=>"))`
For any declaration whose parameter list wraps:
```ts
function foo(
  x: number,
  y: number,
): number {
```
the first `\n` lands right after `function foo(`, so hover returns `function foo(`. This is the common case in Python (`def …(\n    …\n):`) and Rust (`fn …(\n    …\n) -> T {`), both of which W4 advertises as supported. Tests use only single-line signatures so the regression is invisible.
**Fix:** scan for depth-0 `{` / `=>` / end-of-decl; only fall back to `\n` when nothing else matches, or use the tree-sitter children to find the body node and slice up to its `start_byte()`.

### F2 [MED] walker.rs:178–182 — first `{` lands inside parameter/generic/default object literals
The "first `{`" heuristic mis-fires for:
- TS object types: `function f(opts: { x: number }): number { … }` → `function f(opts: `
- Object-literal defaults: `function f(o = { a: 1 }) { … }`
- Generic defaults: `function f<T = { K: V }>() { … }`
- Python set/dict defaults: `def f(x = {1, 2}): …`
Same root cause as F1: naive char scan ignores brace depth and string boundaries.
**Fix:** balanced-pair scan, or walk tree-sitter children to locate the actual body node.

### F3 [MED] walker.rs:167–188 — SymbolSlice + #hover silently drops the slice
`apply_symbol_slice` (L168) rewrites `nref.range/content/kind`. The very next branch re-reads `&src[node.start_byte()..node.end_byte()]` (the unsliced declaration) and overwrites `nref.range` / `nref.content`. Mixing `SymbolSlice` with `#hover` returns the unsliced signature with no diagnostic. Either feed hover from the slice range, or push an `UnsupportedOperation` diagnostic when both predicates are present.

### F4 [LOW] walker.rs:176 — universal hover shadows any dialect-registered `hover`
The `q.name == "hover"` branch runs before `dialect.qualifiers.iter().find(...)` and `continue`s past it. A dialect that later registers its own `hover` (e.g. richer Elixir/Rust hover with `///` doc capture) will be silently shadowed: registration validates, but the resolver never reaches it. Today no dialect uses the name, so this is foresight only. Either reserve `hover` as a universal name in `LanguageDialect` (with a debug-time check), or attempt dialect dispatch first and fall back to the universal stub.

### F5 [LOW] walker.rs:178–182 — expression-body arrow asymmetry
For `const f = (x) => x + 1`, no `{` and no `\n` exist; the `=>` fallback returns the prefix `(x) `, dropping `=> x + 1`. With a braced body the `=>` is preserved (`=> {` is cut at `{`). Asymmetric and probably not what hover wants. Low impact because typed arrows usually carry a return type before `=>`.

### F6 [LOW] walker.rs:176 — no node-kind filter
Hover runs on any node returned by the query: classes, interfaces, imports, type aliases, even `import { x } from 'y'`. For the import case `sig_end` lands on `{` of the destructure pattern, yielding `import ` — meaningless. Consider gating hover to the dialect's `function/method/class/…` anchor families, or returning the first line for non-callable nodes.

### Non-issues (verified, not bugs)
- **Range arithmetic / UTF-8.** `sig_start = node.start_byte()` and `sig_start + sig.len()` are both absolute byte offsets into `src`. `decl_text[..sig_end]` slices by byte at a char boundary (`find` with a `char` predicate returns byte offsets at char boundaries). `trim_end()` only trims trailing whitespace bytes, preserving the start. Multi-byte UTF-8 is safe.
- **`trim_end` of leading whitespace.** Function `decl_text` starts at the symbol's `start_byte()`, so leading indentation is *not* in `decl_text` (tree-sitter declaration nodes don't include leading whitespace). No Python indent loss.
- **`continue` after `results.push`.** Correctly skips dialect dispatch and the diagnostic-emitting else branches; no diagnostic is owed on the success path.

## Coverage gaps

`tests/hover_qualifier_e2e.rs` is too thin to catch any of F1–F6.

1. **`hover_truncates_arrow_function_at_arrow_or_brace`** only asserts `body.contains("arrowGreet")`, which holds even if the full braced body is returned. The test name promises a truncation check it does not perform. Add `!body.contains('{')` and `!body.contains("return")`.
2. **No multi-line signature fixture.** Add a TS/Rust/Python fn with one parameter per line; assert all params survive.
3. **No object-type-in-parameter fixture.** Add `function f(opts: { x: number }): number { return opts.x; }`; assert returned sig contains the full `{ x: number }` and the return type.
4. **No SymbolSlice + #hover combination test.** Either assert the slice wins, or assert a diagnostic is emitted.
5. **No non-TS coverage.** Hover is advertised as universal; add fixtures for Rust `fn`, Python `def`, and at least one of Go/Elixir.
6. **No class / interface / type-alias / const / import hover test.** Behaviour on non-callable nodes is undefined by the implementation; pin it down.
7. **No multi-byte UTF-8 fixture.** `fn 함수(인자: i32) -> i32 { 인자 }` or `function π(τ: number)` — asserts range arithmetic is byte-correct end-to-end.
8. **No expression-body arrow** (`const f = (x) => x + 1`) test — exercises the `=>` fallback path.

## Confidence
0.85 — F1, F2, F3, and the test gaps are demonstrable from the code as written; F4–F6 are well-founded foresight calls.
