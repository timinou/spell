//! Type-aware CodePath qualifier dispatch.
//!
//! Routes semantic CodePath qualifiers to [`pi_code_graph::SemanticBackend`]:
//!
//! - `#hover` → smart merge of written (graph) + inferred (LSP) via
//!   [`pi_code_graph::merge_hover`]. Default `[source=both]`; escape
//!   hatches `[source=graph]` and `[source=semantic]`.
//! - `#type_definition` (alias `#type_def`) → `backend.type_definition_of`
//! - `#signature` → `backend.signature_at`
//! - `#inlay` → `backend.inlay_hints(file, range)`
//! - `#diagnostics` → `backend.diagnostics(file)` filtered by
//!   the `[severity=…]` predicate
//!
//! ## Hover smart-merge (FUP-097)
//!
//! `#hover` consults BOTH the graph-side Annotation backend and the
//! per-extension LSP backend independently via
//! [`SemanticBackend::hover_dual`], then merges via
//! [`pi_code_graph::merge_hover`]:
//!
//! - **Agreed** — both produce equal repr (normalised whitespace): render one
//! - **Single** — only one half present: render with `[source: graph|semantic]`
//! - **Disagreed** — both differ: render both, labelled
//! - **None** — neither answered: `NotFound`
//!
//! The `[source=…]` predicate on `#hover` overrides the smart-merge:
//!
//! - `[source=graph]` — query Annotation half only (skips LSP cost)
//! - `[source=semantic]` — query LSP half only (skips written sig)
//! - `[source=both]` (default) — smart merge above
//!
//! For non-hover semantic qualifiers there is no tree-sitter analog;
//! `[source=…]` predicates are silently ignored on those.
//!
//! ## Deprecation
//!
//! `#hover_inferred` (W3 introduction) was folded into `#hover` per
//! FUP-097. Calls to `#hover_inferred` return
//! [`TypeResolverOutcome::Deprecated`] with a replacement hint.
//!
//! This module is the SEAM between the agent-facing CodePath grammar and
//! the LSP-or-Annotation backend layer. It deliberately knows nothing
//! about how the backend was constructed (KDL config / LRU registry /
//! etc.) — that's `pi-code-graph::semantic::config`'s problem.

use std::path::Path;

use pi_code_graph::{
	merge_hover, Confidence, DiagnosticSeverity, HoverDual, HoverOutcome, HoverSource,
	InferResult, InlayHint, LineRange, SemanticBackend, SemanticDiagnostic, SemanticLocation,
	SignatureInfo, TypeRepr,
};
use pi_code_path::ast::{Predicate, Qualifier};

/// Result of dispatching a semantic qualifier. Each variant maps to one
/// of the trait methods; consumers in `napi.rs` marshal these into
/// CodePath `NodeRefDto` chunks.
#[derive(Debug, Clone, PartialEq)]
pub enum TypeResolverOutcome {
	/// `#hover` — the smart-merge of written (graph) + inferred (LSP).
	/// Single rendered string with optional source label — see
	/// [`HoverOutcome`].
	Hover(HoverOutcome),
	/// `#type_definition` (or its alias `#type_def`) — the declaration-site
	/// of the type of the symbol at `(file, line, col)`. `None` when
	/// unresolvable.
	TypeDefinition(Option<SemanticLocation>),
	/// `#signature` — signature help at a call site.
	Signature(Option<SignatureInfo>),
	/// `#inlay` — inline type hints across `range` (or the whole file).
	Inlay(Vec<InlayHint>),
	/// `#diagnostics` — push-cached diagnostics for the file, filtered
	/// by `[severity=…]` if present.
	Diagnostics(Vec<SemanticDiagnostic>),
	/// The qualifier name was unknown to this resolver. Caller falls back
	/// to the lexical / tree-sitter path with no special handling.
	NotASemanticQualifier,
	/// FUP-097: the qualifier is deprecated. `name` is the deprecated
	/// qualifier (e.g. `"hover_inferred"`); `replacement` is the
	/// canonical form the agent should use (e.g. `"hover"` or
	/// `"hover [source=semantic]"`). Callers MUST surface this as a
	/// diagnostic to the agent.
	Deprecated { name: String, replacement: String },
}

/// Map of qualifier name → recogniser. Public so call sites can ask
/// "is this a qualifier that needs semantic dispatch?" without paying
/// the dispatch cost.
///
/// `#hover` is admitted post-FUP-097: it dispatches through the same
/// smart-merge path as the deprecated `#hover_inferred` did.
pub fn is_semantic_qualifier(name: &str) -> bool {
	matches!(
		name,
		"hover" | "type_definition" | "type_def" | "signature" | "inlay" | "diagnostics"
	)
}

/// FUP-097: qualifiers that the W3 grammar accepted but have since been
/// folded into [`is_semantic_qualifier`] or removed. Dispatched as
/// [`TypeResolverOutcome::Deprecated`] with a friendly replacement hint.
pub fn deprecated_qualifier_replacement(name: &str) -> Option<&'static str> {
	match name {
		"hover_inferred" => Some("hover [source=semantic]"),
		_ => None,
	}
}

/// Predicate extraction: pull the named-attribute predicates out of a
/// `Query.head.predicates` slice into typed values the resolver can
/// reason about without re-parsing strings.
///
/// `source` is `Option<SourceSelector>` because the appropriate default
/// is per-qualifier: `#hover` defaults to `Both` (smart merge);
/// `#type_definition` / `#signature` / `#inlay` / `#diagnostics` default
/// to `Semantic` (no graph analog). Callers resolve via
/// [`SourceSelector::or_default`].
pub struct SemanticPredicates {
	pub source:   Option<SourceSelector>,
	pub severity: Option<DiagnosticSeverity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceSelector {
	/// `[source=semantic]` — only the SemanticBackend is consulted.
	Semantic,
	/// `[source=graph]` — only the graph-side (tree-sitter / annotation)
	/// answer is used.
	Graph,
	/// `[source=both]` — both consulted; merge policy is qualifier-specific
	/// (smart-merge for `#hover` via [`pi_code_graph::merge_hover`]).
	Both,
}

impl SourceSelector {
	/// Parse the value of `[source=…]`; unrecognised values return `None`
	/// so the caller can fall back to its per-qualifier default.
	pub fn parse(value: &str) -> Option<Self> {
		match value {
			"graph" => Some(Self::Graph),
			"semantic" => Some(Self::Semantic),
			"both" => Some(Self::Both),
			_ => None,
		}
	}
}

impl SemanticPredicates {
	pub fn extract(preds: &[Predicate]) -> Self {
		let mut source = None;
		let mut severity = None;
		for p in preds {
			if let Predicate::Attribute { name, value } = p {
				match name.as_str() {
					"source" => source = SourceSelector::parse(value),
					"severity" => severity = parse_severity(value),
					_ => {},
				}
			}
		}
		Self { source, severity }
	}
}

fn parse_severity(s: &str) -> Option<DiagnosticSeverity> {
	match s.to_ascii_lowercase().as_str() {
		"error" => Some(DiagnosticSeverity::Error),
		"warning" => Some(DiagnosticSeverity::Warning),
		"info" => Some(DiagnosticSeverity::Info),
		"hint" => Some(DiagnosticSeverity::Hint),
		_ => None,
	}
}

/// Dispatch entry point. `backend` is the per-workspace SemanticBackend
/// (typically `CompositeSemanticBackend`); `file/line/col` are 1-indexed
/// Semantic coordinates resolved from the CodePath target.
///
/// Returns [`TypeResolverOutcome::NotASemanticQualifier`] when the
/// qualifier name isn't one of the W3 set; the caller then falls back
/// to its tree-sitter path.
pub fn dispatch(
	backend: &dyn SemanticBackend,
	qualifier: &Qualifier,
	predicates: &[Predicate],
	file: &Path,
	line: u32,
	col: u32,
) -> TypeResolverOutcome {
	let sp = SemanticPredicates::extract(predicates);

	// FUP-097: deprecated qualifiers (e.g. `#hover_inferred`) before any
	// other reasoning — the agent should learn the canonical replacement.
	if let Some(replacement) = deprecated_qualifier_replacement(&qualifier.name) {
		return TypeResolverOutcome::Deprecated {
			name: qualifier.name.clone(),
			replacement: replacement.to_string(),
		};
	}

	// Unknown qualifier: caller falls back to the lexical / tree-sitter path.
	if !is_semantic_qualifier(&qualifier.name) {
		return TypeResolverOutcome::NotASemanticQualifier;
	}

	match qualifier.name.as_str() {
		// FUP-097: smart-merge dispatch. Default = Both (merge); escape
		// hatches via `[source=…]`.
		"hover" => dispatch_hover(backend, sp.source.unwrap_or(SourceSelector::Both), file, line, col),
		"type_definition" | "type_def" => {
			TypeResolverOutcome::TypeDefinition(backend.type_definition_of(file, line, col))
		},
		"signature" => TypeResolverOutcome::Signature(backend.signature_at(file, line, col)),
		"inlay" => {
			let range = parse_inlay_range(predicates);
			TypeResolverOutcome::Inlay(backend.inlay_hints(file, range))
		},
		"diagnostics" => {
			let mut diags = backend.diagnostics(file);
			if let Some(target) = sp.severity {
				diags.retain(|d| d.severity == target);
			}
			TypeResolverOutcome::Diagnostics(diags)
		},
		_ => unreachable!("is_semantic_qualifier admits exactly these names"),
	}
}

/// `#hover` smart-merge dispatch (FUP-097).
///
/// `source=both` (default): query both halves via [`SemanticBackend::hover_dual`],
/// merge via [`pi_code_graph::merge_hover`].
/// `source=graph`: take only `dual.written` (Annotation half).
/// `source=semantic`: take only `dual.inferred` (LSP half).
fn dispatch_hover(
	backend: &dyn SemanticBackend,
	source: SourceSelector,
	file: &Path,
	line: u32,
	col: u32,
) -> TypeResolverOutcome {
	let dual = backend.hover_dual(file, line, col);
	let filtered = match source {
		SourceSelector::Graph => HoverDual { written: dual.written, inferred: None },
		SourceSelector::Semantic => HoverDual { written: None, inferred: dual.inferred },
		SourceSelector::Both => dual,
	};
	TypeResolverOutcome::Hover(merge_hover(filtered))
}

/// Test whether the `[type_aware]` flag is present in a predicate set.
pub fn has_type_aware(predicates: &[Predicate]) -> bool {
	predicates.iter().any(|p| matches!(p, Predicate::Flag(s) if s == "type_aware"))
}

/// Narrow the result of an `EdgeResolver::resolve` call by receiver type via
/// `backend.narrow_dispatch`. Used by the dispatcher when a `def→[type_aware]`
/// or `call→[type_aware]` tail is parsed.
///
/// Conservative semantics: if `backend.capabilities().narrow_dispatch` is
/// false, returns `candidates` unchanged (no false-narrowing). The caller is
/// expected to surface an Informational diagnostic when narrowing was
/// requested but not honoured.
pub fn narrow_edge_results(
	backend: &dyn SemanticBackend,
	call_site: &SemanticLocation,
	candidates: Vec<SemanticLocation>,
) -> Vec<SemanticLocation> {
	if !backend.capabilities().narrow_dispatch {
		return candidates;
	}
	backend.narrow_dispatch(call_site, &candidates)
}

fn parse_inlay_range(predicates: &[Predicate]) -> Option<LineRange> {
	for p in predicates {
		if let Predicate::Range { start, end } = p {
			let s = start.and_then(|i| u32::try_from(i.max(1)).ok())?;
			let e = end.and_then(|i| u32::try_from(i.max(1)).ok())?;
			return Some(LineRange { start: s, end: e });
		}
	}
	None
}

/// Helper: render a TypeResolverOutcome to a human-readable summary
/// string the agent can read directly.
pub fn outcome_to_summary(outcome: &TypeResolverOutcome) -> String {
	match outcome {
		TypeResolverOutcome::Hover(hover) => format_hover(hover),
		TypeResolverOutcome::TypeDefinition(loc) => match loc {
			Some(l) => format!("{}:{}:{}", l.file.display(), l.line, l.col),
			None => "unknown".into(),
		},
		TypeResolverOutcome::Signature(sig) => match sig {
			Some(s) => s.signature.clone(),
			None => "unknown".into(),
		},
		TypeResolverOutcome::Inlay(hints) => {
			let mut out = String::new();
			for h in hints {
				out.push_str(&format!(
					"{}:{}:{}  {} ({:?})\n",
					h.location.file.display(),
					h.location.line,
					h.location.col,
					h.label,
					h.kind
				));
			}
			out
		},
		TypeResolverOutcome::Diagnostics(diags) => {
			let mut out = String::new();
			for d in diags {
				out.push_str(&format!(
					"{}:{}:{} [{:?}] {} ({})\n",
					d.location.file.display(),
					d.location.line,
					d.location.col,
					d.severity,
					d.message,
					d.source,
				));
			}
			out
		},
		TypeResolverOutcome::NotASemanticQualifier => String::new(),
		TypeResolverOutcome::Deprecated { name, replacement } => {
			format!("deprecated qualifier #{name} — use `#{replacement}` instead")
		},
	}
}

/// Render a [`HoverOutcome`] to the human-readable string the agent sees.
///
/// `Agreed` — just the repr, no source noise.
/// `Single { Graph }` — `<repr> [source: graph]`
/// `Single { Semantic }` — `<repr> [source: semantic]`
/// `Disagreed` — two lines, `written: ...` and `inferred: ...`
/// `None` — `"unknown"`
pub fn format_hover(hover: &HoverOutcome) -> String {
	match hover {
		HoverOutcome::Agreed { repr } => repr.clone(),
		HoverOutcome::Single { repr, source } => {
			let label = match source {
				HoverSource::Graph => "graph",
				HoverSource::Semantic => "semantic",
			};
			format!("{repr} [source: {label}]")
		},
		HoverOutcome::Disagreed { written, inferred } => {
			format!("written:  {written}\ninferred: {inferred}")
		},
		HoverOutcome::None => "unknown".into(),
	}
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use pi_code_graph::{SemanticCapabilities as Capabilities, TypeSource};

	use super::*;

	/// Test double: implements SemanticBackend with fixed-shape outputs so
	/// we can verify dispatch routing without spawning a real LSP.
	///
	/// `hover_dual_override` lets tests set both halves independently —
	/// when `None`, the trait default impl runs (classify-by-confidence on
	/// `type_at`).
	struct StubBackend {
		hover: InferResult,
		hover_dual_override: Option<HoverDual>,
		type_def: Option<SemanticLocation>,
		sig: Option<SignatureInfo>,
		inlay: Vec<InlayHint>,
		diag: Vec<SemanticDiagnostic>,
		last_inlay_range: std::sync::Mutex<Option<LineRange>>,
	}

	impl StubBackend {
		fn new() -> Self {
			Self {
				hover: InferResult::known(TypeRepr::text("Foo"), Confidence::Inferred, TypeSource::ForwardFlow),
				hover_dual_override: None,
				type_def: Some(SemanticLocation::point("/tmp/types.rs", 10, 1)),
				sig: None,
				inlay: vec![],
				diag: vec![],
				last_inlay_range: std::sync::Mutex::new(None),
			}
		}

		fn with_dual(mut self, dual: HoverDual) -> Self {
			self.hover_dual_override = Some(dual);
			self
		}
	}

	impl SemanticBackend for StubBackend {
		fn capabilities(&self) -> Capabilities { Capabilities::default() }
		fn type_at(&self, _f: &Path, _l: u32, _c: u32) -> InferResult { self.hover.clone() }
		fn hover_dual(&self, file: &Path, line: u32, col: u32) -> HoverDual {
			if let Some(d) = &self.hover_dual_override {
				return d.clone();
			}
			// Fall through to default impl: classify the single `type_at`.
			let r = self.type_at(file, line, col);
			if r.is_unknown() { return HoverDual::empty(); }
			match r.confidence {
				Confidence::Annotated => HoverDual { written: Some(r), inferred: None },
				Confidence::Inferred | Confidence::Heuristic => HoverDual { written: None, inferred: Some(r) },
				Confidence::Unknown => HoverDual::empty(),
			}
		}
		fn type_definition_of(&self, _f: &Path, _l: u32, _c: u32) -> Option<SemanticLocation> { self.type_def.clone() }
		fn signature_at(&self, _f: &Path, _l: u32, _c: u32) -> Option<SignatureInfo> { self.sig.clone() }
		fn inlay_hints(&self, _f: &Path, range: Option<LineRange>) -> Vec<InlayHint> {
			*self.last_inlay_range.lock().unwrap() = range;
			self.inlay.clone()
		}
		fn diagnostics(&self, _f: &Path) -> Vec<SemanticDiagnostic> { self.diag.clone() }
	}

	/// Helper: build an InferResult for the written half of a HoverDual.
	fn written(text: &str) -> InferResult {
		InferResult::known(TypeRepr::text(text), Confidence::Annotated, TypeSource::Annotation)
	}

	/// Helper: build an InferResult for the inferred half.
	fn inferred(text: &str) -> InferResult {
		InferResult::known(TypeRepr::text(text), Confidence::Inferred, TypeSource::ForwardFlow)
	}

	fn qual(name: &str) -> Qualifier {
		Qualifier { name: name.into(), args: None }
	}

	fn file() -> PathBuf {
		PathBuf::from("/tmp/foo.ex")
	}

	#[test]
	fn is_semantic_qualifier_recognises_w3_set() {
		// FUP-097: #hover replaces #hover_inferred via smart-merge.
		assert!(is_semantic_qualifier("hover"));
		assert!(is_semantic_qualifier("type_definition"));
		assert!(is_semantic_qualifier("type_def"));
		assert!(is_semantic_qualifier("signature"));
		assert!(is_semantic_qualifier("inlay"));
		assert!(is_semantic_qualifier("diagnostics"));
		// hover_inferred deprecated, NOT in the active semantic set.
		assert!(!is_semantic_qualifier("hover_inferred"));
		assert!(!is_semantic_qualifier("body"));
	}

	#[test]
	fn deprecated_qualifier_returns_replacement_hint() {
		let stub = StubBackend::new();
		let out = dispatch(&stub, &qual("hover_inferred"), &[], &file(), 1, 1);
		match out {
			TypeResolverOutcome::Deprecated { name, replacement } => {
				assert_eq!(name, "hover_inferred");
				assert_eq!(replacement, "hover [source=semantic]");
			},
			other => panic!("expected Deprecated, got {other:?}"),
		}
	}

	/// FUP-097 case A: both halves agree under normalisation - Agreed, no source label.
	#[test]
	fn hover_merge_agreed_collapses_to_one_repr() {
		let stub = StubBackend::new().with_dual(HoverDual {
			written: Some(written("fn foo(x: i32) -> bool")),
			inferred: Some(inferred("fn foo(x: i32) -> bool")),
		});
		let out = dispatch(&stub, &qual("hover"), &[], &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(HoverOutcome::Agreed { repr }) => {
				assert_eq!(repr, "fn foo(x: i32) -> bool");
			},
			other => panic!("expected Agreed, got {other:?}"),
		}
	}

	/// FUP-097 case B: only written present - Single { Graph }.
	#[test]
	fn hover_merge_single_graph_when_only_written() {
		let stub = StubBackend::new().with_dual(HoverDual {
			written: Some(written("&str")),
			inferred: None,
		});
		let out = dispatch(&stub, &qual("hover"), &[], &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(HoverOutcome::Single { repr, source }) => {
				assert_eq!(repr, "&str");
				assert_eq!(source, HoverSource::Graph);
			},
			other => panic!("expected Single Graph, got {other:?}"),
		}
	}

	/// FUP-097 case C: only inferred present - Single { Semantic }.
	#[test]
	fn hover_merge_single_semantic_when_only_inferred() {
		let stub = StubBackend::new().with_dual(HoverDual {
			written: None,
			inferred: Some(inferred("User { id: i32 }")),
		});
		let out = dispatch(&stub, &qual("hover"), &[], &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(HoverOutcome::Single { repr, source }) => {
				assert_eq!(repr, "User { id: i32 }");
				assert_eq!(source, HoverSource::Semantic);
			},
			other => panic!("expected Single Semantic, got {other:?}"),
		}
	}

	/// FUP-097 case D: both differ after normalisation - Disagreed, both labelled.
	#[test]
	fn hover_merge_disagreed_renders_both() {
		let stub = StubBackend::new().with_dual(HoverDual {
			written: Some(written("any")),
			inferred: Some(inferred("User { id: i32 }")),
		});
		let out = dispatch(&stub, &qual("hover"), &[], &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(HoverOutcome::Disagreed { written, inferred }) => {
				assert_eq!(written, "any");
				assert_eq!(inferred, "User { id: i32 }");
			},
			other => panic!("expected Disagreed, got {other:?}"),
		}
	}

	/// FUP-097 case E: neither half present - HoverOutcome::None.
	#[test]
	fn hover_merge_none_when_neither_half() {
		let stub = StubBackend::new().with_dual(HoverDual::empty());
		let out = dispatch(&stub, &qual("hover"), &[], &file(), 1, 1);
		assert_eq!(out, TypeResolverOutcome::Hover(HoverOutcome::None));
	}

	/// FUP-097: [source=graph] takes only the written half.
	#[test]
	fn hover_source_graph_uses_only_written() {
		let stub = StubBackend::new().with_dual(HoverDual {
			written: Some(written("any")),
			inferred: Some(inferred("User")),
		});
		let preds = vec![Predicate::Attribute { name: "source".into(), value: "graph".into() }];
		let out = dispatch(&stub, &qual("hover"), &preds, &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(HoverOutcome::Single { repr, source }) => {
				assert_eq!(repr, "any");
				assert_eq!(source, HoverSource::Graph);
			},
			other => panic!("expected Single Graph from source=graph, got {other:?}"),
		}
	}

	/// FUP-097: [source=semantic] takes only the inferred half.
	#[test]
	fn hover_source_semantic_uses_only_inferred() {
		let stub = StubBackend::new().with_dual(HoverDual {
			written: Some(written("any")),
			inferred: Some(inferred("User")),
		});
		let preds = vec![Predicate::Attribute { name: "source".into(), value: "semantic".into() }];
		let out = dispatch(&stub, &qual("hover"), &preds, &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(HoverOutcome::Single { repr, source }) => {
				assert_eq!(repr, "User");
				assert_eq!(source, HoverSource::Semantic);
			},
			other => panic!("expected Single Semantic from source=semantic, got {other:?}"),
		}
	}

	#[test]
	fn dispatch_type_def_and_alias_route_to_type_definition_of() {
		let stub = StubBackend::new();
		for name in ["type_definition", "type_def"] {
			let out = dispatch(&stub, &qual(name), &[], &file(), 1, 1);
			match out {
				TypeResolverOutcome::TypeDefinition(Some(loc)) => {
					assert_eq!(loc.line, 10);
				},
				other => panic!("expected TypeDefinition for `{name}`, got {other:?}"),
			}
		}
	}

	#[test]
	fn dispatch_diagnostics_filters_by_severity_attribute() {
		let mut stub = StubBackend::new();
		stub.diag = vec![
			SemanticDiagnostic {
				location: SemanticLocation::point(&file(), 1, 1),
				severity: DiagnosticSeverity::Error,
				message:  "oops".into(),
				source:   "test".into(),
			},
			SemanticDiagnostic {
				location: SemanticLocation::point(&file(), 2, 1),
				severity: DiagnosticSeverity::Warning,
				message:  "meh".into(),
				source:   "test".into(),
			},
		];

		// No filter → all 2.
		let all = dispatch(&stub, &qual("diagnostics"), &[], &file(), 1, 1);
		match all {
			TypeResolverOutcome::Diagnostics(d) => assert_eq!(d.len(), 2),
			other => panic!("expected Diagnostics, got {other:?}"),
		}

		// severity=error → 1.
		let preds = vec![Predicate::Attribute { name: "severity".into(), value: "error".into() }];
		let filtered = dispatch(&stub, &qual("diagnostics"), &preds, &file(), 1, 1);
		match filtered {
			TypeResolverOutcome::Diagnostics(d) => {
				assert_eq!(d.len(), 1);
				assert!(matches!(d[0].severity, DiagnosticSeverity::Error));
			},
			other => panic!("expected Diagnostics, got {other:?}"),
		}
	}

	/// FUP-097: unknown qualifier (no semantic match, no deprecation) returns
	/// `NotASemanticQualifier` so the caller falls back to its tree-sitter
	/// path. The `[source=...]` predicate is irrelevant for unknown names.
	#[test]
	fn dispatch_unknown_qualifier_with_source_graph_is_not_semantic() {
		let stub = StubBackend::new();
		let preds = vec![Predicate::Attribute { name: "source".into(), value: "graph".into() }];
		let out = dispatch(&stub, &qual("body"), &preds, &file(), 1, 1);
		assert_eq!(out, TypeResolverOutcome::NotASemanticQualifier);
	}

	#[test]
	fn dispatch_inlay_passes_range_through_when_predicate_present() {
		let stub = StubBackend::new();
		let preds = vec![Predicate::Range { start: Some(10), end: Some(20) }];
		let _ = dispatch(&stub, &qual("inlay"), &preds, &file(), 1, 1);
		let captured = stub.last_inlay_range.lock().unwrap().clone();
		assert_eq!(captured, Some(LineRange { start: 10, end: 20 }));
	}

	#[test]
	fn dispatch_inlay_without_range_passes_none() {
		let stub = StubBackend::new();
		let _ = dispatch(&stub, &qual("inlay"), &[], &file(), 1, 1);
		let captured = stub.last_inlay_range.lock().unwrap().clone();
		assert_eq!(captured, None);
	}

	#[test]
	fn dispatch_unknown_qualifier_returns_not_semantic() {
		let stub = StubBackend::new();
		let out = dispatch(&stub, &qual("body"), &[], &file(), 1, 1);
		assert_eq!(out, TypeResolverOutcome::NotASemanticQualifier);
	}

	#[test]
	fn has_type_aware_detects_flag_predicate() {
		assert!(!has_type_aware(&[]));
		assert!(!has_type_aware(&[Predicate::Flag("text".into())]));
		assert!(has_type_aware(&[Predicate::Flag("type_aware".into())]));
	}

	#[test]
	fn narrow_edge_results_returns_candidates_unchanged_when_backend_cant_narrow() {
		let stub = StubBackend::new();
		let call_site = SemanticLocation::point(&file(), 1, 1);
		let candidates = vec![
			SemanticLocation::point("/tmp/a.ex", 10, 1),
			SemanticLocation::point("/tmp/b.ex", 20, 1),
		];
		let narrowed = narrow_edge_results(&stub, &call_site, candidates.clone());
		assert_eq!(narrowed, candidates, "non-narrowing backend preserves the set");
	}

	/// W3: a backend that DOES advertise narrow_dispatch is consulted; result
	/// is whatever it returns (filter logic tested in backend impl tests).
	#[test]
	fn narrow_edge_results_consults_backend_when_capability_advertised() {
		struct NarrowingBackend;
		impl SemanticBackend for NarrowingBackend {
			fn capabilities(&self) -> Capabilities {
				Capabilities { narrow_dispatch: true, ..Default::default() }
			}
			fn type_at(&self, _f: &Path, _l: u32, _c: u32) -> InferResult {
				InferResult::unknown()
			}
			fn narrow_dispatch(
				&self,
				_call_site: &SemanticLocation,
				candidates: &[SemanticLocation],
			) -> Vec<SemanticLocation> {
				// Stub narrowing: keep only odd-line candidates.
				candidates.iter().filter(|l| l.line % 2 == 1).cloned().collect()
			}
		}
		let backend = NarrowingBackend;
		let call_site = SemanticLocation::point(&file(), 5, 1);
		let candidates = vec![
			SemanticLocation::point("/tmp/a.ex", 10, 1),
			SemanticLocation::point("/tmp/b.ex", 11, 1),
			SemanticLocation::point("/tmp/c.ex", 12, 1),
		];
		let narrowed = narrow_edge_results(&backend, &call_site, candidates);
		assert_eq!(narrowed.len(), 1, "odd-line filter keeps line 11 only");
		assert_eq!(narrowed[0].line, 11);
	}

	#[test]
	fn outcome_to_summary_formats_each_hover_variant() {
		let agreed = TypeResolverOutcome::Hover(HoverOutcome::Agreed { repr: "i32".into() });
		assert_eq!(outcome_to_summary(&agreed), "i32");

		let single_graph = TypeResolverOutcome::Hover(HoverOutcome::Single {
			repr: "i32".into(),
			source: HoverSource::Graph,
		});
		assert_eq!(outcome_to_summary(&single_graph), "i32 [source: graph]");

		let single_semantic = TypeResolverOutcome::Hover(HoverOutcome::Single {
			repr: "User".into(),
			source: HoverSource::Semantic,
		});
		assert_eq!(outcome_to_summary(&single_semantic), "User [source: semantic]");

		let disagreed = TypeResolverOutcome::Hover(HoverOutcome::Disagreed {
			written: "any".into(),
			inferred: "User".into(),
		});
		assert_eq!(outcome_to_summary(&disagreed), "written:  any\ninferred: User");

		let none = TypeResolverOutcome::Hover(HoverOutcome::None);
		assert_eq!(outcome_to_summary(&none), "unknown");

		let deprecated = TypeResolverOutcome::Deprecated {
			name: "hover_inferred".into(),
			replacement: "hover [source=semantic]".into(),
		};
		assert_eq!(
			outcome_to_summary(&deprecated),
			"deprecated qualifier #hover_inferred \u{2014} use `#hover [source=semantic]` instead"
		);
	}
}
