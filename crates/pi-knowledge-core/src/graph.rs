use std::collections::{BTreeMap, HashSet, VecDeque};

use petgraph::stable_graph::{NodeIndex, StableGraph};
use petgraph::visit::EdgeRef;
use petgraph::Direction;
use serde::{Deserialize, Serialize};

/// Stable identifier for a graph node. Maps to a `CUSTOM_ID` for org items,
/// a `qualified_name` for code symbols, a file path for files.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct NodeKey(pub String);

impl NodeKey {
	pub fn new(s: impl Into<String>) -> Self {
		Self(s.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// Unified edge kind across code-graph + org-graph. New variants land here;
/// no other crate defines its own edge kind enum.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EdgeKind {
	// Code-graph lane (matches pi-code-graph::model::EdgeKind ordinally)
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

	// Org-graph lane (FEAT-631 vocabulary)
	Involved,
	About,
	Produced,
	DistilledFrom,
	Mentions,
	Supersedes,
	DerivedFrom,
	Blocks,
	Action,

	// Generic structural
	Contains,

	// Forward-compat for foreign drawer tokens
	Other(String),
}

impl EdgeKind {
	/// Canonical drawer-line keyword (e.g. `Supersedes` -> "SUPERSEDES").
	/// Used when serialising RELATIONS drawers and by the org parser.
	pub const fn drawer_keyword(&self) -> &str {
		match self {
			Self::Defines => "DEFINES",
			Self::Imports => "IMPORTS",
			Self::Calls => "CALLS",
			Self::References => "REFERENCES",
			Self::Inherits => "INHERITS",
			Self::Renders => "RENDERS",
			Self::Styles => "STYLES",
			Self::Requires => "REQUIRES",
			Self::Refers => "REFERS",
			Self::Aliases => "ALIASES",
			Self::Implements => "IMPLEMENTS",
			Self::Dispatches => "DISPATCHES",
			Self::Tests => "TESTS",
			Self::UsesKeyword => "USES_KEYWORD",
			Self::TypeImports => "TYPE_IMPORTS",
			Self::TypeParameterOf => "TYPE_PARAMETER_OF",
			Self::Involved => "INVOLVED",
			Self::About => "ABOUT",
			Self::Produced => "PRODUCED",
			Self::DistilledFrom => "DISTILLED_FROM",
			Self::Mentions => "MENTIONS",
			Self::Supersedes => "SUPERSEDES",
			Self::DerivedFrom => "DERIVED_FROM",
			Self::Blocks => "BLOCKS",
			Self::Action => "ACTION",
			Self::Contains => "CONTAINS",
			Self::Other(s) => s.as_str(),
		}
	}

	/// Parse a drawer keyword. Case-insensitive. Unknown tokens become
	/// `EdgeKind::Other` for forward compatibility.
	pub fn from_drawer_keyword(s: &str) -> Self {
		match s.to_ascii_uppercase().as_str() {
			"DEFINES" => Self::Defines,
			"IMPORTS" => Self::Imports,
			"CALLS" => Self::Calls,
			"REFERENCES" => Self::References,
			"INHERITS" => Self::Inherits,
			"RENDERS" => Self::Renders,
			"STYLES" => Self::Styles,
			"REQUIRES" => Self::Requires,
			"REFERS" => Self::Refers,
			"ALIASES" => Self::Aliases,
			"IMPLEMENTS" => Self::Implements,
			"DISPATCHES" => Self::Dispatches,
			"TESTS" => Self::Tests,
			"USES_KEYWORD" => Self::UsesKeyword,
			"TYPE_IMPORTS" => Self::TypeImports,
			"TYPE_PARAMETER_OF" => Self::TypeParameterOf,
			"INVOLVED" => Self::Involved,
			"ABOUT" => Self::About,
			"PRODUCED" => Self::Produced,
			"DISTILLED_FROM" => Self::DistilledFrom,
			"MENTIONS" => Self::Mentions,
			"SUPERSEDES" => Self::Supersedes,
			"DERIVED_FROM" => Self::DerivedFrom,
			"BLOCKS" => Self::Blocks,
			"ACTION" => Self::Action,
			"CONTAINS" => Self::Contains,
			_ => Self::Other(s.to_owned()),
		}
	}
}

/// Generic node payload.
///
/// Carries the `kind` discriminator + any consumer-defined metadata.
/// Default `P = serde_json::Value` keeps the graph bincodable without
/// dragging full domain types into this crate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node<P = serde_json::Value> {
	pub key: NodeKey,
	pub kind: String,
	pub payload: P,
}

/// A neighbor returned by `neighborhood`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Neighbor<E = EdgeKind> {
	pub key: NodeKey,
	pub depth: usize,
	/// The edge that brought this neighbor into the BFS (None for the focus itself).
	pub via: Option<E>,
}

/// A single step in a path returned by `path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathStep<E = EdgeKind> {
	pub from: NodeKey,
	pub to: NodeKey,
	pub kind: E,
}

/// The typed graph itself.
#[derive(Debug, Serialize, Deserialize)]
pub struct TypedGraph<P = serde_json::Value, E = EdgeKind> {
	graph: StableGraph<Node<P>, E>,
	index: BTreeMap<NodeKey, NodeIndex>,
}

impl<P, E> Default for TypedGraph<P, E> {
	fn default() -> Self {
		Self {
			graph: StableGraph::default(),
			index: BTreeMap::default(),
		}
	}
}

impl TypedGraph {
	pub fn new() -> Self {
		Self::default()
	}
}

impl<P, E> TypedGraph<P, E> {

	/// Idempotent node insertion. If the key already exists the payload is
	/// replaced in-place and the existing index is returned.
	pub fn upsert_node(&mut self, node: Node<P>) -> NodeIndex {
		if let Some(&idx) = self.index.get(&node.key) {
			self.graph[idx] = node;
			idx
		} else {
			let key = node.key.clone();
			let idx = self.graph.add_node(node);
			self.index.insert(key, idx);
			idx
		}
	}

	/// Add a directed edge. Returns `None` if either endpoint is missing.
	pub fn add_edge(&mut self, from: &NodeKey, to: &NodeKey, kind: E) -> Option<()> {
		let from_idx = *self.index.get(from)?;
		let to_idx = *self.index.get(to)?;
		self.graph.add_edge(from_idx, to_idx, kind);
		Some(())
	}

	/// Idempotent edge insertion. No-op if the same `(from, to, kind)` triple
	/// already exists. Returns `None` if either endpoint is missing.
	pub fn upsert_edge(&mut self, from: &NodeKey, to: &NodeKey, kind: E) -> Option<()>
	where
		E: Eq,
	{
		let from_idx = *self.index.get(from)?;
		let to_idx = *self.index.get(to)?;
		if self
			.graph
			.edges_connecting(from_idx, to_idx)
			.any(|e| e.weight() == &kind)
		{
			return Some(());
		}
		self.graph.add_edge(from_idx, to_idx, kind);
		Some(())
	}

	/// Remove all outgoing edges from `key`. No-op if the node is absent.
	pub fn clear_outgoing(&mut self, key: &NodeKey) {
		let Some(&idx) = self.index.get(key) else { return };
		let to_remove: Vec<_> = self.graph.edges(idx).map(|e| e.id()).collect();
		for eid in to_remove {
			self.graph.remove_edge(eid);
		}
	}

	/// Lookup a node by its stable key.
	pub fn node(&self, key: &NodeKey) -> Option<&Node<P>> {
		let idx = self.index.get(key)?;
		self.graph.node_weight(*idx)
	}

	pub fn node_count(&self) -> usize {
		self.graph.node_count()
	}

	pub fn edge_count(&self) -> usize {
		self.graph.edge_count()
	}

	/// BFS up to `hops` levels traversing edges in both directions.
	/// Optional `kinds` filter (None = all edges).
	/// Returns visits in BFS order (shallow first), each with the hop count
	/// from the focus and the edge that was traversed.
	pub fn neighborhood(
		&self,
		focus: &NodeKey,
		hops: usize,
		kinds: Option<&[E]>,
	) -> Vec<Neighbor<E>>
	where
		E: Eq + Clone,
	{
		let Some(&start) = self.index.get(focus) else {
			return Vec::new();
		};

		let mut visited = HashSet::new();
		let mut result = Vec::new();
		let mut queue = VecDeque::new();

		visited.insert(start);
		result.push(Neighbor {
			key: focus.clone(),
			depth: 0,
			via: None,
		});
		queue.push_back((start, 0_usize));

		while let Some((current, depth)) = queue.pop_front() {
			if depth >= hops {
				continue;
			}
			let next_depth = depth + 1;

			// Outgoing neighbors
			for edge in self.graph.edges(current) {
				if let Some(filter) = kinds
					&& !filter.contains(edge.weight())
				{
					continue;
				}
				let target = edge.target();
				if visited.insert(target) {
					let via = Some(edge.weight().clone());
					result.push(Neighbor {
						key: self.graph[target].key.clone(),
						depth: next_depth,
						via: via.clone(),
					});
					queue.push_back((target, next_depth));
				}
			}

			// Incoming neighbors
			for edge in self.graph.edges_directed(current, Direction::Incoming) {
				if let Some(filter) = kinds
					&& !filter.contains(edge.weight())
				{
					continue;
				}
				let source = edge.source();
				if visited.insert(source) {
					let via = Some(edge.weight().clone());
					result.push(Neighbor {
						key: self.graph[source].key.clone(),
						depth: next_depth,
						via: via.clone(),
					});
					queue.push_back((source, next_depth));
				}
			}
		}

		result
	}

	/// Shortest path from `from` to `to` honouring optional kind filter.
	/// Traverses edges in both directions (undirected search).
	/// Returns the sequence of path steps. Empty if start == goal.
	pub fn path(
		&self,
		from: &NodeKey,
		to: &NodeKey,
		kinds: Option<&[E]>,
	) -> Option<Vec<PathStep<E>>>
	where
		E: Eq + Clone,
	{
		let start = *self.index.get(from)?;
		let goal = *self.index.get(to)?;

		if start == goal {
			return Some(Vec::new());
		}

		let mut visited = HashSet::new();
		let mut parent = BTreeMap::new();
		let mut queue = VecDeque::new();

		visited.insert(start);
		queue.push_back(start);

		while let Some(current) = queue.pop_front() {
			if current == goal {
				let mut steps = Vec::new();
				let mut cur = goal;
				while cur != start {
					let entry: &(NodeIndex, E) = parent.get(&cur)?;
					let prev = entry.0;
					let kind = entry.1.clone();
					steps.push(PathStep {
						from: self.graph.node_weight(prev).expect("valid parent").key.clone(),
						to: self.graph[cur].key.clone(),
						kind: kind.clone(),
					});
					cur = prev;
				}
				steps.reverse();
				return Some(steps);
			}

			// Outgoing
			for edge in self.graph.edges(current) {
				if let Some(filter) = kinds
					&& !filter.contains(edge.weight())
				{
					continue;
				}
				let target = edge.target();
				if visited.insert(target) {
					parent.insert(target, (current, edge.weight().clone()));
					queue.push_back(target);
				}
			}

			// Incoming
			for edge in self.graph.edges_directed(current, Direction::Incoming) {
				if let Some(filter) = kinds
					&& !filter.contains(edge.weight())
				{
					continue;
				}
				let source = edge.source();
				if visited.insert(source) {
					parent.insert(source, (current, edge.weight().clone()));
					queue.push_back(source);
				}
			}
		}

		None
	}

	/// All in-edges (callers, `ABOUTers`, DISTILLED_FROM-ers).
	pub fn in_edges(&self, key: &NodeKey) -> Vec<(NodeKey, E)>
	where
		E: Clone,
	{
		let Some(&idx) = self.index.get(key) else {
			return Vec::new();
		};
		self.graph
			.edges_directed(idx, Direction::Incoming)
			.map(|e| (self.graph[e.source()].key.clone(), e.weight().clone()))
			.collect()
	}

	/// All out-edges.
	pub fn out_edges(&self, key: &NodeKey) -> Vec<(NodeKey, E)>
	where
		E: Clone,
	{
		let Some(&idx) = self.index.get(key) else {
			return Vec::new();
		};
		self.graph
			.edges_directed(idx, Direction::Outgoing)
			.map(|e| (self.graph[e.target()].key.clone(), e.weight().clone()))
			.collect()
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use super::*;

	fn payload_str(s: &str) -> serde_json::Value {
		serde_json::Value::String(s.to_string())
	}

	fn make_node(key: &str, kind: &str, payload: &str) -> Node {
		Node {
			key: NodeKey::new(key),
			kind: kind.to_string(),
			payload: payload_str(payload),
		}
	}

	#[test]
	fn edge_kind_drawer_roundtrip() {
		let variants = [
			EdgeKind::Defines,
			EdgeKind::Imports,
			EdgeKind::Calls,
			EdgeKind::References,
			EdgeKind::Inherits,
			EdgeKind::Renders,
			EdgeKind::Styles,
			EdgeKind::Requires,
			EdgeKind::Refers,
			EdgeKind::Aliases,
			EdgeKind::Implements,
			EdgeKind::Dispatches,
			EdgeKind::Tests,
			EdgeKind::UsesKeyword,
			EdgeKind::TypeImports,
			EdgeKind::TypeParameterOf,
			EdgeKind::Involved,
			EdgeKind::About,
			EdgeKind::Produced,
			EdgeKind::DistilledFrom,
			EdgeKind::Mentions,
			EdgeKind::Supersedes,
			EdgeKind::DerivedFrom,
			EdgeKind::Blocks,
			EdgeKind::Action,
			EdgeKind::Contains,
		];
		for kind in &variants {
			let keyword = kind.drawer_keyword();
			assert_eq!(
				&EdgeKind::from_drawer_keyword(keyword),
				kind,
				"round-trip failed for {:?}",
				kind
			);
		}
		// Forward-compat: unknown tokens become Other
		assert_eq!(
			EdgeKind::from_drawer_keyword("FOOBAR"),
			EdgeKind::Other("FOOBAR".into())
		);
		assert_eq!(
			EdgeKind::from_drawer_keyword("imports"),
			EdgeKind::Imports
		);
	}

	#[test]
	fn upsert_node_idempotent() {
		let mut g = TypedGraph::new();
		let n1 = make_node("a", "test", "first");
		let idx1 = g.upsert_node(n1);
		assert_eq!(g.node_count(), 1);

		let n2 = make_node("a", "test", "second");
		let idx2 = g.upsert_node(n2);
		assert_eq!(g.node_count(), 1);
		assert_eq!(idx1, idx2);
		assert_eq!(g.node(&NodeKey::new("a")).unwrap().payload, payload_str("second"));
	}

	#[test]
	fn add_edge_missing_node_returns_none() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		assert!(g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports).is_none());
		assert!(g.add_edge(&NodeKey::new("b"), &NodeKey::new("a"), EdgeKind::Imports).is_none());
	}

	#[test]
	fn upsert_edge_idempotent() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		assert!(g.upsert_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports).is_some());
		assert_eq!(g.edge_count(), 1);
		assert!(g.upsert_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports).is_some());
		assert_eq!(g.edge_count(), 1);
	}

	#[test]
	fn upsert_edge_distinct_kinds_coexist() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		assert!(g.upsert_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports).is_some());
		assert!(g.upsert_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::References).is_some());
		assert_eq!(g.edge_count(), 2);
	}

	#[test]
	fn clear_outgoing_removes_all_outbound_only() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		g.upsert_node(make_node("c", "test", "z"));
		// a -> b, c -> a
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("c"), &NodeKey::new("a"), EdgeKind::Calls);
		assert_eq!(g.edge_count(), 2);

		g.clear_outgoing(&NodeKey::new("a"));
		assert_eq!(g.edge_count(), 1);
		// c -> a survives
		let inn = g.in_edges(&NodeKey::new("a"));
		assert_eq!(inn, vec![(NodeKey::new("c"), EdgeKind::Calls)]);
	}

	#[test]
	fn neighborhood_hop_0_returns_focus() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);

		let n = g.neighborhood(&NodeKey::new("a"), 0, None);
		assert_eq!(
			n,
			vec![Neighbor {
				key: NodeKey::new("a"),
				depth: 0,
				via: None,
			}]
		);
	}

	#[test]
	fn neighborhood_hop_1_returns_direct_neighbors() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		g.upsert_node(make_node("c", "test", "z"));
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("c"), &NodeKey::new("a"), EdgeKind::References);

		let n = g.neighborhood(&NodeKey::new("a"), 1, None);
		let keys: Vec<_> = n.iter().map(|nb| nb.key.clone()).collect();
		assert_eq!(keys, vec![NodeKey::new("a"), NodeKey::new("b"), NodeKey::new("c")]);
	}

	#[test]
	fn neighborhood_hop_2_returns_2_levels() {
		let mut g = TypedGraph::new();
		for k in ["a", "b", "c", "d"] {
			g.upsert_node(make_node(k, "test", k));
		}
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("b"), &NodeKey::new("c"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("c"), &NodeKey::new("d"), EdgeKind::Imports);

		let n = g.neighborhood(&NodeKey::new("a"), 2, None);
		let by_key: BTreeMap<_, _> = n.into_iter().map(|nb| (nb.key, nb.depth)).collect();
		assert_eq!(by_key[&NodeKey::new("a")], 0);
		assert_eq!(by_key[&NodeKey::new("b")], 1);
		assert_eq!(by_key[&NodeKey::new("c")], 2);
		assert!(!by_key.contains_key(&NodeKey::new("d")));
	}

	#[test]
	fn neighborhood_kinds_filter() {
		let mut g = TypedGraph::new();
		for k in ["a", "b", "c"] {
			g.upsert_node(make_node(k, "test", k));
		}
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("c"), EdgeKind::References);

		let n = g.neighborhood(&NodeKey::new("a"), 1, Some(&[EdgeKind::Imports]));
		let keys: Vec<_> = n.iter().map(|nb| nb.key.clone()).collect();
		assert_eq!(keys, vec![NodeKey::new("a"), NodeKey::new("b")]);
	}

	#[test]
	fn neighborhood_via_records_traversal_edge() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		g.upsert_node(make_node("c", "test", "z"));
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("b"), &NodeKey::new("c"), EdgeKind::Calls);

		let n = g.neighborhood(&NodeKey::new("a"), 2, None);
		let by_key: BTreeMap<_, _> = n.into_iter().map(|nb| (nb.key.clone(), nb)).collect();
		assert_eq!(by_key[&NodeKey::new("a")].depth, 0);
		assert_eq!(by_key[&NodeKey::new("a")].via, None);
		assert_eq!(by_key[&NodeKey::new("b")].depth, 1);
		assert_eq!(by_key[&NodeKey::new("b")].via, Some(EdgeKind::Imports));
		assert_eq!(by_key[&NodeKey::new("c")].depth, 2);
		assert_eq!(by_key[&NodeKey::new("c")].via, Some(EdgeKind::Calls));
	}

	#[test]
	fn path_finds_shortest() {
		let mut g = TypedGraph::new();
		for k in ["a", "b", "c"] {
			g.upsert_node(make_node(k, "test", k));
		}
		// Long path a -> b -> c
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("b"), &NodeKey::new("c"), EdgeKind::Imports);
		// Short direct edge a -> c (different kind)
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("c"), EdgeKind::References);

		// No filter -> direct edge wins
		let p = g.path(&NodeKey::new("a"), &NodeKey::new("c"), None);
		assert_eq!(
			p,
			Some(vec![PathStep {
				from: NodeKey::new("a"),
				to: NodeKey::new("c"),
				kind: EdgeKind::References,
			}])
		);

		// Filter out References -> longer path via b
		let p = g.path(&NodeKey::new("a"), &NodeKey::new("c"), Some(&[EdgeKind::Imports]));
		assert_eq!(
			p,
			Some(vec![
				PathStep {
					from: NodeKey::new("a"),
					to: NodeKey::new("b"),
					kind: EdgeKind::Imports,
				},
				PathStep {
					from: NodeKey::new("b"),
					to: NodeKey::new("c"),
					kind: EdgeKind::Imports,
				},
			])
		);
	}

	#[test]
	fn path_no_route_returns_none() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		let p = g.path(&NodeKey::new("a"), &NodeKey::new("b"), None);
		assert_eq!(p, None);
	}

	#[test]
	fn path_returns_typed_steps() {
		let mut g = TypedGraph::new();
		g.upsert_node(make_node("a", "test", "x"));
		g.upsert_node(make_node("b", "test", "y"));
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);

		let p = g.path(&NodeKey::new("a"), &NodeKey::new("b"), None);
		assert_eq!(
			p,
			Some(vec![PathStep {
				from: NodeKey::new("a"),
				to: NodeKey::new("b"),
				kind: EdgeKind::Imports,
			}])
		);
	}

	#[test]
	fn in_out_edges_correct() {
		let mut g = TypedGraph::new();
		for k in ["hub", "spoke1", "spoke2"] {
			g.upsert_node(make_node(k, "test", k));
		}
		g.add_edge(&NodeKey::new("hub"), &NodeKey::new("spoke1"), EdgeKind::Imports);
		g.add_edge(&NodeKey::new("hub"), &NodeKey::new("spoke2"), EdgeKind::References);
		g.add_edge(&NodeKey::new("spoke1"), &NodeKey::new("hub"), EdgeKind::Calls);

		let out = g.out_edges(&NodeKey::new("hub"));
		assert_eq!(out.len(), 2);
		assert!(out.contains(&(NodeKey::new("spoke1"), EdgeKind::Imports)));
		assert!(out.contains(&(NodeKey::new("spoke2"), EdgeKind::References)));

		let inn = g.in_edges(&NodeKey::new("hub"));
		assert_eq!(inn, vec![(NodeKey::new("spoke1"), EdgeKind::Calls)]);
	}

	#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
	struct MyStruct {
		name: String,
		n: u32,
	}

	#[test]
	fn bincode_round_trip() {
		let mut g = TypedGraph::<MyStruct, EdgeKind>::default();
		for i in 0..10 {
			g.upsert_node(Node {
				key: NodeKey::new(format!("n{i}")),
				kind: "item".to_string(),
				payload: MyStruct {
					name: format!("name{i}"),
					n: i as u32,
				},
			});
		}
		// Chain + some cross edges
		for i in 0..9 {
			g.add_edge(
				&NodeKey::new(format!("n{i}")),
				&NodeKey::new(format!("n{}", i + 1)),
				EdgeKind::Imports,
			);
		}
		g.add_edge(&NodeKey::new("n0"), &NodeKey::new("n5"), EdgeKind::References);
		g.add_edge(&NodeKey::new("n2"), &NodeKey::new("n7"), EdgeKind::Calls);

		let bytes = bincode::serialize(&g).expect("serialize");
		let g2: TypedGraph<MyStruct, EdgeKind> = bincode::deserialize(&bytes).expect("deserialize");

		assert_eq!(g2.node_count(), g.node_count());
		assert_eq!(g2.edge_count(), g.edge_count());

		// Spot-check a node payload
		let n3 = g2.node(&NodeKey::new("n3")).unwrap();
		assert_eq!(n3.payload.name, "name3");
		assert_eq!(n3.payload.n, 3);

		// Neighborhood must match
		assert_eq!(
			g.neighborhood(&NodeKey::new("n0"), 2, Some(&[EdgeKind::Imports])),
			g2.neighborhood(&NodeKey::new("n0"), 2, Some(&[EdgeKind::Imports]))
		);

		// Path must match
		assert_eq!(
			g.path(&NodeKey::new("n0"), &NodeKey::new("n9"), None),
			g2.path(&NodeKey::new("n0"), &NodeKey::new("n9"), None)
		);
	}

	#[test]
	fn generic_typed_payload_round_trip() {
		let mut g = TypedGraph::<MyStruct, EdgeKind>::default();
		g.upsert_node(Node {
			key: NodeKey::new("a"),
			kind: "test".to_string(),
			payload: MyStruct { name: "Alice".to_string(), n: 42 },
		});
		g.upsert_node(Node {
			key: NodeKey::new("b"),
			kind: "test".to_string(),
			payload: MyStruct { name: "Bob".to_string(), n: 7 },
		});
		g.add_edge(&NodeKey::new("a"), &NodeKey::new("b"), EdgeKind::Imports);

		let bytes = bincode::serialize(&g).expect("serialize");
		let g2: TypedGraph<MyStruct, EdgeKind> = bincode::deserialize(&bytes).expect("deserialize");

		assert_eq!(g2.node_count(), 2);
		assert_eq!(g2.edge_count(), 1);

		let a = g2.node(&NodeKey::new("a")).unwrap();
		assert_eq!(a.payload.name, "Alice");
		assert_eq!(a.payload.n, 42);

		let b = g2.node(&NodeKey::new("b")).unwrap();
		assert_eq!(b.payload.name, "Bob");
		assert_eq!(b.payload.n, 7);
	}
}
