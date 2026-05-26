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
pub mod lsp;

use std::path::{Path, PathBuf};

pub use annotation::AnnotationSemanticBackend;
pub use composite::CompositeSemanticBackend;

// ── Trait ────────────────────────────────────────────────────────────

/// A provider of semantic-level answers about code at a given position.
///
/// ## Coordinate convention
///
/// All methods take `(file, line, col)` where both `line` and `col` are
/// **1-indexed bytes** — matching `SymbolNode::line/column` as populated by
/// the tree-sitter extractors. LSP-backed backends ([`lsp::LspSemanticBackend`])
/// convert to LSP's 0-indexed UTF-16 positions at their boundary; agent-facing
/// callers do not see the difference.
///
/// ## "Don't know" is data, not failure
///
/// No method panics or returns `Err` on a "don't know". Missing capability
/// returns [`Confidence::Unknown`] / `None` / empty `Vec` — the caller
/// composes fallbacks via [`CompositeSemanticBackend`].
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

	/// Compute the cross-file edit set for renaming a symbol at
	/// `(file, line, col)` to `new_name`. Drives
	/// `edit { ::S symbolRename newName=… }` in its semantic-aware form
	/// (cf. PLAN-320 W4 — the lexical rename via `def→` edges is the
	/// fallback path when no backend implements this).
	///
	/// Returns [`RenameError::Unsupported`] by default; backends that can
	/// perform type-aware rename override this.
	fn rename_preview(
		&self,
		_file: &Path,
		_line: u32,
		_col: u32,
		_new_name: &str,
	) -> Result<WorkspaceEdit, RenameError> {
		Err(RenameError::Unsupported)
	}

	/// Find references narrowed by receiver type — the type-aware
	/// counterpart to lexical `def→`. For `foo.bar()` where
	/// `foo: SomeInterface`, returns only the reference sites where the
	/// receiver's static type matches `receiver_filter`.
	///
	/// `receiver_filter = None` requests all references (equivalent to
	/// the lexical edge). Default impl returns an empty Vec; backends
	/// that implement type-aware narrowing override this.
	fn references_narrowed(
		&self,
		_symbol: &Location,
		_receiver_filter: Option<&TypeRepr>,
	) -> Vec<Location> {
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
	pub rename:            bool,
	pub references_narrowed: bool,
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

	/// Construct a known result. Panics in debug builds if `confidence ==
	/// Unknown` to enforce the invariant that `Unknown` implies an empty
	/// `repr` — use [`InferResult::unknown`] for that case.
	pub fn known(repr: TypeRepr, confidence: Confidence, source: TypeSource) -> Self {
		debug_assert!(
			!matches!(confidence, Confidence::Unknown),
			"InferResult::known called with Confidence::Unknown; use ::unknown()",
		);
		Self { repr, confidence, source }
	}

	/// True iff this result carries no useful information. Verifies
	/// **both** `confidence == Unknown` **and** `repr` is empty, so a
	/// future caller that builds an `InferResult` directly with
	/// `confidence: Unknown, repr: Text("…")` doesn't get a false positive
	/// that drops useful data on the [`CompositeSemanticBackend`] fallback
	/// path.
	pub fn is_unknown(&self) -> bool {
		matches!(self.confidence, Confidence::Unknown) && matches!(self.repr, TypeRepr::Empty)
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

/// A point or range in source. `line` and `col` are **1-indexed bytes**
/// (matches `SymbolNode::line/column` populated by the tree-sitter
/// extractors). LSP-backed backends convert to LSP's 0-indexed UTF-16 at
/// their boundary.
///
/// `end` is `Some((line, col))` for a range; `None` for a single point at
/// `(line, col)`. Combined into a single `Option<(u32, u32)>` so the
/// invariant "end_line and end_col agree on presence" is enforced by the
/// type system.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Location {
	pub file: PathBuf,
	pub line: u32,
	pub col:  u32,
	pub end:  Option<(u32, u32)>,
}

impl Location {
	pub fn point(file: impl Into<PathBuf>, line: u32, col: u32) -> Self {
		Self { file: file.into(), line, col, end: None }
	}

	pub fn range(
		file: impl Into<PathBuf>,
		(start_line, start_col): (u32, u32),
		(end_line, end_col): (u32, u32),
	) -> Self {
		Self {
			file: file.into(),
			line: start_line,
			col:  start_col,
			end:  Some((end_line, end_col)),
		}
	}

	/// `(end_line, end_col)` if this is a range; otherwise `(line, col)`
	/// (the start is also the end of a point).
	pub fn end_or_point(&self) -> (u32, u32) {
		self.end.unwrap_or((self.line, self.col))
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

// ── Rename ────────────────────────────────────────────────────────────

/// A workspace-wide edit set produced by a rename operation. Each entry
/// is one contiguous text replacement at `Location`; multiple entries can
/// target the same file (atomic across the workspace).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEdit {
	pub edits: Vec<TextEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
	pub location: Location,
	pub new_text: String,
}

/// Why a rename couldn't be computed. Distinct from "no occurrences":
/// returning `Ok(WorkspaceEdit { edits: vec![] })` indicates the symbol
/// resolved but has no rewrite sites; `RenameError` indicates the rename
/// can't be attempted at all (capability missing / symbol unresolvable /
/// new name invalid for the language).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenameError {
	/// Backend doesn't implement type-aware rename. Callers fall back to
	/// the lexical edit path (PLAN-320 W4).
	Unsupported,
	/// No symbol resolved at `(file, line, col)`.
	NoSymbol,
	/// The proposed `new_name` is not a valid identifier in this language
	/// (e.g. reserved word, illegal character, conflicting binding).
	InvalidName { reason: String },
	/// Backend was reachable but returned an error during computation.
	BackendError(String),
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
		assert!(p.end.is_none());
		assert_eq!(p.end_or_point(), (10, 5));
	}

	/// W0g (P2): `Location::range` is the only path that sets `end`, so the
	/// type system enforces that end-line and end-col agree on presence.
	#[test]
	fn location_range_carries_both_end_fields() {
		let r = Location::range("foo.rs", (1, 0), (3, 10));
		assert_eq!(r.line, 1);
		assert_eq!(r.col, 0);
		assert_eq!(r.end, Some((3, 10)));
		assert_eq!(r.end_or_point(), (3, 10));
	}

	/// W0g (P2): `is_unknown` now checks BOTH confidence AND empty repr,
	/// preventing CompositeSemanticBackend from dropping a meaningful
	/// `Text("…")` result whose `Confidence::Unknown` was set by a backend bug.
	#[test]
	fn is_unknown_requires_both_confidence_and_empty_repr() {
		let hand_built = InferResult {
			repr:       TypeRepr::text("meaningful"),
			confidence: Confidence::Unknown,
			source:     TypeSource::ForwardFlow,
		};
		assert!(!hand_built.is_unknown(), "non-empty repr must NOT be considered unknown");

		let canonical = InferResult::unknown();
		assert!(canonical.is_unknown());
	}

	/// W0g (P1+P2): `RenameError::Unsupported` is the default for backends
	/// that don't implement type-aware rename. The variant exists so W3 can
	/// distinguish "no symbol" from "capability missing".
	#[test]
	fn rename_error_variants_are_distinct() {
		assert_ne!(RenameError::Unsupported, RenameError::NoSymbol);
		assert_ne!(
			RenameError::Unsupported,
			RenameError::InvalidName { reason: "x".into() },
		);
	}

	/// W0g (P1): default trait impls for the new methods return the right
	/// "don't know" signal so backends inheriting them never accidentally
	/// promise capabilities they don't have.
	#[test]
	fn default_trait_impls_return_unsupported_or_empty() {
		struct NoOp;
		impl SemanticBackend for NoOp {
			fn capabilities(&self) -> Capabilities { Capabilities::default() }
			fn type_at(&self, _f: &Path, _l: u32, _c: u32) -> InferResult { InferResult::unknown() }
		}
		let backend = NoOp;
		let result = backend.rename_preview(Path::new("a"), 1, 1, "foo");
		assert_eq!(result, Err(RenameError::Unsupported));
		let refs = backend.references_narrowed(&Location::point("a", 1, 1), None);
		assert!(refs.is_empty());
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
