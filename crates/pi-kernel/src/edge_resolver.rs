//! EdgeResolver implementation backed by `pi-code-graph`.
//!
//! Bridges the kernel `EdgeKind` axis (ref→, def→, call→, import→, bind→)
//! into `pi-code-graph` edge traversals.

use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use pi_code_graph::model::{CodeGraph, EdgeKind as GraphEdgeKind, GraphNode};
use pi_code_path::{
	ast::EdgeKind as KernelEdgeKind,
	resolver::{CancellationToken, EdgeResolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

/// [`EdgeResolver`] backed by a `pi-code-graph` [`CodeGraph`].
pub struct EdgeResolverImpl {
	pub graph: Arc<CodeGraph>,
	outgoing:  HashMap<usize, Vec<(usize, GraphEdgeKind)>>,
	incoming:  HashMap<usize, Vec<(usize, GraphEdgeKind)>>,
	nodes:     HashMap<usize, NodeRef>,
}

impl EdgeResolverImpl {
	pub fn new(graph: Arc<CodeGraph>) -> Self {
		let mut outgoing: HashMap<usize, Vec<(usize, GraphEdgeKind)>> = HashMap::new();
		let mut incoming: HashMap<usize, Vec<(usize, GraphEdgeKind)>> = HashMap::new();
		let mut nodes: HashMap<usize, NodeRef> = HashMap::new();

		let g = graph.graph();
		for idx in g.node_indices() {
			let index = idx.index();

			// Cache the NodeRef for every graph node so we can O(1) resolve
			// results later without repeatedly scanning the graph.
			if let Some(node) = g.node_weight(idx) {
				let node_ref = match node {
					GraphNode::Symbol(sym) => {
						let mut metadata = HashMap::new();
						let file_prefix = format!("{}::", sym.file.display());
						let symbol_path = sym
							.qualified_name
							.strip_prefix(&file_prefix)
							.unwrap_or(&sym.qualified_name);
						metadata.insert(
							"symbolPath".to_string(),
							serde_json::Value::String(symbol_path.to_string()),
						);
						metadata.insert(
							"symbolKind".to_string(),
							serde_json::Value::String(format!("{:?}", sym.kind).to_ascii_lowercase()),
						);
						metadata
							.insert("symbolLine".to_string(), serde_json::Value::Number(sym.line.into()));
						NodeRef {
							locator: format!("{}:{}", sym.file.display(), sym.line),
							range: 0..0,
							kind: format!("{:?}", sym.kind).to_ascii_lowercase(),
							content: None,
							metadata,
							diagnostics: Vec::new(),
						}
					},
					GraphNode::File(file) => NodeRef {
						locator:     file.path.display().to_string(),
						range:       0..0,
						kind:        "file".into(),
						content:     None,
						metadata:    Default::default(),
						diagnostics: Vec::new(),
					},
				};
				nodes.insert(index, node_ref);
			}
		}
		// Build adjacency lists using only inherent methods so we don't need
		// to import petgraph traits.
		for ei in g.edge_indices() {
			if let Some((src, dst)) = g.edge_endpoints(ei) {
				if let Some(&kind) = g.edge_weight(ei) {
					outgoing
						.entry(src.index())
						.or_default()
						.push((dst.index(), kind));
					incoming
						.entry(dst.index())
						.or_default()
						.push((src.index(), kind));
				}
			}
		}

		Self { graph, outgoing, incoming, nodes }
	}

	/// Locate a graph node index from a [`NodeRef`] locator.
	///
	/// Tries, in order:
	/// 1. Exact symbol `qualified_name`.
	/// 2. Exact file path.
	/// 3. Partial file path (`ends_with`).
	/// 4. `file:line` format.
	fn find_node_index(&self, source: &NodeRef) -> Option<usize> {
		let g = self.graph.graph();
		let locator = &source.locator;

		// 1. Exact qualified-name match for symbols.
		for idx in g.node_indices() {
			if let Some(GraphNode::Symbol(sym)) = g.node_weight(idx) {
				if sym.qualified_name == *locator {
					return Some(idx.index());
				}
			}
		}

		// 2. Exact file-path match.
		for idx in g.node_indices() {
			if let Some(GraphNode::File(file)) = g.node_weight(idx) {
				if file.path.to_string_lossy() == *locator {
					return Some(idx.index());
				}
			}
		}

		// 3. Partial file-path match.
		for idx in g.node_indices() {
			if let Some(GraphNode::File(file)) = g.node_weight(idx) {
				if file.path.ends_with(locator) {
					return Some(idx.index());
				}
			}
		}

		// 4. `file:line` format.
		if let Some((path_part, line_part)) = locator.rsplit_once(':') {
			if let Ok(line) = line_part.parse::<u32>() {
				for idx in g.node_indices() {
					if let Some(GraphNode::Symbol(sym)) = g.node_weight(idx) {
						if sym.file.to_string_lossy() == path_part && sym.line == line {
							return Some(idx.index());
						}
					}
				}
			}
		}

		None
	}

	/// Map a kernel [`KernelEdgeKind`] to the graph [`GraphEdgeKind`] and
	/// whether we should walk **incoming** edges.
	fn to_graph_edge(kind: KernelEdgeKind) -> Option<(GraphEdgeKind, bool)> {
		match kind {
			// ref→  : from reference site to definition  → outgoing References
			KernelEdgeKind::Ref => Some((GraphEdgeKind::References, false)),
			// def→  : from declaration to its references  → incoming References
			KernelEdgeKind::Def => Some((GraphEdgeKind::References, true)),
			// call→ : from call site to callee            → outgoing Calls
			KernelEdgeKind::Call => Some((GraphEdgeKind::Calls, false)),
			// import→ : from importer to imported module   → outgoing Imports
			KernelEdgeKind::Import => Some((GraphEdgeKind::Imports, false)),
			// bind→ : scope-local, not in graph
			KernelEdgeKind::Bind => None,
			// implements→ : from type to interface/trait → outgoing Implements
			KernelEdgeKind::Implements => Some((GraphEdgeKind::Implements, false)),
			// inherits→ : from type to base type → outgoing Inherits
			KernelEdgeKind::Inherits => Some((GraphEdgeKind::Inherits, false)),
			// dispatches→ : polymorphic call → outgoing Dispatches
			KernelEdgeKind::Dispatches => Some((GraphEdgeKind::Dispatches, false)),
		}
	}

	/// PLAN-318 W5: like [`neighbors`], plus one hop of re-export chain
	/// following for `def→` queries. When `kind == References` and we're
	/// looking incoming (i.e. "who references this symbol?"), also include
	/// any file that has an `Aliases` edge to the starting symbol's file.
	/// Those files are re-exporters whose downstream consumers would
	/// otherwise be invisible — their bindings reference the re-export
	/// module, not the original symbol.
	fn neighbours_with_reexport(
		&self,
		node: usize,
		kind: GraphEdgeKind,
		incoming: bool,
		kernel_kind: KernelEdgeKind,
	) -> Vec<usize> {
		let mut results = self.neighbors(node, kind, incoming);
		if !matches!(kernel_kind, KernelEdgeKind::Def) {
			return results;
		}
		// PLAN-318 W1g: def→ semantically means "all sites that reference
		// this definition". Different extractors use different edge kinds for
		// the same semantic relationship: tree-sitter dialects record concrete
		// call expressions as Calls, while textual references show up as
		// References. Both must be surfaced under def→.
		for caller in self.neighbors(node, GraphEdgeKind::Calls, incoming) {
			if !results.contains(&caller) {
				results.push(caller);
			}
		}
		// For def→: identify the file that defines this symbol, then walk
		// Aliases edges (incoming) to that file = files that re-export it.
		// Each re-exporter file becomes an additional referrer.
		if let Some(file_node) = self.symbol_defining_file(node) {
			for reexporter in self.neighbors(file_node, GraphEdgeKind::Aliases, true) {
				if !results.contains(&reexporter) {
					results.push(reexporter);
				}
			}
		}
		results
	}

	/// Find the file node that defines `symbol_node` by walking the incoming
	/// Defines edge. Returns None for non-symbol nodes or unrooted symbols.
	fn symbol_defining_file(&self, symbol_node: usize) -> Option<usize> {
		self
			.incoming
			.get(&symbol_node)?
			.iter()
			.find(|(_, k)| *k == GraphEdgeKind::Defines)
			.map(|(n, _)| *n)
	}

	/// Return the neighbours of `node` that are connected by `kind` in the
	/// requested direction.
	fn neighbors(&self, node: usize, kind: GraphEdgeKind, incoming: bool) -> Vec<usize> {
		let adj = if incoming {
			&self.incoming
		} else {
			&self.outgoing
		};
		adj.get(&node)
			.map(|edges| {
				edges
					.iter()
					.filter(|(_, k)| *k == kind)
					.map(|(n, _)| *n)
					.collect()
			})
			.unwrap_or_default()
	}

	/// Verify the underlying code graph has been initialised.
	fn ensure_initialised(&self) -> Result<(), Diagnostic> {
		if self.graph.root().exists() {
			Ok(())
		} else {
			Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: "[CODE_GRAPH_NOT_INITIALISED] code graph not initialised; run `manage index` \
				          first or wait for background indexing"
					.to_string(),
				span:    None,
			})
		}
	}
}

impl EdgeResolver for EdgeResolverImpl {
	fn resolve(
		&self,
		source: &NodeRef,
		kind: KernelEdgeKind,
		depth: Option<usize>,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic> {
		self.ensure_initialised()?;

		if self.graph.graph().node_count() == 0 {
			return Ok(Vec::new());
		}

		let Some(start) = self.find_node_index(source) else {
			return Err(Diagnostic {
				variant: DiagnosticVariant::FileNotFound,
				message: format!("node not found for locator: {}", source.locator),
				span:    None,
			});
		};

		let kernel_kind_for_reexport = kind.clone();
		let Some((graph_kind, is_incoming)) = Self::to_graph_edge(kind) else {
			return Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: "bind→ is not supported by the graph resolver".into(),
				span:    None,
			});
		};

		let max_depth = depth.unwrap_or(1);
		if max_depth == 0 {
			return Ok(Vec::new());
		}

		let mut results = Vec::new();
		let mut visited = HashSet::new();
		visited.insert(start);

		if max_depth == 1 {
			let neighbour_set =
				self.neighbours_with_reexport(start, graph_kind, is_incoming, kernel_kind_for_reexport);
			for neighbor in neighbour_set {
				if cancel.is_cancelled() {
					return Err(Diagnostic {
						variant: DiagnosticVariant::Cancelled,
						message: "cancelled".into(),
						span:    None,
					});
				}
				if visited.insert(neighbor) {
					if let Some(node_ref) = self.nodes.get(&neighbor).cloned() {
						results.push(node_ref);
					}
				}
			}
		} else {
			let mut current_level = vec![start];
			let mut current_depth = 0_usize;

			while !current_level.is_empty() && current_depth < max_depth {
				if cancel.is_cancelled() {
					return Err(Diagnostic {
						variant: DiagnosticVariant::Cancelled,
						message: "cancelled".into(),
						span:    None,
					});
				}

				let mut next_level = Vec::new();
				for node in &current_level {
					// PLAN-318 W5g: depth>1 branch must follow re-exports too,
					// otherwise a caller passing depth≥2 loses re-export
					// transparency. Use the same helper as depth==1.
					for neighbor in self.neighbours_with_reexport(
						*node,
						graph_kind,
						is_incoming,
						kernel_kind_for_reexport.clone(),
					) {
						if visited.insert(neighbor) {
							if let Some(node_ref) = self.nodes.get(&neighbor).cloned() {
								results.push(node_ref);
							}
							next_level.push(neighbor);
						}
					}
				}
				current_level = next_level;
				current_depth += 1;
			}
		}

		const LIMIT: usize = 100;
		if results.len() > LIMIT {
			results.truncate(LIMIT);
			let msg = "truncated to 100; pass limit: ... for more".to_string();
			if let Some(last) = results.last_mut() {
				last.diagnostics.push(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: msg,
					span:    None,
				});
			}
		}

		Ok(results)
	}
}

#[cfg(test)]
mod tests {
	use pi_code_graph::model::{CodeGraph, PersistedCodeGraph};

	use super::*;

	fn build_graph(
		nodes: serde_json::Value,
		edges: serde_json::Value,
		stats: serde_json::Value,
	) -> CodeGraph {
		let json = serde_json::json!({
			"root": ".",
			"graph": {
				"nodes": nodes,
				"node_holes": [],
				"edge_property": "directed",
				"edges": edges
			},
			"stats": stats,
			"generated_at_ms": 0,
			"git_head": null
		});
		let persisted: PersistedCodeGraph = serde_json::from_value(json).unwrap();
		CodeGraph::from(persisted)
	}

	fn build_graph_with_root(
		root: std::path::PathBuf,
		nodes: serde_json::Value,
		edges: serde_json::Value,
		stats: serde_json::Value,
	) -> CodeGraph {
		let json = serde_json::json!({
			"root": root,
			"graph": {
				"nodes": nodes,
				"node_holes": [],
				"edge_property": "directed",
				"edges": edges
			},
			"stats": stats,
			"generated_at_ms": 0,
			"git_head": null
		});
		let persisted: PersistedCodeGraph = serde_json::from_value(json).unwrap();
		CodeGraph::from(persisted)
	}

	fn ref_call_import_graph() -> CodeGraph {
		build_graph(
			serde_json::json!([
				{"File": {"path": "src/a.ts", "language": "ts"}},
				{"File": {"path": "src/b.ts", "language": "ts"}},
				{"Symbol": {"name": "a1", "qualified_name": "src/a.ts::a1", "file": "src/a.ts", "kind": "Function", "exported": true, "line": 1, "column": 1, "detail": null}},
				{"Symbol": {"name": "a2", "qualified_name": "src/a.ts::a2", "file": "src/a.ts", "kind": "Function", "exported": true, "line": 2, "column": 1, "detail": null}},
				{"Symbol": {"name": "b1", "qualified_name": "src/b.ts::b1", "file": "src/b.ts", "kind": "Function", "exported": true, "line": 1, "column": 1, "detail": null}}
			]),
			serde_json::json!([
				[0, 2, "Defines"],
				[0, 3, "Defines"],
				[1, 4, "Defines"],
				[2, 4, "References"],
				[4, 3, "References"],
				[2, 4, "Calls"],
				[0, 1, "Imports"]
			]),
			serde_json::json!({"file_count": 2, "symbol_count": 3, "edge_count": 7, "language_counts": {"ts": 2}}),
		)
	}

	fn cycle_graph() -> CodeGraph {
		build_graph(
			serde_json::json!([
				{"File": {"path": "src/cycle.ts", "language": "ts"}},
				{"Symbol": {"name": "x", "qualified_name": "src/cycle.ts::x", "file": "src/cycle.ts", "kind": "Function", "exported": true, "line": 1, "column": 1, "detail": null}},
				{"Symbol": {"name": "y", "qualified_name": "src/cycle.ts::y", "file": "src/cycle.ts", "kind": "Function", "exported": true, "line": 2, "column": 1, "detail": null}}
			]),
			serde_json::json!([[0, 1, "Defines"], [0, 2, "Defines"], [1, 2, "References"], [
				2,
				1,
				"References"
			]]),
			serde_json::json!({"file_count": 1, "symbol_count": 2, "edge_count": 4, "language_counts": {"ts": 1}}),
		)
	}

	fn truncation_graph() -> CodeGraph {
		let mut nodes = vec![
			serde_json::json!({"File": {"path": "src/big.ts", "language": "ts"}}),
			serde_json::json!({"Symbol": {"name": "hub", "qualified_name": "src/big.ts::hub", "file": "src/big.ts", "kind": "Function", "exported": true, "line": 1, "column": 1, "detail": null}}),
		];
		let mut edges = vec![serde_json::json!([0, 1, "Defines"])];
		for i in 0..101 {
			nodes.push(serde_json::json!({
				"Symbol": {
					"name": format!("leaf{i}"),
					"qualified_name": format!("src/big.ts::leaf{i}"),
					"file": "src/big.ts",
					"kind": "Function",
					"exported": true,
					"line": 2 + i,
					"column": 1,
					"detail": null
				}
			}));
			edges.push(serde_json::json!([2 + i, 1, "References"]));
		}
		build_graph(
			serde_json::Value::Array(nodes),
			serde_json::Value::Array(edges),
			serde_json::json!({"file_count": 1, "symbol_count": 102, "edge_count": 103, "language_counts": {"ts": 1}}),
		)
	}

	fn resolver() -> EdgeResolverImpl {
		EdgeResolverImpl::new(Arc::new(ref_call_import_graph()))
	}

	fn node_ref_by_qualified_name(name: &str) -> NodeRef {
		NodeRef {
			locator:     name.into(),
			range:       0..0,
			kind:        "function".into(),
			content:     None,
			metadata:    Default::default(),
			diagnostics: Vec::new(),
		}
	}

	#[test]
	fn uninitialised_graph_returns_not_initialised_diagnostic() {
		let dir = tempfile::tempdir().unwrap();
		let bad_root = dir.path().join("nonexistent_project");
		let graph = build_graph_with_root(
			bad_root,
			serde_json::json!([]),
			serde_json::json!([]),
			serde_json::json!({"file_count": 0, "symbol_count": 0, "edge_count": 0, "language_counts": {}}),
		);
		let r = EdgeResolverImpl::new(Arc::new(graph));
		let source = node_ref_by_qualified_name("foo::bar");
		let err = r
			.resolve(&source, KernelEdgeKind::Ref, None, &CancellationToken::new())
			.unwrap_err();
		assert!(
			matches!(err.variant, DiagnosticVariant::UnsupportedOperation),
			"expected UnsupportedOperation, got {:?}",
			err.variant
		);
		assert!(
			err.message.contains("CODE_GRAPH_NOT_INITIALISED"),
			"expected CODE_GRAPH_NOT_INITIALISED in message, got: {}",
			err.message
		);
	}

	#[test]
	fn empty_initialised_graph_returns_empty_vec() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let graph = build_graph_with_root(
			root,
			serde_json::json!([]),
			serde_json::json!([]),
			serde_json::json!({"file_count": 0, "symbol_count": 0, "edge_count": 0, "language_counts": {}}),
		);
		let r = EdgeResolverImpl::new(Arc::new(graph));
		let source = node_ref_by_qualified_name("foo::bar");
		let results = r
			.resolve(&source, KernelEdgeKind::Ref, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 0, "expected empty results for empty initialised graph");
	}

	#[test]
	fn populated_graph_finds_edges() {
		let r = resolver();
		let source = node_ref_by_qualified_name("src/a.ts::a1");
		let results = r
			.resolve(&source, KernelEdgeKind::Ref, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].locator, "src/b.ts:1");
		assert_eq!(
			results[0]
				.metadata
				.get("symbolPath")
				.and_then(serde_json::Value::as_str),
			Some("b1")
		);
		assert_eq!(
			results[0]
				.metadata
				.get("symbolLine")
				.and_then(serde_json::Value::as_u64),
			Some(1)
		);
	}

	#[test]
	fn ref_edge_resolves_to_definition() {
		let r = resolver();
		let source = node_ref_by_qualified_name("src/a.ts::a1");
		let results = r
			.resolve(&source, KernelEdgeKind::Ref, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].locator, "src/b.ts:1");
	}

	#[test]
	fn def_edge_resolves_to_references() {
		let r = resolver();
		let source = node_ref_by_qualified_name("src/b.ts::b1");
		let results = r
			.resolve(&source, KernelEdgeKind::Def, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].locator, "src/a.ts:1");
	}

	#[test]
	fn call_edge_resolves_to_callee() {
		let r = resolver();
		let source = node_ref_by_qualified_name("src/a.ts::a1");
		let results = r
			.resolve(&source, KernelEdgeKind::Call, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].locator, "src/b.ts:1");
	}

	#[test]
	fn import_edge_resolves_to_module() {
		let r = resolver();
		let source = NodeRef {
			locator:     "src/a.ts".into(),
			range:       0..0,
			kind:        "file".into(),
			content:     None,
			metadata:    Default::default(),
			diagnostics: Vec::new(),
		};
		let results = r
			.resolve(&source, KernelEdgeKind::Import, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].locator, "src/b.ts");
	}

	#[test]
	fn bind_edge_returns_unsupported_diagnostic() {
		let r = resolver();
		let source = node_ref_by_qualified_name("src/a.ts::a1");
		let err = r
			.resolve(&source, KernelEdgeKind::Bind, None, &CancellationToken::new())
			.unwrap_err();
		assert!(
			matches!(err.variant, DiagnosticVariant::UnsupportedOperation),
			"expected UnsupportedOperation, got {:?}",
			err.variant
		);
	}

	#[test]
	fn depth_2_bfs_traverses_two_levels() {
		let r = resolver();
		let source = node_ref_by_qualified_name("src/a.ts::a1");
		let results = r
			.resolve(&source, KernelEdgeKind::Ref, Some(2), &CancellationToken::new())
			.unwrap();
		// a1 →ref b1 →ref a2
		assert_eq!(results.len(), 2, "expected b1 and a2, got {:?}", results);
		assert_eq!(results[0].locator, "src/b.ts:1");
		assert_eq!(results[1].locator, "src/a.ts:2");
	}

	#[test]
	fn cycle_handling_does_not_infinitely_loop() {
		let r = EdgeResolverImpl::new(Arc::new(cycle_graph()));
		let source = node_ref_by_qualified_name("src/cycle.ts::x");
		let results = r
			.resolve(&source, KernelEdgeKind::Ref, Some(3), &CancellationToken::new())
			.unwrap();
		// x →ref y →ref x (cycle, x already visited)
		assert_eq!(results.len(), 1, "expected only y, got {:?}", results);
		assert_eq!(results[0].locator, "src/cycle.ts:2");
	}

	#[test]
	fn truncation_at_100_emits_diagnostic() {
		let r = EdgeResolverImpl::new(Arc::new(truncation_graph()));
		let source = node_ref_by_qualified_name("src/big.ts::hub");
		let results = r
			.resolve(&source, KernelEdgeKind::Def, None, &CancellationToken::new())
			.unwrap();
		assert_eq!(results.len(), 100);
		let last = results.last().unwrap();
		assert!(
			last
				.diagnostics
				.iter()
				.any(|d| matches!(d.variant, DiagnosticVariant::ParseError)),
			"expected truncation diagnostic on last node, got diagnostics: {:?}",
			last.diagnostics
		);
	}
}
