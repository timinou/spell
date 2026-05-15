//! Snapshot tests for [`Diagnostic::render`] — one test per variant.
//!
//! Run with: `cargo test -p pi-code-path --test diagnostic_render_tests`
//! Accept snapshots with: `cargo insta review` or `cargo insta accept`

use pi_code_path::{Diagnostic, DiagnosticVariant, Span};

/// Helper: build a diagnostic with no source or span.
fn diag(variant: DiagnosticVariant, message: impl Into<String>) -> Diagnostic {
	Diagnostic { variant, message: message.into(), span: None }
}

/// Helper: build a diagnostic with a source span.
fn diag_spanned(
	variant: DiagnosticVariant,
	message: impl Into<String>,
	start: usize,
	end: usize,
) -> Diagnostic {
	Diagnostic {
		variant,
		message: message.into(),
		span: Some(Span { start, end }),
	}
}

// ── Variant tests (no source) ─────────────────────────────────────

#[test]
fn snapshot_parse_error() {
	let d = diag(DiagnosticVariant::ParseError, "unexpected token `@`");
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_file_not_found() {
	let d = diag(DiagnosticVariant::FileNotFound, "file `missing.txt` not found");
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_artifact_not_found() {
	let d = diag(
		DiagnosticVariant::ArtifactNotFound,
		"artifact `abc123` not found",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_unknown_locator_scheme() {
	let d = diag(
		DiagnosticVariant::UnknownLocatorScheme {
			available: vec!["http".into(), "https".into(), "file".into()],
		},
		"unknown scheme `ftp`",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_suffix_suggestion() {
	let d = diag(
		DiagnosticVariant::SuffixSuggestion {
			tried:      "foo".into(),
			suggestion: "bar".into(),
		},
		"no matches; did you mean `bar`?",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_no_matches() {
	let d = diag(DiagnosticVariant::NoMatches, "no results for query");
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_ambiguous_target() {
	let d = diag(
		DiagnosticVariant::AmbiguousTarget { count: 5 },
		"found 5 matching nodes",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_unsupported_operation() {
	let d = diag(
		DiagnosticVariant::UnsupportedOperation,
		"delete not supported by this resolver",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_missing_actions() {
	let d = diag(DiagnosticVariant::MissingActions, "no actions provided");
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_unsupported_action_for_resolver() {
	let d = diag(
		DiagnosticVariant::UnsupportedActionForResolver,
		"no resolver handles this action kind",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_inaccessible() {
	let d = diag(
		DiagnosticVariant::Inaccessible,
		"permission denied: /root/secret",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_encoding_fallback() {
	let d = diag(
		DiagnosticVariant::EncodingFallback,
		"file is not UTF-8; using lossy fallback",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_scheme_not_implemented() {
	let d = diag(
		DiagnosticVariant::SchemeNotImplemented,
		"scheme `ftp` is not implemented",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_file_exists() {
	let d = diag(DiagnosticVariant::FileExists, "target `out.txt` already exists");
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_stale_anchor() {
	let d = diag(
		DiagnosticVariant::StaleAnchor,
		"anchor hash mismatch; file changed",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_zero_byte_delete_blocked() {
	let d = diag(
		DiagnosticVariant::ZeroByteDeleteBlocked,
		"delete would leave file at zero bytes",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_cancelled() {
	let d = diag(DiagnosticVariant::Cancelled, "operation cancelled by user");
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_range_bounds_inverted() {
	let d = diag(
		DiagnosticVariant::RangeBoundsInverted,
		"range 10..5 has start > end",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_range_clamped() {
	let d = diag(
		DiagnosticVariant::RangeClamped,
		"range clamped to file bounds [0..100]",
	);
	insta::assert_snapshot!(d.render(None));
}

#[test]
fn snapshot_incompatible_target_shape() {
	let d = diag(
		DiagnosticVariant::IncompatibleTargetShape,
		"cannot apply symbolReplace to a line target",
	);
	insta::assert_snapshot!(d.render(None));
}

// ── Source + span ─────────────────────────────────────────────────

#[test]
fn snapshot_with_source_span() {
	let d = diag_spanned(
		DiagnosticVariant::ParseError,
		"unexpected token at position 5",
		5,
		6, // span covers the `@` in "hello @world"
	);
	insta::assert_snapshot!(d.render(Some("hello @world")));
}
