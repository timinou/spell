//! Native dependency graph engine — replaces elisp graph tools.
//!
//! - DAG construction from BLOCKERS property
//! - Cycle detection (iterative DFS)
//! - Wave computation (Kahn's algorithm for topological layers)
//! - Connected components (union-find)

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::edge::{EdgeKind, ItemId};
use crate::item::OrgItem;

/// A dependency edge: `from` is blocked by `to`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct DepEdge {
	pub from: String,
	pub to:   String,
}

/// A detected cycle in the dependency graph.
#[derive(Debug, Clone, Serialize)]
pub struct Cycle {
	pub nodes: Vec<String>,
}

/// Result of dependency graph analysis.
#[derive(Debug, Clone, Serialize)]
pub struct GraphResult {
	pub nodes:    Vec<GraphNode>,
	pub edges:    Vec<DepEdge>,
	pub cycles:   Vec<Cycle>,
	pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
	pub id:       String,
	pub title:    String,
	pub state:    String,
	pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Dag {
	pub nodes: Vec<DagNode>,
	pub edges: Vec<DepEdge>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DagNode {
	pub id:        String,
	pub title:     String,
	pub state:     String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub parent_id: Option<String>,
}

/// A computed wave (topological layer).
#[derive(Debug, Clone, Serialize)]
pub struct Wave {
	pub number: usize,
	pub items:  Vec<WaveItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WaveItem {
	pub custom_id: String,
	pub parent_id: String,
	pub title:     String,
}

/// Result of wave computation.
#[derive(Debug, Clone, Serialize)]
pub struct WaveResult {
	pub waves:              Vec<Wave>,
	pub warnings:           Vec<String>,
	pub total_sub_outlines: usize,
	pub subfeature_dag:     Dag,
	pub file_dag:           Dag,
}

/// Result of next-wave query.
#[derive(Debug, Clone, Serialize)]
pub struct NextWaveResult {
	pub wave:  usize,
	pub items: Vec<WaveItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DuplicateIdError {
	pub code:            String,
	pub message:         String,
	pub duplicate_ids:   Vec<String>,
	pub duplicate_count: usize,
}

const DUPLICATE_ID_PREVIEW_LIMIT: usize = 10;

type WaveGraphResult<T> = Result<T, DuplicateIdError>;

fn canonical_wave_items(items: &[OrgItem]) -> Vec<&OrgItem> {
	let heading_ids: HashSet<(&str, &str)> = items
		.iter()
		.filter(|item| item.level == 1)
		.map(|item| (item.file.as_str(), item.id.as_str()))
		.collect();
	items
		.iter()
		.filter(|item| {
			!(item.level == 0 && heading_ids.contains(&(item.file.as_str(), item.id.as_str())))
		})
		.collect()
}

fn duplicate_id_error(items: &[&OrgItem]) -> Option<DuplicateIdError> {
	let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
	for item in items {
		*counts.entry(item.id.as_str()).or_insert(0) += 1;
	}
	let duplicate_ids: Vec<String> = counts
		.into_iter()
		.filter(|(_, count)| *count > 1)
		.map(|(id, _)| id.to_string())
		.collect();
	if duplicate_ids.is_empty() {
		return None;
	}
	let shown = duplicate_ids
		.iter()
		.take(DUPLICATE_ID_PREVIEW_LIMIT)
		.cloned()
		.collect::<Vec<_>>();
	let remaining = duplicate_ids.len().saturating_sub(shown.len());
	let message = if remaining == 0 {
		format!("duplicate CUSTOM_ID values in wave input: {}", shown.join(", "))
	} else {
		format!(
			"duplicate CUSTOM_ID values in wave input: {} (+{} more)",
			shown.join(", "),
			remaining,
		)
	};
	Some(DuplicateIdError {
		code: "DUPLICATE_CUSTOM_ID".to_string(),
		message,
		duplicate_ids: shown,
		duplicate_count: duplicate_ids.len(),
	})
}

fn ensure_unique_wave_ids(items: &[OrgItem]) -> WaveGraphResult<Vec<&OrgItem>> {
	let canonical_items = canonical_wave_items(items);
	if let Some(error) = duplicate_id_error(&canonical_items) {
		return Err(error);
	}
	Ok(canonical_items)
}

/// Build a dependency graph from a set of items.
pub fn build_graph(items: &[OrgItem]) -> GraphResult {
	let id_set: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
	let mut edges = Vec::new();
	let mut warnings = Vec::new();
	let mut nodes = Vec::new();

	for item in items {
		let blockers = item.blockers();
		let valid_blockers: Vec<String> = blockers
			.iter()
			.filter(|b| {
				if id_set.contains(*b) {
					true
				} else {
					warnings.push(format!("{}: blocker '{}' not found in item set", item.id, b));
					false
				}
			})
			.map(|b| (*b).to_string())
			.collect();

		for blocker in &valid_blockers {
			edges.push(DepEdge { from: item.id.clone(), to: blocker.clone() });
		}

		nodes.push(GraphNode {
			id:       item.id.clone(),
			title:    item.title.clone(),
			state:    item.state.clone(),
			blockers: valid_blockers,
		});
	}

	let cycles = detect_cycles(items);

	GraphResult { nodes, edges, cycles, warnings }
}

/// Detect cycles using iterative DFS with coloring.
///
/// WHITE (unvisited) → GREY (in stack) → BLACK (finished).
/// A back-edge (to a GREY node) indicates a cycle.
fn detect_cycles(items: &[OrgItem]) -> Vec<Cycle> {
	#[derive(Clone, Copy, PartialEq)]
	enum Color {
		White,
		Grey,
		Black,
	}

	let id_set: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
	let blocker_map: HashMap<&str, Vec<&str>> = items
		.iter()
		.map(|i| {
			let blockers: Vec<&str> = i
				.blockers()
				.into_iter()
				.filter(|b| id_set.contains(b))
				.collect();
			(i.id.as_str(), blockers)
		})
		.collect();

	let mut color: HashMap<&str, Color> = items
		.iter()
		.map(|i| (i.id.as_str(), Color::White))
		.collect();
	let mut cycles = Vec::new();

	for item in items {
		if color[item.id.as_str()] != Color::White {
			continue;
		}

		// Iterative DFS
		let mut stack: Vec<(&str, usize)> = vec![(item.id.as_str(), 0)];
		let mut path: Vec<&str> = Vec::new();

		while let Some((node, idx)) = stack.last_mut() {
			if *idx == 0 {
				color.insert(node, Color::Grey);
				path.push(node);
			}

			let neighbors = blocker_map.get(node).cloned().unwrap_or_default();
			if *idx < neighbors.len() {
				let next = neighbors[*idx];
				*idx += 1;
				match color[next] {
					Color::White => {
						stack.push((next, 0));
					},
					Color::Grey => {
						// Found a cycle — extract it from path
						if let Some(cycle_start) = path.iter().position(|n| *n == next) {
							let cycle_nodes: Vec<String> = path[cycle_start..]
								.iter()
								.map(|n| (*n).to_string())
								.collect();
							cycles.push(Cycle { nodes: cycle_nodes });
						}
					},
					Color::Black => {},
				}
			} else {
				color.insert(node, Color::Black);
				path.pop();
				stack.pop();
			}
		}
	}

	cycles
}

/// Compute wave layers using Kahn's algorithm (topological sort by layers).
///
/// Items with no dependencies (or all deps satisfied) are wave 0.
/// Items depending only on wave-0 items are wave 1, etc.
///
/// `items`: the items to wave-sort.
/// `parent_id_fn`: maps item ID to `parent_id` for sub-outline grouping.
pub fn compute_waves(
	items: &[OrgItem],
	parent_id_fn: impl Fn(&str) -> String,
) -> WaveGraphResult<WaveResult> {
	let items = ensure_unique_wave_ids(items)?;
	Ok(compute_waves_from_items(&items, parent_id_fn))
}

fn compute_waves_from_items(
	items: &[&OrgItem],
	parent_id_fn: impl Fn(&str) -> String,
) -> WaveResult {
	let id_set: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
	let mut warnings = Vec::new();

	// Build adjacency: item → items it blocks (reverse of BLOCKERS), and retain
	// explicit DAG edges.
	let mut in_degree: HashMap<&str, usize> = HashMap::new();
	let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
	let mut subfeature_edges = Vec::new();

	for item in items {
		in_degree.entry(item.id.as_str()).or_insert(0);
		for blocker in item.blockers() {
			if id_set.contains(blocker) {
				*in_degree.entry(item.id.as_str()).or_insert(0) += 1;
				dependents
					.entry(blocker)
					.or_default()
					.push(item.id.as_str());
				subfeature_edges.push(DepEdge { from: item.id.clone(), to: blocker.to_string() });
			} else if item.properties.contains_key("DEPENDS") {
				warnings.push(format!("{}: blocker '{}' not found in item set", item.id, blocker));
			}
		}
	}

	let mut parent_ids: HashMap<&str, String> = HashMap::new();
	for item in items {
		parent_ids.insert(item.id.as_str(), parent_id_fn(&item.id));
	}

	let subfeature_dag = Dag {
		nodes: items
			.iter()
			.map(|item| DagNode {
				id:        item.id.clone(),
				title:     item.title.clone(),
				state:     item.state.clone(),
				parent_id: parent_ids
					.get(item.id.as_str())
					.cloned()
					.filter(|parent_id| !parent_id.is_empty()),
			})
			.collect(),
		edges: subfeature_edges.clone(),
	};

	let mut file_nodes_by_id: BTreeMap<String, DagNode> = BTreeMap::new();
	for item in items {
		let file_id = parent_ids
			.get(item.id.as_str())
			.filter(|parent_id| !parent_id.is_empty())
			.cloned()
			.unwrap_or_else(|| item.id.clone());
		file_nodes_by_id
			.entry(file_id.clone())
			.or_insert_with(|| DagNode {
				id:        file_id,
				title:     item.title.clone(),
				state:     item.state.clone(),
				parent_id: None,
			});
	}

	let mut file_edges_by_pair: BTreeMap<(String, String), DepEdge> = BTreeMap::new();
	for edge in &subfeature_edges {
		let from = parent_ids
			.get(edge.from.as_str())
			.filter(|parent_id| !parent_id.is_empty())
			.cloned()
			.unwrap_or_else(|| edge.from.clone());
		let to = parent_ids
			.get(edge.to.as_str())
			.filter(|parent_id| !parent_id.is_empty())
			.cloned()
			.unwrap_or_else(|| edge.to.clone());
		if from != to {
			file_edges_by_pair.insert((from.clone(), to.clone()), DepEdge { from, to });
		}
	}

	let file_dag = Dag {
		nodes: file_nodes_by_id.into_values().collect(),
		edges: file_edges_by_pair.into_values().collect(),
	};

	// Kahn's algorithm with wave numbering
	let mut wave_assignment: HashMap<&str, usize> = HashMap::new();
	let mut queue: VecDeque<&str> = VecDeque::new();

	// Wave 0: items with no dependencies
	for item in items {
		if in_degree[item.id.as_str()] == 0 {
			queue.push_back(item.id.as_str());
			wave_assignment.insert(item.id.as_str(), 0);
		}
	}

	while let Some(node) = queue.pop_front() {
		let wave = wave_assignment[node];
		if let Some(deps) = dependents.get(node) {
			for dep in deps {
				let deg = in_degree.get_mut(dep).unwrap();
				*deg -= 1;
				// Dependent's wave is max of all its blocker waves + 1
				let new_wave = wave + 1;
				let current = wave_assignment.entry(dep).or_insert(0);
				if new_wave > *current {
					*current = new_wave;
				}
				if *deg == 0 {
					queue.push_back(dep);
				}
			}
		}
	}

	// Check for items not assigned (part of a cycle)
	for item in items {
		if !wave_assignment.contains_key(item.id.as_str()) {
			warnings.push(format!("{}: part of a dependency cycle, excluded from waves", item.id));
		}
	}

	// Group into waves
	let max_wave = wave_assignment.values().copied().max().unwrap_or(0);
	let mut waves = Vec::new();
	for wave_num in 0..=max_wave {
		let wave_items: Vec<WaveItem> = items
			.iter()
			.filter(|i| wave_assignment.get(i.id.as_str()) == Some(&wave_num))
			.map(|i| WaveItem {
				custom_id: i.id.clone(),
				parent_id: parent_ids.get(i.id.as_str()).cloned().unwrap_or_default(),
				title:     i.title.clone(),
			})
			.collect();
		if !wave_items.is_empty() {
			waves.push(Wave { number: wave_num, items: wave_items });
		}
	}

	WaveResult { waves, warnings, total_sub_outlines: items.len(), subfeature_dag, file_dag }
}

/// Get the next wave of eligible items (not DONE, all blockers DONE).
pub fn next_wave(items: &[OrgItem], done_states: &[&str]) -> WaveGraphResult<NextWaveResult> {
	let items = ensure_unique_wave_ids(items)?;
	let done_ids: HashSet<&str> = items
		.iter()
		.filter(|i| done_states.contains(&i.state.as_str()))
		.map(|i| i.id.as_str())
		.collect();

	let id_set: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();

	// Find items that are not done and all their blockers are done
	let mut eligible = Vec::new();
	let mut wave_num = 0usize;

	// Items with no blockers (or all blockers done) and not done themselves
	for item in &items {
		if done_ids.contains(item.id.as_str()) {
			continue;
		}
		let blockers = item.blockers();
		let all_done = blockers
			.iter()
			.all(|b| !id_set.contains(b) || done_ids.contains(b));
		if all_done {
			eligible.push(WaveItem {
				custom_id: item.id.clone(),
				parent_id: String::new(),
				title:     item.title.clone(),
			});
		}
	}

	// Determine wave number based on completed waves
	// Simple heuristic: count how many "layers" of done items exist
	let waves_result = compute_waves_from_items(&items, |_| String::new());
	for wave in &waves_result.waves {
		if wave
			.items
			.iter()
			.all(|wi| done_ids.contains(wi.custom_id.as_str()))
		{
			wave_num = wave.number + 1;
		} else {
			break;
		}
	}

	Ok(NextWaveResult { wave: wave_num, items: eligible })
}

/// Union-Find for connected components.
struct UnionFind {
	parent: Vec<usize>,
	rank:   Vec<usize>,
}

impl UnionFind {
	fn new(n: usize) -> Self {
		Self { parent: (0..n).collect(), rank: vec![0; n] }
	}

	fn find(&mut self, mut x: usize) -> usize {
		while self.parent[x] != x {
			self.parent[x] = self.parent[self.parent[x]]; // path halving
			x = self.parent[x];
		}
		x
	}

	fn union(&mut self, a: usize, b: usize) {
		let ra = self.find(a);
		let rb = self.find(b);
		if ra == rb {
			return;
		}
		match self.rank[ra].cmp(&self.rank[rb]) {
			std::cmp::Ordering::Less => self.parent[ra] = rb,
			std::cmp::Ordering::Greater => self.parent[rb] = ra,
			std::cmp::Ordering::Equal => {
				self.parent[rb] = ra;
				self.rank[ra] += 1;
			},
		}
	}
}

/// Find connected components in the dependency graph.
pub fn connected_components(items: &[OrgItem]) -> Vec<Vec<String>> {
	if items.is_empty() {
		return Vec::new();
	}

	let id_to_idx: HashMap<&str, usize> = items
		.iter()
		.enumerate()
		.map(|(i, item)| (item.id.as_str(), i))
		.collect();
	let mut uf = UnionFind::new(items.len());

	for item in items {
		let idx = id_to_idx[item.id.as_str()];
		for blocker in item.blockers() {
			if let Some(&blocker_idx) = id_to_idx.get(blocker) {
				uf.union(idx, blocker_idx);
			}
		}
	}

	// Group by root
	let mut components: HashMap<usize, Vec<String>> = HashMap::new();
	for (i, item) in items.iter().enumerate() {
		let root = uf.find(i);
		components.entry(root).or_default().push(item.id.clone());
	}
	components.into_values().collect()
}



/// A typed edge between two items in the org graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct TypedEdge {
	pub from: ItemId,
	pub to: ItemId,
	pub kind: EdgeKind,
}

/// A node in the typed org graph.
#[derive(Debug, Clone, Serialize)]
pub struct TypedGraphNode {
	pub id: ItemId,
	pub kind: String,
	pub title: String,
	pub file: String,
	pub dangling: bool,
}

/// The full typed graph with bidirectional edge indexing.
#[derive(Debug, Clone, Serialize)]
pub struct TypedGraph {
	pub nodes: BTreeMap<ItemId, TypedGraphNode>,
	pub out_edges: HashMap<ItemId, Vec<TypedEdge>>,
	pub in_edges: HashMap<ItemId, Vec<TypedEdge>>,
}

/// A subgraph result from neighborhood queries.
#[derive(Debug, Clone, Serialize)]
pub struct Subgraph {
	pub nodes: Vec<TypedGraphNode>,
	pub edges: Vec<TypedEdge>,
}

/// A timeline entry for an entity.
#[derive(Debug, Clone, Serialize)]
pub struct TimelineEntry {
	pub item: TypedGraphNode,
	pub ts: Option<i64>,
}

/// A shortest path between two nodes.
#[derive(Debug, Clone, Serialize)]
pub struct GraphPath {
	pub edges: Vec<TypedEdge>,
}

/// Build a typed graph from a set of org items, including children.
/// Synthesizes legacy BLOCKERS/DEPENDS properties into Blocks edges.
pub fn build_typed_graph(items: &[OrgItem]) -> TypedGraph {
	let mut nodes = BTreeMap::new();
	let mut out_edges: HashMap<ItemId, Vec<TypedEdge>> = HashMap::new();
	let mut in_edges: HashMap<ItemId, Vec<TypedEdge>> = HashMap::new();

	fn collect_edges(item: &OrgItem, edges: &mut Vec<TypedEdge>) {
		for (kind, target) in &item.relations {
			if !target.is_empty() {
				edges.push(TypedEdge {
					from: item.id.clone(),
					to: target.clone(),
					kind: kind.clone(),
				});
			}
		}
		let blockers_prop = item.properties.get("BLOCKERS").or_else(|| item.properties.get("DEPENDS"));
		if let Some(value) = blockers_prop {
			for token in value.split(|c: char| c == ',' || c.is_whitespace()).map(str::trim).filter(|s| !s.is_empty()) {
				let already = item.relations.iter().any(|(k, t)| *k == EdgeKind::Blocks && t == token);
				if !already {
					edges.push(TypedEdge {
						from: item.id.clone(),
						to: token.to_string(),
						kind: EdgeKind::Blocks,
					});
				}
			}
		}
	}

	fn walk_items(items: &[OrgItem], nodes: &mut BTreeMap<ItemId, TypedGraphNode>, all_edges: &mut Vec<TypedEdge>) {
		for item in items {
			if item.id.is_empty() { continue; }
			nodes.entry(item.id.clone()).or_insert_with(|| TypedGraphNode {
				id: item.id.clone(),
				kind: String::new(),
				title: item.title.clone(),
				file: item.file.clone(),
				dangling: false,
			});
			collect_edges(item, all_edges);
			walk_items(&item.children, nodes, all_edges);
		}
	}

	let mut all_edges = Vec::new();
	walk_items(items, &mut nodes, &mut all_edges);

	for edge in &all_edges {
		out_edges.entry(edge.from.clone()).or_default().push(edge.clone());
		in_edges.entry(edge.to.clone()).or_default().push(edge.clone());
	}

	TypedGraph { nodes, out_edges, in_edges }
}

/// Compute the neighborhood of a node up to `hops` away, optionally filtered by kind.
pub fn neighborhood(graph: &TypedGraph, root: &str, hops: u8, kinds_filter: &[EdgeKind]) -> Subgraph {
	let mut visited: HashSet<ItemId> = HashSet::new();
	let mut found_edges: Vec<TypedEdge> = Vec::new();
	let mut queue: VecDeque<(ItemId, u8)> = VecDeque::new();

	visited.insert(root.to_string());
	queue.push_back((root.to_string(), 0));

	while let Some((current, depth)) = queue.pop_front() {
		if depth >= hops { continue; }

		if let Some(edges) = graph.out_edges.get(&current) {
			for edge in edges {
				if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) { continue; }
				if visited.insert(edge.to.clone()) {
					queue.push_back((edge.to.clone(), depth + 1));
				}
				found_edges.push(edge.clone());
			}
		}

		if let Some(edges) = graph.in_edges.get(&current) {
			for edge in edges {
				if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) { continue; }
				if visited.insert(edge.from.clone()) {
					queue.push_back((edge.from.clone(), depth + 1));
				}
				found_edges.push(edge.clone());
			}
		}
	}

	let mut seen_edges: HashSet<TypedEdge> = HashSet::new();
	let deduped_edges: Vec<TypedEdge> = found_edges.into_iter().filter(|e| seen_edges.insert(e.clone())).collect();

	let nodes: Vec<TypedGraphNode> = visited.iter().map(|id| {
		graph.nodes.get(id).cloned().unwrap_or_else(|| TypedGraphNode {
			id: id.clone(), kind: String::new(), title: String::new(), file: String::new(), dangling: true,
		})
	}).collect();

	Subgraph { nodes, edges: deduped_edges }
}

/// Timeline of items that `About` a target entity, sorted chronologically.
pub fn timeline(items: &[OrgItem], target: &str) -> Vec<TimelineEntry> {
	let mut entries: Vec<TimelineEntry> = items.iter().filter(|item| {
		item.relations.iter().any(|(kind, t)| *kind == EdgeKind::About && t == target)
	}).map(|item| {
		let ts = item.properties.get("AT").or_else(|| item.properties.get("CREATED")).and_then(|v| {
			parse_iso_datetime(v)
		});
		TimelineEntry {
			item: TypedGraphNode {
				id: item.id.clone(), kind: String::new(), title: item.title.clone(), file: item.file.clone(), dangling: false,
			},
			ts,
		}
	}).collect();

	entries.sort_by(|a, b| a.ts.cmp(&b.ts));
	entries
}

/// Parse an ISO-8601 datetime string to epoch milliseconds.
fn parse_iso_datetime(s: &str) -> Option<i64> {
	if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%dT%H:%M:%S") {
		return Some(dt.and_utc().timestamp_millis());
	}
	if let Ok(d) = chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d") {
		if let Some(dt) = d.and_hms_opt(0, 0, 0) {
			return Some(dt.and_utc().timestamp_millis());
		}
	}
	None
}

/// Find the shortest path between two nodes in the typed graph.
/// Uses bidirectional BFS with optional kind filter.
pub fn path(graph: &TypedGraph, a: &str, b: &str, kinds_filter: &[EdgeKind]) -> Option<GraphPath> {
	if a == b {
		return Some(GraphPath { edges: Vec::new() });
	}

	let mut forward_visited: HashMap<ItemId, Option<(ItemId, TypedEdge)>> = HashMap::new();
	let mut backward_visited: HashMap<ItemId, Option<(ItemId, TypedEdge)>> = HashMap::new();
	let mut forward_queue: VecDeque<ItemId> = VecDeque::new();
	let mut backward_queue: VecDeque<ItemId> = VecDeque::new();

	forward_visited.insert(a.to_string(), None);
	backward_visited.insert(b.to_string(), None);
	forward_queue.push_back(a.to_string());
	backward_queue.push_back(b.to_string());

	let mut meeting: Option<ItemId> = None;

	while meeting.is_none() && (!forward_queue.is_empty() || !backward_queue.is_empty()) {
		if let Some(current) = forward_queue.pop_front() {
			if let Some(edges) = graph.out_edges.get(&current) {
				for edge in edges {
					if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) { continue; }
					if !forward_visited.contains_key(&edge.to) {
						let prev = (current.clone(), edge.clone());
						forward_visited.insert(edge.to.clone(), Some(prev));
						if backward_visited.contains_key(&edge.to) { meeting = Some(edge.to.clone()); break; }
						forward_queue.push_back(edge.to.clone());
					}
				}
			}
			if let Some(edges) = graph.in_edges.get(&current) {
				for edge in edges {
					if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) { continue; }
					if !forward_visited.contains_key(&edge.from) {
						let rev = TypedEdge { from: edge.from.clone(), to: current.clone(), kind: edge.kind.clone() };
						forward_visited.insert(edge.from.clone(), Some((current.clone(), rev)));
						if backward_visited.contains_key(&edge.from) { meeting = Some(edge.from.clone()); break; }
						forward_queue.push_back(edge.from.clone());
					}
				}
			}
		}

		if meeting.is_some() { break; }

		if let Some(current) = backward_queue.pop_front() {
			if let Some(edges) = graph.in_edges.get(&current) {
				for edge in edges {
					if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) { continue; }
					if !backward_visited.contains_key(&edge.from) {
						let rev = TypedEdge { from: edge.from.clone(), to: current.clone(), kind: edge.kind.clone() };
						backward_visited.insert(edge.from.clone(), Some((current.clone(), rev)));
						if forward_visited.contains_key(&edge.from) { meeting = Some(edge.from.clone()); break; }
						backward_queue.push_back(edge.from.clone());
					}
				}
			}
			if let Some(edges) = graph.out_edges.get(&current) {
				for edge in edges {
					if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) { continue; }
					if !backward_visited.contains_key(&edge.to) {
						backward_visited.insert(edge.to.clone(), Some((current.clone(), edge.clone())));
						if forward_visited.contains_key(&edge.to) { meeting = Some(edge.to.clone()); break; }
						backward_queue.push_back(edge.to.clone());
					}
				}
			}
		}
	}

	let meeting = meeting?;

	let mut forward_edges: Vec<TypedEdge> = Vec::new();
	let mut current = meeting.clone();
	while let Some(Some((prev, edge))) = forward_visited.get(&current).cloned() {
		forward_edges.push(edge);
		current = prev;
	}
	forward_edges.reverse();

	let mut backward_edges: Vec<TypedEdge> = Vec::new();
	let mut current = meeting;
	while let Some(Some((prev, edge))) = backward_visited.get(&current).cloned() {
		backward_edges.push(edge);
		current = prev;
	}

	forward_edges.extend(backward_edges);
	Some(GraphPath { edges: forward_edges })
}
mod tests {
	use super::*;

	fn make_item(id: &str, blockers: &str) -> OrgItem {
		let mut properties = std::collections::HashMap::new();
		properties.insert("CUSTOM_ID".to_string(), id.to_string());
		if !blockers.is_empty() {
			properties.insert("BLOCKERS".to_string(), blockers.to_string());
		}
		OrgItem {
			id: id.to_string(),
			title: format!("Task {id}"),
			state: "ITEM".to_string(),
			category: "test".to_string(),
			dir: "tasks".to_string(),
			file: "/test.org".to_string(),
			line: 1,
			level: 1,
			properties,
			body: None,
			clocks: Vec::new(),
			byte_range: (0, 0),
			children: Vec::new(),
			relations: Vec::new(),
		}
	}

	fn make_item_with_properties(
		id: &str,
		properties: std::collections::HashMap<String, String>,
	) -> OrgItem {
		let mut properties = properties;
		properties
			.entry("CUSTOM_ID".to_string())
			.or_insert_with(|| id.to_string());
		OrgItem {
			id: id.to_string(),
			title: format!("Task {id}"),
			state: "ITEM".to_string(),
			category: "test".to_string(),
			dir: "tasks".to_string(),
			file: "/test.org".to_string(),
			line: 1,
			level: 2,
			properties,
			body: None,
			clocks: Vec::new(),
			byte_range: (0, 0),
			children: Vec::new(),
			relations: Vec::new(),
		}
	}

	#[test]
	fn build_graph_simple() {
		let items = vec![make_item("A", ""), make_item("B", "A"), make_item("C", "A, B")];
		let result = build_graph(&items);
		assert_eq!(result.nodes.len(), 3);
		assert_eq!(result.edges.len(), 3); // B->A, C->A, C->B
		assert!(result.cycles.is_empty());
	}

	#[test]
	fn detect_cycle() {
		let items = vec![make_item("A", "C"), make_item("B", "A"), make_item("C", "B")];
		let result = build_graph(&items);
		assert!(!result.cycles.is_empty());
	}

	#[test]
	fn compute_waves_depends_edges_respect_parent_tokens() {
		let items = vec![
			make_item("PARENT", ""),
			make_item("CHILD", "PARENT"),
			make_item("GRANDCHILD", "FEAT-001::slug PARENT"),
			make_item("ALONE", ""),
		];
		let result = compute_waves(&items, |id| match id {
			"PARENT" => String::new(),
			"CHILD" => "PARENT".to_string(),
			"GRANDCHILD" => "CHILD".to_string(),
			"ALONE" => String::new(),
			other => panic!("unexpected id: {other}"),
		})
		.expect("wave computation");
		assert_eq!(
			result.waves[0]
				.items
				.iter()
				.map(|w| w.custom_id.as_str())
				.collect::<Vec<_>>(),
			vec!["PARENT", "ALONE"]
		);
		assert_eq!(
			result.waves[1]
				.items
				.iter()
				.map(|w| w.custom_id.as_str())
				.collect::<Vec<_>>(),
			vec!["CHILD", "GRANDCHILD"]
		);
		assert!(result.warnings.is_empty());
	}

	#[test]
	fn compute_waves_with_sub_outline_nodes_across_files() {
		let items = vec![
			make_item_with_properties("FEAT-002-root", std::collections::HashMap::new()),
			make_item_with_properties(
				"FEAT-001::b",
				std::collections::HashMap::from([("DEPENDS".to_string(), "FEAT-002-root".to_string())]),
			),
			make_item_with_properties(
				"FEAT-001::a",
				std::collections::HashMap::from([("DEPENDS".to_string(), "FEAT-001::b".to_string())]),
			),
		];
		let result = compute_waves(&items, |id| id.split("::").next().unwrap_or(id).to_string())
			.expect("wave computation");
		assert_eq!(result.waves.len(), 3);
		assert_eq!(result.waves[0].items[0].custom_id, "FEAT-002-root");
		assert_eq!(result.waves[1].items[0].custom_id, "FEAT-001::b");
		assert_eq!(result.waves[1].items[0].parent_id, "FEAT-001");
		assert_eq!(result.waves[2].items[0].custom_id, "FEAT-001::a");
	}

	#[test]
	fn compute_waves_exposes_subfeature_dag_edges() {
		let items = vec![
			make_item_with_properties("FEAT-001::a", std::collections::HashMap::new()),
			make_item_with_properties("FEAT-001::b", std::collections::HashMap::new()),
			make_item_with_properties(
				"FEAT-002::c",
				std::collections::HashMap::from([(
					"DEPENDS".to_string(),
					"FEAT-001::a FEAT-001::b".to_string(),
				)]),
			),
		];
		let result = compute_waves(&items, |id| id.split("::").next().unwrap_or(id).to_string())
			.expect("wave computation");

		assert_eq!(
			result
				.subfeature_dag
				.nodes
				.iter()
				.map(|node| (node.id.as_str(), node.parent_id.as_deref()))
				.collect::<Vec<_>>(),
			vec![
				("FEAT-001::a", Some("FEAT-001")),
				("FEAT-001::b", Some("FEAT-001")),
				("FEAT-002::c", Some("FEAT-002")),
			]
		);
		assert_eq!(result.subfeature_dag.edges, vec![
			DepEdge { from: "FEAT-002::c".to_string(), to: "FEAT-001::a".to_string() },
			DepEdge { from: "FEAT-002::c".to_string(), to: "FEAT-001::b".to_string() },
		]);
	}

	#[test]
	fn compute_waves_file_dag_collapses_cross_parent_edges() {
		let items = vec![
			make_item_with_properties("FEAT-001::types", std::collections::HashMap::new()),
			make_item_with_properties(
				"FEAT-001::test",
				std::collections::HashMap::from([(
					"DEPENDS".to_string(),
					"FEAT-001::types".to_string(),
				)]),
			),
			make_item_with_properties(
				"FEAT-002::impl",
				std::collections::HashMap::from([(
					"DEPENDS".to_string(),
					"FEAT-001::types FEAT-001::test".to_string(),
				)]),
			),
		];
		let result = compute_waves(&items, |id| id.split("::").next().unwrap_or(id).to_string())
			.expect("wave computation");

		assert_eq!(
			result
				.file_dag
				.nodes
				.iter()
				.map(|node| node.id.as_str())
				.collect::<Vec<_>>(),
			vec!["FEAT-001", "FEAT-002"]
		);
		assert_eq!(result.file_dag.edges, vec![DepEdge {
			from: "FEAT-002".to_string(),
			to:   "FEAT-001".to_string(),
		}]);
	}

	#[test]
	fn compute_waves_unknown_dep_warns_and_excludes_dag_edge() {
		let items = vec![make_item_with_properties(
			"FEAT-001::impl",
			std::collections::HashMap::from([("DEPENDS".to_string(), "MISSING::types".to_string())]),
		)];
		let result = compute_waves(&items, |id| id.split("::").next().unwrap_or(id).to_string())
			.expect("wave computation");

		assert_eq!(result.subfeature_dag.edges, Vec::<DepEdge>::new());
		assert_eq!(result.file_dag.edges, Vec::<DepEdge>::new());
		assert_eq!(result.warnings, vec![
			"FEAT-001::impl: blocker 'MISSING::types' not found in item set"
		]);
	}

	#[test]
	fn compute_waves_cycle_keeps_dag_and_excludes_cyclic_waves() {
		let items = vec![make_item("A", "B"), make_item("B", "A")];
		let result = compute_waves(&items, |_| String::new()).expect("wave computation");

		assert!(result.waves.is_empty());
		assert_eq!(result.subfeature_dag.edges, vec![
			DepEdge { from: "A".to_string(), to: "B".to_string() },
			DepEdge { from: "B".to_string(), to: "A".to_string() },
		]);
		assert_eq!(result.warnings.len(), 2);
	}

	#[test]
	fn connected_components_separate() {
		let items =
			vec![make_item("A", ""), make_item("B", "A"), make_item("C", ""), make_item("D", "C")];
		let components = connected_components(&items);
		assert_eq!(components.len(), 2);
	}

	#[test]
	fn next_wave_basic() {
		let mut items = vec![make_item("A", ""), make_item("B", "A")];
		items[0].state = "DONE".to_string();
		let result = next_wave(&items, &["DONE"]).expect("next wave");
		assert_eq!(result.items.len(), 1);
		assert_eq!(result.items[0].custom_id, "B");
	}

	#[test]
	fn compute_waves_unique_ids_preserve_wave_numbers() {
		let items = vec![make_item("A", ""), make_item("B", "A"), make_item("C", "B")];
		let result = compute_waves(&items, |_| String::new()).expect("unique ids should succeed");
		assert_eq!(result.waves.len(), 3);
		assert_eq!(result.waves[0].number, 0);
		assert_eq!(result.waves[0].items[0].custom_id, "A");
		assert_eq!(result.waves[1].number, 1);
		assert_eq!(result.waves[1].items[0].custom_id, "B");
		assert_eq!(result.waves[2].number, 2);
		assert_eq!(result.waves[2].items[0].custom_id, "C");
	}

	#[test]
	fn compute_waves_duplicate_ids_return_duplicate_id_error() {
		let items = vec![
			make_item("TASK-002", ""),
			make_item("TASK-001", ""),
			make_item("TASK-001", "TASK-002"),
			make_item("TASK-003", "TASK-001"),
			make_item("TASK-003", ""),
		];
		let error = compute_waves(&items, |_| String::new()).expect_err("duplicate ids should fail");
		assert_eq!(error.code, "DUPLICATE_CUSTOM_ID");
		assert_eq!(error.duplicate_ids, vec!["TASK-001", "TASK-003"]);
		assert_eq!(error.duplicate_count, 2);
		assert_eq!(error.message, "duplicate CUSTOM_ID values in wave input: TASK-001, TASK-003");
	}

	#[test]
	fn next_wave_duplicate_ids_return_duplicate_id_error() {
		let mut items = vec![
			make_item("TASK-002", ""),
			make_item("TASK-001", "TASK-002"),
			make_item("TASK-001", ""),
		];
		items[0].state = "DONE".to_string();
		let error = next_wave(&items, &["DONE"]).expect_err("duplicate ids should fail");
		assert_eq!(error.code, "DUPLICATE_CUSTOM_ID");
		assert_eq!(error.duplicate_ids, vec!["TASK-001"]);
		assert_eq!(error.duplicate_count, 1);
		assert_eq!(error.message, "duplicate CUSTOM_ID values in wave input: TASK-001");
	}
}
