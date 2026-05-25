//! [`AnnotationSemanticBackend`] — reads written types out of the
//! `SymbolNode::detail` field populated by PLAN-318 W4's tree-sitter
//! extractors. Zero process spawn, instant.
//!
//! This is the default backend for every language. LSP-backed backends
//! (`semantic::lsp`) layer on top of it via [`CompositeSemanticBackend`]
//! and only handle queries Annotation can't answer.
//!
//! ## What it can do
//!
//! - [`SemanticBackend::type_at`] — returns `Confidence::Annotated` when
//!   a symbol at the queried position has a non-empty
//!   `SymbolNode::detail`; `Confidence::Unknown` otherwise. Never
//!   `Confidence::Inferred` — Annotation doesn't infer.
//!
//! ## What it can't
//!
//! - `type_definition_of`, `signature_at`, `inlay_hints`,
//!   `narrow_dispatch`, `diagnostics` — all default-impl'd to "unknown".
//!   These are LSP-only capabilities; PLAN-319 W1 wires them via
//!   `LspSemanticBackend`.

use std::{
	path::Path,
	sync::Arc,
};

use crate::{
	model::{CodeGraph, GraphNode, SymbolNode},
	semantic::{Capabilities, Confidence, InferResult, SemanticBackend, TypeRepr, TypeSource},
};

/// Default backend: reads written signatures from `SymbolNode::detail`.
/// Holds an `Arc<CodeGraph>` so multiple call sites share one snapshot.
#[derive(Debug, Clone)]
pub struct AnnotationSemanticBackend {
	graph: Arc<CodeGraph>,
}

impl AnnotationSemanticBackend {
	pub fn new(graph: Arc<CodeGraph>) -> Self {
		Self { graph }
	}

	/// Walk the graph for a Symbol node whose file matches and whose
	/// line spans `line`. Returns the closest-matching symbol (tightest
	/// line match wins). `O(N)` over the graph node set; fine for the
	/// current scale, can be indexed later.
	fn symbol_at(&self, file: &Path, line: u32) -> Option<&SymbolNode> {
		let mut best: Option<&SymbolNode> = None;
		let mut best_distance: u32 = u32::MAX;
		for node in self.graph.graph().node_weights() {
			let GraphNode::Symbol(sym) = node else { continue };
			if sym.file != file {
				continue;
			}
			// Exact-line match wins immediately.
			if sym.line == line {
				return Some(sym);
			}
			// Otherwise track the nearest preceding symbol (closest above
			// the queried line) — that's the symbol whose body the
			// position falls into, in practice.
			if sym.line <= line {
				let distance = line - sym.line;
				if distance < best_distance {
					best_distance = distance;
					best = Some(sym);
				}
			}
		}
		best
	}
}

impl SemanticBackend for AnnotationSemanticBackend {
	fn capabilities(&self) -> Capabilities {
		Capabilities {
			inferred_hover:  false,
			type_definition: false,
			signature:       false,
			inlay_hints:     false,
			narrow_dispatch: false,
			diagnostics:     false,
		}
	}

	fn type_at(&self, file: &Path, line: u32, _col: u32) -> InferResult {
		let Some(sym) = self.symbol_at(file, line) else {
			return InferResult::unknown();
		};
		let Some(detail) = sym.detail.as_deref() else {
			return InferResult::unknown();
		};
		let trimmed = detail.trim();
		if trimmed.is_empty() {
			return InferResult::unknown();
		}
		InferResult {
			repr:       TypeRepr::text(trimmed),
			confidence: Confidence::Annotated,
			source:     TypeSource::Annotation,
		}
	}

	// `type_definition_of`, `signature_at`, `inlay_hints`,
	// `narrow_dispatch`, `diagnostics` all inherit the default
	// "unknown / empty" impls from the trait. Annotation can't answer.
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{
		CodeGraph, EdgeKind, FileNode, GraphNode, GraphStats, PersistedCodeGraph, SymbolKind,
		SymbolNode,
	};

	fn build_test_graph() -> Arc<CodeGraph> {
		let mut graph: StableGraph<GraphNode, EdgeKind> = StableGraph::new();
		graph.add_node(GraphNode::File(FileNode {
			path:     PathBuf::from("src/foo.rs"),
			language: "rust".into(),
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "annotated_fn".into(),
			qualified_name: "src/foo.rs::annotated_fn".into(),
			file:           PathBuf::from("src/foo.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           10,
			column:         1,
			detail:         Some("fn annotated_fn(x: i32) -> bool".into()),
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "no_detail_fn".into(),
			qualified_name: "src/foo.rs::no_detail_fn".into(),
			file:           PathBuf::from("src/foo.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           20,
			column:         1,
			detail:         None,
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "blank_detail_fn".into(),
			qualified_name: "src/foo.rs::blank_detail_fn".into(),
			file:           PathBuf::from("src/foo.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           30,
			column:         1,
			detail:         Some("   \n  ".into()),
		}));
		Arc::new(CodeGraph::from(PersistedCodeGraph {
			root:            PathBuf::from("."),
			graph,
			stats:           GraphStats::default(),
			generated_at_ms: 0,
			git_head:        None,
		}))
	}

	#[test]
	fn type_at_returns_annotated_when_detail_present() {
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let r = backend.type_at(&PathBuf::from("src/foo.rs"), 10, 0);
		assert_eq!(r.confidence, Confidence::Annotated);
		assert_eq!(r.source, TypeSource::Annotation);
		assert_eq!(r.repr.as_str(), "fn annotated_fn(x: i32) -> bool");
	}

	#[test]
	fn type_at_returns_unknown_when_detail_absent() {
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let r = backend.type_at(&PathBuf::from("src/foo.rs"), 20, 0);
		assert!(r.is_unknown());
		assert_eq!(r.source, TypeSource::Default);
	}

	#[test]
	fn type_at_treats_blank_detail_as_unknown() {
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let r = backend.type_at(&PathBuf::from("src/foo.rs"), 30, 0);
		assert!(r.is_unknown(), "blank/whitespace detail must not surface as a type");
	}

	#[test]
	fn type_at_returns_unknown_for_unknown_file() {
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let r = backend.type_at(&PathBuf::from("src/other.rs"), 10, 0);
		assert!(r.is_unknown());
	}

	#[test]
	fn type_at_picks_closest_preceding_symbol() {
		// Query at line 15 falls between annotated_fn@10 and no_detail_fn@20.
		// `symbol_at` should select annotated_fn (closest <= line).
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let r = backend.type_at(&PathBuf::from("src/foo.rs"), 15, 0);
		assert_eq!(r.repr.as_str(), "fn annotated_fn(x: i32) -> bool");
	}

	#[test]
	fn capabilities_are_all_false_for_annotation() {
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let c = backend.capabilities();
		assert!(!c.inferred_hover);
		assert!(!c.type_definition);
		assert!(!c.signature);
		assert!(!c.inlay_hints);
		assert!(!c.narrow_dispatch);
		assert!(!c.diagnostics);
	}

	#[test]
	fn default_impls_return_empty_or_none() {
		let backend = AnnotationSemanticBackend::new(build_test_graph());
		let file = PathBuf::from("src/foo.rs");
		assert!(backend.type_definition_of(&file, 10, 0).is_none());
		assert!(backend.signature_at(&file, 10, 0).is_none());
		assert!(backend.inlay_hints(&file, None).is_empty());
		assert!(backend.diagnostics(&file).is_empty());

		let call_site = crate::semantic::Location::point(&file, 10, 0);
		let candidates = vec![crate::semantic::Location::point(&file, 20, 0)];
		// narrow_dispatch returns the input unchanged by default.
		assert_eq!(backend.narrow_dispatch(&call_site, &candidates), candidates);
	}
}
