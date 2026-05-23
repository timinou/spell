//! Converts internal [`Diagnostic`] values to miette-formatted pretty reports.
//!
//! Uses miette's [`GraphicalReportHandler`] to produce multi-line output
//! with error codes, carets, help text, and optional source-code annotations.
//!
//! ## Design
//!
//! A single `DiagReport` struct implements the [`miette::Diagnostic`] trait
//! manually (not via derive) so we can construct it dynamically from our
//! serializable `DiagnosticVariant` enum. This is cleaner than 19 separate
//! types because the mapping logic lives in one place.

use std::{error::Error, fmt};

use miette::{
	Diagnostic as MietteDiagnostic, GraphicalReportHandler, GraphicalTheme, LabeledSpan,
	NamedSource, Severity, SourceCode, SourceSpan,
};

use crate::types::{Diagnostic, DiagnosticVariant, Span};

/// A single miette-compatible error report built from a [`Diagnostic`].
struct DiagReport {
	message:  String,
	code:     String,
	help:     String,
	severity: Severity,
	source:   Option<NamedSource<String>>,
	span:     Option<SourceSpan>,
}

impl fmt::Display for DiagReport {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.message)
	}
}

impl fmt::Debug for DiagReport {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("DiagReport")
			.field("code", &self.code)
			.field("message", &self.message)
			.finish()
	}
}

impl Error for DiagReport {}

impl MietteDiagnostic for DiagReport {
	fn code(&self) -> Option<Box<dyn fmt::Display + '_>> {
		Some(Box::new(&self.code))
	}

	fn severity(&self) -> Option<Severity> {
		Some(self.severity)
	}

	fn help<'a>(&'a self) -> Option<Box<dyn fmt::Display + 'a>> {
		Some(Box::new(&self.help))
	}

	fn source_code(&self) -> Option<&dyn SourceCode> {
		self.source.as_ref().map(|s| s as &dyn SourceCode)
	}

	fn labels(&self) -> Option<Box<dyn Iterator<Item = LabeledSpan> + '_>> {
		self.span.map(|sp| {
			Box::new(std::iter::once(LabeledSpan::new_with_span(Some("here".into()), sp)))
				as Box<dyn Iterator<Item = LabeledSpan>>
		})
	}
}

/// Map a [`DiagnosticVariant`] to its error code, help text, and severity.
fn variant_info(variant: &DiagnosticVariant) -> (String, String, Severity) {
	match variant {
		DiagnosticVariant::ParseError => (
			"E_PARSE_ERROR".into(),
			"Check the CodePath syntax; see the specification for valid grammar".into(),
			Severity::Error,
		),
		DiagnosticVariant::FileNotFound => {
			("E_FILE_NOT_FOUND".into(), "Check the path and permissions".into(), Severity::Error)
		},
		DiagnosticVariant::ArtifactNotFound => (
			"E_ARTIFACT_NOT_FOUND".into(),
			"The artifact may have expired or been deleted".into(),
			Severity::Error,
		),
		DiagnosticVariant::UnknownLocatorScheme { available } => {
			let help = format!("Unknown scheme. Available schemes: {}", available.join(", "));
			("E_UNKNOWN_LOCATOR_SCHEME".into(), help, Severity::Error)
		},
		DiagnosticVariant::SuffixSuggestion { tried, suggestion } => {
			let help = format!("Did you mean `{suggestion}` instead of `{tried}`?");
			("E_SUFFIX_SUGGESTION".into(), help, Severity::Warning)
		},
		DiagnosticVariant::NoMatches => (
			"E_NO_MATCHES".into(),
			"The path resolved to zero results; try broadening the query".into(),
			Severity::Warning,
		),
		DiagnosticVariant::AmbiguousTarget { count } => {
			let help = format!("Use a more specific path to narrow results; found {count} matches");
			("E_AMBIGUOUS_TARGET".into(), help, Severity::Error)
		},
		DiagnosticVariant::UnsupportedOperation => (
			"E_UNSUPPORTED_OPERATION".into(),
			"This resolver does not support the requested operation".into(),
			Severity::Error,
		),
		DiagnosticVariant::MissingActions => (
			"E_MISSING_ACTIONS".into(),
			"Edit command must include at least one action".into(),
			Severity::Error,
		),
		DiagnosticVariant::UnsupportedActionForResolver => (
			"E_UNSUPPORTED_ACTION_FOR_RESOLVER".into(),
			"No resolver supports the requested action kind".into(),
			Severity::Error,
		),
		DiagnosticVariant::Inaccessible => (
			"E_INACCESSIBLE".into(),
			"Permission denied when accessing the filesystem entry".into(),
			Severity::Error,
		),
		DiagnosticVariant::EncodingFallback => (
			"E_ENCODING_FALLBACK".into(),
			"File is not valid UTF-8; contents were read with a lossy encoding fallback".into(),
			Severity::Warning,
		),
		DiagnosticVariant::SchemeNotImplemented => (
			"E_SCHEME_NOT_IMPLEMENTED".into(),
			"The requested URI scheme is not implemented in this release".into(),
			Severity::Error,
		),
		DiagnosticVariant::FileExists => (
			"E_FILE_EXISTS".into(),
			"Use --force or delete the existing target first".into(),
			Severity::Error,
		),
		DiagnosticVariant::StaleAnchor => (
			"E_STALE_ANCHOR".into(),
			"The file has changed since the anchor was read; re-read and retry".into(),
			Severity::Error,
		),
		DiagnosticVariant::ZeroByteDeleteBlocked => (
			"E_ZERO_BYTE_DELETE_BLOCKED".into(),
			"Use a bare-path target to remove the file instead of a zero-byte delete".into(),
			Severity::Warning,
		),
		DiagnosticVariant::Cancelled => (
			"E_CANCELLED".into(),
			"The operation was cancelled; retry if this was unexpected".into(),
			Severity::Warning,
		),
		DiagnosticVariant::RangeBoundsInverted => (
			"E_RANGE_BOUNDS_INVERTED".into(),
			"The start of the range is greater than the end (e.g. [10..5]); swap the bounds".into(),
			Severity::Error,
		),
		DiagnosticVariant::RangeClamped => (
			"E_RANGE_CLAMPED".into(),
			"The range bounds were clamped to the file extent".into(),
			Severity::Warning,
		),
		DiagnosticVariant::IncompatibleTargetShape => (
			"E_INCOMPATIBLE_TARGET_SHAPE".into(),
			"The target shape is incompatible with the requested Op family".into(),
			Severity::Error,
		),
		DiagnosticVariant::PeerConflict => (
			"E_PEER_CONFLICT".into(),
			"Another session holds an active intent on the target; retry after the peer releases its \
			 lock"
				.into(),
			Severity::Error,
		),
	}
}

/// Render a [`Diagnostic`] to a multi-line pretty-printed string using miette.
///
/// When `source` is provided, the diagnostic span (if any) is annotated with
/// a caret pointing at the relevant portion of the source text.
pub fn render_diagnostic(diag: &Diagnostic, source: Option<&str>) -> String {
	let (code, help, severity) = variant_info(&diag.variant);

	let named_source = source.map(|s| NamedSource::new("codepath", s.to_owned()));
	let span = diag.span.as_ref().map(|s: &Span| {
		let start: usize = s.start;
		let len: usize = s.end.saturating_sub(s.start);
		SourceSpan::new(start.into(), len.into())
	});

	let report = DiagReport {
		message: diag.message.clone(),
		code,
		help,
		severity,
		source: named_source,
		span,
	};

	let mut output = String::new();
	let handler = GraphicalReportHandler::new_themed(GraphicalTheme::unicode_nocolor());
	// render_report only fails if the fmt::Write impl (String) errors, which it
	// won't.
	handler.render_report(&mut output, &report).unwrap();
	output
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;
	use crate::types::DiagnosticVariant;

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
		Diagnostic { variant, message: message.into(), span: Some(Span { start, end }) }
	}

	// ── No-source tests (1 per variant) ───────────────────────────

	#[test]
	fn render_parse_error() {
		let d = diag(DiagnosticVariant::ParseError, "unexpected token `@`");
		let out = d.render(None);
		assert!(out.contains("E_PARSE_ERROR"), "output:\n{out}");
	}

	#[test]
	fn render_file_not_found() {
		let d = diag(DiagnosticVariant::FileNotFound, "file `missing.txt` not found");
		let out = d.render(None);
		assert!(out.contains("E_FILE_NOT_FOUND"), "output:\n{out}");
	}

	#[test]
	fn render_artifact_not_found() {
		let d = diag(DiagnosticVariant::ArtifactNotFound, "artifact `abc123` not found");
		let out = d.render(None);
		assert!(out.contains("E_ARTIFACT_NOT_FOUND"), "output:\n{out}");
	}

	#[test]
	fn render_unknown_locator_scheme() {
		let d = diag(
			DiagnosticVariant::UnknownLocatorScheme {
				available: vec!["http".into(), "https".into(), "file".into()],
			},
			"unknown scheme `ftp`",
		);
		let out = d.render(None);
		assert!(out.contains("E_UNKNOWN_LOCATOR_SCHEME"), "output:\n{out}");
		assert!(out.contains("http"), "scheme hint absent:\n{out}");
	}

	#[test]
	fn render_suffix_suggestion() {
		let d = diag(
			DiagnosticVariant::SuffixSuggestion { tried: "foo".into(), suggestion: "bar".into() },
			"no matches; did you mean `bar`?",
		);
		let out = d.render(None);
		assert!(out.contains("E_SUFFIX_SUGGESTION"), "output:\n{out}");
		assert!(out.contains("bar"), "suggestion absent:\n{out}");
	}

	#[test]
	fn render_no_matches() {
		let d = diag(DiagnosticVariant::NoMatches, "no results for query");
		let out = d.render(None);
		assert!(out.contains("E_NO_MATCHES"), "output:\n{out}");
	}

	#[test]
	fn render_ambiguous_target() {
		let d = diag(DiagnosticVariant::AmbiguousTarget { count: 5 }, "found 5 matching nodes");
		let out = d.render(None);
		assert!(out.contains("E_AMBIGUOUS_TARGET"), "output:\n{out}");
		assert!(out.contains("5"), "count absent:\n{out}");
	}

	#[test]
	fn render_unsupported_operation() {
		let d =
			diag(DiagnosticVariant::UnsupportedOperation, "delete not supported by this resolver");
		let out = d.render(None);
		assert!(out.contains("E_UNSUPPORTED_OPERATION"), "output:\n{out}");
	}

	#[test]
	fn render_missing_actions() {
		let d = diag(DiagnosticVariant::MissingActions, "no actions provided");
		let out = d.render(None);
		assert!(out.contains("E_MISSING_ACTIONS"), "output:\n{out}");
	}

	#[test]
	fn render_unsupported_action_for_resolver() {
		let d = diag(
			DiagnosticVariant::UnsupportedActionForResolver,
			"no resolver handles this action kind",
		);
		let out = d.render(None);
		assert!(out.contains("E_UNSUPPORTED_ACTION_FOR_RESOLVER"), "output:\n{out}");
	}

	#[test]
	fn render_inaccessible() {
		let d = diag(DiagnosticVariant::Inaccessible, "permission denied: /root/secret");
		let out = d.render(None);
		assert!(out.contains("E_INACCESSIBLE"), "output:\n{out}");
	}

	#[test]
	fn render_encoding_fallback() {
		let d = diag(DiagnosticVariant::EncodingFallback, "file is not UTF-8; using lossy fallback");
		let out = d.render(None);
		assert!(out.contains("E_ENCODING_FALLBACK"), "output:\n{out}");
	}

	#[test]
	fn render_scheme_not_implemented() {
		let d = diag(DiagnosticVariant::SchemeNotImplemented, "scheme `ftp` is not implemented");
		let out = d.render(None);
		assert!(out.contains("E_SCHEME_NOT_IMPLEMENTED"), "output:\n{out}");
	}

	#[test]
	fn render_file_exists() {
		let d = diag(DiagnosticVariant::FileExists, "target `out.txt` already exists");
		let out = d.render(None);
		assert!(out.contains("E_FILE_EXISTS"), "output:\n{out}");
	}

	#[test]
	fn render_stale_anchor() {
		let d = diag(DiagnosticVariant::StaleAnchor, "anchor hash mismatch; file changed");
		let out = d.render(None);
		assert!(out.contains("E_STALE_ANCHOR"), "output:\n{out}");
	}

	#[test]
	fn render_zero_byte_delete_blocked() {
		let d =
			diag(DiagnosticVariant::ZeroByteDeleteBlocked, "delete would leave file at zero bytes");
		let out = d.render(None);
		assert!(out.contains("E_ZERO_BYTE_DELETE_BLOCKED"), "output:\n{out}");
	}

	#[test]
	fn render_cancelled() {
		let d = diag(DiagnosticVariant::Cancelled, "operation cancelled by user");
		let out = d.render(None);
		assert!(out.contains("E_CANCELLED"), "output:\n{out}");
	}

	#[test]
	fn render_range_bounds_inverted() {
		let d = diag(DiagnosticVariant::RangeBoundsInverted, "range 10..5 has start > end");
		let out = d.render(None);
		assert!(out.contains("E_RANGE_BOUNDS_INVERTED"), "output:\n{out}");
	}

	#[test]
	fn render_range_clamped() {
		let d = diag(DiagnosticVariant::RangeClamped, "range clamped to file bounds [0..100]");
		let out = d.render(None);
		assert!(out.contains("E_RANGE_CLAMPED"), "output:\n{out}");
	}

	#[test]
	fn render_incompatible_target_shape() {
		let d = diag(
			DiagnosticVariant::IncompatibleTargetShape,
			"cannot apply symbolReplace to a line target",
		);
		let out = d.render(None);
		assert!(out.contains("E_INCOMPATIBLE_TARGET_SHAPE"), "output:\n{out}");
	}

	// ── Source + span rendering ───────────────────────────────────

	#[test]
	fn render_with_source_span() {
		let d = diag_spanned(DiagnosticVariant::ParseError, "unexpected token at position 5", 5, 6);
		let out = d.render(Some("hello @world"));
		assert!(out.contains("E_PARSE_ERROR"), "output:\n{out}");
		// The source line should appear in the output.
		assert!(out.contains("hello"), "source line absent:\n{out}");
	}
}
