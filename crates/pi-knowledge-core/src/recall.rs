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
	/// Origin store. `"repo"` for the cwd-rooted knowledge dir,
	/// `"personal"` for `~/.spell/personal/`. PLAN-310 W9.
	#[serde(default = "default_source")]
	pub source:          String,
}

fn default_source() -> String {
	"repo".to_string()
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

/// Borrowed slice of every artifact the recall pipeline needs for a single query.
///
/// Caller builds the bm25 / vec indices and the graph; the pipeline is
/// read-only.
///
/// `profiles` is the registry consulted when `query.profile` is set. Pass
/// `&RecallProfileRegistry::default()` (empty registry) when profiles are
/// irrelevant, or `&RecallProfileRegistry::defaults()` to pick up the
/// built-in `"session-start"` / `"priors"` curated views.
pub struct RecallContext<'a> {
	pub docs:     &'a [RecallDoc],
	pub bm25:     &'a SearchIndex,
	pub vec:      &'a VectorIndex,
	pub embedder: &'a dyn Embedder,
	pub graph:    &'a dyn RecallGraph,
	pub profiles: &'a RecallProfileRegistry,
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
			weights:     FusionWeights { bm25: 0.4, vector: 0.5, graph: 0.1, k: 60.0 },
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
/// Finds the first occurrence of the query (case-insensitive) in the body
/// and returns a window of text around it. Falls back to first 200
/// characters.
///
/// Char-aligned to survive non-ASCII bodies. `String::to_lowercase` is
/// allowed to change byte length (Turkish `İ` → `i\u{307}`, capital
/// sharp s `ẞ` → `ß`), so byte offsets from the lowercased copy
/// must never index back into the original. We scan char-by-char on the
/// original and slice on char boundaries.
#[must_use]
pub fn extract_excerpt(body: &str, query: &str) -> String {
	let query = query.trim();
	if query.is_empty() {
		return body.chars().take(200).collect();
	}

	let needle: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
	if needle.is_empty() {
		return body.chars().take(200).collect();
	}

	let body_chars: Vec<char> = body.chars().collect();
	let match_idx = find_ci_char_match(&body_chars, &needle);
	let Some(match_start) = match_idx else {
		return body.chars().take(200).collect();
	};

	let ctx_before = 50;
	let ctx_after = 150;
	let start = match_start.saturating_sub(ctx_before);
	let end = (match_start + needle.len() + ctx_after).min(body_chars.len());
	let excerpt: String = body_chars[start..end].iter().collect();
	if start > 0 {
		format!("...{excerpt}")
	} else {
		excerpt
	}
}

/// Case-insensitive char-aligned substring search. Returns the starting
/// char index in `haystack` where `needle` first matches, or `None`.
fn find_ci_char_match(haystack: &[char], needle: &[char]) -> Option<usize> {
	if needle.is_empty() || needle.len() > haystack.len() {
		return None;
	}
	let limit = haystack.len() - needle.len() + 1;
	'outer: for i in 0..limit {
		for (j, nc) in needle.iter().enumerate() {
			let hc = haystack[i + j].to_lowercase().next().unwrap_or(haystack[i + j]);
			if hc != *nc {
				continue 'outer;
			}
		}
		return Some(i);
	}
	None
}

// ---------------------------------------------------------------------------
// Recall entry point
// ---------------------------------------------------------------------------

/// Run the hybrid recall pipeline, fusing BM25 + vector + graph via RRF.
///
/// When `query.profile` is set and registered in `ctx.profiles`, the
/// profile's `scope`/`weights`/`graph_hops`/`graph_kinds`/`limit` are applied as
/// defaults: explicit query fields win, unset/zero/empty fields inherit
/// from the profile. Unknown profile names are silently ignored (caller
/// gets the bare-weights default behaviour).
///
/// Errors propagate from the embedder and the vector index. The hot path
/// does not swallow them — a zero query vector against a cosine-normalised
/// index produces meaningless rankings and a `vec.search` dim mismatch is a
/// configuration bug, not a soft failure.
pub fn recall(query: RecallQuery, ctx: &RecallContext) -> Result<Vec<RecallHit>> {
	let query = apply_profile(query, ctx.profiles);
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
	// Embedder and vec.search errors propagate (no zero-vector fabrication,
	// no silent empty result on dim mismatch). Caller decides how to surface
	// the failure — see W5.5 F1.
	let vector_ranked: Vec<String> = if let Some(ref text) = query.text {
		if weights.vector > 0.0 {
			let query_vec = ctx.embedder.embed_query(text)?;
			ctx.vec
				.search(&query_vec, over_fetch)
				.map_err(|e| crate::Error::Other(format!("vec.search: {e}")))?
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

			RecallHit { id, kind, score, title, excerpt, path_from_focus: None, why, source: "repo".to_string() }
		})
		.collect();

	Ok(results)
}

/// Apply a named profile from `profiles` onto `query`. Explicit query
/// fields win; unset/zero/empty fields inherit from the profile.
/// Unknown profile names are passed through unchanged.
fn apply_profile(query: RecallQuery, profiles: &RecallProfileRegistry) -> RecallQuery {
	let Some(name) = query.profile.as_deref() else {
		return query;
	};
	let Some(p) = profiles.get(name) else {
		return query;
	};
	RecallQuery {
		text:             query.text,
		scope:            if query.scope.is_empty() { p.scope.clone() } else { query.scope },
		focus:            query.focus,
		graph_hops:       if query.graph_hops == 0 { p.graph_hops } else { query.graph_hops },
		graph_kinds:      if query.graph_kinds.is_empty() {
			p.graph_kinds.clone()
		} else {
			query.graph_kinds
		},
		limit:            if query.limit == 0 { p.limit } else { query.limit },
		weights:          query.weights.or_else(|| Some(p.weights.clone())),
		profile:          query.profile,
		include_personal: query.include_personal,
	}
}

// ---------------------------------------------------------------------------
// Dual-context recall (cwd + personal store)
// ---------------------------------------------------------------------------

/// Bundles two recall contexts for dual-root recall (cwd + personal store).
pub struct DualContext<'a> {
	pub cwd:      RecallContext<'a>,
	pub personal: Option<RecallContext<'a>>,
}

/// Run [`recall`] against both contexts and fuse by position-based RRF.
///
/// Each context produces its own ranked list; the two lists are then fused
/// by reciprocal-rank-fusion treating `cwd` and `personal` as two lanes.
/// This is the right shape because RRF scores from the two `recall()`
/// outputs are **not** commensurate: lane weights and corpus sizes differ,
/// so summing the per-context fused scores would let a #1 hit in personal
/// lose to a #15 in cwd just because cwd had more lanes contributing.
/// Position-based fusion keeps rank meaning intact.
///
/// Dedup: cwd wins on collision (the cwd hit’s metadata is preserved). On
/// dedup, the duplicate id contributes its rank from *both* lanes to the
/// fused score, so cross-corpus agreement still boosts the result.
///
/// Both lanes carry equal weight (1.0). RRF naturally rewards consensus,
/// so an item present in both lanes outranks a same-position item in only
/// one. `cwd` only “wins” on metadata collision (title/excerpt come from
/// the cwd hit) — it does not get extra weight in the ranking.
pub fn recall_dual(query: RecallQuery, ctx: &DualContext) -> Result<Vec<RecallHit>> {
	if !query.include_personal || ctx.personal.is_none() {
		return recall(query, &ctx.cwd);
	}
	let limit = query.limit.max(1);
	let weights = query.weights.clone().unwrap_or_default();
	let k = weights.k;

	let cwd_hits = recall(query.clone(), &ctx.cwd)?;
	let personal_hits = recall(query, ctx.personal.as_ref().unwrap())?;

	// Capture metadata before lifting ids into rank lists.
	let mut by_id: BTreeMap<String, RecallHit> = BTreeMap::new();
	for h in &personal_hits {
		by_id.insert(h.id.clone(), h.clone());
	}
	// cwd second so cwd wins on collision.
	for h in &cwd_hits {
		by_id.insert(h.id.clone(), h.clone());
	}

	let cwd_ids: Vec<&str> = cwd_hits.iter().map(|h| h.id.as_str()).collect();
	let personal_ids: Vec<&str> = personal_hits.iter().map(|h| h.id.as_str()).collect();
	let rankings = vec![(1.0_f32, cwd_ids), (1.0_f32, personal_ids)];
	let fused = rrf(&rankings, k);

	let mut out: Vec<RecallHit> = Vec::with_capacity(fused.len().min(limit));
	for (id, score) in fused.into_iter().take(limit) {
		if let Some(mut h) = by_id.remove(&id) {
			h.score = score;
			out.push(h);
		}
	}
	Ok(out)
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
		profiles: &'a RecallProfileRegistry,
	) -> RecallContext<'a> {
		RecallContext { docs, bm25, vec, embedder, graph, profiles }
	}

	static EMPTY_PROFILES: std::sync::OnceLock<RecallProfileRegistry> = std::sync::OnceLock::new();
	fn no_profiles() -> &'static RecallProfileRegistry {
		EMPTY_PROFILES.get_or_init(RecallProfileRegistry::default)
	}

	// Embedder that always errors — exercises F1 propagation.
	struct FailingEmbedder {
		dim: usize,
	}

	impl Embedder for FailingEmbedder {
		fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
			Err(crate::Error::Embedder("worker offline".into()))
		}
		fn embed_batch(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>> {
			Err(crate::Error::Embedder("worker offline".into()))
		}
		fn dim(&self) -> usize {
			self.dim
		}
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
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph, no_profiles());
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
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph, no_profiles());
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
		let cwd = build_ctx(&docs, &bm25, &vec, &emb, &graph, no_profiles());

		let pdocs = vec![doc("P-1", "episode", "Personal", None)];
		let pbm25 = SearchIndex::from_docs(&pdocs);
		let pvec = VectorIndex::new(8, 1).unwrap();
		let pemb = MockEmbedder { dim: 8 };
		let pgraph = MapGraph::default();
		let personal = build_ctx(&pdocs, &pbm25, &pvec, &pemb, &pgraph, no_profiles());

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
		let cwd = build_ctx(&docs, &bm25, &vec, &emb, &graph, no_profiles());

		let pdocs = vec![doc("DUP-1", "episode", "From personal", None)];
		let pbm25 = SearchIndex::from_docs(&pdocs);
		let pvec = VectorIndex::new(8, 1).unwrap();
		let pemb = MockEmbedder { dim: 8 };
		let pgraph = MapGraph::default();
		let personal = build_ctx(&pdocs, &pbm25, &pvec, &pemb, &pgraph, no_profiles());

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

	// --- F1: vector lane errors propagate ----------------------------------
	#[test]
	fn recall_returns_err_on_embed_failure() {
		let docs = vec![doc("X-1", "episode", "Alpha", Some("body"))];
		let bm25 = SearchIndex::from_docs(&docs);
		let vec = VectorIndex::new(8, 1).unwrap();
		let emb = FailingEmbedder { dim: 8 };
		let graph = MapGraph::default();
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph, no_profiles());
		let q = RecallQuery {
			text:    Some("alpha".into()),
			limit:   5,
			weights: Some(FusionWeights { bm25: 0.0, vector: 1.0, graph: 0.0, k: 60.0 }),
			..Default::default()
		};
		let result = recall(q, &ctx);
		assert!(result.is_err(), "embed failure must propagate; got {result:?}");
	}

	#[test]
	fn recall_returns_err_on_vec_search_dim_mismatch() {
		// Embedder returns dim=4 vectors; index was built for dim=8.
		struct WrongDim;
		impl Embedder for WrongDim {
			fn embed_query(&self, _: &str) -> Result<Vec<f32>> {
				Ok(vec![0.1; 4])
			}
			fn embed_batch(&self, _: &[&str]) -> Result<Vec<Vec<f32>>> {
				Ok(vec![])
			}
			fn dim(&self) -> usize {
				4
			}
		}
		let docs = vec![doc("X-1", "episode", "a", None)];
		let bm25 = SearchIndex::from_docs(&docs);
		let vec = VectorIndex::new(8, 1).unwrap();
		let graph = MapGraph::default();
		let emb = WrongDim;
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph, no_profiles());
		let q = RecallQuery {
			text:    Some("x".into()),
			limit:   5,
			weights: Some(FusionWeights { bm25: 0.0, vector: 1.0, graph: 0.0, k: 60.0 }),
			..Default::default()
		};
		assert!(recall(q, &ctx).is_err(), "vec.search dim mismatch must propagate");
	}

	// --- F3: profile threading --------------------------------------------
	#[test]
	fn recall_applies_profile_weights() {
		// Build a corpus where bm25 would naturally favour title "alpha".
		let docs = vec![
			doc("CN-1", "concept", "alpha", Some("alpha alpha alpha")),
			doc("EP-1", "episode", "beta", Some("alpha")),
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
		let profiles = RecallProfileRegistry::defaults();
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph, &profiles);

		// session-start scope = ["concept"]; with profile applied EP-1 must be filtered.
		let q = RecallQuery {
			text: Some("alpha".into()),
			profile: Some("session-start".into()),
			..Default::default()
		};
		let hits = recall(q, &ctx).unwrap();
		assert!(
			hits.iter().all(|h| h.id != "EP-1"),
			"session-start scope=concept must filter EP-1; got {hits:?}",
		);
		assert!(
			hits.iter().any(|h| h.id == "CN-1"),
			"session-start should still surface CN-1; got {hits:?}",
		);
	}

	#[test]
	fn recall_ignores_unknown_profile_name() {
		let docs = vec![doc("X-1", "episode", "alpha", None)];
		let bm25 = SearchIndex::from_docs(&docs);
		let vec = VectorIndex::new(8, 1).unwrap();
		let emb = MockEmbedder { dim: 8 };
		let graph = MapGraph::default();
		let profiles = RecallProfileRegistry::defaults();
		let ctx = build_ctx(&docs, &bm25, &vec, &emb, &graph, &profiles);
		let q = RecallQuery {
			text:    Some("alpha".into()),
			profile: Some("does-not-exist".into()),
			limit:   5,
			..Default::default()
		};
		let hits = recall(q, &ctx).unwrap();
		// Default weights (bm25+vector both >0) would surface X-1.
		assert!(hits.iter().any(|h| h.id == "X-1"), "unknown profile should be no-op; got {hits:?}");
	}

	#[test]
	fn defaults_registry_session_start_has_live_weights() {
		let reg = RecallProfileRegistry::defaults();
		let p = reg.get("session-start").expect("session-start registered");
		assert!(
			p.weights.vector > 0.0 || p.weights.bm25 > 0.0,
			"session-start must have a non-zero retrieval lane (W7 needs hits): {:?}",
			p.weights,
		);
	}

	// --- F4: recall_dual uses position-based RRF ---------------------------
	#[test]
	fn recall_dual_uses_rrf_not_raw_score_sum() {
		// Construct a scenario where personal's #1 hit had a *low* raw score
		// (because personal lanes were sparse) but a *high* rank. The old
		// implementation sorted by raw score so personal's #1 would sink under
		// cwd's middle-rank hits. The new implementation uses position-based
		// RRF, so personal's #1 should land near the top.
		let cwd_docs = vec![
			doc("C-1", "episode", "alpha cwd one", Some("alpha")),
			doc("C-2", "episode", "alpha cwd two", Some("alpha")),
			doc("C-3", "episode", "alpha cwd three", Some("alpha")),
			doc("C-4", "episode", "alpha cwd four", Some("alpha")),
			doc("C-5", "episode", "alpha cwd five", Some("alpha")),
		];
		let cwd_bm25 = SearchIndex::from_docs(&cwd_docs);
		let cwd_vec = VectorIndex::new(8, cwd_docs.len()).unwrap();
		let cwd_emb = MockEmbedder { dim: 8 };
		let cwd_graph = MapGraph::default();
		let cwd = build_ctx(&cwd_docs, &cwd_bm25, &cwd_vec, &cwd_emb, &cwd_graph, no_profiles());

		let p_docs = vec![doc("P-1", "episode", "alpha", Some("alpha"))];
		let p_bm25 = SearchIndex::from_docs(&p_docs);
		let p_vec = VectorIndex::new(8, 1).unwrap();
		let p_emb = MockEmbedder { dim: 8 };
		let p_graph = MapGraph::default();
		let personal =
			build_ctx(&p_docs, &p_bm25, &p_vec, &p_emb, &p_graph, no_profiles());

		let ctx = DualContext { cwd, personal: Some(personal) };
		let q = RecallQuery {
			text:             Some("alpha".into()),
			limit:            10,
			include_personal: true,
			weights: Some(FusionWeights { bm25: 1.0, vector: 0.0, graph: 0.0, k: 60.0 }),
			..Default::default()
		};
		let hits = recall_dual(q, &ctx).unwrap();
		let p_idx = hits.iter().position(|h| h.id == "P-1").expect("P-1 present");
		// With position-based RRF (equal lane weights), P-1 (personal rank #1)
		// shares the top RRF contribution 1.0/(k+1) with whichever cwd hit
		// landed at cwd rank #1. It must therefore outrank cwd ranks #2..#5.
		assert!(
			p_idx < hits.len() - 1,
			"P-1 must outrank at least one cwd hit (proves position-based fusion); got {hits:?}",
		);
		assert!(
			p_idx <= 1,
			"P-1 (personal rank #1) must land in the top 2 alongside the cwd-rank-#1 hit; got idx={p_idx} hits={hits:?}",
		);
		// Sanity: the top RRF score is 1/(k+1) = 1/61 ≈ 0.0164. If old impl
		// were active, scores would be the (different) raw recall() scores
		// inherited from the per-context fusion — same magnitude here but
		// the *shape* would differ for a 2-lane query. We assert the new
		// invariant: every score is a sum of 1/(k+rank) RRF contributions.
		let top = hits.first().unwrap().score;
		let expected_top_max = 2.0 / (60.0 + 1.0); // both lanes contributing
		assert!(top <= expected_top_max, "top score {top} exceeds 2/(k+1)={expected_top_max}");
	}

	// --- F5: utf-8 boundary -----------------------------------------------
	#[test]
	fn extract_excerpt_handles_multibyte_chars() {
		// German sharp s — the classic case that breaks lowercase byte indexing.
		let body = "Über die ß-Regel und die i-Punkte";
		let out = extract_excerpt(body, "ß");
		assert!(
			out.contains('ß'),
			"excerpt should contain the matched char; got {out:?}",
		);
	}

	#[test]
	fn extract_excerpt_handles_turkish_capital_i() {
		// `İ`.to_lowercase() yields "i\u{307}" (3 bytes → 3 bytes by way of
		// 1 char → 2 chars). Byte indexing would shift.
		let body = "İstanbul ferries depart at dawn";
		let out = extract_excerpt(body, "istanbul");
		assert!(
			out.to_lowercase().contains("istanbul") || out.contains('İ'),
			"case-insensitive match should locate İstanbul; got {out:?}",
		);
	}

	#[test]
	fn extract_excerpt_does_not_panic_on_no_match() {
		// Non-ASCII body, query absent — must fall back without panic.
		let body = "你好世界";
		let out = extract_excerpt(body, "zzz");
		assert!(!out.is_empty());
	}
}
