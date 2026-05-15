//! Negative-space test suite for CodePath kernel.
//!
//! Every impossible/forbidden target shape MUST produce a specific Diagnostic
//! variant, never silent success. Tests are organised in three tiers:
//!
//! 1. **Parse-level** — `parse_code_path` rejects syntactically invalid input.
//! 2. **Op-level** — target constructors / `Op::from_legacy` reject shape mismatches.
//! 3. **Resolver-level** (mostly #[ignore]) — require wired resolvers not yet built.
//!
//! Mirrors `packages/coding-agent/test/codepath/negative.test.ts` at the kernel
//! level. Resolver-dependent tests are marked `#[ignore = "…"]` with FUP
//! references and document what the kernel *should* do once resolvers land.

use std::collections::HashMap;
use std::sync::Arc;

use pi_code_path::{
    Action, ActionContent, CodePath, CssTarget, DiagnosticVariant, FileTarget,
    FsLocator, FsSegment, HeadingTarget, Locator, Op, OpKind, Query, Step, Head, NamePayload,
    SymbolTarget, UriLocator,
    dialects::typescript::TsNameLexer,
    parse_code_path,
    resolver::dispatch::{DispatchEngine, ResolveContext},
    resolver::traits::{CancellationToken, FsAnchorContext},
};

// ── Helpers ──────────────────────────────────────────────────────

fn bare_fs_codepath(segments: Vec<&str>) -> CodePath {
    CodePath {
        locator:   Locator::Fs(FsLocator {
            segments: segments
                .into_iter()
                .map(|s| FsSegment::Literal(s.to_string()))
                .collect(),
        }),
        query:     None,
        qualifier: None,
    }
}

fn bare_file_path() -> CodePath {
    bare_fs_codepath(vec!["test.rs"])
}

fn symbol_path() -> CodePath {
    CodePath {
        locator:   Locator::Fs(FsLocator {
            segments: vec![FsSegment::Literal("test.rs".to_string())],
        }),
        query:     Some(Query::single(Step {
            axis:       None,
            head:       Head::Name(NamePayload::Raw("Foo".to_string())),
            predicates: vec![],
        })),
        qualifier: None,
    }
}

fn uri_path() -> CodePath {
    CodePath {
        locator:   Locator::Uri(UriLocator {
            scheme: "artifact".to_string(),
            path:   "abc123".to_string(),
        }),
        query:     None,
        qualifier: None,
    }
}



struct NoopFsAnchor;
impl FsAnchorContext for NoopFsAnchor {
    fn is_code_extension(&self, _ext: &str) -> bool {
        false
    }
    fn is_image_extension(&self, _ext: &str) -> bool {
        false
    }
    fn is_doc_extension(&self, _ext: &str) -> bool {
        false
    }
    fn is_lockfile_basename(&self, _name: &str) -> bool {
        false
    }
}

fn empty_resolve_context() -> ResolveContext {
    ResolveContext {
        fs_anchor:     Arc::new(NoopFsAnchor),
        extractors:    vec![],
        schemes:       HashMap::new(),
        code_resolver: None,
        edge_resolver: None,
        cancel:        CancellationToken::new(),
    }
}

// ═══════════════════════════════════════════════════════════════════
// Tier 1: Parse-level negative tests
// ═══════════════════════════════════════════════════════════════════

#[test]
fn empty_target_returns_parse_error() {
    let result = parse_code_path("", &TsNameLexer);
    assert!(result.is_err(), "empty target must fail to parse");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

#[test]
fn empty_locator_with_query_returns_parse_error() {
    // "::Foo" has no locator (empty before ::) → ParseError
    let result = parse_code_path("::Foo", &TsNameLexer);
    assert!(result.is_err(), "empty locator must fail to parse");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

#[test]
fn multiple_qualifiers_returns_parse_error() {
    // Only one #qualifier is allowed; trailing input after first qualifier
    // is rejected as unexpected.
    let result = parse_code_path("foo.ts#stat#diff", &TsNameLexer);
    assert!(result.is_err(), "multiple qualifiers must fail to parse");
    let err = result.unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::ParseError);
    assert!(
        err.message.contains("trailing"),
        "message should mention trailing input: {}",
        err.message
    );
}

#[test]
fn garbled_axis_returns_parse_error() {
    // After ::§ there must be a valid axis name; a second § is not valid.
    let result = parse_code_path("foo.ts::§§", &TsNameLexer);
    assert!(result.is_err(), "garbled axis must fail to parse");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

#[test]
fn unterminated_backtick_returns_parse_error() {
    let result = parse_code_path("`unterminated", &TsNameLexer);
    assert!(result.is_err(), "unterminated backtick must fail to parse");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

#[test]
fn invalid_qualifier_after_range_shorthand_returns_parse_error() {
    // "foo.ts:50#bad#qualifier" — first #bad is consumed; #qualifier is trailing.
    let result = parse_code_path("foo.ts:50#bad#qualifier", &TsNameLexer);
    assert!(result.is_err(), "multiple qualifiers after shorthand must fail");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

#[test]
fn lone_colon_does_not_synth_shorthand() {
    // "foo.ts:" has a trailing colon followed by nothing — non-numeric,
    // so the shorthand sniff fails and it falls through as a bare path
    // with a trailing colon. Current behavior: parses silently (the colon
    // is absorbed into the fs path component).
    let result = parse_code_path("foo.ts:", &TsNameLexer);
    // The colon at end is treated as part of the path because the shorthand
    // sniff rejected it (empty payload after `:`). This documents current
    // parser behavior.
    assert!(result.is_ok(), "bare path with trailing colon currently parses");
}

#[test]
fn unbalanced_predicate_bracket_returns_parse_error() {
    let result = parse_code_path("foo.ts::Foo[", &TsNameLexer);
    assert!(result.is_err(), "unbalanced [ must fail to parse");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

#[test]
fn unbalanced_subquery_predicate_returns_parse_error() {
    let result = parse_code_path("foo.ts::Foo[.Bar", &TsNameLexer);
    assert!(result.is_err(), "unbalanced subquery must fail to parse");
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

// ═══════════════════════════════════════════════════════════════════
// Tier 2: Op-level / target construction negative tests
// ═══════════════════════════════════════════════════════════════════

#[test]
fn symbol_target_rejects_bare_path() {
    let err = SymbolTarget::new(bare_file_path()).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    assert!(
        err.message.contains("query"),
        "message should mention missing ::Symbol: {}",
        err.message
    );
}

#[test]
fn symbol_target_rejects_uri_locator() {
    let err = SymbolTarget::new(uri_path()).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    // Query check fires first (no ::Symbol) before locator check:
    assert!(
        err.message.contains("query"),
        "message should mention missing ::Symbol: {}",
        err.message
    );
}

#[test]
fn file_target_rejects_symbol_query() {
    let err = FileTarget::new(symbol_path()).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    assert!(
        err.message.contains("symbol"),
        "message should mention symbol variant: {}",
        err.message
    );
}

#[test]
fn file_target_rejects_uri_locator() {
    let err = FileTarget::new(uri_path()).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    assert!(
        err.message.contains("FsLocator"),
        "message should mention fs locator requirement: {}",
        err.message
    );
}

#[test]
fn css_target_rejects_uri_locator() {
    let err = CssTarget::new(uri_path()).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    assert!(
        err.message.contains("FsLocator"),
        "message should mention fs locator requirement: {}",
        err.message
    );
}

#[test]
fn heading_target_rejects_uri_locator() {
    let err = HeadingTarget::new(uri_path()).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    assert!(
        err.message.contains("FsLocator"),
        "message should mention fs locator requirement: {}",
        err.message
    );
}

#[test]
fn file_target_rejects_qualifier() {
    let mut cp = bare_file_path();
    use pi_code_path::Qualifier;
    cp.qualifier = Some(Qualifier { name: "stat".to_string(), args: None });
    let err = FileTarget::new(cp).unwrap_err();
    assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
    assert!(
        err.message.contains("symbol") || err.message.contains("qualifier"),
        "message should mention symbol/qualifier: {}",
        err.message
    );
}

/// Document current overload behavior:
/// `fileFindReplace` on a `::Symbol` target dispatches to `SymbolFindReplace`.
#[test]
fn from_legacy_filefindreplace_on_symbol_creates_symbol_op() {
    let action = Action::FindAndReplace {
        find:       ActionContent::Single("old".to_string()),
        content:    ActionContent::Single("new".to_string()),
        occurrence: None,
    };
    let op = Op::from_legacy(&action, &symbol_path()).unwrap();
    assert_eq!(
        op.kind(),
        OpKind::SymbolFindReplace,
        "find/replace on ::Symbol target currently dispatches to SymbolFindReplace (overload)"
    );
}

/// Document that a bare-path target with a `Write` action creates `FileWrite`.
#[test]
fn from_legacy_write_on_bare_path_creates_file_write() {
    let action = Action::Write {
        content: ActionContent::Single("new content".to_string()),
        force:   false,
    };
    let op = Op::from_legacy(&action, &bare_file_path()).unwrap();
    assert_eq!(op.kind(), OpKind::FileWrite);
}

/// Document that a `::Symbol` target with a `Write` action creates `SymbolReplace`.
#[test]
fn from_legacy_write_on_symbol_path_creates_symbol_replace() {
    let action = Action::Write {
        content: ActionContent::Single("new content".to_string()),
        force:   false,
    };
    let op = Op::from_legacy(&action, &symbol_path()).unwrap();
    assert_eq!(op.kind(), OpKind::SymbolReplace);
    match op {
        Op::SymbolReplace { scope, .. } => assert_eq!(scope, pi_code_path::SymScope::Whole),
        _ => panic!("expected SymbolReplace"),
    }
}

/// Document that `Insert` without `pos` or `line` fails.
#[test]
fn from_legacy_insert_without_pos_or_line_returns_parse_error() {
    let action = Action::Insert {
        pos:   None,
        line:  None,
        lines: ActionContent::Single("x".to_string()),
    };
    let result = Op::from_legacy(&action, &bare_file_path());
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::ParseError
    );
}

/// `from_legacy` on a URI locator rejects via target constructors.
#[test]
fn from_legacy_write_on_uri_returns_incompatible_target() {
    let action = Action::Write {
        content: ActionContent::Single("x".to_string()),
        force:   false,
    };
    let result = Op::from_legacy(&action, &uri_path());
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err().variant,
        DiagnosticVariant::IncompatibleTargetShape
    );
}

// ═══════════════════════════════════════════════════════════════════
// Tier 3: Resolver-level negative tests (dispatch engine)
// ═══════════════════════════════════════════════════════════════════

/// URI dispatch is currently a stub that returns `Err(ParseError)`, so this
/// test *does* pass even though a real resolver would emit a more specific
/// variant (e.g. `SchemeNotImplemented` or `UnsupportedOperation`).
#[test]
fn uri_locator_dispatch_returns_diagnostic() {
    let cp = parse_code_path("memory://root", &TsNameLexer).unwrap();
    let engine = DispatchEngine::new();
    let ctx = empty_resolve_context();
    let result = engine.dispatch(&cp, &ctx);
    assert!(result.is_err(), "URI dispatch should fail (stub)");
    let diag = result.unwrap_err();
    assert_eq!(diag.variant, DiagnosticVariant::ParseError);
    assert!(
        diag.message.contains("memory"),
        "message should mention the URI scheme: {}",
        diag.message
    );
}

/// URI with a query symbol — current dispatch returns the same stub error.
#[test]
fn uri_locator_with_query_dispatch_returns_diagnostic() {
    let cp = parse_code_path("memory://root::Sym", &TsNameLexer).unwrap();
    let engine = DispatchEngine::new();
    let ctx = empty_resolve_context();
    let result = engine.dispatch(&cp, &ctx);
    assert!(result.is_err(), "URI+symbol dispatch should fail (stub)");
}

// ═══════════════════════════════════════════════════════════════════
// #[ignore] — Need real resolvers to exercise these paths
// ═══════════════════════════════════════════════════════════════════

/// SHOULD return `FileNotFound` or `NoMatches`.
/// Currently the FS dispatch stub returns `Ok(vec![])`.
#[ignore = "requires wired FS resolver (PROJ-066)"]
#[test]
fn non_existent_file_returns_not_found() {
    let _cp = parse_code_path("nonexistent-xyzpdq.ts", &TsNameLexer).unwrap();
    // Unreachable until dispatch is wired
}

/// SHOULD return a diagnostic (out-of-root or inaccessible).
/// Currently the FS dispatch stub silently accepts any path.
#[ignore = "requires root-enforcement in FS resolver"]
#[test]
fn out_of_root_absolute_path_returns_diagnostic() {
    let _cp = parse_code_path("/etc/passwd", &TsNameLexer).unwrap();
}

/// SHOULD return `IncompatibleTargetShape`.
/// Currently `src/**/*.ts:50-80` parses cleanly as a glob with a line-slice
/// shorthand, and the FS dispatch stub returns `Ok(vec![])`.
#[ignore = "requires resolver-level validation: glob + range is incompatible"]
#[test]
fn range_on_glob_returns_incompatible() {
    let _cp = parse_code_path("src/**/*.ts:50-80", &TsNameLexer).unwrap();
}

/// SHOULD return `NoMatches` or `UnsupportedOperation`.
/// Currently `foo.txt::Bar` parses cleanly; FS dispatch is a stub.
#[ignore = "requires code resolver to check file type"]
#[test]
fn symbol_on_non_code_file_returns_no_matches() {
    let _cp = parse_code_path("foo.txt::Bar", &TsNameLexer).unwrap();
}

/// SHOULD return `NoMatches`.
/// Currently `foo.ts::NonExistent` parses cleanly; FS dispatch is a stub.
#[ignore = "requires code resolver to search symbols"]
#[test]
fn missing_symbol_returns_no_matches() {
    let _cp = parse_code_path("foo.ts::NonExistent", &TsNameLexer).unwrap();
}

/// SHOULD return `RangeBoundsInverted`.
/// The parser accepts `§line[10..5]` without validating bounds; a resolver
/// should check and emit `RangeBoundsInverted`.
#[ignore = "requires resolver-level range validation"]
#[test]
fn inverted_range_returns_range_bounds_inverted() {
    let _cp = parse_code_path("foo.ts::§line[10..5]", &TsNameLexer).unwrap();
}

/// SHOULD return `FileExists`.
/// Requires a mutation resolver to check filesystem state.
#[ignore = "requires wired mutation resolver"]
#[test]
fn file_create_on_existing_file_returns_file_exists() {
    let _cp = bare_file_path();
}

/// SHOULD return `NoMatches`.
/// `SymbolRename` on a non-existent symbol requires the code resolver to
/// look up the symbol and reject it.
#[ignore = "requires code resolver to search symbols"]
#[test]
fn symbol_rename_on_non_existent_returns_no_matches() {
    let _target = SymbolTarget::new(symbol_path()).unwrap();
}

/// SHOULD return `NoMatches`.
/// `SymbolWrap` on a non-existent symbol requires the code resolver.
#[ignore = "requires code resolver to search symbols"]
#[test]
fn symbol_wrap_on_non_existent_returns_no_matches() {
    let _target = SymbolTarget::new(symbol_path()).unwrap();
}

/// SHOULD return a diagnostic (empty content rejected by resolver).
/// Currently the Op constructor accepts empty content without error.
#[ignore = "requires resolver-level validation of empty content"]
#[test]
fn empty_content_for_symbol_replace_is_rejected() {
    let op = Op::SymbolReplace {
        target:  SymbolTarget::new(symbol_path()).unwrap(),
        scope:   pi_code_path::SymScope::Whole,
        content: ActionContent::Single("".to_string()),
    };
    // Op construction succeeds; resolver should reject empty content
    let _ = op;
}

/// SHOULD return `IncompatibleTargetShape`.
/// `foo.ts[80-130]` is parsed as a valid FsLocator containing a CharClass
/// segment. The parser should detect the dashed bracket form `[A-B]` and
/// emit a hint / ParseError instead.
#[ignore = "requires parser-level detection of dashed bracket range"]
#[test]
fn bracket_range_smell_should_reject() {
    // Currently parses successfully as CharClass — see `bracket_dashed_range_hint`
    // test in parser.rs which only catches the `§line[85-180]` form (inside
    // the query), not `foo.ts[80-130]` (locator-level).
    let result = parse_code_path("foo.ts[80-130]", &TsNameLexer);
    assert!(
        result.is_ok(),
        "currently parses as CharClass — kernel should reject this shape"
    );
}
