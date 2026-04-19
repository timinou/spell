//! Native dependency graph engine — replaces elisp graph tools.
//!
//! - DAG construction from BLOCKERS property
//! - Cycle detection (iterative DFS)
//! - Wave computation (Kahn's algorithm for topological layers)
//! - Connected components (union-find)

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::item::OrgItem;

/// A dependency edge: `from` is blocked by `to`.
#[derive(Debug, Clone, Serialize)]
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
}

/// Result of next-wave query.
#[derive(Debug, Clone, Serialize)]
pub struct NextWaveResult {
	pub wave:  usize,
	pub items: Vec<WaveItem>,
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
pub fn compute_waves(items: &[OrgItem], parent_id_fn: impl Fn(&str) -> String) -> WaveResult {
	let id_set: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
	let mut warnings = Vec::new();

	// Build adjacency: item → items it blocks (reverse of BLOCKERS)
	let mut in_degree: HashMap<&str, usize> = HashMap::new();
	let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

	for item in items {
		in_degree.entry(item.id.as_str()).or_insert(0);
		for blocker in item.blockers() {
			if id_set.contains(blocker) {
				*in_degree.entry(item.id.as_str()).or_insert(0) += 1;
				dependents
					.entry(blocker)
					.or_default()
					.push(item.id.as_str());
			}
		}
	}

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
				parent_id: parent_id_fn(&i.id),
				title:     i.title.clone(),
			})
			.collect();
		if !wave_items.is_empty() {
			waves.push(Wave { number: wave_num, items: wave_items });
		}
	}

	WaveResult { waves, warnings, total_sub_outlines: items.len() }
}

/// Get the next wave of eligible items (not DONE, all blockers DONE).
pub fn next_wave(items: &[OrgItem], done_states: &[&str]) -> NextWaveResult {
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
	for item in items {
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
	let waves_result = compute_waves(items, |_| String::new());
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

	NextWaveResult { wave: wave_num, items: eligible }
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

#[cfg(test)]
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
		});
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
		let result = compute_waves(&items, |id| id.split("::").next().unwrap_or(id).to_string());
		assert_eq!(result.waves.len(), 3);
		assert_eq!(result.waves[0].items[0].custom_id, "FEAT-002-root");
		assert_eq!(result.waves[1].items[0].custom_id, "FEAT-001::b");
		assert_eq!(result.waves[1].items[0].parent_id, "FEAT-001");
		assert_eq!(result.waves[2].items[0].custom_id, "FEAT-001::a");
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
		let result = next_wave(&items, &["DONE"]);
		assert_eq!(result.items.len(), 1);
		assert_eq!(result.items[0].custom_id, "B");
	}
}
