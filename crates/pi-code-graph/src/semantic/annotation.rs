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

	/// Walk the graph for a Symbol node whose file matches `(line, col)`.
	///
	/// Resolution priority:
	/// 1. Exact line match — if multiple symbols share `line`, the one with
	///    `column` nearest to `col` wins (col tiebreak).
	/// 2. Otherwise the nearest preceding symbol (closest `sym.line <= line`),
	///    representing the symbol whose body the position falls into.
	///
	/// Path matching: direct PathBuf equality first; on mismatch falls back
	/// to canonicalised comparison so absolute-vs-relative-vs-symlink variants
	/// converge.
	///
	/// `O(N)` over the graph node set; can be indexed later.
	fn symbol_at(&self, file: &Path, line: u32, col: u32) -> Option<&SymbolNode> {
		let canonical_query = canonicalise_path(file);
		let mut exact_line: Option<&SymbolNode> = None;
		let mut exact_line_col_distance: u32 = u32::MAX;
		let mut best_preceding: Option<&SymbolNode> = None;
		let mut best_line_distance: u32 = u32::MAX;
		for node in self.graph.graph().node_weights() {
			let GraphNode::Symbol(sym) = node else { continue };
			if !file_matches(&sym.file, file, canonical_query.as_deref()) {
				continue;
			}
			if sym.line == line {
				let col_distance = sym.column.abs_diff(col);
				if col_distance < exact_line_col_distance {
					exact_line_col_distance = col_distance;
					exact_line = Some(sym);
				}
				continue;
			}
			if sym.line <= line {
				let line_distance = line - sym.line;
				if line_distance < best_line_distance {
					best_line_distance = line_distance;
					best_preceding = Some(sym);
				}
			}
		}
		exact_line.or(best_preceding)
	}
}

/// Returns true when `sym_file` refers to the same file as `query_file`.
///
/// Cheap path: direct PathBuf equality. Slow path (only on mismatch):
/// canonicalise both sides and compare — catches absolute-vs-relative,
/// symlink, and trailing-slash variants. Failing canonicalisation falls
/// through to the original mismatch (treats the file as not-our-target,
/// which is the safe default).
fn file_matches(sym_file: &Path, query_file: &Path, canonical_query: Option<&Path>) -> bool {
	if sym_file == query_file {
		return true;
	}
	let Some(canonical_query) = canonical_query else {
		return false;
	};
	canonicalise_path(sym_file).as_deref() == Some(canonical_query)
}

fn canonicalise_path(path: &Path) -> Option<std::path::PathBuf> {
	std::fs::canonicalize(path).ok()
}

impl SemanticBackend for AnnotationSemanticBackend {
	fn capabilities(&self) -> Capabilities {
		Capabilities::default()
	}

	fn type_at(&self, file: &Path, line: u32, col: u32) -> InferResult {
		let Some(sym) = self.symbol_at(file, line, col) else {
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
		assert_eq!(backend.capabilities(), Capabilities::default());
	}

	/// W0g (P1): column tiebreak when multiple symbols share a line.
	/// Builds a graph with two symbols on line 5 at columns 4 and 20.
	/// Queries at col 5 (near col 4) must resolve to the first; queries at
	/// col 19 (near col 20) must resolve to the second.
	#[test]
	fn symbol_at_uses_col_as_tiebreak_for_same_line_symbols() {
		let mut graph: StableGraph<GraphNode, EdgeKind> = StableGraph::new();
		graph.add_node(GraphNode::File(FileNode {
			path:     PathBuf::from("src/multi.rs"),
			language: "rust".into(),
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "a".into(),
			qualified_name: "src/multi.rs::a".into(),
			file:           PathBuf::from("src/multi.rs"),
			kind:           SymbolKind::Variable,
			exported:       false,
			line:           5,
			column:         4,
			detail:         Some("a: i32".into()),
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "b".into(),
			qualified_name: "src/multi.rs::b".into(),
			file:           PathBuf::from("src/multi.rs"),
			kind:           SymbolKind::Variable,
			exported:       false,
			line:           5,
			column:         20,
			detail:         Some("b: &str".into()),
		}));
		let backend = AnnotationSemanticBackend::new(Arc::new(CodeGraph::from(
			PersistedCodeGraph {
				root:            PathBuf::from("."),
				graph,
				stats:           GraphStats::default(),
				generated_at_ms: 0,
				git_head:        None,
			},
		)));

		let near_a = backend.type_at(&PathBuf::from("src/multi.rs"), 5, 5);
		assert_eq!(near_a.repr.as_str(), "a: i32");

		let near_b = backend.type_at(&PathBuf::from("src/multi.rs"), 5, 19);
		assert_eq!(near_b.repr.as_str(), "b: &str");
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
