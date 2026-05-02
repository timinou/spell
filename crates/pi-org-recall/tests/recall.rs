//! Integration tests for the hybrid recall pipeline.
//!
//! Tests the full [`recall`] pipeline with real (or mock) BM25, vector, and
//! graph lanes fused via RRF. Each test builds a small in-memory org-item
//! snapshot.

use std::collections::HashMap;

use pi_org_engine::{edge::EdgeKind, graph::build_typed_graph, item::OrgItem};
use pi_org_recall::{
	Embedder, FusionWeights, RecallContext, RecallProfileRegistry, RecallQuery,
	embedder::MockEmbedder, extract_excerpt, fts::FtsIndex, recall, rrf, vec::VecIndex,
};
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn mk_item(id: &str, title: &str, kind: &str, body: Option<&str>) -> OrgItem {
	let mut props = HashMap::new();
	props.insert("KIND".into(), kind.into());
	OrgItem {
		id:         id.into(),
		title:      title.into(),
		state:      String::new(),
		category:   String::new(),
		dir:        String::new(),
		file:       String::new(),
		line:       1,
		level:      1,
		properties: props,
		body:       body.map(String::from),
		clocks:     vec![],
		byte_range: (0, 0),
		children:   vec![],
		relations:  vec![],
	}
}

/// Normalize a vector in-place.
fn normalize(v: &mut [f32]) {
	let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
	if norm > 1e-9 {
		for x in v.iter_mut() {
			*x /= norm;
		}
	}
}

// ---------------------------------------------------------------------------
// rrf unit-style tests re-checked in integration context
// ---------------------------------------------------------------------------

#[test]
fn fuses_three_lanes_with_rrf() {
	// Manually craft rankings simulating three lanes:
	//   BM25:   [A, B, C]   weight 0.3
	//   Vector: [B, A, D]   weight 0.5
	//   Graph:  [C, D]      weight 0.2
	//
	// Scores (k=60):
	//   A: 0.3/61 + 0.5/62 ≈ 0.012983
	//   B: 0.3/62 + 0.5/61 ≈ 0.013036  ← highest
	//   C: 0.3/63 + 0.2/61 ≈ 0.008041
	//   D: 0.5/63 + 0.2/62 ≈ 0.011163
	let rankings = [(0.3, vec!["A", "B", "C"]), (0.5, vec!["B", "A", "D"]), (0.2, vec!["C", "D"])];
	let result = rrf(&rankings, 60.0);
	assert_eq!(result.len(), 4);
	assert_eq!(result[0].0, "B", "B should be first");
	assert_eq!(result[1].0, "A");
	assert_eq!(result[2].0, "D");
	assert_eq!(result[3].0, "C");

	// Verify scores match calculated values
	let eps = 1e-5;
	assert!((result[0].1 - 0.013036).abs() < eps);
}

// ---------------------------------------------------------------------------
// Single-lane integration tests
// ---------------------------------------------------------------------------

#[test]
fn bm25_only_when_vector_disabled() {
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

	let items = vec![
		mk_item("A", "Pizza supreme", "concept", Some("delicious pizza with cheese")),
		mk_item("B", "Lunch ideas", "concept", Some("pizza is great for lunch")),
		mk_item("C", "Dinner", "concept", Some("making pizza at home")),
		mk_item("D", "Salad", "concept", Some("healthy vegetables")),
	];
	fts.index(&items).unwrap();

	let graph = build_typed_graph(&items);
	let vec_index = VecIndex::new(768);
	let embedder = MockEmbedder::new();
	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery {
		text: Some("pizza".into()),
		weights: Some(FusionWeights { bm25: 1.0, vector: 0.0, graph: 0.0, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	// BM25-only: only A, B, C should appear (D has no "pizza")
	assert_eq!(hits.len(), 3);
	assert!(hits.iter().any(|h| h.id == "A"));
	assert!(hits.iter().any(|h| h.id == "B"));
	assert!(hits.iter().any(|h| h.id == "C"));
	// A should be first (title boost for "pizza")
	assert_eq!(hits[0].id, "A");
	// All hits should have bm25_rank set and no vector_rank/graph info
	for h in &hits {
		assert!(h.why.bm25_rank.is_some());
		assert!(h.why.vector_rank.is_none());
		assert!(!h.why.graph_seed);
		assert!(h.why.graph_hops_from_focus.is_none());
	}
}

#[test]
fn vector_only_when_bm25_disabled() {
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

	let items = vec![
		mk_item("A", "Red apple", "concept", Some("a red fruit")),
		mk_item("B", "Blue berry", "concept", Some("a blue fruit")),
		mk_item("C", "Green pear", "concept", Some("a green fruit")),
	];
	fts.index(&items).unwrap();

	// Compute query embedding then insert controlled vectors
	let embedder = MockEmbedder::new();
	let qv = embedder.embed_query("fruit").unwrap();

	// B's vector = query → closest
	// A's vector = slightly perturbed
	// C's vector = more perturbed
	let mut vec_index = VecIndex::new(embedder.dim());
	let mut vec_a = qv.clone();
	vec_a[0] += 0.15;
	normalize(&mut vec_a);
	let mut vec_c = qv.clone();
	vec_c[0] += 0.5;
	normalize(&mut vec_c);
	vec_index.insert("A".into(), vec_a).unwrap();
	vec_index.insert("B".into(), qv.clone()).unwrap();
	vec_index.insert("C".into(), vec_c).unwrap();

	let graph = build_typed_graph(&items);
	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery {
		text: Some("fruit".into()),
		weights: Some(FusionWeights { bm25: 0.0, vector: 1.0, graph: 0.0, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	assert_eq!(hits.len(), 3, "all 3 items should be found");
	// B should be first (identical to query vector)
	assert_eq!(hits[0].id, "B");
	// Each hit should have vector_rank set
	for h in &hits {
		assert!(h.why.vector_rank.is_some());
		assert!(h.why.bm25_rank.is_none());
	}
}

// ---------------------------------------------------------------------------
// Graph-only / empty-text tests
// ---------------------------------------------------------------------------

#[test]
fn graph_seed_only_when_text_empty() {
	// Build a small graph: A→B, B→C
	let mut items = vec![
		mk_item("A", "Root", "concept", None),
		mk_item("B", "Child", "concept", None),
		mk_item("C", "Leaf", "concept", None),
	];
	items[0].relations = vec![(EdgeKind::About, "B".into())];
	items[1].relations = vec![(EdgeKind::About, "C".into())];

	let graph = build_typed_graph(&items);
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	fts.index(&items).unwrap();
	let vec_index = VecIndex::new(768);
	let embedder = MockEmbedder::new();
	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	// query.text = None, focus = "A", graph_hops = 2
	let query = RecallQuery {
		text: None,
		focus: Some("A".into()),
		graph_hops: 2,
		weights: Some(FusionWeights { bm25: 0.0, vector: 0.0, graph: 1.0, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	assert_eq!(hits.len(), 3, "A, B, C from graph BFS");
	// Ordered by hop count: A (0), B (1), C (2)
	assert_eq!(hits[0].id, "A");
	assert_eq!(hits[1].id, "B");
	assert_eq!(hits[2].id, "C");

	// A is the seed
	assert!(hits[0].why.graph_seed);
	assert_eq!(hits[0].why.graph_hops_from_focus, Some(0));
	assert_eq!(hits[1].why.graph_hops_from_focus, Some(1));
	assert_eq!(hits[2].why.graph_hops_from_focus, Some(2));
}

// ---------------------------------------------------------------------------
// Scope filtering
// ---------------------------------------------------------------------------

#[test]
fn scope_filter_propagates_to_all_lanes() {
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	let embedder = MockEmbedder::new();

	let items = vec![
		mk_item("CN-1", "JWT token", "concept", Some("JSON web token authentication")),
		mk_item("CN-2", "OAuth flow", "concept", Some("OAuth2 authorization code flow")),
		mk_item("EP-1", "Setup auth", "episode", Some("Implement JWT and OAuth together")),
		mk_item("EP-2", "Deploy", "episode", Some("Deploy to production")),
	];
	fts.index(&items).unwrap();

	// Build graph: CN-1 → EP-1 (About) and put EP-1 in relations so it's a neighbor
	let mut items_mut = items.clone();
	items_mut[0].relations = vec![(EdgeKind::About, "EP-1".into())];
	let graph = build_typed_graph(&items_mut);

	// Insert controlled vectors: CN-1 and CN-2 close to query
	let qv = embedder.embed_query("JWT").unwrap();
	let mut vec_index = VecIndex::new(embedder.dim());
	vec_index.insert("CN-1".into(), qv.clone()).unwrap();
	let mut cn2 = qv.clone();
	cn2[0] += 0.1;
	normalize(&mut cn2);
	vec_index.insert("CN-2".into(), cn2).unwrap();
	// EP items get far-away vectors
	let far = vec![0.0; embedder.dim()];
	vec_index.insert("EP-1".into(), far.clone()).unwrap();
	vec_index.insert("EP-2".into(), far).unwrap();

	let ctx = RecallContext {
		items:    &items_mut,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	// Scope = concept only, focus = CN-1, hops = 1
	let query = RecallQuery {
		text: Some("JWT".into()),
		scope: vec!["concept".into()],
		focus: Some("CN-1".into()),
		graph_hops: 1,
		weights: Some(FusionWeights { bm25: 0.3, vector: 0.5, graph: 0.2, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	// Only concepts should appear (CN-1, CN-2)
	for h in &hits {
		assert_eq!(h.kind, "concept", "scope filter should exclude episodes: {}", h.id);
	}
	// EP-1 is in the graph neighborhood but filtered out by scope
	assert!(!hits.iter().any(|h| h.id == "EP-1"), "EP-1 should be filtered by scope");
	assert!(!hits.iter().any(|h| h.id == "EP-2"), "EP-2 should be filtered by scope");
}

// ---------------------------------------------------------------------------
// Limit truncation
// ---------------------------------------------------------------------------

#[test]
fn limit_truncates_after_fusion() {
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	let embedder = MockEmbedder::new();

	let items: Vec<OrgItem> = (0..10)
		.map(|i| {
			let id = format!("ITEM-{i}");
			mk_item(&id, &format!("Item {i}"), "concept", Some("test content"))
		})
		.collect();
	fts.index(&items).unwrap();
	let graph = build_typed_graph(&items);

	let mut vec_index = VecIndex::new(embedder.dim());
	let qv = embedder.embed_query("test").unwrap();
	for (i, item) in items.iter().enumerate() {
		let mut v = qv.clone();
		v[0] += (i as f32) * 0.01;
		normalize(&mut v);
		vec_index.insert(item.id.clone(), v).unwrap();
	}

	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery {
		text: Some("test".into()),
		limit: 3,
		weights: Some(FusionWeights { bm25: 0.5, vector: 0.5, graph: 0.0, k: 60.0 }),
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	assert_eq!(hits.len(), 3, "limit=3 should return exactly 3 hits");
}

// ---------------------------------------------------------------------------
// RRF k constant default and override
// ---------------------------------------------------------------------------

#[test]
fn rrf_k_constant_default_60_and_overridable() {
	// Test with k=60 (default) → scores are spread out
	let rankings = [(1.0, vec!["A", "B", "C"])];
	let result = rrf(&rankings, 60.0);
	assert_eq!(result.len(), 3);
	assert_eq!(result[0].0, "A");

	// With k=0, weighting is more aggressive: first item gets 1/1=1, second gets
	// 1/2=0.5, third gets 1/3≈0.33
	let result_zero = rrf(&rankings, 0.0);
	assert_eq!(result_zero.len(), 3);
	assert!((result_zero[0].1 - 1.0).abs() < 1e-5, "first item at k=0 should score 1.0");
	assert!((result_zero[1].1 - 0.5).abs() < 1e-5, "second item at k=0 should score 0.5");
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

#[test]
fn empty_query_with_focus_works() {
	// No text, no BM25/vector, but graph with focus
	let mut items =
		vec![mk_item("X", "Focus", "concept", None), mk_item("Y", "Related", "concept", None)];
	items[0].relations = vec![(EdgeKind::About, "Y".into())];
	let graph = build_typed_graph(&items);
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	fts.index(&items).unwrap();
	let embedder = MockEmbedder::new();
	let vec_index = VecIndex::new(embedder.dim());
	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery {
		text: None,
		focus: Some("X".into()),
		graph_hops: 1,
		weights: Some(FusionWeights { bm25: 0.0, vector: 0.0, graph: 1.0, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	assert_eq!(hits.len(), 2);
	assert_eq!(hits[0].id, "X");
	assert_eq!(hits[1].id, "Y");
}

#[test]
fn empty_query_no_focus_returns_empty() {
	let items = vec![mk_item("A", "Thing", "concept", Some("body"))];
	let graph = build_typed_graph(&items);
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	fts.index(&items).unwrap();
	let embedder = MockEmbedder::new();
	let vec_index = VecIndex::new(embedder.dim());
	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery { text: None, focus: None, limit: 10, ..RecallQuery::default() };

	let hits = recall(query, &ctx).unwrap();
	assert!(hits.is_empty(), "no lanes active → empty results");
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

#[test]
fn profile_lookup_resolves_named_profile() {
	let registry = RecallProfileRegistry::defaults();
	let profile = registry.get("priors").unwrap();
	assert_eq!(profile.scope, vec!["concept", "episode"]);
	assert!((profile.weights.bm25 - 0.4).abs() < 1e-5);
	assert!((profile.weights.vector - 0.5).abs() < 1e-5);
	assert!((profile.weights.graph - 0.1).abs() < 1e-5);
	assert_eq!(profile.graph_hops, 1);
	assert_eq!(profile.limit, 12);

	let session = registry.get("session-start").unwrap();
	assert_eq!(session.scope, vec!["concept"]);
	assert!((session.weights.bm25 - 0.0).abs() < 1e-5);
	assert_eq!(session.limit, 12);
}

// ---------------------------------------------------------------------------
// Why / provenance
// ---------------------------------------------------------------------------

#[test]
fn hit_includes_explanation_why() {
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	let embedder = MockEmbedder::new();

	let items = vec![
		mk_item("A", "Alpha", "concept", Some("alpha beta gamma delta")),
		mk_item("B", "Bravo", "concept", Some("bravo charlie delta")),
	];
	fts.index(&items).unwrap();
	let graph = build_typed_graph(&items);

	// Insert vectors: A close to query, B far
	let qv = embedder.embed_query("delta").unwrap();
	let mut vec_index = VecIndex::new(embedder.dim());
	vec_index.insert("A".into(), qv.clone()).unwrap();
	let mut far = qv.clone();
	far[0] += 10.0;
	normalize(&mut far);
	vec_index.insert("B".into(), far).unwrap();

	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery {
		text: Some("delta".into()),
		focus: Some("A".into()),
		weights: Some(FusionWeights { bm25: 0.3, vector: 0.5, graph: 0.2, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let hits = recall(query, &ctx).unwrap();
	// A appears in all 3 lanes: BM25 (delta in body), vector (close), graph (seed)
	let hit_a = hits.iter().find(|h| h.id == "A").unwrap();
	assert!(hit_a.why.bm25_rank.is_some(), "A should have BM25 rank");
	assert!(hit_a.why.vector_rank.is_some(), "A should have vector rank");
	assert!(hit_a.why.graph_seed, "A is the graph focus");
	assert_eq!(hit_a.why.graph_hops_from_focus, Some(0), "A at depth 0");
	assert!(hit_a.excerpt.is_some(), "A should have excerpt from body+query");

	// B appears only in BM25 and maybe vector lane (if close enough)
	let hit_b = hits.iter().find(|h| h.id == "B");
	if let Some(b) = hit_b {
		assert!(b.why.bm25_rank.is_some(), "B should have BM25 rank (delta in body)");
		assert!(!b.why.graph_seed, "B is not the focus");
	}
}

// ---------------------------------------------------------------------------
// Determinism: same inputs → same output
// ---------------------------------------------------------------------------

#[test]
fn recall_is_deterministic() {
	let dir = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let fts = FtsIndex::open_at(dir.path(), cache.path()).unwrap();
	let embedder = MockEmbedder::new();

	let items = vec![
		mk_item("X", "X-ray", "concept", Some("x-ray vision")),
		mk_item("Y", "Yankee", "concept", Some("yankee doodle")),
		mk_item("Z", "Zebra", "concept", Some("zebra stripes")),
	];
	fts.index(&items).unwrap();
	let graph = build_typed_graph(&items);

	let mut vec_index = VecIndex::new(embedder.dim());
	let qv = embedder.embed_query("test").unwrap();
	for item in &items {
		let mut v = qv.clone();
		v[0] += 0.1; // noise, same for all → HNSW may break ties
		normalize(&mut v);
		vec_index.insert(item.id.clone(), v).unwrap();
	}

	let ctx = RecallContext {
		items:    &items,
		fts:      &fts,
		vec:      &vec_index,
		embedder: &embedder,
		graph:    &graph,
	};

	let query = RecallQuery {
		text: Some("test".into()),
		weights: Some(FusionWeights { bm25: 0.5, vector: 0.5, graph: 0.0, k: 60.0 }),
		limit: 10,
		..RecallQuery::default()
	};

	let first = recall(query.clone(), &ctx).unwrap();
	let second = recall(query, &ctx).unwrap();

	assert_eq!(first.len(), second.len());
	for (a, b) in first.iter().zip(second.iter()) {
		assert_eq!(a.id, b.id, "deterministic ordering");
		assert!((a.score - b.score).abs() < 1e-5, "deterministic scores");
	}
}

// ---------------------------------------------------------------------------
// excerpt extraction
// ---------------------------------------------------------------------------

#[test]
fn extract_excerpt_finds_query_in_body() {
	let body = "The quick brown fox jumps over the lazy dog near the riverbank.";
	let excerpt = extract_excerpt(body, "fox");
	assert!(excerpt.contains("fox"), "excerpt should contain the matched term");
	assert!(excerpt.len() <= body.len(), "excerpt should not exceed body");
}

#[test]
fn extract_excerpt_empty_query_returns_prefix() {
	let body = "Hello world this is a test";
	let excerpt = extract_excerpt(body, "");
	assert_eq!(excerpt, "Hello world this is a test");
}

#[test]
fn extract_excerpt_no_match_returns_prefix() {
	let body = "abcdefghijklmnopqrstuvwxyz";
	let excerpt = extract_excerpt(body, "zzz");
	assert_eq!(excerpt.len(), 26.min(200));
}
