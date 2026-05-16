# W9.3 — Kernel-level Negative Corpus (Rust)

**Commit**: `a13ff8b8b`  
**File**: `crates/pi-code-path/tests/negative_corpus_tests.rs`  
**Tests**: 34 (23 passing, 11 ignored)

---

## Status

| Tier | Count | Passing | Ignored |
|------|-------|---------|---------|
| Parse-level (syntax) | 9 | 9 | 0 |
| Op-level (target construction) | 11 | 11 | 0 |
| Resolver-level (dispatch engine) | 2 | 2 | 0 |
| Resolver-level (needs real resolvers) | 11 | 0 | 11 |
| Parser gap (bracket range) | 1 | 0 | 1 |
| **Total** | **34** | **23** | **11** |

## Passing tests

### Parse-level (9)
| Test | Variant | Notes |
|------|---------|-------|
| `empty_target_returns_parse_error` | ParseError | `""` rejected |
| `empty_locator_with_query_returns_parse_error` | ParseError | `::Foo` rejected |
| `multiple_qualifiers_returns_parse_error` | ParseError | `foo.ts#stat#diff` rejected |
| `garbled_axis_returns_parse_error` | ParseError | `foo.ts::§§` rejected |
| `unterminated_backtick_returns_parse_error` | ParseError | `` `unterminated`` rejected |
| `invalid_qualifier_after_range_shorthand_returns_parse_error` | ParseError | `foo.ts:50#bad#qualifier` rejected |
| `unbalanced_predicate_bracket_returns_parse_error` | ParseError | `foo.ts::Foo[` rejected |
| `unbalanced_subquery_predicate_returns_parse_error` | ParseError | `foo.ts::Foo[.Bar` rejected |
| `lone_colon_does_not_synth_shorthand` | — | documents that `foo.ts:` parses as bare path |

### Op-level (11)
| Test | Variant | Notes |
|------|---------|-------|
| `symbol_target_rejects_bare_path` | IncompatibleTargetShape | no `::Symbol` |
| `symbol_target_rejects_uri_locator` | IncompatibleTargetShape | URI + no query |
| `file_target_rejects_symbol_query` | IncompatibleTargetShape | has `::Symbol` |
| `file_target_rejects_uri_locator` | IncompatibleTargetShape | URI locator |
| `css_target_rejects_uri_locator` | IncompatibleTargetShape | URI locator |
| `heading_target_rejects_uri_locator` | IncompatibleTargetShape | URI locator |
| `file_target_rejects_qualifier` | IncompatibleTargetShape | bare path + `#qualifier` |
| `from_legacy_write_on_bare_path_creates_file_write` | — | documents dispatch |
| `from_legacy_write_on_symbol_path_creates_symbol_replace` | — | documents dispatch |
| `from_legacy_filefindreplace_on_symbol_creates_symbol_op` | — | documents overload → SymbolFindReplace |
| `from_legacy_insert_without_pos_or_line_returns_parse_error` | ParseError | missing anchor |
| `from_legacy_write_on_uri_returns_incompatible_target` | IncompatibleTargetShape | URI write rejected |

### Dispatch-level (2)
| Test | Variant | Notes |
|------|---------|-------|
| `uri_locator_dispatch_returns_diagnostic` | ParseError | dispatch stub for `memory://root` |
| `uri_locator_with_query_dispatch_returns_diagnostic` | ParseError | dispatch stub for `memory://root::Sym` |

## Ignored tests (resolve-path gaps)

| Test | Expected variant | FUP / Reason |
|------|------------------|-------------|
| `non_existent_file_returns_not_found` | FileNotFound | requires wired FS resolver (PROJ-066) |
| `out_of_root_absolute_path_returns_diagnostic` | Inaccessible | requires root enforcement |
| `range_on_glob_returns_incompatible` | IncompatibleTargetShape | requires resolver-level glob+range validation |
| `symbol_on_non_code_file_returns_no_matches` | NoMatches | requires code resolver |
| `missing_symbol_returns_no_matches` | NoMatches | requires code resolver |
| `inverted_range_returns_range_bounds_inverted` | RangeBoundsInverted | requires resolver-level range validation |
| `file_create_on_existing_file_returns_file_exists` | FileExists | requires mutation resolver |
| `symbol_rename_on_non_existent_returns_no_matches` | NoMatches | requires code resolver |
| `symbol_wrap_on_non_existent_returns_no_matches` | NoMatches | requires code resolver |
| `empty_content_for_symbol_replace_is_rejected` | (resolver diagnostic) | requires resolver-level empty-content validation |
| `bracket_range_smell_should_reject` | ParseError | `foo.ts[80-130]` parses as CharClass, not rejected |

## Coverage vs JS negative.test.ts

| JS test | Rust status |
|---------|------------|
| `'' (empty target)` | ✅ passing |
| `'foo.ts[80-130]'` | ⏳ ignored (parser gap — currently parses as CharClass) |
| `'src/**/*.ts:50-80'` | ⏳ ignored (resolver gap) |
| `'nonexistent-xyzpdq.ts'` | ⏳ ignored (resolver gap) |
| `'/etc/passwd'` | ⏳ ignored (resolver gap) |
| `'foo.ts::NonExistent'` | ⏳ ignored (resolver gap) |
| `symbolReplace on bare path` | ✅ passing (via SymbolTarget::new) |
| `fileFindReplace on symbol target` | ✅ documented (overloads to SymbolFindReplace) |
| `fileCreate on existing file` | ⏳ ignored (resolver gap) |
| `symbolRename on non-existent` | ⏳ ignored (resolver gap) |
| `symbolWrap on non-existent` | ⏳ ignored (resolver gap) |
