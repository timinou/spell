use std::{collections::BTreeMap, path::PathBuf};

use petgraph::{Directed, stable_graph::StableGraph, visit::IntoEdgeReferences};
use pi_knowledge_core::bm25::SearchIndex;
use serde::{Deserialize, Serialize};

use crate::bm25_adapter;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileNode {
	pub path:     PathBuf,
	pub language: String,
}

impl FileNode {
	pub fn target_id(&self) -> String {
		self.path.to_string_lossy().to_string()
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SymbolKind {
	Function,
	Class,
	Method,
	Variable,
	Interface,
	TypeAlias,
	Enum,
	Module,
	Macro,
	Namespace,
	Var,
	Protocol,
	Record,
	Multimethod,
	Test,
	Spec,
	Keyword,
	Template,
	Element,
	CssRule,
	CssProperty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolNode {
	pub name:           String,
	pub qualified_name: String,
	pub file:           PathBuf,
	pub kind:           SymbolKind,
	pub exported:       bool,
	pub line:           u32,
	pub column:         u32,
	pub detail:         Option<String>,
}

impl SymbolNode {
	pub fn target_id(&self) -> &str {
		&self.qualified_name
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GraphNode {
	File(FileNode),
	Symbol(SymbolNode),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
	Defines,
	Imports,
	Calls,
	References,
	Inherits,
	Renders,
	Styles,
	Requires,
	Refers,
	Aliases,
	Implements,
	Dispatches,
	Tests,
	UsesKeyword,
	TypeImports,
	TypeParameterOf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GraphStats {
	pub file_count:      u32,
	pub symbol_count:    u32,
	pub edge_count:      u32,
	pub language_counts: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedCodeGraph {
	pub root:            PathBuf,
	pub graph:           StableGraph<GraphNode, EdgeKind, Directed>,
	pub stats:           GraphStats,
	pub generated_at_ms: u64,
	pub git_head:        Option<String>,
}

#[derive(Debug)]
pub struct CodeGraph {
	persisted:    PersistedCodeGraph,
	// FEAT-811: the BM25 search index is expensive to build over a large
	// workspace (~20s for 70k nodes) and is only needed by the search lane,
	// not by edge resolution (`def→`/`ref→`/`call→`). Build it lazily on first
	// search so a cold edge query pays deserialize cost only.
	search_index: std::sync::OnceLock<SearchIndex>,
	vector_index: Option<std::sync::Arc<pi_knowledge_core::vec::VectorIndex>>,
}

impl Clone for CodeGraph {
	fn clone(&self) -> Self {
		// Carry over an already-built search index; otherwise leave it unbuilt
		// so the clone also pays the build cost only on demand.
		let search_index = std::sync::OnceLock::new();
		if let Some(idx) = self.search_index.get() {
			let _ = search_index.set(idx.clone());
		}
		Self {
			persisted: self.persisted.clone(),
			search_index,
			vector_index: self.vector_index.clone(),
		}
	}
}

impl CodeGraph {
	pub fn new(persisted: PersistedCodeGraph) -> Self {
		// FEAT-811: do not build the BM25 index here; it is built lazily on the
		// first `bm25_search`/`search_index` call so edge-only loads stay fast.
		Self { persisted, search_index: std::sync::OnceLock::new(), vector_index: None }
	}

	/// Lazily build (once) and return the BM25 search index.
	fn search_index_lazy(&self) -> &SearchIndex {
		self
			.search_index
			.get_or_init(|| bm25_adapter::build_search_index(&self.persisted))
	}

	/// Run a BM25 query and map results back to graph-aware `SearchHit`s.
	/// Replaces the deleted `pi-code-graph::search::SearchIndex::search` —
	/// the underlying engine is now `pi-knowledge-core::bm25`.
	pub fn bm25_search(&self, query: &str, limit: usize) -> Vec<bm25_adapter::SearchHit> {
		bm25_adapter::bm25_search_adapted(&self.persisted, self.search_index_lazy(), query, limit)
	}

	pub const fn persisted(&self) -> &PersistedCodeGraph {
		&self.persisted
	}

	pub fn into_persisted(self) -> PersistedCodeGraph {
		self.persisted
	}

	/// Access the BM25 search index, building it lazily on first use
	/// (FEAT-811). No longer `const` because construction may be deferred.
	pub fn search_index(&self) -> &SearchIndex {
		self.search_index_lazy()
	}

	pub const fn stats(&self) -> &GraphStats {
		&self.persisted.stats
	}

	pub const fn root(&self) -> &PathBuf {
		&self.persisted.root
	}

	pub const fn graph(&self) -> &StableGraph<GraphNode, EdgeKind, Directed> {
		&self.persisted.graph
	}

	pub fn symbol_names(&self) -> Vec<String> {
		self
			.persisted
			.graph
			.node_weights()
			.filter_map(|node| match node {
				GraphNode::Symbol(symbol) => Some(symbol.qualified_name.clone()),
				GraphNode::File(_) => None,
			})
			.collect()
	}

	pub fn count_edges(&self, kind: EdgeKind) -> usize {
		self
			.persisted
			.graph
			.edge_references()
			.filter(|edge| *edge.weight() == kind)
			.count()
	}

	/// Construct with a pre-built vector index for hybrid search.
	pub fn with_vectors(
		persisted: PersistedCodeGraph,
		vectors: pi_knowledge_core::vec::VectorIndex,
	) -> Self {
		// FEAT-811: the BM25 index is built lazily on first search; pre-seed the
		// cell only if a caller needs eager warmth (none currently).
		Self {
			persisted,
			search_index: std::sync::OnceLock::new(),
			vector_index: Some(std::sync::Arc::new(vectors)),
		}
	}

	/// Access the vector index if available.
	pub fn vector_index(&self) -> Option<&pi_knowledge_core::vec::VectorIndex> {
		self.vector_index.as_deref()
	}
}

impl From<PersistedCodeGraph> for CodeGraph {
	fn from(value: PersistedCodeGraph) -> Self {
		Self::new(value)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	// FEAT-811: the BM25 search index must NOT be built by `new`; it is built
	// lazily on first `search_index()`/`bm25_search()`. A cold edge-only load
	// must not pay the index-build cost.
	#[test]
	fn search_index_is_built_lazily() {
		let persisted = PersistedCodeGraph {
			root:            std::path::PathBuf::from("/tmp/project"),
			graph:           StableGraph::<GraphNode, EdgeKind>::new(),
			stats:           GraphStats::default(),
			generated_at_ms: 0,
			git_head:        None,
		};
		let graph = CodeGraph::new(persisted);
		assert!(graph.search_index.get().is_none(), "new() must not build the search index");
		// First access triggers the build and memoises it.
		let _ = graph.search_index();
		assert!(graph.search_index.get().is_some(), "search_index() must build and cache the index");
	}

	#[test]
	fn clojure_symbol_and_edge_kinds_serialize_stably() {
		let symbol_kinds = [
			SymbolKind::Namespace,
			SymbolKind::Var,
			SymbolKind::Protocol,
			SymbolKind::Record,
			SymbolKind::Multimethod,
			SymbolKind::Test,
			SymbolKind::Spec,
			SymbolKind::Keyword,
		];
		let encoded = serde_json::to_value(symbol_kinds).expect("symbol kinds serialize");
		assert_eq!(
			encoded,
			serde_json::json!([
				"Namespace",
				"Var",
				"Protocol",
				"Record",
				"Multimethod",
				"Test",
				"Spec",
				"Keyword"
			])
		);

		let edge_kinds = [
			EdgeKind::Requires,
			EdgeKind::Refers,
			EdgeKind::Aliases,
			EdgeKind::Implements,
			EdgeKind::Dispatches,
			EdgeKind::Tests,
			EdgeKind::UsesKeyword,
		];
		let encoded = serde_json::to_value(edge_kinds).expect("edge kinds serialize");
		assert_eq!(
			encoded,
			serde_json::json!([
				"Requires",
				"Refers",
				"Aliases",
				"Implements",
				"Dispatches",
				"Tests",
				"UsesKeyword"
			])
		);
	}
}
