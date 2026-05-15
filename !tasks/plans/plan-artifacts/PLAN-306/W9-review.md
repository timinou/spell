# PLAN-306 Wave 9 — Reviewer Checkpoint

**Scope**: W9.1 language matrix · W9.2 diag snapshot audit · W9.3 negative corpus · W9.4 perf benches.

## Verdict: **PROCEED**

## Confidence: **MEDIUM**

No P0 / blocking defects. Three P1 quality concerns flagged below — none should hold Wave 10 (NAPI rebuild) but each should be tracked as a FUP before W9 is considered "done done".

---

## Findings (P1 only)

### F1 — W9.4 grep bench measures one crate, not the spell repo (P1)
`crates/pi-natives/benches/codepath_bench.rs:32` sets `REPO_ROOT = env!("CARGO_MANIFEST_DIR")`. That expands to `crates/pi-natives` (73 `.rs` files, verified via `find`), **not** the workspace root. The bench is named `grep_todo_spell_repo`, the doc-comment claims "~3K .rs files", and `W9-4-perf.md` reports "Files visited: ~3000". The reported `mean = 4.31 ms` reflects a single-crate scan, ~40× smaller than the stated workload. Fix: derive workspace root from a relative path (`Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")`) or pass via env. Update report numbers after re-running.

### F2 — W9.4 `resolve_50_symbols` fixture mismatches its extension (P1)
The bench writes Rust syntax (`fn handler_i(...)`, `struct Config_i { ... }`) into a `test.ts` tempfile (`codepath_bench.rs:206-211`). Tree-sitter TS produces a heavily error'd parse tree for this input. The "5.5 ms / symbol → over budget 5.5×" verdict in `W9-4-perf.md` therefore measures parsing + searching an ERROR-laden TS tree, not realistic `.ts` symbol resolution. Either (a) rename the file to `test.rs` so the Rust grammar handles it, or (b) emit real TS (`function handler_i(x: number)…`, `class Config_i { field: string }`). Without this fix the "over budget" recommendation (parse-tree caching) is based on noise.

### F3 — W9.3 ignored tests are stub bodies with no assertions (P1)
The 11 `#[ignore]`'d tests in `negative_corpus_tests.rs:330-490` document the *intent* in their attribute strings but their bodies do nothing meaningful — e.g. `non_existent_file_returns_not_found` is just `let _cp = parse_code_path("nonexistent-xyzpdq.ts", &TsNameLexer).unwrap();` with no diagnostic assertion (similarly `out_of_root_absolute_path_returns_diagnostic`, `range_on_glob_returns_incompatible`, `symbol_on_non_code_file_returns_no_matches`, `missing_symbol_returns_no_matches`, `inverted_range_returns_range_bounds_inverted`, `file_create_on_existing_file_returns_file_exists`, `symbol_rename_on_non_existent_returns_no_matches`, `symbol_wrap_on_non_existent_returns_no_matches`, `empty_content_for_symbol_replace_is_rejected`). When a future contributor un-ignores them after the FUP (PROJ-066 etc.) lands, they will pass trivially — no `assert_eq!(...DiagnosticVariant)` is in scope. This is a latent regression trap: the negative corpus appears to cover 34 cases but only 23 actually defend behavior. Track a FUP that fills in the resolver-level assertion bodies in the same commit that ships the wired resolver.

---

## Quality notes (non-blocking)

- **W9.1 ignored cells** — both FUP-010 (`css::rename_custom_prop`) and FUP-011 (`html::symbol_insert_after`) match the kernel quirk descriptions in `code_buffer`. The ignore reasons cite concrete root causes (selector vs token target id for CSS; HTML element name not treated as symbol target by `code_buffer`). The fact that `html::symbol_replace` and `html::symbol_wrap` pass while `symbol_insert_after` fails confirms the FUP-011 cause is specific to the insert-after dispatch path, not a blanket HTML symbol gap — worth noting in the FUP so it isn't fixed at the wrong layer.
- **W9.1 dispatch** — `dispatch_op` skips `FsResolver`/`TextResolver` with a comment that they return `None` for the structural ops under test. Risk: if a future refactor makes one of them claim a Symbol/Heading/CSS op, these tests will silently bypass that path. Cheap mitigation: include the full chain and assert which resolver claimed.
- **W9.1 spot-check (passing cells)** — fixture before/after pairs all differ in observable bytes (verified). Silent no-op cannot pass the `actual.trim() == after.trim()` assertion.
- **W9.3 passing tests** — `IncompatibleTargetShape` constructor checks (`SymbolTarget::new`, `FileTarget::new`, `CssTarget::new`, `HeadingTarget::new`) genuinely test rejection paths with message substring assertions. `from_legacy_*` tests document live overload behavior (e.g. `fileFindReplace` on a `::Symbol` overloads to `SymbolFindReplace`) and would fail if dispatch semantics regressed.
- **W9.2** — coverage audit verified by `b71991524` is real (20/20 variants); no new code, only a status report. ✓
- **W9.4 safety** — criterion config caps `measurement_time` at 5s × 4 benches; no infinite loops, no hardcoded large paths beyond the workspace, no content leakage (only counts, not lines).
- **Coverage adequacy** — W9.1's 6 langs × 3 ops mirrors the JS test surface; comparison against W8.4 audit is consistent (universal qualifiers are validated in `routing_tests`, not the matrix). W9.3's 34 cases span parse / op-shape / dispatch tiers reasonably; the gaps are explicit and FUP-tagged.

---

## Recommendation

Ship Wave 10. Open FUPs for F1 (`bench: correct REPO_ROOT to workspace root`), F2 (`bench: realistic TS fixture for resolve_50_symbols`), and F3 (`negative corpus: fill ignored-test bodies with resolver assertions on un-ignore`). None gate the NAPI rebuild.
