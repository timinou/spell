use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
};

use petgraph::{
	Direction,
	stable_graph::NodeIndex,
	visit::{EdgeRef, NodeIndexable},
};

use crate::{
	model::{CodeGraph, EdgeKind, GraphNode},
	search::SearchHit,
};

/// Reciprocal Rank Fusion constant. k=60 is the standard value from
/// Cormack et al. (2009), widely used in hybrid search systems.
const RRF_K: f32 = 60.0;

/// Number of top hits used as anchors for graph re-ranking.
const RERANK_TOP_K: usize = 5;

/// Boost factor for direct graph neighbors of top hits.
const NEIGHBOR_BOOST: f32 = 0.3;

/// Boost factor for nodes sharing a file with top hits.
const SAME_FILE_BOOST: f32 = 0.1;

/// A search hit from hybrid BM25 + vector search.
#[derive(Debug, Clone)]
pub struct HybridSearchHit {
	pub node_index:  usize,
	pub score:       f32,
	pub label:       String,
	pub path:        PathBuf,
	pub bm25_rank:   Option<usize>,
	pub vector_rank: Option<usize>,
}

/// Merge BM25 and vector search results using Reciprocal Rank Fusion.
///
/// Each ranker contributes `1 / (k + rank)` for documents it returned.
/// Documents appearing in both lists get scores from both.
pub fn reciprocal_rank_fusion(
	bm25_hits: &[SearchHit],
	vector_hits: &[pi_code_vectors::VectorSearchHit],
	graph: &CodeGraph,
	limit: usize,
) -> Vec<HybridSearchHit> {
	let petgraph = graph.graph();

	// Collect per-node metadata + RRF contributions.
	let mut entries: BTreeMap<usize, HybridSearchHit> = BTreeMap::new();

	for (rank, hit) in bm25_hits.iter().enumerate() {
		let entry = entries
			.entry(hit.node_index)
			.or_insert_with(|| HybridSearchHit {
				node_index:  hit.node_index,
				score:       0.0,
				label:       hit.label.clone(),
				path:        hit.path.clone(),
				bm25_rank:   None,
				vector_rank: None,
			});
		entry.bm25_rank = Some(rank);
		entry.score += 1.0 / (RRF_K + rank as f32);
	}

	for (rank, hit) in vector_hits.iter().enumerate() {
		let entry = entries.entry(hit.node_index).or_insert_with(|| {
			// Look up label + path from the graph for vector-only hits.
			let (label, path) = node_label_path(petgraph, hit.node_index);
			HybridSearchHit {
				node_index: hit.node_index,
				score: 0.0,
				label,
				path,
				bm25_rank: None,
				vector_rank: None,
			}
		});
		entry.vector_rank = Some(rank);
		entry.score += 1.0 / (RRF_K + rank as f32);
	}

	let mut hits: Vec<HybridSearchHit> = entries.into_values().collect();
	hits.sort_unstable_by(|a, b| b.score.total_cmp(&a.score));

	// Graph re-ranking: boost neighbors of top results.
	graph_rerank(&mut hits, graph);

	hits.truncate(limit);
	hits
}

/// Boost nodes that are direct graph neighbors of the top-K hits.
fn graph_rerank(hits: &mut [HybridSearchHit], graph: &CodeGraph) {
	if hits.is_empty() {
		return;
	}

	let petgraph = graph.graph();
	let max_score = hits[0].score;
	let top_k = hits.len().min(RERANK_TOP_K);

	// Collect anchor node indices and their file paths.
	let anchors: Vec<(NodeIndex, PathBuf)> = hits[..top_k]
		.iter()
		.filter_map(|h| {
			let idx = petgraph.from_index(h.node_index);
			// Validate the node exists in the graph.
			petgraph.node_weight(idx)?;
			Some((idx, h.path.clone()))
		})
		.collect();

	// Build neighbor set: nodes reachable via Calls, References, Imports edges.
	let mut neighbor_set: BTreeSet<usize> = BTreeSet::new();
	let boost_edges = [
		EdgeKind::Calls,
		EdgeKind::References,
		EdgeKind::Imports,
		EdgeKind::Requires,
		EdgeKind::Refers,
		EdgeKind::Aliases,
		EdgeKind::UsesKeyword,
	];

	for (anchor_idx, _) in &anchors {
		for direction in [Direction::Outgoing, Direction::Incoming] {
			for edge in petgraph.edges_directed(*anchor_idx, direction) {
				if boost_edges.contains(edge.weight()) {
					let neighbor = match direction {
						Direction::Outgoing => edge.target(),
						Direction::Incoming => edge.source(),
					};
					neighbor_set.insert(petgraph.to_index(neighbor));
				}
			}
		}
	}

	// Build same-file set from anchor paths.
	let anchor_paths: BTreeSet<&PathBuf> = anchors.iter().map(|(_, p)| p).collect();

	// Apply boosts to all hits.
	for hit in hits.iter_mut() {
		if neighbor_set.contains(&hit.node_index) {
			hit.score = NEIGHBOR_BOOST.mul_add(max_score, hit.score);
		}
		if anchor_paths.contains(&hit.path) {
			hit.score = SAME_FILE_BOOST.mul_add(max_score, hit.score);
		}
	}

	// Re-sort after boosting.
	hits.sort_unstable_by(|a, b| b.score.total_cmp(&a.score));
}

/// Extract label and file path for a node index from the graph.
fn node_label_path(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind, petgraph::Directed>,
	node_index: usize,
) -> (String, PathBuf) {
	let idx = graph.from_index(node_index);
	match graph.node_weight(idx) {
		Some(GraphNode::Symbol(s)) => (s.qualified_name.clone(), s.file.clone()),
		Some(GraphNode::File(f)) => (f.path.to_string_lossy().to_string(), f.path.clone()),
		None => (String::new(), PathBuf::new()),
	}
}

#[cfg(test)]
mod tests {
	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{FileNode, GraphStats, PersistedCodeGraph, SymbolKind, SymbolNode};

	fn test_graph() -> CodeGraph {
		let mut graph = StableGraph::new();
		// File: src/lib.rs
		graph.add_node(GraphNode::File(FileNode {
			path:     PathBuf::from("src/lib.rs"),
			language: "rust".into(),
		}));
		// Symbol A (node_index=1): "throttle" in src/lib.rs
		let a = graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "throttle".into(),
			qualified_name: "src/lib.rs::throttle".into(),
			file:           PathBuf::from("src/lib.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           10,
			column:         1,
			detail:         None,
		}));
		// Symbol B (node_index=2): "rate_limit" in src/lib.rs
		let b = graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "rate_limit".into(),
			qualified_name: "src/lib.rs::rate_limit".into(),
			file:           PathBuf::from("src/lib.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           20,
			column:         1,
			detail:         None,
		}));
		// Symbol C (node_index=3): "handle_request" in src/server.rs
		graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "handle_request".into(),
			qualified_name: "src/server.rs::handle_request".into(),
			file:           PathBuf::from("src/server.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           5,
			column:         1,
			detail:         None,
		}));
		// Symbol D (node_index=4): "create_limiter" in src/util.rs
		let d = graph.add_node(GraphNode::Symbol(SymbolNode {
			name:           "create_limiter".into(),
			qualified_name: "src/util.rs::create_limiter".into(),
			file:           PathBuf::from("src/util.rs"),
			kind:           SymbolKind::Function,
			exported:       true,
			line:           1,
			column:         1,
			detail:         None,
		}));

		// throttle -> rate_limit (Calls)
		graph.add_edge(a, b, EdgeKind::Calls);
		// rate_limit -> create_limiter (Calls)
		graph.add_edge(b, d, EdgeKind::Calls);

		let persisted = PersistedCodeGraph {
			root: PathBuf::from("."),
			graph,
			stats: GraphStats::default(),
			generated_at_ms: 0,
			git_head: None,
		};
		CodeGraph::new(persisted)
	}

	#[test]
	fn rrf_merges_overlapping_results() {
		let graph = test_graph();

		// BM25 found: A (rank 0), B (rank 1), C (rank 2)
		let bm25 = vec![
			SearchHit {
				node_index: 1,
				score:      5.0,
				label:      "throttle".into(),
				path:       PathBuf::from("src/lib.rs"),
			},
			SearchHit {
				node_index: 2,
				score:      3.0,
				label:      "rate_limit".into(),
				path:       PathBuf::from("src/lib.rs"),
			},
			SearchHit {
				node_index: 3,
				score:      1.0,
				label:      "handle_request".into(),
				path:       PathBuf::from("src/server.rs"),
			},
		];
		// Vector found: B (rank 0), D (rank 1), A (rank 2)
		let vector = vec![
			pi_code_vectors::VectorSearchHit { node_index: 2, score: 0.95 },
			pi_code_vectors::VectorSearchHit { node_index: 4, score: 0.80 },
			pi_code_vectors::VectorSearchHit { node_index: 1, score: 0.70 },
		];

		let hits = reciprocal_rank_fusion(&bm25, &vector, &graph, 10);

		// B appears in both lists (BM25 rank 1, vector rank 0) — highest RRF.
		assert_eq!(hits[0].label, "rate_limit", "B should be top result (overlap)");
		assert!(hits[0].bm25_rank.is_some() && hits[0].vector_rank.is_some());

		// A appears in both lists too.
		assert_eq!(hits[1].label, "throttle", "A should be second (overlap)");

		// All 4 unique nodes should appear.
		let node_indices: Vec<usize> = hits.iter().map(|h| h.node_index).collect();
		assert!(node_indices.contains(&1));
		assert!(node_indices.contains(&2));
		assert!(node_indices.contains(&3));
		assert!(node_indices.contains(&4));
	}

	#[test]
	fn graph_reranking_boosts_neighbors() {
		let graph = test_graph();

		// Simulate: B is the top RRF hit, D has a low score.
		// B -> D via Calls edge, so D should get boosted.
		let bm25 = vec![SearchHit {
			node_index: 2,
			score:      5.0,
			label:      "rate_limit".into(),
			path:       PathBuf::from("src/lib.rs"),
		}];
		let vector = vec![
			pi_code_vectors::VectorSearchHit { node_index: 2, score: 0.95 },
			pi_code_vectors::VectorSearchHit { node_index: 4, score: 0.30 },
			pi_code_vectors::VectorSearchHit { node_index: 3, score: 0.40 },
		];

		let hits = reciprocal_rank_fusion(&bm25, &vector, &graph, 10);

		// D (create_limiter) should be boosted above C (handle_request)
		// because B calls D (graph neighbor).
		let d_pos = hits.iter().position(|h| h.node_index == 4).unwrap();
		let c_pos = hits.iter().position(|h| h.node_index == 3).unwrap();
		assert!(d_pos < c_pos, "D (graph neighbor of B) should rank higher than C after re-ranking");
	}

	#[test]
	fn fallback_bm25_only_when_no_vectors() {
		let graph = test_graph();

		let bm25 = vec![
			SearchHit {
				node_index: 1,
				score:      5.0,
				label:      "throttle".into(),
				path:       PathBuf::from("src/lib.rs"),
			},
			SearchHit {
				node_index: 2,
				score:      3.0,
				label:      "rate_limit".into(),
				path:       PathBuf::from("src/lib.rs"),
			},
		];
		let vector: Vec<pi_code_vectors::VectorSearchHit> = vec![];

		let hits = reciprocal_rank_fusion(&bm25, &vector, &graph, 10);
		assert_eq!(hits.len(), 2);
		// Order preserves BM25 ranking.
		assert_eq!(hits[0].label, "throttle");
		assert_eq!(hits[1].label, "rate_limit");
	}
	#[test]
	fn graph_search_surfaces_vector_only_matches() {
		let graph = test_graph();
		let bm25_graph = CodeGraph::new(graph.persisted().clone());
		let vector_index = pi_code_vectors::VectorIndex::new(
			vec![
				pi_code_vectors::VectorEntry { node_index: 1, vector: vec![0.95, 0.05, 0.0] },
				pi_code_vectors::VectorEntry { node_index: 2, vector: vec![0.80, 0.20, 0.0] },
				pi_code_vectors::VectorEntry { node_index: 4, vector: vec![0.70, 0.30, 0.0] },
				pi_code_vectors::VectorEntry { node_index: 3, vector: vec![0.05, 0.05, 0.90] },
			],
			3,
		);
		let graph_with_vectors = CodeGraph::with_vectors(graph.into_persisted(), vector_index);
		let query_vector = vec![1.0, 0.0, 0.0];

		let hybrid_results = graph_with_vectors.graph_search("limiter", Some(&query_vector), 10);
		let bm25_results = bm25_graph.graph_search("limiter", None, 10);

		assert!(!hybrid_results.is_empty(), "hybrid search should return results");
		assert!(
			hybrid_results
				.iter()
				.any(|hit| hit.summary.label.ends_with("src/lib.rs::throttle")),
			"hybrid search should surface throttle via vector similarity"
		);
		assert!(
			!bm25_results
				.iter()
				.any(|hit| hit.summary.label.ends_with("src/lib.rs::throttle")),
			"bm25-only search should not surface throttle for limiter queries"
		);
	}
}
