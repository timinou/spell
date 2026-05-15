# W9.2 — Diagnostic Snapshot Coverage Audit

**Goal:** Verify every `DiagnosticVariant` has a snapshot test; extend if missing.

## Result: **No gaps** — all 20 enum variants covered

### Variants already covered (20/20)

| Variant | Test fn | Snapshot file |
|---|---|---|
| `ParseError` | `snapshot_parse_error` | ✅ |
| `FileNotFound` | `snapshot_file_not_found` | ✅ |
| `ArtifactNotFound` | `snapshot_artifact_not_found` | ✅ |
| `UnknownLocatorScheme { available }` | `snapshot_unknown_locator_scheme` | ✅ |
| `SuffixSuggestion { tried, suggestion }` | `snapshot_suffix_suggestion` | ✅ |
| `NoMatches` | `snapshot_no_matches` | ✅ |
| `AmbiguousTarget { count }` | `snapshot_ambiguous_target` | ✅ |
| `UnsupportedOperation` | `snapshot_unsupported_operation` | ✅ |
| `MissingActions` | `snapshot_missing_actions` | ✅ |
| `UnsupportedActionForResolver` | `snapshot_unsupported_action_for_resolver` | ✅ |
| `Inaccessible` | `snapshot_inaccessible` | ✅ |
| `EncodingFallback` | `snapshot_encoding_fallback` | ✅ |
| `SchemeNotImplemented` | `snapshot_scheme_not_implemented` | ✅ |
| `FileExists` | `snapshot_file_exists` | ✅ |
| `StaleAnchor` | `snapshot_stale_anchor` | ✅ |
| `ZeroByteDeleteBlocked` | `snapshot_zero_byte_delete_blocked` | ✅ |
| `Cancelled` | `snapshot_cancelled` | ✅ |
| `RangeBoundsInverted` | `snapshot_range_bounds_inverted` | ✅ |
| `RangeClamped` | `snapshot_range_clamped` | ✅ |
| `IncompatibleTargetShape` | `snapshot_incompatible_target_shape` | ✅ |

### Bonus tests (1)
- `snapshot_with_source_span` — ParseError with source text and span annotation

### Variants added: **0** (all already present)

### Test run
```
cargo test -p pi-code-path --test diagnostic_render_tests
→ 21 passed, 0 failed
```

### Commit
No files modified — coverage was already complete. No commit needed.
