use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
};

use petgraph::visit::NodeIndexable;
use serde::{Deserialize, Serialize};

use crate::model::{GraphNode, PersistedCodeGraph};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchHit {
	pub node_index: usize,
	pub score:      f32,
	pub label:      String,
	pub path:       PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct SearchIndex {
	docs:          Vec<SearchDocument>,
	avg_doc_len:   f32,
	term_doc_freq: BTreeMap<String, usize>,
}

#[derive(Debug, Clone)]
struct SearchDocument {
	node_index:  usize,
	label:       String,
	path:        PathBuf,
	tokens:      Vec<String>,
	frequencies: BTreeMap<String, usize>,
}

impl SearchIndex {
	pub fn build(graph: &PersistedCodeGraph) -> Self {
		let docs = graph
			.graph
			.node_indices()
			.filter_map(|node_index| {
				let node = graph.graph.node_weight(node_index)?;
				let (label, path) = match node {
					GraphNode::File(file) => {
						(file.path.to_string_lossy().to_string(), file.path.clone())
					},
					GraphNode::Symbol(symbol) => (symbol.qualified_name.clone(), symbol.file.clone()),
				};
				let tokens = tokenize(&label);
				if tokens.is_empty() {
					return None;
				}
				let mut frequencies = BTreeMap::new();
				for token in &tokens {
					*frequencies.entry(token.clone()).or_default() += 1;
				}
				Some(SearchDocument {
					node_index: graph.graph.to_index(node_index),
					label,
					path,
					tokens,
					frequencies,
				})
			})
			.collect::<Vec<_>>();
		let avg_doc_len = if docs.is_empty() {
			0.0
		} else {
			docs.iter().map(|doc| doc.tokens.len() as f32).sum::<f32>() / docs.len() as f32
		};
		let mut term_doc_freq = BTreeMap::new();
		for doc in &docs {
			let mut seen = BTreeSet::new();
			for token in &doc.tokens {
				if seen.insert(token.clone()) {
					*term_doc_freq.entry(token.clone()).or_default() += 1;
				}
			}
		}
		Self { docs, avg_doc_len, term_doc_freq }
	}

	pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let query_tokens = tokenize(query);
		if query_tokens.is_empty() {
			return Vec::new();
		}
		let doc_count = self.docs.len() as f32;
		let k1 = 1.5_f32;
		let b = 0.75_f32;
		let mut hits = self
			.docs
			.iter()
			.map(|doc| {
				let doc_len = doc.tokens.len() as f32;
				let mut score = 0.0_f32;
				for token in &query_tokens {
					let tf = *doc.frequencies.get(token).unwrap_or(&0) as f32;
					if tf == 0.0 {
						continue;
					}
					let df = *self.term_doc_freq.get(token).unwrap_or(&0) as f32;
					let idf = ((doc_count - df + 0.5) / (df + 0.5)).ln_1p();
					let norm = k1.mul_add(1.0 - b + b * doc_len / self.avg_doc_len.max(1.0), tf);
					score += idf * ((tf * (k1 + 1.0)) / norm);
				}
				SearchHit {
					node_index: doc.node_index,
					score,
					label: doc.label.clone(),
					path: doc.path.clone(),
				}
			})
			.filter(|hit| hit.score > 0.0)
			.collect::<Vec<_>>();
		hits.sort_by(|left, right| {
			right
				.score
				.total_cmp(&left.score)
				.then_with(|| left.label.cmp(&right.label))
		});
		hits.truncate(limit);
		hits
	}
}

fn tokenize(text: &str) -> Vec<String> {
	text
		.split(|char: char| !char.is_ascii_alphanumeric() && char != '_' && char != '-')
		.filter(|part| !part.is_empty())
		.map(|part| part.to_ascii_lowercase())
		.collect()
}

#[cfg(test)]
mod tests {
	use petgraph::stable_graph::StableGraph;

	use super::*;
	use crate::model::{FileNode, GraphStats, PersistedCodeGraph, SymbolKind, SymbolNode};

	#[test]
	fn bm25_prefers_exact_symbol_match() {
		let mut graph = StableGraph::new();
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
		let index = SearchIndex::build(&persisted);
		let hits = index.search("CodeTool", 5);
		assert_eq!(hits.first().map(|hit| hit.label.as_str()), Some("tools/code.ts::CodeTool"));
	}
}
