//! Integration tests for dual-root recall (`personal::recall_dual`).
//!
//! Tests fused results from cwd + personal contexts with deduplication.

use std::collections::HashMap;

use pi_org_engine::{graph::build_typed_graph, item::OrgItem};
use pi_org_recall::{
    DualContext, FusionWeights, RecallContext, RecallQuery, embedder::MockEmbedder,
    fts::FtsIndex, recall_dual, vec::VecIndex,
};
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Helpers (mirrored from recall.rs tests)
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

/// Build a recall context from a vec of items. Returns (ctx, fts, vec, graph)
/// in drop order — keep them alive for the context's lifetime.
fn build_context<'a>(
	items: &'a [OrgItem],
	fts: &'a FtsIndex,
	vec: &'a VecIndex,
	embedder: &'a MockEmbedder,
	graph: &'a pi_org_engine::graph::TypedGraph,
) -> RecallContext<'a> {
	RecallContext { items, fts, vec, embedder, graph }
}

/// Default query fusing all three lanes with typical weights.
fn default_query(text: &str, limit: usize, include_personal: bool) -> RecallQuery {
	RecallQuery {
		text: Some(text.into()),
		weights: Some(FusionWeights { bm25: 1.0, vector: 0.0, graph: 0.0, k: 60.0 }),
		limit,
		include_personal,
		..RecallQuery::default()
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn recall_unions_hits_from_both_roots() {
	let cwd_dir = tempdir().unwrap();
	let cwd_cache = tempdir().unwrap();
	let cwd_fts = FtsIndex::open_at(cwd_dir.path(), cwd_cache.path()).unwrap();
	let cwd_items = vec![
		mk_item("A", "Pizza in cwd", "concept", Some("pizza recipe cwd")),
		mk_item("B", "Pizza toppings", "concept", Some("pizza toppings cwd")),
	];
	cwd_fts.index(&cwd_items).unwrap();
	let cwd_graph = build_typed_graph(&cwd_items);
	let cwd_vec = VecIndex::new(768);
	let embedder = MockEmbedder::new();

	let personal_dir = tempdir().unwrap();
	let personal_cache = tempdir().unwrap();
	let personal_fts = FtsIndex::open_at(personal_dir.path(), personal_cache.path()).unwrap();
	let personal_items =
		vec![mk_item("C", "Pizza personal", "concept", Some("pizza recipe personal"))];
	personal_fts.index(&personal_items).unwrap();
	let personal_graph = build_typed_graph(&personal_items);
	let personal_vec = VecIndex::new(768);

	let ctx = DualContext {
		cwd:      build_context(&cwd_items, &cwd_fts, &cwd_vec, &embedder, &cwd_graph),
		personal: Some(build_context(
			&personal_items,
			&personal_fts,
			&personal_vec,
			&embedder,
			&personal_graph,
		)),
	};

	let query = default_query("pizza", 10, true);
	let hits = recall_dual(query, &ctx).unwrap();

	// Both roots contribute: A, B (cwd) + C (personal)
	assert_eq!(hits.len(), 3, "should contain hits from both roots");
	let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
	assert!(ids.contains(&"A"), "cwd hit A present");
	assert!(ids.contains(&"B"), "cwd hit B present");
	assert!(ids.contains(&"C"), "personal hit C present");
}

#[test]
fn include_personal_false_excludes_personal_hits() {
	let cwd_dir = tempdir().unwrap();
	let cwd_cache = tempdir().unwrap();
	let cwd_fts = FtsIndex::open_at(cwd_dir.path(), cwd_cache.path()).unwrap();
	let cwd_items = vec![mk_item("A", "Pizza in cwd", "concept", Some("pizza recipe cwd"))];
	cwd_fts.index(&cwd_items).unwrap();
	let cwd_graph = build_typed_graph(&cwd_items);
	let cwd_vec = VecIndex::new(768);
	let embedder = MockEmbedder::new();

	let personal_dir = tempdir().unwrap();
	let personal_cache = tempdir().unwrap();
	let personal_fts = FtsIndex::open_at(personal_dir.path(), personal_cache.path()).unwrap();
	let personal_items = vec![mk_item("B", "Pizza personal", "concept", Some("pizza personal"))];
	personal_fts.index(&personal_items).unwrap();
	let personal_graph = build_typed_graph(&personal_items);
	let personal_vec = VecIndex::new(768);

	let ctx = DualContext {
		cwd:      build_context(&cwd_items, &cwd_fts, &cwd_vec, &embedder, &cwd_graph),
		personal: Some(build_context(
			&personal_items,
			&personal_fts,
			&personal_vec,
			&embedder,
			&personal_graph,
		)),
	};

	// include_personal = false
	let query = default_query("pizza", 10, false);
	let hits = recall_dual(query, &ctx).unwrap();

	assert_eq!(hits.len(), 1, "only cwd hit");
	assert_eq!(hits[0].id, "A", "cwd hit is A");
}

#[test]
fn duplicate_id_collision_returns_cwd_only() {
	let cwd_dir = tempdir().unwrap();
	let cwd_cache = tempdir().unwrap();
	let cwd_fts = FtsIndex::open_at(cwd_dir.path(), cwd_cache.path()).unwrap();
	let cwd_items = vec![mk_item("X", "Shared cwd item", "concept", Some("cwd version of X"))];
	cwd_fts.index(&cwd_items).unwrap();
	let cwd_graph = build_typed_graph(&cwd_items);
	let cwd_vec = VecIndex::new(768);
	let embedder = MockEmbedder::new();

	let personal_dir = tempdir().unwrap();
	let personal_cache = tempdir().unwrap();
	let personal_fts = FtsIndex::open_at(personal_dir.path(), personal_cache.path()).unwrap();
	let personal_items =
		vec![mk_item("X", "Shared personal item", "concept", Some("personal version of X"))];
	personal_fts.index(&personal_items).unwrap();
	let personal_graph = build_typed_graph(&personal_items);
	let personal_vec = VecIndex::new(768);

	let ctx = DualContext {
		cwd:      build_context(&cwd_items, &cwd_fts, &cwd_vec, &embedder, &cwd_graph),
		personal: Some(build_context(
			&personal_items,
			&personal_fts,
			&personal_vec,
			&embedder,
			&personal_graph,
		)),
	};

	let query = default_query("version", 10, true);
	let hits = recall_dual(query, &ctx).unwrap();

	assert_eq!(hits.len(), 1, "only one hit after dedupe");
	assert_eq!(hits[0].id, "X", "id is X");
	assert_eq!(hits[0].title, "Shared cwd item", "cwd hit wins on collision");
}

#[test]
fn personal_only_when_cwd_empty() {
	let cwd_dir = tempdir().unwrap();
	let cwd_cache = tempdir().unwrap();
	let cwd_fts = FtsIndex::open_at(cwd_dir.path(), cwd_cache.path()).unwrap();
	let cwd_items: Vec<OrgItem> = vec![]; // empty cwd
	cwd_fts.index(&cwd_items).unwrap();
	let cwd_graph = build_typed_graph(&cwd_items);
	let cwd_vec = VecIndex::new(768);
	let embedder = MockEmbedder::new();

	let personal_dir = tempdir().unwrap();
	let personal_cache = tempdir().unwrap();
	let personal_fts = FtsIndex::open_at(personal_dir.path(), personal_cache.path()).unwrap();
	let personal_items =
		vec![mk_item("P1", "Personal only item", "concept", Some("only in personal"))];
	personal_fts.index(&personal_items).unwrap();
	let personal_graph = build_typed_graph(&personal_items);
	let personal_vec = VecIndex::new(768);

	let ctx = DualContext {
		cwd:      build_context(&cwd_items, &cwd_fts, &cwd_vec, &embedder, &cwd_graph),
		personal: Some(build_context(
			&personal_items,
			&personal_fts,
			&personal_vec,
			&embedder,
			&personal_graph,
		)),
	};

	let query = default_query("personal", 10, true);
	let hits = recall_dual(query, &ctx).unwrap();

	assert_eq!(hits.len(), 1, "personal hit surfaces when cwd empty");
	assert_eq!(hits[0].id, "P1", "personal hit P1");
}

#[test]
fn dual_recall_respects_limit() {
	let cwd_dir = tempdir().unwrap();
	let cwd_cache = tempdir().unwrap();
	let cwd_fts = FtsIndex::open_at(cwd_dir.path(), cwd_cache.path()).unwrap();
	let cwd_items = vec![
		mk_item("A", "Thing A", "concept", Some("alpha thing")),
		mk_item("B", "Thing B", "concept", Some("beta thing")),
		mk_item("C", "Thing C", "concept", Some("gamma thing")),
	];
	cwd_fts.index(&cwd_items).unwrap();
	let cwd_graph = build_typed_graph(&cwd_items);
	let cwd_vec = VecIndex::new(768);
	let embedder = MockEmbedder::new();

	let personal_dir = tempdir().unwrap();
	let personal_cache = tempdir().unwrap();
	let personal_fts = FtsIndex::open_at(personal_dir.path(), personal_cache.path()).unwrap();
	let personal_items = vec![
		mk_item("D", "Thing D", "concept", Some("delta thing")),
		mk_item("E", "Thing E", "concept", Some("epsilon thing")),
	];
	personal_fts.index(&personal_items).unwrap();
	let personal_graph = build_typed_graph(&personal_items);
	let personal_vec = VecIndex::new(768);

	let ctx = DualContext {
		cwd:      build_context(&cwd_items, &cwd_fts, &cwd_vec, &embedder, &cwd_graph),
		personal: Some(build_context(
			&personal_items,
			&personal_fts,
			&personal_vec,
			&embedder,
			&personal_graph,
		)),
	};

	// 5 total hits, limit to 2
	let query = default_query("thing", 2, true);
	let hits = recall_dual(query, &ctx).unwrap();

	assert_eq!(hits.len(), 2, "truncated to limit=2");
	assert!(hits[0].score >= hits[1].score, "sorted by score descending");
}
