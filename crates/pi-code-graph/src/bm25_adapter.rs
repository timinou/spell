//! Graph-aware adapter over `pi_knowledge_core::bm25`.
//!
//! `pi-code-graph` historically owned its own `SearchIndex` (PLAN-310). It was
//! a near-byte-identical copy of `pi-knowledge-core::bm25::SearchIndex` plus
//! one differentiator: each indexed document carried back the `petgraph`
//! `node_index` and the file `PathBuf` for direct lookup by callers. PLAN-319
//! W0 deletes the duplicate and replaces it with a thin adapter:
//!
//! - Documents indexed by `pi-knowledge-core::bm25` use `doc_id =
//!   node_index.to_string()`. Caller bridges back to the petgraph node and
//!   its owning file via [`bm25_search_adapted`].
//! - `pi-knowledge-core::bm25::SearchIndex` is stored directly on
//!   [`crate::model::CodeGraph`]; the graph-specific [`SearchHit`] is the
//!   public output type and preserves the existing API surface of
//!   `pi-code-graph`.
//!
//! ## Why `node_index.to_string()` as the doc_id
//!
//! `petgraph::StableGraph::from_index` is a stable, cheap `usize → NodeIndex`
//! conversion; round-tripping through a decimal string costs a tiny
//! tokenisation hop on each hit but avoids any second-class indexing layer.
//! The BM25 corpus is a closed set per `CodeGraph`, so collisions are
//! impossible and stale doc_ids cannot survive a rebuild.

use std::path::PathBuf;

use petgraph::visit::NodeIndexable;
use pi_knowledge_core::bm25::{self, Document, SearchIndex as Bm25Index};
use serde::{Deserialize, Serialize};

use crate::model::{GraphNode, PersistedCodeGraph};

/// Graph-aware BM25 hit: carries the petgraph `node_index` and the owning
/// file path so callers can navigate without re-tokenising the label.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchHit {
	pub node_index: usize,
	pub score:      f32,
	pub label:      String,
	pub path:       PathBuf,
}

/// Internal projection: one [`pi_knowledge_core::bm25::Document`] per
/// indexable graph node. `doc_id` is the stringified `petgraph` index;
/// `label` mirrors the historical behaviour (file path for File nodes,
/// qualified symbol name for Symbol nodes).
struct GraphNodeDoc {
	node_index: usize,
	label:      String,
}

impl Document for GraphNodeDoc {
	fn id(&self) -> String {
		self.node_index.to_string()
	}
	fn label(&self) -> &str {
		&self.label
	}
}

/// Build a fresh BM25 index over the indexable nodes of `persisted`.
///
/// Iteration order matches `PersistedCodeGraph::graph().node_indices()`. File
/// nodes contribute their path string; Symbol nodes contribute their
/// qualified name.
pub(crate) fn build_search_index(persisted: &PersistedCodeGraph) -> Bm25Index {
	let docs: Vec<GraphNodeDoc> = persisted
		.graph
		.node_indices()
		.filter_map(|node_index| {
			let node = persisted.graph.node_weight(node_index)?;
			let label = match node {
				GraphNode::File(file) => file.path.to_string_lossy().to_string(),
				GraphNode::Symbol(symbol) => symbol.qualified_name.clone(),
			};
			Some(GraphNodeDoc {
				node_index: persisted.graph.to_index(node_index),
				label,
			})
		})
		.collect();
	Bm25Index::from_docs(&docs)
}

/// Run a BM25 query over `index` and map each raw [`bm25::SearchHit`] back
/// to a graph-aware [`SearchHit`] by resolving its `doc_id` to the owning
/// `petgraph` node + file path.
///
/// Hits whose `doc_id` no longer resolves to a live node in `persisted` are
/// dropped (defensive — would indicate index/graph divergence).
pub(crate) fn bm25_search_adapted(
	persisted: &PersistedCodeGraph,
	index: &Bm25Index,
	query: &str,
	limit: usize,
) -> Vec<SearchHit> {
	index
		.search(query, limit)
		.into_iter()
		.filter_map(|hit| resolve_hit(persisted, hit))
		.collect()
}

fn resolve_hit(persisted: &PersistedCodeGraph, hit: bm25::SearchHit) -> Option<SearchHit> {
	let node_index_usize: usize = hit.doc_id.parse().ok()?;
	let ni = persisted.graph.from_index(node_index_usize);
	let node = persisted.graph.node_weight(ni)?;
	let path = match node {
		GraphNode::File(file) => file.path.clone(),
		GraphNode::Symbol(symbol) => symbol.file.clone(),
	};
	Some(SearchHit {
		node_index: node_index_usize,
		score:      hit.score,
		label:      hit.label,
		path,
	})
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{EdgeKind, FileNode, GraphStats, SymbolKind, SymbolNode};

	/// PORTED from the deleted `pi-code-graph::search::tests::bm25_prefers_exact_symbol_match`.
	///
	/// Asserts that the adapter still returns graph-aware [`SearchHit`]s with
	/// stable `node_index` + `path` after the migration to
	/// `pi-knowledge-core::bm25` as the underlying engine.
	#[test]
	fn bm25_prefers_exact_symbol_match() {
		let mut graph: StableGraph<GraphNode, EdgeKind> = StableGraph::new();
		graph.add_node(GraphNode::File(FileNode {
			path:     PathBuf::from("src/tools/code.ts"),
			language: "typescript".into(),
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "CodeTool".into(),
			qualified_name: "tools/code.ts::CodeTool".into(),
			file:           PathBuf::from("src/tools/code.ts"),
			kind:           SymbolKind::Class,
			exported:       true,
			line:           1,
			column:         1,
			detail:         None,
		}));
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "CodeGraph".into(),
			qualified_name: "src/code-graph.rs::CodeGraph".into(),
			file:           PathBuf::from("src/code-graph.rs"),
			kind:           SymbolKind::Class,
			exported:       true,
			line:           1,
			column:         1,
			detail:         None,
		}));
		let persisted = PersistedCodeGraph {
			root: PathBuf::from("."),
			graph,
			stats: GraphStats::default(),
			generated_at_ms: 0,
			git_head: None,
		};
		let index = build_search_index(&persisted);
		let hits = bm25_search_adapted(&persisted, &index, "CodeTool", 5);
		assert_eq!(
			hits.first().map(|hit| hit.label.as_str()),
			Some("tools/code.ts::CodeTool"),
			"exact symbol match must rank first"
		);
		// Adapter must populate node_index AND path on every hit.
		let top = hits.first().expect("at least one hit");
		assert_eq!(top.path, PathBuf::from("src/tools/code.ts"));
		assert!(top.node_index <= 2, "node_index must point at the live graph slot");
	}

	#[test]
	fn unresolvable_hits_filtered() {
		// Build an empty graph and synthesise an out-of-range doc_id.
		// `bm25_search_adapted` over a real index can't produce these,
		// but `resolve_hit` is the defence-in-depth boundary.
		let persisted = PersistedCodeGraph {
			root:            PathBuf::from("."),
			graph:           StableGraph::<GraphNode, EdgeKind>::new(),
			stats:           GraphStats::default(),
			generated_at_ms: 0,
			git_head:        None,
		};
		let stray = bm25::SearchHit {
			doc_id: "9999".into(),
			score:  1.0,
			label:  "ghost".into(),
		};
		assert!(resolve_hit(&persisted, stray).is_none());
	}
}
