use std::{
	collections::{BTreeMap, BTreeSet, VecDeque},
	path::{Path, PathBuf},
};

use petgraph::{
	Direction,
	stable_graph::NodeIndex,
	visit::{EdgeRef, NodeIndexable},
};
use serde::{Deserialize, Serialize};

use crate::model::{CodeGraph, EdgeKind, GraphNode, SymbolKind};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphNodeSummary {
	pub label:    String,
	pub path:     PathBuf,
	pub kind:     String,
	pub exported: bool,
	pub line:     u32,
	pub column:   u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphTraversalLevel {
	pub depth: u32,
	pub nodes: Vec<GraphNodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphContextResult {
	pub target:        GraphNodeSummary,
	pub callers:       Vec<GraphNodeSummary>,
	pub callees:       Vec<GraphNodeSummary>,
	pub references:    Vec<GraphNodeSummary>,
	pub referenced_by: Vec<GraphNodeSummary>,
	pub imports:       Vec<GraphNodeSummary>,
	pub imported_by:   Vec<GraphNodeSummary>,
	pub inherits:      Vec<GraphNodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphImpactResult {
	pub target: GraphNodeSummary,
	pub levels: Vec<GraphTraversalLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphDepsResult {
	pub target:   GraphNodeSummary,
	pub outgoing: Vec<GraphNodeSummary>,
	pub incoming: Vec<GraphNodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphFlowResult {
	pub target: GraphNodeSummary,
	pub levels: Vec<GraphTraversalLevel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphDeadCodeItem {
	pub symbol:     GraphNodeSummary,
	pub reason:     String,
	pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphCluster {
	pub id:           usize,
	pub name:         String,
	pub files:        Vec<GraphNodeSummary>,
	pub symbol_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphStatus {
	pub root:            PathBuf,
	pub file_count:      u32,
	pub symbol_count:    u32,
	pub edge_count:      u32,
	pub git_head:        Option<String>,
	pub generated_at_ms: u64,
	pub languages:       BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphSearchMatch {
	pub score:   f32,
	pub summary: GraphNodeSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphSymbolsResult {
	pub query:   String,
	pub status:  String,
	pub matches: Vec<GraphNodeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphFilesResult {
	pub query:   String,
	pub status:  String,
	pub matches: Vec<GraphNodeSummary>,
}

impl CodeGraph {
	pub fn graph_status(&self) -> GraphStatus {
		GraphStatus {
			root:            self.root().clone(),
			file_count:      self.stats().file_count,
			symbol_count:    self.stats().symbol_count,
			edge_count:      self.stats().edge_count,
			git_head:        self.persisted().git_head.clone(),
			generated_at_ms: self.persisted().generated_at_ms,
			languages:       self.stats().language_counts.clone(),
		}
	}

	pub fn graph_search(
		&self,
		query: &str,
		query_vector: Option<&[f32]>,
		limit: usize,
	) -> Vec<GraphSearchMatch> {
		// When semantic feature is enabled and vectors are available, use hybrid
		// search.
		#[cfg(feature = "semantic")]
		if let (Some(vector_index), Some(qv)) = (self.vector_index(), query_vector) {
			let bm25_hits = self.search_index().search(query, limit * 2);
			let vector_hits = vector_index.search(qv, limit * 2).unwrap_or_default();
			let hybrid = crate::hybrid::reciprocal_rank_fusion(&bm25_hits, &vector_hits, self, limit);
			let graph = self.graph();
			return hybrid
				.into_iter()
				.filter_map(|hit| {
					let node_index = graph.from_index(hit.node_index);
					summary_for_node(graph, node_index)
						.map(|summary| GraphSearchMatch { score: hit.score, summary })
				})
				.collect();
		}
		// Suppress unused variable warning when semantic feature is disabled.
		let _ = query_vector;
		// Fallback: BM25 only.
		let graph = self.graph();
		self
			.search_index()
			.search(query, limit)
			.into_iter()
			.filter_map(|hit| {
				let node_index = graph.from_index(hit.node_index);
				summary_for_node(graph, node_index)
					.map(|summary| GraphSearchMatch { score: hit.score, summary })
			})
			.collect()
	}

	pub fn graph_symbols(&self, query: &str, limit: usize) -> GraphSymbolsResult {
		let graph = self.graph();
		let exact = exact_symbol_matches(graph, query);
		if exact.len() == 1 {
			return GraphSymbolsResult {
				query:   query.to_string(),
				status:  "exact".into(),
				matches: exact
					.into_iter()
					.filter_map(|node_index| summary_for_node(graph, node_index))
					.collect(),
			};
		}
		if exact.len() > 1 {
			return GraphSymbolsResult {
				query:   query.to_string(),
				status:  "ambiguous".into(),
				matches: dedupe_summaries(
					exact
						.into_iter()
						.filter_map(|node_index| summary_for_node(graph, node_index))
						.collect(),
					limit,
				),
			};
		}
		let matches = dedupe_summaries(
			self
				.graph_search(query, None, limit.saturating_mul(2).max(limit))
				.into_iter()
				.filter(|hit| hit.summary.kind != "file")
				.map(|hit| hit.summary)
				.collect(),
			limit,
		);
		GraphSymbolsResult {
			query: query.to_string(),
			status: if matches.is_empty() {
				"none".into()
			} else {
				"ranked".into()
			},
			matches,
		}
	}

	pub fn graph_files(&self, query: &str, limit: usize) -> GraphFilesResult {
		let graph = self.graph();
		let exact = exact_file_matches(graph, query);
		if exact.len() == 1 {
			return GraphFilesResult {
				query:   query.to_string(),
				status:  "exact".into(),
				matches: exact
					.into_iter()
					.filter_map(|node_index| summary_for_node(graph, node_index))
					.collect(),
			};
		}
		if exact.len() > 1 {
			return GraphFilesResult {
				query:   query.to_string(),
				status:  "ambiguous".into(),
				matches: dedupe_summaries(
					exact
						.into_iter()
						.filter_map(|node_index| summary_for_node(graph, node_index))
						.collect(),
					limit,
				),
			};
		}
		let matches = dedupe_summaries(
			self
				.graph_search(query, None, limit.saturating_mul(2).max(limit))
				.into_iter()
				.filter(|hit| hit.summary.kind == "file")
				.map(|hit| hit.summary)
				.collect(),
			limit,
		);
		GraphFilesResult {
			query: query.to_string(),
			status: if matches.is_empty() {
				"none".into()
			} else {
				"ranked".into()
			},
			matches,
		}
	}

	pub fn graph_context(&self, query: &str) -> Option<GraphContextResult> {
		let graph = self.graph();
		let node_index = resolve_symbol(graph, self, query)?;
		Some(GraphContextResult {
			target:        summary_for_node(graph, node_index)?,
			callers:       neighbors_by_kind(graph, node_index, Direction::Incoming, &[
				EdgeKind::Calls,
			]),
			callees:       neighbors_by_kind(graph, node_index, Direction::Outgoing, &[
				EdgeKind::Calls,
			]),
			references:    neighbors_by_kind(graph, node_index, Direction::Outgoing, &[
				EdgeKind::References,
				EdgeKind::Styles,
			]),
			referenced_by: neighbors_by_kind(graph, node_index, Direction::Incoming, &[
				EdgeKind::References,
				EdgeKind::Styles,
			]),
			imports:       file_neighbors_for_symbol(graph, node_index, Direction::Outgoing),
			imported_by:   file_neighbors_for_symbol(graph, node_index, Direction::Incoming),
			inherits:      neighbors_by_kind(graph, node_index, Direction::Outgoing, &[
				EdgeKind::Inherits,
			]),
		})
	}

	pub fn graph_impact(&self, query: &str, max_depth: usize) -> Option<GraphImpactResult> {
		let graph = self.graph();
		let start = resolve_symbol_or_file(graph, self, query)?;
		let levels = bfs_levels(
			graph,
			start,
			Direction::Incoming,
			[
				EdgeKind::Calls,
				EdgeKind::References,
				EdgeKind::Styles,
				EdgeKind::Inherits,
				EdgeKind::Imports,
				EdgeKind::TypeImports,
				EdgeKind::TypeParameterOf,
			]
			.as_slice(),
			max_depth,
		);
		Some(GraphImpactResult { target: summary_for_node(graph, start)?, levels })
	}

	pub fn graph_deps(&self, query: &str) -> Option<GraphDepsResult> {
		let graph = self.graph();
		let file = resolve_file(graph, query)?;
		Some(GraphDepsResult {
			target:   summary_for_node(graph, file)?,
			outgoing: neighbors_by_kind(graph, file, Direction::Outgoing, &[EdgeKind::Imports]),
			incoming: neighbors_by_kind(graph, file, Direction::Incoming, &[EdgeKind::Imports]),
		})
	}

	pub fn graph_flow(&self, query: &str, max_depth: usize) -> Option<GraphFlowResult> {
		let graph = self.graph();
		let start = resolve_symbol(graph, self, query)?;
		let levels = bfs_levels(graph, start, Direction::Outgoing, &[EdgeKind::Calls], max_depth);
		Some(GraphFlowResult { target: summary_for_node(graph, start)?, levels })
	}

	pub fn graph_dead_code(&self) -> Vec<GraphDeadCodeItem> {
		self.graph_dead_code_with_limit(50)
	}

	pub fn graph_dead_code_with_limit(&self, limit: usize) -> Vec<GraphDeadCodeItem> {
		let graph = self.graph();
		let mut items = graph
			.node_indices()
			.filter_map(|node_index| {
				let GraphNode::Symbol(symbol) = graph.node_weight(node_index)? else {
					return None;
				};
				if symbol.exported
					|| matches!(
						symbol.kind,
						SymbolKind::Module
							| SymbolKind::Template
							| SymbolKind::Element
							| SymbolKind::CssProperty
					) || (symbol.kind == SymbolKind::Method && symbol.name == "constructor")
					|| is_entry_point_symbol(symbol)
					|| is_test_path(symbol.file.as_path())
				{
					return None;
				}
				let has_inbound_usage =
					graph
						.edges_directed(node_index, Direction::Incoming)
						.any(|edge| {
							matches!(
								edge.weight(),
								EdgeKind::Calls
									| EdgeKind::References
									| EdgeKind::Inherits
									| EdgeKind::Renders
							)
						});
				let has_style_consumers = symbol.kind == SymbolKind::CssRule
					&& graph
						.edges_directed(node_index, Direction::Outgoing)
						.any(|edge| *edge.weight() == EdgeKind::Styles);
				if has_inbound_usage || has_style_consumers {
					return None;
				}
				let confidence = if symbol
					.file
					.file_name()
					.and_then(|name| name.to_str())
					.is_some_and(|name| matches!(name, "index.ts" | "index.js" | "mod.rs" | "lib.rs"))
				{
					"low"
				} else if symbol.kind == SymbolKind::Function || symbol.kind == SymbolKind::Class {
					"high"
				} else {
					"medium"
				};
				Some(GraphDeadCodeItem {
					symbol:     summary_for_node(graph, node_index)?,
					reason:     if symbol.kind == SymbolKind::CssRule {
						"no matched styled elements".into()
					} else {
						"no inbound semantic references".into()
					},
					confidence: confidence.into(),
				})
			})
			.collect::<Vec<_>>();
		items.sort_by(|left, right| {
			confidence_rank(&right.confidence)
				.cmp(&confidence_rank(&left.confidence))
				.then_with(|| left.symbol.label.cmp(&right.symbol.label))
		});
		if limit > 0 {
			items.truncate(limit);
		}
		items
	}

	pub fn graph_clusters(&self) -> Vec<GraphCluster> {
		let graph = self.graph();
		let mut visited = BTreeSet::new();
		let mut clusters = Vec::new();
		for start in graph.node_indices() {
			if !visited.insert(start) {
				continue;
			}
			let mut queue = VecDeque::from([start]);
			let mut component = Vec::new();
			while let Some(node_index) = queue.pop_front() {
				component.push(node_index);
				for edge in graph.edges(node_index) {
					let neighbor = edge.target();
					if visited.insert(neighbor) {
						queue.push_back(neighbor);
					}
				}
				for edge in graph.edges_directed(node_index, Direction::Incoming) {
					let neighbor = edge.source();
					if visited.insert(neighbor) {
						queue.push_back(neighbor);
					}
				}
			}
			let files = component
				.iter()
				.copied()
				.filter_map(|node_index| match graph.node_weight(node_index) {
					Some(GraphNode::File(_)) => summary_for_node(graph, node_index),
					_ => None,
				})
				.collect::<Vec<_>>();
			if files.len() < 2 {
				continue;
			}
			let symbol_count = component
				.iter()
				.filter(|node_index| {
					matches!(graph.node_weight(**node_index), Some(GraphNode::Symbol(_)))
				})
				.count();
			let name = common_path_prefix(&files);
			clusters.push((name, files, symbol_count));
		}
		clusters.sort_by(|left, right| {
			right
				.1
				.len()
				.cmp(&left.1.len())
				.then_with(|| left.0.cmp(&right.0))
		});
		clusters.truncate(20);
		clusters
			.into_iter()
			.enumerate()
			.map(|(id, (name, files, symbol_count))| GraphCluster { id, name, files, symbol_count })
			.collect()
	}
}

fn resolve_symbol(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	code_graph: &CodeGraph,
	query: &str,
) -> Option<NodeIndex> {
	let exact = graph
		.node_indices()
		.find(|&node_index| match graph.node_weight(node_index) {
			Some(GraphNode::Symbol(symbol)) => symbol_matches_query(symbol, query),
			_ => false,
		});
	exact.or_else(|| {
		code_graph
			.graph_search(query, None, 10)
			.into_iter()
			.filter(|hit| hit.summary.kind != "file")
			.find_map(|hit| {
				let node_index = find_node_by_summary(graph, &hit.summary)?;
				match graph.node_weight(node_index) {
					Some(GraphNode::Symbol(symbol)) if symbol.name.contains(query) => Some(node_index),
					_ => None,
				}
			})
	})
}

fn resolve_file(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	query: &str,
) -> Option<NodeIndex> {
	graph
		.node_indices()
		.find(|&node_index| match graph.node_weight(node_index) {
			Some(GraphNode::File(file)) => file.path == Path::new(query) || file.path.ends_with(query),
			_ => false,
		})
}

fn symbol_matches_query(symbol: &crate::model::SymbolNode, query: &str) -> bool {
	symbol.qualified_name == query
		|| symbol.name == query
		|| symbol
			.qualified_name
			.split_once("::")
			.is_some_and(|(_, suffix)| suffix == query)
}

fn exact_symbol_matches(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	query: &str,
) -> Vec<NodeIndex> {
	graph
		.node_indices()
		.filter(|&node_index| match graph.node_weight(node_index) {
			Some(GraphNode::Symbol(symbol)) => symbol_matches_query(symbol, query),
			_ => false,
		})
		.collect()
}

fn exact_file_matches(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	query: &str,
) -> Vec<NodeIndex> {
	graph
		.node_indices()
		.filter(|&node_index| match graph.node_weight(node_index) {
			Some(GraphNode::File(file)) => file.path == Path::new(query) || file.path.ends_with(query),
			_ => false,
		})
		.collect()
}

fn dedupe_summaries(mut summaries: Vec<GraphNodeSummary>, limit: usize) -> Vec<GraphNodeSummary> {
	let mut seen = BTreeSet::new();
	summaries.retain(|summary| seen.insert((summary.label.clone(), summary.path.clone())));
	summaries.truncate(limit);
	summaries
}

fn resolve_symbol_or_file(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	code_graph: &CodeGraph,
	query: &str,
) -> Option<NodeIndex> {
	resolve_symbol(graph, code_graph, query).or_else(|| resolve_file(graph, query))
}

fn find_node_by_summary(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	summary: &GraphNodeSummary,
) -> Option<NodeIndex> {
	graph
		.node_indices()
		.find(|&node_index| summary_for_node(graph, node_index).as_ref() == Some(summary))
}

fn neighbors_by_kind(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	node_index: NodeIndex,
	direction: Direction,
	kinds: &[EdgeKind],
) -> Vec<GraphNodeSummary> {
	let mut seen = BTreeSet::new();
	let mut result = Vec::new();
	for edge in graph.edges_directed(node_index, direction) {
		if !kinds.contains(edge.weight()) {
			continue;
		}
		let other = if direction == Direction::Incoming {
			edge.source()
		} else {
			edge.target()
		};
		if seen.insert(other.index())
			&& let Some(summary) = summary_for_node(graph, other)
		{
			result.push(summary);
		}
	}
	result
}

fn file_neighbors_for_symbol(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	symbol_index: NodeIndex,
	direction: Direction,
) -> Vec<GraphNodeSummary> {
	let Some(GraphNode::Symbol(symbol)) = graph.node_weight(symbol_index) else {
		return Vec::new();
	};
	let Some(file_index) = resolve_file(graph, &symbol.file.to_string_lossy()) else {
		return Vec::new();
	};
	neighbors_by_kind(graph, file_index, direction, &[EdgeKind::Imports])
}

fn bfs_levels(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	start: NodeIndex,
	direction: Direction,
	kinds: &[EdgeKind],
	max_depth: usize,
) -> Vec<GraphTraversalLevel> {
	let mut visited = BTreeSet::from([start.index()]);
	let mut queue = VecDeque::from([(start, 0_usize)]);
	let mut levels = BTreeMap::<usize, Vec<GraphNodeSummary>>::new();
	while let Some((node_index, depth)) = queue.pop_front() {
		if depth >= max_depth {
			continue;
		}
		for edge in graph.edges_directed(node_index, direction) {
			if !kinds.contains(edge.weight()) {
				continue;
			}
			let next = if direction == Direction::Incoming {
				edge.source()
			} else {
				edge.target()
			};
			if !visited.insert(next.index()) {
				continue;
			}
			if let Some(summary) = summary_for_node(graph, next) {
				levels.entry(depth + 1).or_default().push(summary);
			}
			queue.push_back((next, depth + 1));
		}
	}
	levels
		.into_iter()
		.map(|(depth, nodes)| GraphTraversalLevel { depth: depth as u32, nodes })
		.collect()
}

fn summary_for_node(
	graph: &petgraph::stable_graph::StableGraph<GraphNode, EdgeKind>,
	node_index: NodeIndex,
) -> Option<GraphNodeSummary> {
	match graph.node_weight(node_index)? {
		GraphNode::File(file) => Some(GraphNodeSummary {
			label:    file.path.to_string_lossy().to_string(),
			path:     file.path.clone(),
			kind:     "file".into(),
			exported: false,
			line:     0,
			column:   0,
		}),
		GraphNode::Symbol(symbol) => Some(GraphNodeSummary {
			label:    symbol.qualified_name.clone(),
			path:     symbol.file.clone(),
			kind:     format!("{:?}", symbol.kind).to_ascii_lowercase(),
			exported: symbol.exported,
			line:     symbol.line,
			column:   symbol.column,
		}),
	}
}

fn is_test_path(path: &Path) -> bool {
	let path_str = path.to_string_lossy();
	path_str.contains("/test/")
		|| path_str.contains("/spec/")
		|| path_str.contains("/__tests__/")
		|| path
			.file_name()
			.and_then(|name| name.to_str())
			.is_some_and(|name| name.contains(".test.") || name.contains(".spec."))
}

fn is_entry_point_symbol(symbol: &crate::model::SymbolNode) -> bool {
	symbol.name == "main" || symbol.name == "default"
}

fn confidence_rank(confidence: &str) -> usize {
	match confidence {
		"high" => 3,
		"medium" => 2,
		_ => 1,
	}
}

fn common_path_prefix(files: &[GraphNodeSummary]) -> String {
	let mut parts: Option<Vec<_>> = None;
	for file in files {
		let current = file.path.components().collect::<Vec<_>>();
		parts = Some(match parts {
			None => current,
			Some(existing) => existing
				.into_iter()
				.zip(current)
				.take_while(|(left, right)| left == right)
				.map(|(part, _)| part)
				.collect(),
		});
	}
	let Some(parts) = parts else {
		return String::new();
	};
	if parts.is_empty() {
		return String::new();
	}
	PathBuf::from_iter(parts).to_string_lossy().to_string()
}

#[cfg(test)]
fn build_style_graph() -> CodeGraph {
	let mut graph = petgraph::stable_graph::StableGraph::<GraphNode, EdgeKind>::new();
	let html_file = graph.add_node(GraphNode::File(crate::model::FileNode {
		path:     PathBuf::from("index.html"),
		language: "html".into(),
	}));
	let css_file = graph.add_node(GraphNode::File(crate::model::FileNode {
		path:     PathBuf::from("app.css"),
		language: "css".into(),
	}));
	let selector = graph.add_node(GraphNode::Symbol(crate::model::SymbolNode {
		name:           ".btn".into(),
		qualified_name: "app.css::.btn".into(),
		file:           PathBuf::from("app.css"),
		kind:           SymbolKind::CssRule,
		exported:       false,
		line:           1,
		column:         1,
		detail:         None,
	}));
	let element = graph.add_node(GraphNode::Symbol(crate::model::SymbolNode {
		name:           "button.btn".into(),
		qualified_name: "index.html::button.btn".into(),
		file:           PathBuf::from("index.html"),
		kind:           SymbolKind::Element,
		exported:       false,
		line:           1,
		column:         1,
		detail:         None,
	}));
	graph.add_edge(css_file, selector, EdgeKind::Defines);
	graph.add_edge(html_file, element, EdgeKind::Defines);
	graph.add_edge(selector, element, EdgeKind::Styles);
	CodeGraph::from(crate::model::PersistedCodeGraph {
		root: PathBuf::from("."),
		graph,
		stats: crate::model::GraphStats {
			file_count:      2,
			symbol_count:    2,
			edge_count:      3,
			language_counts: std::collections::BTreeMap::from([("css".into(), 1), ("html".into(), 1)]),
		},
		generated_at_ms: 0,
		git_head: None,
	})
}

#[test]
fn queries_context_and_dead_code_treat_styles_as_usage() {
	let graph = build_style_graph();
	let context = graph
		.graph_context(".btn")
		.expect("style context should exist");
	assert!(
		context
			.references
			.iter()
			.any(|node| node.label.ends_with("index.html::button.btn"))
	);
	let dead_code = graph.graph_dead_code();
	assert!(
		!dead_code
			.iter()
			.any(|item| item.symbol.label.ends_with("app.css::.btn"))
	);
	assert!(
		!dead_code
			.iter()
			.any(|item| item.symbol.label.ends_with("index.html::button.btn"))
	);
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf, sync::Arc};

	use super::*;
	use crate::{
		cache::CacheStore,
		indexer::{BuildGraphOptions, CodeGraphBuilder},
		language::{
			ExtractedFile, ExtractedImport, ExtractedImportBinding, ExtractedReference,
			ExtractedSymbol, ImportResolver, LanguageExtractor, LanguageRegistry, ResolveRequest,
			SupportedLanguage,
		},
		model::SymbolKind,
	};

	#[derive(Clone)]
	struct QueryExtractor;

	impl LanguageExtractor for QueryExtractor {
		fn language(&self) -> SupportedLanguage {
			SupportedLanguage::new("query")
		}

		fn matches_path(&self, path: &Path) -> bool {
			path.extension().and_then(|extension| extension.to_str()) == Some("query")
		}

		fn extract(&self, path: &Path, _source: &str) -> crate::Result<ExtractedFile> {
			let name = path
				.file_stem()
				.and_then(|stem| stem.to_str())
				.unwrap_or("entry");
			if name == "constructor_holder" {
				return Ok(ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![ExtractedSymbol {
						name:           "constructor".into(),
						qualified_name: format!("{}::constructor", path.display()),
						kind:           SymbolKind::Method,
						exported:       false,
						line:           1,
						column:         1,
						detail:         None,
						references:     Vec::new(),
					}],
					imports:  Vec::new(),
				});
			}
			let (imports, references) = match name {
				"caller" => (
					vec![ExtractedImport {
						specifier:    "./callee.query".into(),
						bindings:     vec![ExtractedImportBinding {
							imported_name: "callee".into(),
							local_name:    "callee".into(),
						}],
						is_type_only: false,
					}],
					vec![ExtractedReference {
						target_name: "callee".into(),
						edge_kind:   EdgeKind::Calls,
					}],
				),
				"type_consumer" => (
					vec![ExtractedImport {
						specifier:    "./type_only.query".into(),
						bindings:     vec![ExtractedImportBinding {
							imported_name: "type_only".into(),
							local_name:    "type_only".into(),
						}],
						is_type_only: true,
					}],
					Vec::new(),
				),
				_ => (Vec::new(), Vec::new()),
			};
			Ok(ExtractedFile {
				path: path.to_path_buf(),
				language: self.language(),
				symbols: vec![ExtractedSymbol {
					name: name.into(),
					qualified_name: format!("{}::{name}", path.display()),
					kind: SymbolKind::Function,
					exported: name == "callee",
					line: 1,
					column: 1,
					detail: None,
					references,
				}],
				imports,
			})
		}
	}

	#[derive(Clone)]
	struct QueryResolver;

	impl ImportResolver for QueryResolver {
		fn language(&self) -> SupportedLanguage {
			SupportedLanguage::new("query")
		}

		fn resolve(&self, request: ResolveRequest<'_>) -> crate::Result<Option<PathBuf>> {
			Ok(match request.specifier {
				"./callee.query" => Some(PathBuf::from("callee.query")),
				"./type_only.query" => Some(PathBuf::from("type_only.query")),
				_ => None,
			})
		}
	}

	fn build_query_graph() -> CodeGraph {
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_nanos();
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-queries-{}-{unique}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		std::fs::create_dir_all(&root).expect("query graph temp dir should exist");
		for file in [
			"caller.query",
			"callee.query",
			"orphan.query",
			"type_consumer.query",
			"type_only.query",
			"constructor_holder.query",
		] {
			std::fs::write(root.join(file), file).expect("query fixture should be written");
		}
		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(QueryExtractor), Arc::new(QueryResolver))
			.expect("registry should succeed");
		let cache_dir = root.join("cache");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(&cache_dir));
		let graph = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("query graph build should succeed")
			.graph;
		let _ = std::fs::remove_dir_all(root);
		graph
	}

	#[test]
	fn queries_context_reports_callers_and_callees() {
		let graph = build_query_graph();
		let context = graph.graph_context("callee").expect("context should exist");
		assert!(
			context
				.callers
				.iter()
				.any(|node| node.label.ends_with("caller.query::caller"))
		);
		assert!(
			context
				.imported_by
				.iter()
				.any(|node| node.label.ends_with("caller.query"))
		);
	}

	#[test]
	fn queries_impact_and_flow_traverse_graph() {
		let graph = build_query_graph();
		let impact = graph
			.graph_impact("callee", 4)
			.expect("impact should exist");
		assert!(impact.levels.iter().any(|level| {
			level
				.nodes
				.iter()
				.any(|node| node.label.ends_with("caller.query::caller"))
		}));
		let flow = graph.graph_flow("caller", 4).expect("flow should exist");
		assert!(flow.levels.iter().any(|level| {
			level
				.nodes
				.iter()
				.any(|node| node.label.ends_with("callee.query::callee"))
		}));
	}

	#[test]
	fn queries_impact_includes_type_only_dependents() {
		let graph = build_query_graph();
		let impact = graph
			.graph_impact("type_only", 4)
			.expect("type-only impact should exist");
		assert!(impact.levels.iter().any(|level| {
			level
				.nodes
				.iter()
				.any(|node| node.label.ends_with("type_consumer.query"))
		}));
	}

	#[test]
	fn dead_code_ignores_type_only_references() {
		let graph = build_query_graph();
		let dead_code = graph.graph_dead_code();
		assert!(
			dead_code
				.iter()
				.any(|item| item.symbol.label.ends_with("type_only.query::type_only"))
		);
	}

	#[test]
	fn dead_code_excludes_constructors() {
		let graph = build_query_graph();
		let dead_code = graph.graph_dead_code();
		assert!(!dead_code.iter().any(|item| {
			item
				.symbol
				.label
				.ends_with("constructor_holder.query::constructor")
		}));
	}

	#[test]
	fn resolve_symbol_does_not_match_files() {
		let graph = build_query_graph();
		assert!(graph.graph_context("caller.query").is_none());
	}

	#[test]
	fn queries_symbol_and_file_lookup_distinguish_exact_from_ranked() {
		let graph = build_query_graph();
		let symbols = graph.graph_symbols("callee", 5);
		assert_eq!(symbols.status, "exact");
		assert_eq!(symbols.matches.len(), 1);
		assert!(symbols.matches[0].label.ends_with("callee.query::callee"));

		let ranked_symbols = graph.graph_symbols("caller.query", 5);
		assert_eq!(ranked_symbols.status, "ranked");
		assert!(
			ranked_symbols
				.matches
				.iter()
				.any(|node| node.label.ends_with("caller.query::caller"))
		);

		let files = graph.graph_files("caller.query", 5);
		assert_eq!(files.status, "exact");
		assert_eq!(files.matches.len(), 1);
		assert_eq!(files.matches[0].label, "caller.query");
	}

	#[test]
	fn graph_symbols_match_typst_callable_lets_by_base_name() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-query-typst-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("docs")).expect("docs dir");
		fs::write(
			root.join("docs/report.typ"),
			"#let section-block(num, title) = {\n  [#num #title]\n}\n#let posterior-chart() = [ok]\n",
		)
		.expect("typst file");

		let graph = CodeGraphBuilder::new(
			LanguageRegistry::new().with_defaults().expect("registry"),
			CacheStore::new(&cache_dir),
		)
		.build(&BuildGraphOptions::new(&root))
		.expect("typst workspace should index")
		.graph;

		let exact = graph.graph_symbols("section-block", 5);
		assert_eq!(exact.status, "exact");
		assert_eq!(exact.matches.len(), 1);
		assert!(
			exact.matches[0]
				.label
				.ends_with("docs/report.typ::section-block")
		);

		let qualified = graph.graph_symbols("docs/report.typ::section-block", 5);
		assert_eq!(qualified.status, "exact");
		assert_eq!(qualified.matches.len(), 1);
		assert!(
			qualified.matches[0]
				.label
				.ends_with("docs/report.typ::section-block")
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn graph_symbols_exact_match_native_canonical_paths_for_audited_languages() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-query-parity-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("docs")).expect("docs dir");
		fs::create_dir_all(root.join("lib/my_app")).expect("elixir dir");
		fs::create_dir_all(root.join("web")).expect("web dir");
		fs::write(root.join("docs/readme.md"), "# Installation\n\n## Prerequisites\n")
			.expect("markdown file");
		fs::write(root.join("docs/plan.org"), "* OrgTop\n** OrgChild\n").expect("org file");
		fs::write(
			root.join("lib/my_app/app.ex"),
			"defmodule MyApp.Greeter do\n  def greet(name) do\n    name\n  end\nend\n",
		)
		.expect("elixir file");
		fs::write(
			root.join("web/index.html"),
			"<!doctype html>\n<html id=\"root\">\n  <body id=\"main\">\n    <button \
			 id=\"save\">Save</button>\n  </body>\n</html>\n",
		)
		.expect("html file");
		fs::write(root.join("web/app.css"), ":root { --accent: red; color: var(--accent); }\n")
			.expect("css file");

		let graph = CodeGraphBuilder::new(
			LanguageRegistry::new().with_defaults().expect("registry"),
			CacheStore::new(&cache_dir),
		)
		.build(&BuildGraphOptions::new(&root))
		.expect("parity workspace should index")
		.graph;

		let cases = [
			("Installation.Prerequisites", "docs/readme.md::Installation.Prerequisites"),
			("OrgTop.OrgChild", "docs/plan.org::OrgTop.OrgChild"),
			("MyApp.Greeter.greet", "lib/my_app/app.ex::MyApp.Greeter.greet"),
			("html#root.body#main.button#save", "web/index.html::html#root.body#main.button#save"),
			(":root.--accent", "web/app.css:::root.--accent"),
		];
		for (query, expected_label) in cases {
			let symbols = graph.graph_symbols(query, 5);
			assert_eq!(symbols.status, "exact", "{query} should exact-match");
			assert_eq!(symbols.matches.len(), 1, "{query} should return one match");
			assert!(
				symbols.matches[0].label.ends_with(expected_label),
				"unexpected label for {query}: {}",
				symbols.matches[0].label
			);
		}
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn queries_search_dead_code_and_clusters_work() {
		let graph = build_query_graph();
		let search = graph.graph_search("caller", None, 5);
		assert!(
			search
				.iter()
				.any(|hit| hit.summary.label.ends_with("caller.query::caller"))
		);
		let dead_code = graph.graph_dead_code();
		assert!(
			dead_code
				.iter()
				.any(|item| item.symbol.label.ends_with("orphan.query::orphan"))
		);
		let deps = graph.graph_deps("caller.query").expect("deps should exist");
		assert!(
			deps
				.outgoing
				.iter()
				.any(|node| node.label.ends_with("callee.query"))
		);
		let clusters = graph.graph_clusters();
		assert!(!clusters.is_empty());
	}
}
