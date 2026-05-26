//! Type-aware CodePath qualifier dispatch.
//!
//! Routes the PLAN-319 W3 qualifiers to [`pi_code_graph::SemanticBackend`]:
//!
//! - `#hover_inferred` → `backend.type_at(file, line, col)`
//! - `#type_definition` (alias `#type_def`) → `backend.type_definition_of(file, line, col)`
//! - `#signature` → `backend.signature_at(file, line, col)`
//! - `#inlay` → `backend.inlay_hints(file, range)`
//! - `#diagnostics` → `backend.diagnostics(file)` filtered by
//!   the `[severity=…]` and `[source=…]` predicates
//!
//! ## Source filtering
//!
//! The `[source=…]` predicate gates which backends contribute to the
//! result set:
//!
//! - `source=semantic` (default for these qualifiers) — only the
//!   SemanticBackend is consulted.
//! - `source=graph` — [`dispatch`] returns
//!   [`TypeResolverOutcome::RedirectedToGraph`] so the caller can route
//!   to the tree-sitter analog (e.g. `#hover` for `#hover_inferred`).
//! - `source=both` — SemanticBackend is consulted AND the caller is told
//!   to ALSO query the graph-side analog. The dispatcher returns the
//!   semantic result wrapped in a flag indicating both should be merged
//!   by the caller (which holds the graph resolvers). The merge policy
//!   — semantic wins on conflict — lives outside this module.
//!
//! This module is the SEAM between the agent-facing CodePath grammar and
//! the LSP-or-Annotation backend layer. It deliberately knows nothing
//! about how the backend was constructed (KDL config / LRU registry /
//! etc.) — that's `pi-code-graph::semantic::config`'s problem.

use std::path::Path;

use pi_code_graph::{
	Confidence, DiagnosticSeverity, InferResult, InlayHint, LineRange,
	SemanticBackend, SemanticDiagnostic, SemanticLocation, SignatureInfo, TypeRepr,
};
use pi_code_path::ast::{Predicate, Qualifier};

/// Result of dispatching a semantic qualifier. Each variant maps to one
/// of the trait methods; consumers in `napi.rs` marshal these into
/// CodePath `NodeRefDto` chunks.
#[derive(Debug, Clone, PartialEq)]
pub enum TypeResolverOutcome {
	/// `#hover_inferred` — `InferResult` for a position.
	Hover(InferResult),
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
	/// W3g (P2 fix): the qualifier IS semantic but `[source=graph]` was
	/// requested. Caller should run the tree-sitter analog of this
	/// qualifier (e.g. `#hover` for `#hover_inferred`). The variant carries
	/// the *original* semantic qualifier name so the caller can pick the
	/// right analog.
	RedirectedToGraph { semantic_qualifier: String },
	/// W3g (P1 disclosure): `[source=both]` was requested. The semantic
	/// answer is included; the caller MUST also run the tree-sitter analog
	/// and merge results (semantic wins on conflict). Wraps the semantic
	/// outcome plus the original qualifier name so the caller knows what
	/// to merge with.
	BothMerged { semantic: Box<TypeResolverOutcome>, semantic_qualifier: String },
}

/// Map of qualifier name → recogniser. Public so call sites can ask
/// "is this a qualifier that needs semantic dispatch?" without paying
/// the dispatch cost.
pub fn is_semantic_qualifier(name: &str) -> bool {
	matches!(
		name,
		"hover_inferred" | "type_definition" | "type_def" | "signature" | "inlay" | "diagnostics"
	)
}

/// Predicate extraction: pull the named-attribute predicates out of a
/// `Query.head.predicates` slice into typed values the resolver can
/// reason about without re-parsing strings.
pub struct SemanticPredicates {
	pub source:   SourceSelector,
	pub severity: Option<DiagnosticSeverity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceSelector {
	/// `[source=semantic]` (default for the semantic qualifiers).
	Semantic,
	/// `[source=graph]` — caller falls back to the tree-sitter path.
	Graph,
	/// `[source=both]` — both consulted; semantic answer wins on tie.
	Both,
}

impl SemanticPredicates {
	pub fn extract(preds: &[Predicate]) -> Self {
		let mut source = SourceSelector::Semantic;
		let mut severity = None;
		for p in preds {
			if let Predicate::Attribute { name, value } = p {
				match name.as_str() {
					"source" => {
						source = match value.as_str() {
							"graph" => SourceSelector::Graph,
							"both" => SourceSelector::Both,
							_ => SourceSelector::Semantic,
						};
					},
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

	// Unknown qualifier first — short-circuit before any backend or source
	// reasoning so 'source=graph + unknown_qualifier' doesn't get mislabelled
	// as a graph-redirect.
	if !is_semantic_qualifier(&qualifier.name) {
		return TypeResolverOutcome::NotASemanticQualifier;
	}

	// `[source=graph]` short-circuit: surface the qualifier name so the
	// caller can pick the right tree-sitter analog (W3g P2 fix).
	if matches!(sp.source, SourceSelector::Graph) {
		return TypeResolverOutcome::RedirectedToGraph {
			semantic_qualifier: qualifier.name.clone(),
		};
	}

	let semantic = match qualifier.name.as_str() {
		"hover_inferred" => TypeResolverOutcome::Hover(backend.type_at(file, line, col)),
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
	};

	// W3g (P1 fix): `[source=both]` wraps the semantic outcome so the
	// caller knows to also run the tree-sitter analog and merge results.
	if matches!(sp.source, SourceSelector::Both) {
		return TypeResolverOutcome::BothMerged {
			semantic: Box::new(semantic),
			semantic_qualifier: qualifier.name.clone(),
		};
	}

	semantic
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
		TypeResolverOutcome::Hover(infer) => format_infer(infer),
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
		TypeResolverOutcome::RedirectedToGraph { semantic_qualifier } => {
			format!("<redirected to graph: #{semantic_qualifier}>")
		},
		TypeResolverOutcome::BothMerged { semantic, semantic_qualifier } => {
			format!(
				"{}\n<also query graph analog of #{semantic_qualifier}>",
				outcome_to_summary(semantic)
			)
		},
	}
}

fn format_infer(infer: &InferResult) -> String {
	let prefix = match infer.confidence {
		Confidence::Annotated => "",
		Confidence::Inferred => "~",
		Confidence::Heuristic => "?",
		Confidence::Unknown => return "unknown".into(),
	};
	let body = match &infer.repr {
		TypeRepr::Empty => return "unknown".into(),
		TypeRepr::Text(s) => s.as_str(),
	};
	format!("{prefix}{body}")
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use pi_code_graph::{SemanticCapabilities as Capabilities, TypeSource};

	use super::*;

	/// Test double: implements SemanticBackend with fixed-shape outputs so
	/// we can verify dispatch routing without spawning a real LSP.
	struct StubBackend {
		hover: InferResult,
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
				type_def: Some(SemanticLocation::point("/tmp/types.rs", 10, 1)),
				sig: None,
				inlay: vec![],
				diag: vec![],
				last_inlay_range: std::sync::Mutex::new(None),
			}
		}
	}

	impl SemanticBackend for StubBackend {
		fn capabilities(&self) -> Capabilities { Capabilities::default() }
		fn type_at(&self, _f: &Path, _l: u32, _c: u32) -> InferResult { self.hover.clone() }
		fn type_definition_of(&self, _f: &Path, _l: u32, _c: u32) -> Option<SemanticLocation> { self.type_def.clone() }
		fn signature_at(&self, _f: &Path, _l: u32, _c: u32) -> Option<SignatureInfo> { self.sig.clone() }
		fn inlay_hints(&self, _f: &Path, range: Option<LineRange>) -> Vec<InlayHint> {
			*self.last_inlay_range.lock().unwrap() = range;
			self.inlay.clone()
		}
		fn diagnostics(&self, _f: &Path) -> Vec<SemanticDiagnostic> { self.diag.clone() }
	}

	fn qual(name: &str) -> Qualifier {
		Qualifier { name: name.into(), args: None }
	}

	fn file() -> PathBuf {
		PathBuf::from("/tmp/foo.ex")
	}

	#[test]
	fn is_semantic_qualifier_recognises_w3_set() {
		assert!(is_semantic_qualifier("hover_inferred"));
		assert!(is_semantic_qualifier("type_definition"));
		assert!(is_semantic_qualifier("type_def"));
		assert!(is_semantic_qualifier("signature"));
		assert!(is_semantic_qualifier("inlay"));
		assert!(is_semantic_qualifier("diagnostics"));
		assert!(!is_semantic_qualifier("body"));
		assert!(!is_semantic_qualifier("hover")); // written-sig is graph-side
	}

	#[test]
	fn dispatch_hover_inferred_routes_to_type_at() {
		let stub = StubBackend::new();
		let out = dispatch(&stub, &qual("hover_inferred"), &[], &file(), 1, 1);
		match out {
			TypeResolverOutcome::Hover(infer) => {
				assert_eq!(infer.repr.as_str(), "Foo");
				assert_eq!(infer.confidence, Confidence::Inferred);
			},
			other => panic!("expected Hover, got {other:?}"),
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

	#[test]
	fn dispatch_source_graph_returns_redirected_carrying_qualifier_name() {
		// W3g (P2) regression: distinguishes 'redirected to graph' from
		// 'unknown qualifier'. Caller needs the semantic-qualifier name to
		// pick the right tree-sitter analog.
		let stub = StubBackend::new();
		let preds = vec![Predicate::Attribute { name: "source".into(), value: "graph".into() }];
		let out = dispatch(&stub, &qual("hover_inferred"), &preds, &file(), 1, 1);
		match out {
			TypeResolverOutcome::RedirectedToGraph { semantic_qualifier } => {
				assert_eq!(semantic_qualifier, "hover_inferred");
			},
			other => panic!("expected RedirectedToGraph, got {other:?}"),
		}
	}

	/// W3g (P2) regression: unknown qualifier returns the original
	/// NotASemanticQualifier variant, NOT RedirectedToGraph, regardless of
	/// the [source=...] predicate.
	#[test]
	fn dispatch_unknown_qualifier_with_source_graph_is_not_redirect() {
		let stub = StubBackend::new();
		let preds = vec![Predicate::Attribute { name: "source".into(), value: "graph".into() }];
		let out = dispatch(&stub, &qual("body"), &preds, &file(), 1, 1);
		assert_eq!(out, TypeResolverOutcome::NotASemanticQualifier);
	}

	/// W3g (P1) regression: `[source=both]` wraps the semantic outcome
	/// in BothMerged so the caller knows to also run the graph analog.
	#[test]
	fn dispatch_source_both_wraps_semantic_outcome_for_merge() {
		let stub = StubBackend::new();
		let preds = vec![Predicate::Attribute { name: "source".into(), value: "both".into() }];
		let out = dispatch(&stub, &qual("hover_inferred"), &preds, &file(), 1, 1);
		match out {
			TypeResolverOutcome::BothMerged { semantic, semantic_qualifier } => {
				assert_eq!(semantic_qualifier, "hover_inferred");
				match *semantic {
					TypeResolverOutcome::Hover(infer) => {
						assert_eq!(infer.repr.as_str(), "Foo");
					},
					other => panic!("expected Hover inside BothMerged, got {other:?}"),
				}
			},
			other => panic!("expected BothMerged, got {other:?}"),
		}
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
	fn outcome_to_summary_formats_each_variant() {
		let stub = StubBackend::new();
		let hover = dispatch(&stub, &qual("hover_inferred"), &[], &file(), 1, 1);
		assert_eq!(outcome_to_summary(&hover), "~Foo", "Inferred prefix '~'");

		let unknown = TypeResolverOutcome::Hover(InferResult::unknown());
		assert_eq!(outcome_to_summary(&unknown), "unknown");
	}
}
