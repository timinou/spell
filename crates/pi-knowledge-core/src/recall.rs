//! Hybrid recall pipeline: BM25 + vector + graph + RRF fusion.
//!
//! Wave-5 absorption of the former `pi-org-recall::recall` module. Backends
//! point at `crate::bm25::SearchIndex`, `crate::vec::VectorIndex`, and a
//! caller-supplied [`RecallGraph`] (an org-engine `TypedGraph` impls it).
//!
//! ## Document boundary
//!
//! pi-knowledge-core does not know about `OrgItem`. The caller projects its
//! domain shape into [`RecallDoc`] (`id` + `kind` + `title` + optional
//! `body`) — the same shape consumed by [`crate::bm25::SearchIndex`] via the
//! [`Document`] impl below.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::{
	Result,
	bm25::{Document, SearchIndex},
	graph::EdgeKind,
	vec::{VectorIndex, id_hash},
};

// ---------------------------------------------------------------------------
// Document boundary
// ---------------------------------------------------------------------------

/// Caller-built record indexed by the recall pipeline.
///
/// Mirrors the subset of fields recall needs from a domain item (org item,
/// code symbol, future document kinds). The caller does the projection at
/// index-build time.
#[derive(Debug, Clone)]
pub struct RecallDoc {
	pub id:    String,
	pub kind:  String,
	pub title: String,
	pub body:  Option<String>,
}

impl Document for RecallDoc {
	fn id(&self) -> String {
		self.id.clone()
	}
	fn label(&self) -> &str {
		&self.title
	}
	fn body(&self) -> Option<&str> {
		self.body.as_deref()
	}
}

// ---------------------------------------------------------------------------
// Embedder trait
// ---------------------------------------------------------------------------

/// Embedding lane abstraction. Production impls bridge to
/// `pi-embedding-worker`; tests use deterministic mocks.
pub trait Embedder: Send + Sync {
	fn embed_query(&self, text: &str) -> Result<Vec<f32>>;
	fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>;
	fn dim(&self) -> usize;
}

// ---------------------------------------------------------------------------
// Graph abstraction
// ---------------------------------------------------------------------------

/// Minimal graph view the recall pipeline needs.
///
/// Returns edges out of and into a node, irrespective of direction (recall
/// treats relations as undirected for BFS purposes). Each pair is
/// `(neighbor_id, edge_kind)`.
///
/// Impl'd by `pi_org_engine::graph::TypedGraph` (over [`EdgeKind`]); other
/// graph layers can opt in cheaply.
pub trait RecallGraph {
	/// Return every neighbor of `id` along with the kind of edge that joins
	/// them, combining outgoing and incoming edges into a single sequence.
	fn neighbors(&self, id: &str) -> Vec<(String, EdgeKind)>;
}

// ---------------------------------------------------------------------------
// Query / Hit / FusionWeights
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

/// Per-lane fusion weights plus the RRF `k` constant.
///
/// Carried over verbatim from the legacy `pi_org_recall::FusionWeights` so
/// the NAPI / serde surface stays bit-identical for TS callers. The richer
/// `crate::fusion::FusionWeights` is preserved for code-graph hybrid retrieval
/// and remains unrelated.
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

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/// Borrowed slice of every artifact the recall pipeline needs for a single
/// query. Caller builds the bm25 / vec indices and the graph; the pipeline
/// is read-only.
pub struct RecallContext<'a> {
	pub docs:     &'a [RecallDoc],
	pub bm25:     &'a SearchIndex,
	pub vec:      &'a VectorIndex,
	pub embedder: &'a dyn Embedder,
	pub graph:    &'a dyn RecallGraph,
}

// ---------------------------------------------------------------------------
// Recall profiles
// ---------------------------------------------------------------------------

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
/// across all lanes is `sum(lane_weight / (k + rank + 1.0))`. Ties break by
/// ascending id for deterministic output.
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

/// BFS from `root` outward up to `max_hops` edges through a [`RecallGraph`],
/// returning `(id, depth)` pairs sorted by depth (ascending) then id
/// (ascending). `kinds_filter` empty means "any edge kind".
fn bfs_hops(
	graph: &dyn RecallGraph,
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
		for (neighbor, kind) in graph.neighbors(&current) {
			if !kinds_filter.is_empty() && !kinds_filter.contains(&kind) {
				continue;
			}
			if !depths.contains_key(&neighbor) {
				depths.insert(neighbor.clone(), depth + 1);
				queue.push_back(neighbor);
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
#[must_use]
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
// Recall entry point
// ---------------------------------------------------------------------------

/// Run the hybrid recall pipeline, fusing BM25 + vector + graph via RRF.
pub fn recall(query: RecallQuery, ctx: &RecallContext) -> Result<Vec<RecallHit>> {
	let weights = query.weights.clone().unwrap_or_default();
	let effective_limit = query.limit.max(1);

	// Lookup maps.
	let id_to_kind: HashMap<&str, &str> = ctx
		.docs
		.iter()
		.map(|doc| (doc.id.as_str(), doc.kind.as_str()))
		.collect();
	let kind_in_scope =
		|kind: &str| -> bool { query.scope.is_empty() || query.scope.iter().any(|s| s == kind) };
	let doc_by_id = |id: &str| -> Option<&RecallDoc> { ctx.docs.iter().find(|d| d.id == id) };

	// Reverse map for vector hits (u64 -> &str).
	let key_to_id: HashMap<u64, &str> = ctx
		.docs
		.iter()
		.map(|d| (id_hash(d.id.as_str()), d.id.as_str()))
		.collect();

	let over_fetch = effective_limit * 3;

	// --- BM25 lane ---
	let bm25_ranked: Vec<String> = if let Some(ref text) = query.text {
		if weights.bm25 > 0.0 {
			ctx.bm25
				.search(text, over_fetch)
				.into_iter()
				.filter(|hit| {
					let kind = id_to_kind.get(hit.doc_id.as_str()).copied().unwrap_or("");
					kind_in_scope(kind)
				})
				.map(|hit| hit.doc_id)
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
				.filter_map(|hit| key_to_id.get(&hit.node_id).copied().map(str::to_string))
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
			let hop_info = bfs_hops(ctx.graph, focus, query.graph_hops, &query.graph_kinds);
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

	// RRF fusion.
	let mut rankings: Vec<(f32, Vec<&str>)> = Vec::new();
	if !bm25_ranked.is_empty() {
		rankings.push((weights.bm25, bm25_ranked.iter().map(String::as_str).collect()));
	}
	if !vector_ranked.is_empty() {
		rankings.push((weights.vector, vector_ranked.iter().map(String::as_str).collect()));
	}
	if !graph_ranked.is_empty() {
		rankings.push((
			weights.graph,
			graph_ranked.iter().map(|(id, _)| id.as_str()).collect(),
		));
	}
	let fused = if rankings.is_empty() {
		Vec::new()
	} else {
		rrf(&rankings, weights.k)
	};
// Build RecallHits.
	let fused = fused.into_iter().take(effective_limit);
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
			let doc = doc_by_id(&id);
			let kind = doc.map(|d| d.kind.clone()).unwrap_or_default();
			let title = doc.map(|d| d.title.clone()).unwrap_or_default();

			let excerpt = query.text.as_ref().and_then(|text| {
				doc.and_then(|d| {
					d.body.as_ref().map(|body| {
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

// ---------------------------------------------------------------------------
// Dual-context recall (cwd + personal store)
// ---------------------------------------------------------------------------

/// Bundles two recall contexts for dual-root recall (cwd + personal store).
pub struct DualContext<'a> {
	pub cwd:      RecallContext<'a>,
	pub personal: Option<RecallContext<'a>>,
}

/// Run [`recall`] against both contexts, dedupe by id (cwd wins on collision),
/// truncate to `query.limit`. Returns only cwd results when
/// `query.include_personal == false` or `ctx.personal.is_none()`.
pub fn recall_dual(query: RecallQuery, ctx: &DualContext) -> Result<Vec<RecallHit>> {
	if !query.include_personal || ctx.personal.is_none() {
		return recall(query, &ctx.cwd);
	}
	let limit = query.limit;
	let cwd_hits = recall(query.clone(), &ctx.cwd)?;
	let personal_hits = recall(query, ctx.personal.as_ref().unwrap())?;

	let mut by_id: BTreeMap<String, RecallHit> = BTreeMap::new();
	for h in cwd_hits {
		by_id.insert(h.id.clone(), h);
	}
	for h in personal_hits {
		by_id.entry(h.id.clone()).or_insert(h);
	}
	let mut fused: Vec<RecallHit> = by_id.into_values().collect();
	fused.sort_by(|a, b| {
		b.score
			.partial_cmp(&a.score)
			.unwrap_or(std::cmp::Ordering::Equal)
			.then_with(|| a.id.cmp(&b.id))
	});
	fused.truncate(limit);
	Ok(fused)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use crate::vec::VectorEntry;

	use super::*;

	// Deterministic mock embedder: FNV-derived f32 components, L2-normalised.
	struct MockEmbedder {
		dim: usize,
	}

	impl Embedder for MockEmbedder {
		fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
			Ok(deterministic_vec(text, self.dim))
		}

		fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
			Ok(texts
				.iter()
				.map(|t| deterministic_vec(t, self.dim))
				.collect())
		}

		fn dim(&self) -> usize {
			self.dim
		}
	}

	fn deterministic_vec(text: &str, dim: usize) -> Vec<f32> {
		let mut v = vec![0.0_f32; dim];
		for (i, slot) in v.iter_mut().enumerate() {
			let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ (i as u64);
			for b in text.bytes() {
				h ^= u64::from(b);
				h = h.wrapping_mul(0x0000_0001_0000_01b3);
			}
			*slot = ((h % 1000) as f32 / 1000.0) - 0.5;
		}
		let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
		if norm > 1e-9 {
			for x in &mut v {
				*x /= norm;
			}
		}
		v
	}

	// Trivial in-memory graph: HashMap<&str, Vec<(neighbor, EdgeKind)>>.
	#[derive(Default)]
	struct MapGraph(HashMap<String, Vec<(String, EdgeKind)>>);

	impl MapGraph {
		fn with_edges<I: IntoIterator<Item = (&'static str, &'static str, EdgeKind)>>(
			edges: I,
		) -> Self {
			let mut m: HashMap<String, Vec<(String, EdgeKind)>> = HashMap::new();
			for (a, b, k) in edges {
				m.entry(a.into())
					.or_default()
					.push((b.into(), k.clone()));
				// Mirror in: bfs treats edges as undirected.
				m.entry(b.into()).or_default().push((a.into(), k));
			}
			Self(m)
		}
	}

	impl RecallGraph for MapGraph {
		fn neighbors(&self, id: &str) -> Vec<(String, EdgeKind)> {
			self.0.get(id).cloned().unwrap_or_default()
		}
	}

	fn doc(id: &str, kind: &str, title: &str, body: Option<&str>) -> RecallDoc {
		RecallDoc {
			id:    id.into(),
			kind:  kind.into(),
			title: title.into(),
			body:  body.map(str::to_string),
		}
	}

	fn build_ctx<'a>(
		docs: &'a [RecallDoc],
		bm25: &'a SearchIndex,
		vec: &'a VectorIndex,
		embedder: &'a dyn Embedder,
		graph: &'a dyn RecallGraph,
	) -> RecallContext<'a> {
		RecallContext { docs, bm25, vec, embedder, graph }
	}

	#[test]
	fn rrf_empty_input_returns_empty() {
		assert!(rrf(&[], 60.0).is_empty());
	}

	#[test]
	fn rrf_single_lane_preserves_order() {
		let rankings = [(1.0, vec!["C", "A", "B"])];
		let result = rrf(&rankings, 60.0);
		assert_eq!(result.len(), 3);
		assert_eq!(result[0].0, "C");
		assert_eq!(result[1].0, "A");
		assert_eq!(result[2].0, "B");
	}

	#[test]
	fn rrf_fuses_two_lanes_with_tie_break() {
		let rankings = [(1.0, vec!["X", "Y", "Z"]), (0.5, vec!["Z", "Y", "X"])];
		let result = rrf(&rankings, 60.0);
		assert_eq!(result[0].0, "X");
		assert_eq!(result[1].0, "Y");
		assert_eq!(result[2].0, "Z");
	}

	#[test]
	fn bfs_hops_filters_by_kind() {
		let g = MapGraph::with_edges([
			("A", "B", EdgeKind::Mentions),
			("B", "C", EdgeKind::About),
		]);
		let hops = bfs_hops(&g, "A", 2, &[EdgeKind::Mentions]);
		let ids: Vec<&str> = hops.iter().map(|(id, _)| id.as_str()).collect();
		assert!(ids.contains(&"A"));
		assert!(ids.contains(&"B"));
		// C is reachable only via About; filtered out.
		assert!(!ids.contains(&"C"));
	}

	#[test]
	fn recall_empty_corpus_returns_empty() {
		let docs: Vec<RecallDoc> = Vec::new();
		let bm25 = SearchIndex::from_docs::<RecallDoc>(&docs);
		let vec = VectorIndex::new(8, 1).unwrap();
		let emb = MockEmbedder { dim: 8 };
		let graph = MapGraph::default();
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph);
		let q = RecallQuery { text: Some("anything".into()), limit: 5, ..Default::default() };
		let hits = recall(q, &ctx).unwrap();
		assert!(hits.is_empty());
	}

	#[test]
	fn recall_happy_path_returns_hits() {
		let docs = vec![
			doc("EP-1", "episode", "Auth refactor", Some("OAuth2 login flow")),
			doc("EP-2", "episode", "DB design", Some("Postgres schema")),
			doc("CN-1", "concept", "JWT", Some("JSON Web Token for auth")),
		];
		let bm25 = SearchIndex::from_docs(&docs);

		let dim = 8;
		let mut vec = VectorIndex::new(dim, docs.len()).unwrap();
		let emb = MockEmbedder { dim };
		for d in &docs {
			let v = deterministic_vec(&d.title, dim);
			vec.upsert(VectorEntry { node_id: id_hash(&d.id), vector: v }).unwrap();
		}
		let graph = MapGraph::default();
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph);
		let q = RecallQuery { text: Some("Auth".into()), limit: 5, ..Default::default() };
		let hits = recall(q, &ctx).unwrap();
		assert!(!hits.is_empty(), "expected hits, got {hits:?}");
		assert!(hits.iter().any(|h| h.id == "EP-1"));
	}

	#[test]
	fn recall_dual_falls_back_when_include_personal_false() {
		let docs = vec![doc("X-1", "episode", "Alpha", None)];
		let bm25 = SearchIndex::from_docs(&docs);
		let vec = VectorIndex::new(8, 1).unwrap();
		let emb = MockEmbedder { dim: 8 };
		let graph = MapGraph::default();
		let cwd = build_ctx(&docs, &bm25, &vec, &emb, &graph);

		let pdocs = vec![doc("P-1", "episode", "Personal", None)];
		let pbm25 = SearchIndex::from_docs(&pdocs);
		let pvec = VectorIndex::new(8, 1).unwrap();
		let pemb = MockEmbedder { dim: 8 };
		let pgraph = MapGraph::default();
		let personal = build_ctx(&pdocs, &pbm25, &pvec, &pemb, &pgraph);

		let ctx = DualContext { cwd, personal: Some(personal) };
		let q = RecallQuery {
			text: Some("Alpha".into()),
			limit: 5,
			include_personal: false,
			..Default::default()
		};
		let hits = recall_dual(q, &ctx).unwrap();
		assert!(hits.iter().all(|h| h.id != "P-1"), "personal hits leaked: {hits:?}");
	}

	#[test]
	fn recall_dual_dedupes_by_id_cwd_wins() {
		let docs = vec![doc("DUP-1", "episode", "From cwd", Some("hello"))];
		let bm25 = SearchIndex::from_docs(&docs);
		let vec = VectorIndex::new(8, 1).unwrap();
		let emb = MockEmbedder { dim: 8 };
		let graph = MapGraph::default();
		let cwd = build_ctx(&docs, &bm25, &vec, &emb, &graph);

		let pdocs = vec![doc("DUP-1", "episode", "From personal", None)];
		let pbm25 = SearchIndex::from_docs(&pdocs);
		let pvec = VectorIndex::new(8, 1).unwrap();
		let pemb = MockEmbedder { dim: 8 };
		let pgraph = MapGraph::default();
		let personal = build_ctx(&pdocs, &pbm25, &pvec, &pemb, &pgraph);

		let ctx = DualContext { cwd, personal: Some(personal) };
		let q = RecallQuery {
			text: Some("From".into()),
			limit: 5,
			include_personal: true,
			..Default::default()
		};
		let hits = recall_dual(q, &ctx).unwrap();
		let dup = hits.iter().find(|h| h.id == "DUP-1").expect("DUP-1 in result");
		assert_eq!(dup.title, "From cwd", "cwd entry should win the collision");
	}
}
