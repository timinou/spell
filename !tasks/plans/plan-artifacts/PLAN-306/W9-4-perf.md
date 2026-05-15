# W9.4 — Criterion performance baselines

**Goal**: Criterion benchmarks for CodePath hot paths. Failures emit warnings (don't block CI); we want baseline numbers and a tripwire for regressions.

**Commit**: `bench(pi-natives): codepath performance ceilings (PLAN-306 W9.4)`

---

## Files changed

| File | Action |
|------|--------|
| `crates/pi-natives/Cargo.toml` | MODIFY — added `criterion` dev-dep + `[[bench]]` section |
| `crates/pi-natives/benches/codepath_bench.rs` | CREATE — 4 criterion benchmarks |

---

## Benchmarks

### 1. `grep_todo_spell_repo` — grep "TODO" across spell repo .rs files

- **Method**: `ignore::WalkBuilder` → read each .rs file → `line.contains("TODO")`
- **Files visited**: ~3000 (spell repo .rs files, .gitignore-respecting)
- **Budget**: 500ms p95

| Metric | Value |
|--------|-------|
| mean   | 4.31 ms |
| p50    | 5.02 ms |
| p95    | 5.72 ms |
| **Budget** | 500ms ✓ |

**Verdict**: Well within budget. File I/O + simple string matching is fast with warm cache.

### 2. `parse_codepath_x1000` — parse 20 canonical CodePaths × 50× (1000 total)

- **Method**: `pi_code_path::parser::parse_code_path` with `DotLexer`
- **Inputs**: 20 paths covering bare file, file:slice, file::symbol, file::symbol#body, glob, URI, predicates, combinator chains
- **Budget**: 100µs each → 100ms total

| Metric | Value |
|--------|-------|
| mean   | 589 µs (0.59 µs per parse) |
| p50    | 734 µs |
| p95    | 794 µs |
| **Budget** | 100ms ✓ |

**Verdict**: Exceptionally fast. `winnow` parser + simple lexer is sub-microsecond per path.

### 3. `get_500line_file` — resolve `§line[10..20]` on 500-line file

- **Method**: `CodeResolverImpl::resolve` with tree-sitter TS dialect parser + `§line[10..20]` structural query
- **Fixture**: 500-line `test.rs` tempfile with function definitions
- **Budget**: 10ms

| Metric | Value |
|--------|-------|
| mean   | 2.34 ms |
| p50    | 2.75 ms |
| p95    | 3.21 ms |
| **Budget** | 10ms ✓ |

**Verdict**: Within budget. Tree-sitter parse dominates; the line-range filter after parsing is cheap.

### 4. `resolve_50_symbols` — resolve 50 named symbols in a .ts file

- **Method**: `CodeResolverImpl::resolve` × 50 iterations, each querying a different symbol name
- **Fixture**: 50 symbols (25 functions + 25 structs) in a `test.ts` tempfile
- **Budget**: 50ms total

| Metric | Value |
|--------|-------|
| mean   | 277 ms (5.5 ms per symbol) |
| p50    | 312 ms |
| p95    | 355 ms |
| **Budget** | 50ms ✗ |

**Verdict**: Over budget (~5.5×). Each symbol resolution re-parses the file through tree-sitter, which dominates. Mitigations:
- Cache the tree-sitter parse tree across symbol lookups on the same file
- Use outline-level indexing instead of per-call AST parse

### 5. Edge traversal (def→)

**NOT IMPLEMENTED** — requires `pi-code-graph` indexing which needs a full workspace scan. Add when a graph fixture is available in a follow-up (see `crates/pi-natives/src/code_path/edge_resolver/`).

---

## Budget compliance summary

| Benchmark | Budget | Actual (p95) | Status |
|-----------|--------|-------------|--------|
| grep_todo_spell_repo | 500 ms | 5.72 ms | ✓ |
| parse_codepath_x1000 | 100 ms | 0.79 ms | ✓ |
| get_500line_file | 10 ms | 3.21 ms | ✓ |
| resolve_50_symbols | 50 ms | 355 ms | ✗ |

**3/4 passing budgets**. `resolve_50_symbols` is over budget due to repeated tree-sitter parse overhead. Recommendation: add parse-tree caching.

## Run command

```bash
cargo bench -p pi-natives --bench codepath_bench
```
