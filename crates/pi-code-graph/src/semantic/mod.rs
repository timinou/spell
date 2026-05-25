//! Semantic-information layer.
//!
//! The static code graph (tree-sitter extractors → typed edges) covers
//! ~95% of agent queries. The remaining 5% — inferred-type hover, narrowed
//! polymorphic dispatch, diagnostics, signature help — needs a real type
//! system. A [`SemanticBackend`] is a configurable provider of those
//! answers; `pi-code-graph` ships two implementations:
//!
//! - [`AnnotationSemanticBackend`] (this module) — reads written types
//!   straight out of `SymbolNode::detail` (already extracted by the
//!   tree-sitter passes in PLAN-318 W4). Zero process spawn, instant.
//! - `LspSemanticBackend` (`pi-code-graph::semantic::lsp`, PLAN-319 W1) —
//!   spawns an LSP server per language and routes hover / typeDefinition /
//!   references / diagnostics requests through it.
//!
//! [`CompositeSemanticBackend`] dispatches per-file by extension to the
//! configured backend, falling back to [`AnnotationSemanticBackend`] when
//! none is wired. The agent-facing CodePath qualifiers
//! (`#hover_inferred`, `#type_definition`, `#signature`, `#inlay`,
//! `#diagnostics`) and the `[type_aware]` predicate are routed here by
//! `pi-natives::code_path::type_resolver` in PLAN-319 W3.
//!
//! ## Why a trait, not concrete LSP code
//!
//! - Languages without an installed LSP degrade gracefully to
//!   [`AnnotationSemanticBackend`] — agents see written sigs, never an error.
//! - Tests for `type_resolver` / `edge_resolver` can use a deterministic
//!   stub backend without spawning processes.
//! - PLAN-320 fan-out adds one `lsp-server` block per language; no new
//!   trait impls needed.

pub mod annotation;
pub mod composite;

use std::path::{Path, PathBuf};

pub use annotation::AnnotationSemanticBackend;
pub use composite::CompositeSemanticBackend;

// ── Trait ────────────────────────────────────────────────────────────

/// A provider of semantic-level answers about code at a given position.
///
/// All methods take a coordinate (`file`, 1-indexed `line`, 0-indexed
/// UTF-16 `col` per LSP convention) and return whatever the backend can
/// resolve — or [`Confidence::Unknown`] when it can't. No method panics or
/// returns `Err` on a "don't know"; missing capability is data, not failure.
pub trait SemanticBackend: Send + Sync {
	/// Static capability advertisement. Populated from the configured KDL
	/// block or (for LSP backends) from the server's `initialize` response.
	fn capabilities(&self) -> Capabilities;

	/// Inferred or written type at `(file, line, col)`. Drives
	/// `find { ::S #hover_inferred }` and `find { ::S #hover }`.
	fn type_at(&self, file: &Path, line: u32, col: u32) -> InferResult;

	/// Where is the type of the symbol at `(file, line, col)` declared?
	/// Drives `find { ::S #type_definition }`. Returns `None` when the
	/// backend has no answer (default trait impl).
	fn type_definition_of(&self, _file: &Path, _line: u32, _col: u32) -> Option<Location> {
		None
	}

	/// Signature help at a call site. Drives `find { ::S #signature }`.
	fn signature_at(&self, _file: &Path, _line: u32, _col: u32) -> Option<SignatureInfo> {
		None
	}

	/// Inline type hints for a file or a sub-range of it. Drives
	/// `find { ::S #inlay }`. Empty Vec when unsupported.
	fn inlay_hints(&self, _file: &Path, _range: Option<LineRange>) -> Vec<InlayHint> {
		Vec::new()
	}

	/// Narrow a candidate dispatch set by receiver type. For `foo.bar()`
	/// where `foo: SomeInterface`, returns only the candidates whose
	/// declaring type matches the receiver type. Returns the input
	/// unchanged when the backend can't perform narrowing (default impl).
	///
	/// Drives `find { ::S def→[type_aware] }`.
	fn narrow_dispatch(&self, _call_site: &Location, candidates: &[Location]) -> Vec<Location> {
		candidates.to_vec()
	}

	/// Diagnostics (errors / warnings / hints) for a file. Drives
	/// `find { glob #diagnostics }`. Empty Vec when none / unsupported.
	fn diagnostics(&self, _file: &Path) -> Vec<Diagnostic> {
		Vec::new()
	}
}

// ── Capabilities ─────────────────────────────────────────────────────

/// What a backend can do. Set conservatively; consumers refuse queries
/// for un-advertised features rather than calling and getting `Unknown`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Capabilities {
	pub inferred_hover:    bool,
	pub type_definition:   bool,
	pub signature:         bool,
	pub inlay_hints:       bool,
	pub narrow_dispatch:   bool,
	pub diagnostics:       bool,
}

// ── Infer / Confidence ───────────────────────────────────────────────

/// Result of a type-at-position query.
#[derive(Debug, Clone, PartialEq)]
pub struct InferResult {
	/// Pretty-printable type representation (per-language: `Promise<string>`,
	/// `Result<T, E>`, `list[int]`, etc.). Empty when `confidence = Unknown`.
	pub repr:       TypeRepr,
	/// How sure the backend is.
	pub confidence: Confidence,
	/// Where the type came from.
	pub source:     TypeSource,
}

impl InferResult {
	pub const fn unknown() -> Self {
		Self {
			repr:       TypeRepr::Empty,
			confidence: Confidence::Unknown,
			source:     TypeSource::Default,
		}
	}

	pub fn is_unknown(&self) -> bool {
		matches!(self.confidence, Confidence::Unknown)
	}
}

/// Pretty-printable type — kept as an opaque newtype rather than a
/// fully-typed AST so each backend can render in its own dialect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeRepr {
	Empty,
	Text(String),
}

impl TypeRepr {
	pub fn text(s: impl Into<String>) -> Self {
		Self::Text(s.into())
	}

	pub fn as_str(&self) -> &str {
		match self {
			Self::Empty => "",
			Self::Text(s) => s,
		}
	}
}

/// How sure is the backend about a [`TypeRepr`]?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
	/// User wrote the type explicitly (annotation, signature).
	Annotated,
	/// Backend inferred it via forward-flow / unification / its own logic.
	Inferred,
	/// Best-guess (e.g. literal-derived).
	Heuristic,
	/// Backend has no answer.
	Unknown,
}

/// Provenance of an [`InferResult`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeSource {
	/// Read directly from a written type annotation in source.
	Annotation,
	/// Result of forward-flow / unification / LSP inference.
	ForwardFlow,
	/// Backend default / placeholder.
	Default,
}

// ── Location ─────────────────────────────────────────────────────────

/// A point or range in source. `line` is 1-indexed; `col` is 0-indexed
/// (matches LSP). When `end_line` is `None`, the location is a single
/// point at `(line, col)`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Location {
	pub file:     PathBuf,
	pub line:     u32,
	pub col:      u32,
	pub end_line: Option<u32>,
	pub end_col:  Option<u32>,
}

impl Location {
	pub fn point(file: impl Into<PathBuf>, line: u32, col: u32) -> Self {
		Self {
			file: file.into(),
			line,
			col,
			end_line: None,
			end_col: None,
		}
	}
}

/// Inclusive `[start, end]` line range. 1-indexed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineRange {
	pub start: u32,
	pub end:   u32,
}

// ── Diagnostic / Signature / Inlay ───────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
	pub location: Location,
	pub severity: Severity,
	pub message:  String,
	/// E.g. `"rust-analyzer"`, `"expert"`, `"clippy"`. Surfaced in the
	/// agent's output so the user knows which tool produced the diagnostic.
	pub source:   String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
	Error,
	Warning,
	Info,
	Hint,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignatureInfo {
	/// Full signature text (`fn foo(a: i32, b: &str) -> bool`).
	pub signature:      String,
	/// Per-parameter sub-strings (`["a: i32", "b: &str"]`).
	pub parameters:     Vec<String>,
	/// 0-indexed; the currently-active parameter at the cursor position.
	/// `None` when the backend can't determine it.
	pub active_param:   Option<usize>,
	/// Optional documentation block.
	pub documentation:  Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlayHint {
	pub location: Location,
	pub label:    String,
	pub kind:     InlayKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InlayKind {
	/// `let x: <ThisShownInline> = expr`.
	Type,
	/// `fn foo(<param>: arg)`.
	Parameter,
}

// ── Unit tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn infer_result_unknown_is_unknown() {
		let r = InferResult::unknown();
		assert!(r.is_unknown());
		assert_eq!(r.repr, TypeRepr::Empty);
		assert_eq!(r.confidence, Confidence::Unknown);
		assert_eq!(r.source, TypeSource::Default);
	}

	#[test]
	fn type_repr_text_round_trip() {
		let t = TypeRepr::text("Promise<string>");
		assert_eq!(t.as_str(), "Promise<string>");
	}

	#[test]
	fn capabilities_default_is_all_false() {
		let c = Capabilities::default();
		assert!(!c.inferred_hover);
		assert!(!c.type_definition);
		assert!(!c.signature);
		assert!(!c.inlay_hints);
		assert!(!c.narrow_dispatch);
		assert!(!c.diagnostics);
	}

	#[test]
	fn location_point_collapses_end() {
		let p = Location::point("foo.rs", 10, 5);
		assert_eq!(p.line, 10);
		assert_eq!(p.col, 5);
		assert!(p.end_line.is_none());
		assert!(p.end_col.is_none());
	}

	#[test]
	fn confidence_distinguishes_annotated_from_inferred() {
		// Strictly ordering by certainty isn't part of the contract, but
		// the variants must be distinct so callers can filter by them.
		assert_ne!(Confidence::Annotated, Confidence::Inferred);
		assert_ne!(Confidence::Inferred, Confidence::Heuristic);
		assert_ne!(Confidence::Heuristic, Confidence::Unknown);
	}
}
