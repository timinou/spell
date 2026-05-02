//! Hybrid recall pipeline: BM25 + vector + graph + RRF fusion.
//!
//! Types land in FEAT-636::types; pipeline in FEAT-636::impl.

use std::collections::{HashMap, VecDeque};

use pi_org_engine::{
    edge::EdgeKind,
    graph::TypedGraph,
    item::OrgItem,
};
use serde::{Deserialize, Serialize};

use crate::{embedder::Embedder, fts::FtsIndex, vec::VecIndex, Result};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RecallQuery {
	#[serde(default)]
	pub text:             Option<String>,
	#[serde(default)]
	pub scope:            Vec<String>,
	#[serde(default)]
	pub focus:            Option<String>,
	#[serde(default)]
	pub graph_hops:       u8,
	#[serde(default)]
	pub graph_kinds:      Vec<EdgeKind>,
	#[serde(default = "default_limit")]
	pub limit:            usize,
	#[serde(default)]
	pub weights:          Option<FusionWeights>,
	#[serde(default)]
	pub profile:          Option<String>,
	#[serde(default)]
	pub include_personal: bool,
}

#[must_use]
pub const fn default_limit() -> usize {
	10
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FusionWeights {
	pub bm25:   f32,
	pub vector: f32,
	pub graph:  f32,
	/// RRF constant, typically 60.
	pub k:      f32,
}

impl Default for FusionWeights {
	fn default() -> Self {
		Self { bm25: 0.3, vector: 0.5, graph: 0.2, k: 60.0 }
	}
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallHit {
	pub id:              String,
	pub kind:            String,
	pub score:           f32,
	pub title:           String,
	pub excerpt:         Option<String>,
	pub path_from_focus: Option<Vec<String>>,
	pub why:             WhyHit,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WhyHit {
	pub bm25_rank:             Option<usize>,
	pub vector_rank:           Option<usize>,
	pub graph_seed:            bool,
	pub graph_hops_from_focus: Option<u8>,
}

pub struct RecallContext<'a> {
	pub items:    &'a [OrgItem],
	pub fts:      &'a FtsIndex,
	pub vec:      &'a VecIndex,
	pub embedder: &'a dyn Embedder,
	pub graph:    &'a TypedGraph,
}

#[derive(Debug, Clone)]
pub struct RecallProfile {
	pub scope:       Vec<String>,
	pub weights:     FusionWeights,
	pub graph_hops:  u8,
	pub graph_kinds: Vec<EdgeKind>,
	pub limit:       usize,
}

#[derive(Debug, Default, Clone)]
pub struct RecallProfileRegistry {
	profiles: HashMap<String, RecallProfile>,
}

impl RecallProfileRegistry {
	/// Seed with built-in profiles: `"session-start"` and `"priors"`.
	#[must_use]
	pub fn defaults() -> Self {
		let mut reg = Self { profiles: HashMap::new() };
		reg.register("session-start", RecallProfile {
			scope:       vec!["concept".into()],
			weights:     FusionWeights { bm25: 0.0, vector: 0.0, graph: 0.0, k: 60.0 },
			graph_hops:  0,
			graph_kinds: Vec::new(),
			limit:       12,
		});
		reg.register("priors", RecallProfile {
			scope:       vec!["concept".into(), "episode".into()],
			weights:     FusionWeights { bm25: 0.4, vector: 0.5, graph: 0.1, k: 60.0 },
			graph_hops:  1,
			graph_kinds: Vec::new(),
			limit:       12,
		});
		reg
	}

	pub fn register(&mut self, name: impl Into<String>, profile: RecallProfile) {
		self.profiles.insert(name.into(), profile);
	}

	#[must_use]
	pub fn get(&self, name: &str) -> Option<&RecallProfile> {
		self.profiles.get(name)
	}
}

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

/// Reciprocal Rank Fusion across multiple ranked lists.
///
/// Each entry in `rankings` is a `(lane_weight, Vec<id>)` where ids are ordered
/// by descending relevance (index 0 = best). The fusion score for each doc
/// across all lanes is `sum(lane_weight / (k + rank + 1.0))`.
#[must_use]
pub fn rrf(rankings: &[(f32, Vec<&str>)], k: f32) -> Vec<(String, f32)> {
	let mut scores: HashMap<&str, f32> = HashMap::new();

	for &(lane_weight, ref ranked_ids) in rankings {
		for (rank, id) in ranked_ids.iter().enumerate() {
			let contribution = lane_weight / (k + rank as f32 + 1.0);
			*scores.entry(id).or_insert(0.0) += contribution;
		}
	}

	let mut result: Vec<(String, f32)> = scores
		.into_iter()
		.map(|(id, score)| (id.to_string(), score))
		.collect();
	result.sort_by(|a, b| {
		b.1.partial_cmp(&a.1)
			.unwrap_or(std::cmp::Ordering::Equal)
			.then(a.0.cmp(&b.0))
	});
	result
}

// ---------------------------------------------------------------------------
// BFS hop tracking
// ---------------------------------------------------------------------------

/// BFS from `root` outward up to `max_hops` edges, returning `(id, depth)`
/// pairs sorted by depth (ascending) then id (ascending).
fn bfs_hops(
	graph: &TypedGraph,
	root: &str,
	max_hops: u8,
	kinds_filter: &[EdgeKind],
) -> Vec<(String, u8)> {
	let mut depths: HashMap<String, u8> = HashMap::new();
	let mut queue: VecDeque<String> = VecDeque::new();

	depths.insert(root.to_string(), 0);
	queue.push_back(root.to_string());

	while let Some(current) = queue.pop_front() {
		let depth = depths[&current];
		if depth >= max_hops {
			continue;
		}

		// Outgoing edges
		if let Some(edges) = graph.out_edges.get(&current) {
			for edge in edges {
				if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) {
					continue;
				}
				if !depths.contains_key(&edge.to) {
					depths.insert(edge.to.clone(), depth + 1);
					queue.push_back(edge.to.clone());
				}
			}
		}

		// Incoming edges
		if let Some(edges) = graph.in_edges.get(&current) {
			for edge in edges {
				if !kinds_filter.is_empty() && !kinds_filter.contains(&edge.kind) {
					continue;
				}
				if !depths.contains_key(&edge.from) {
					depths.insert(edge.from.clone(), depth + 1);
					queue.push_back(edge.from.clone());
				}
			}
		}
	}

	let mut result: Vec<(String, u8)> = depths.into_iter().collect();
	result.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
	result
}

// ---------------------------------------------------------------------------
// Excerpt extraction
// ---------------------------------------------------------------------------

/// Extract a relevant excerpt from item body given a search query.
///
/// Finds the first occurrence of the query (case-insensitive) in the body and
/// returns a window of text around it. Falls back to first 200 characters.
pub fn extract_excerpt(body: &str, query: &str) -> String {
	let query = query.trim();
	if query.is_empty() {
		return body.chars().take(200).collect();
	}

	let lower_body = body.to_lowercase();
	let lower_query = query.to_lowercase();

	if let Some(pos) = lower_body.find(&lower_query) {
		let ctx_before = 50;
		let ctx_after = 150;
		let start = pos.saturating_sub(ctx_before);
		let body_len = body.len();
		let end = (pos + lower_query.len() + ctx_after).min(body_len);
		let excerpt: String = body[start..end].to_string();
		if start > 0 {
			format!("...{excerpt}")
		} else {
			excerpt
		}
	} else {
		body.chars().take(200).collect()
	}
}

// ---------------------------------------------------------------------------
/// Run the hybrid recall pipeline, fusing BM25 + vector + graph via RRF.
pub fn recall(query: RecallQuery, ctx: &RecallContext) -> Result<Vec<RecallHit>> {
	// 1. Resolve effective profile
	let weights = query.weights.clone().unwrap_or_default();
	let effective_limit = query.limit.max(1);

	// 2. Build item lookup maps
	let id_to_kind: HashMap<&str, &str> = ctx
		.items
		.iter()
		.map(|item| {
			(
				item.id.as_str(),
				item
					.properties
					.get("KIND")
					.map(String::as_str)
					.unwrap_or(""),
			)
		})
		.collect();
	let kind_in_scope =
		|kind: &str| -> bool { query.scope.is_empty() || query.scope.iter().any(|s| s == kind) };

	let item_by_id = |id: &str| -> Option<&OrgItem> { ctx.items.iter().find(|item| item.id == id) };

	// 3. Compute lanes (over-fetch 3x for fusion context)
	let over_fetch = effective_limit * 3;

	// --- BM25 lane ---
	let bm25_ranked: Vec<String> = if let Some(ref text) = query.text {
		if weights.bm25 > 0.0 {
			ctx.fts
				.search(text, &query.scope, over_fetch)
				.unwrap_or_default()
				.into_iter()
				.map(|(id, _score)| id)
				.collect()
		} else {
			Vec::new()
		}
	} else {
		Vec::new()
	};

	// --- Vector lane ---
	let vector_ranked: Vec<String> = if let Some(ref text) = query.text {
		if weights.vector > 0.0 {
			let query_vec = ctx
				.embedder
				.embed_query(text)
				.unwrap_or_else(|_| vec![0.0; ctx.embedder.dim()]);
			ctx.vec
				.search(&query_vec, over_fetch)
				.unwrap_or_default()
				.into_iter()
				.map(|(id, _score)| id)
				.filter(|id| {
					let kind = id_to_kind.get(id.as_str()).copied().unwrap_or("");
					kind_in_scope(kind)
				})
				.collect()
		} else {
			Vec::new()
		}
	} else {
		Vec::new()
	};

	// --- Graph lane ---
	let graph_ranked: Vec<(String, u8)> = if let Some(ref focus) = query.focus {
		if weights.graph > 0.0 {
			let hops = query.graph_hops;
			let hop_info = bfs_hops(ctx.graph, focus, hops, &query.graph_kinds);
			let mut results: Vec<(String, u8)> = Vec::new();
			for (id, depth) in &hop_info {
				let kind = id_to_kind.get(id.as_str()).copied().unwrap_or("");
				if kind_in_scope(kind) || id == focus {
					results.push((id.clone(), *depth));
				}
			}
			results.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
			results.dedup_by(|a, b| a.0 == b.0);
			results
		} else {
			Vec::new()
		}
	} else {
		Vec::new()
	};

	// 4. RRF fusion
	let mut rankings: Vec<(f32, Vec<&str>)> = Vec::new();
	if !bm25_ranked.is_empty() {
		let ids: Vec<&str> = bm25_ranked.iter().map(String::as_str).collect();
		rankings.push((weights.bm25, ids));
	}
	if !vector_ranked.is_empty() {
		let ids: Vec<&str> = vector_ranked.iter().map(String::as_str).collect();
		rankings.push((weights.vector, ids));
	}
	if !graph_ranked.is_empty() {
		let ids: Vec<&str> = graph_ranked.iter().map(|(id, _)| id.as_str()).collect();
		rankings.push((weights.graph, ids));
	}

	let fused = if rankings.is_empty() {
		Vec::new()
	} else {
		rrf(&rankings, weights.k)
	};

	// 5. Truncate to effective_limit
	let fused: Vec<(String, f32)> = fused.into_iter().take(effective_limit).collect();

	// 6. Build RecallHits
	let bm25_pos: HashMap<&str, usize> = bm25_ranked
		.iter()
		.enumerate()
		.map(|(i, id)| (id.as_str(), i))
		.collect();
	let vector_pos: HashMap<&str, usize> = vector_ranked
		.iter()
		.enumerate()
		.map(|(i, id)| (id.as_str(), i))
		.collect();
	let graph_depths: HashMap<&str, u8> = graph_ranked
		.iter()
		.map(|(id, depth)| (id.as_str(), *depth))
		.collect();

	let results: Vec<RecallHit> = fused
		.into_iter()
		.map(|(id, score)| {
			let item = item_by_id(&id);
			let kind = item
				.and_then(|i| i.properties.get("KIND"))
				.cloned()
				.unwrap_or_default();
			let title = item.map(|i| i.title.clone()).unwrap_or_default();

			let excerpt = query.text.as_ref().and_then(|text| {
				item.and_then(|i| {
					i.body.as_ref().map(|body| {
						if text.trim().is_empty() {
							body.chars().take(200).collect()
						} else {
							extract_excerpt(body, text)
						}
					})
				})
			});

			let why = WhyHit {
				bm25_rank:             bm25_pos.get(id.as_str()).copied(),
				vector_rank:           vector_pos.get(id.as_str()).copied(),
				graph_seed:            query.focus.as_ref().is_some_and(|f| f == &id),
				graph_hops_from_focus: graph_depths.get(id.as_str()).copied(),
			};

			RecallHit { id, kind, score, title, excerpt, path_from_focus: None, why }
		})
		.collect();

	Ok(results)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rrf_empty_input_returns_empty() {
		let result = rrf(&[], 60.0);
		assert!(result.is_empty());
	}

	#[test]
	fn rrf_single_lane_preserves_order() {
		let rankings = [(1.0, vec!["C", "A", "B"])];
		let result = rrf(&rankings, 60.0);
		// With k=60 the scores differ (desc), tie-break by id for equal-score items
		// 1.0/(60+0+1) = 1/61 ≈ 0.0164 for C
		// 1.0/(60+1+1) = 1/62 ≈ 0.0161 for A
		// 1.0/(60+2+1) = 1/63 ≈ 0.0159 for B
		assert_eq!(result.len(), 3);
		assert_eq!(result[0].0, "C");
		assert_eq!(result[1].0, "A");
		assert_eq!(result[2].0, "B");
	}

	#[test]
	fn rrf_fuses_two_lanes_with_tie_break() {
		// Lane 1: [X, Y, Z]  Lane 2: [Z, Y, X]
		// X: 1.0/(60+0+1) + 0.5/(60+2+1) = 1/61 + 0.5/63 ≈ 0.0164 + 0.0079 = 0.0243
		// Y: 1.0/(60+1+1) + 0.5/(60+1+1) = 1/62 + 0.5/62 = 1.5/62 ≈ 0.0242
		// Z: 1.0/(60+2+1) + 0.5/(60+0+1) = 1/63 + 0.5/61 ≈ 0.0159 + 0.0082 = 0.0241
		// Order: X > Y > Z
		let rankings = [(1.0, vec!["X", "Y", "Z"]), (0.5, vec!["Z", "Y", "X"])];
		let result = rrf(&rankings, 60.0);
		assert_eq!(result.len(), 3);
		assert_eq!(result[0].0, "X");
		assert_eq!(result[1].0, "Y");
		assert_eq!(result[2].0, "Z");
	}

	#[test]
	fn rrf_k_constant_overridable() {
		// With k=0, rank contributes more: X = 0.3/1 + 0.5/3 = 0.467, Y = 0.3/2 + 0.5/2
		// = 0.4, Z = 0.3/3 + 0.5/1 = 0.6 Order: Z > X > Y
		let rankings = [(0.3, vec!["X", "Y", "Z"]), (0.5, vec!["Z", "Y", "X"])];
		let result = rrf(&rankings, 0.0);
		assert_eq!(result.len(), 3);
		assert_eq!(result[0].0, "Z");
	}
}
