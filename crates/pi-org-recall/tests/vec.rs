//! Integration tests for VecIndex.
//!
//! Run with `cargo test -p pi-org-recall --tests`.

use pi_org_recall::vec::VecIndex;
use tempfile::tempdir;

/// Build a deterministic normalized test vector.
fn test_vector(dim: usize, seed: f32) -> Vec<f32> {
	let mut v: Vec<f32> = (0..dim).map(|i| seed * (i as f32 + 1.0)).collect();
	let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
	if norm > 1e-9 {
		for x in &mut v {
			*x /= norm;
		}
	}
	v
}

#[test]
fn vec_index_insert_and_search() {
	let mut idx = VecIndex::new(4);
	for i in 0..5 {
		let id = format!("id-{i}");
		let vec = test_vector(4, i as f32 + 1.0);
		idx.insert(id, vec).unwrap();
	}
	let query = test_vector(4, 3.0);
	let results = idx.search(&query, 10).unwrap();
	assert_eq!(results.len(), 5);
	// Results should be in descending score order
	for pair in results.windows(2) {
		let cmp = pair[0].1.total_cmp(&pair[1].1);
		assert!(cmp != std::cmp::Ordering::Less, "scores not descending: {:?}", &results);
		if cmp == std::cmp::Ordering::Equal {
			assert!(pair[0].0 <= pair[1].0, "same-score ties not sorted by id: {:?}", &results);
		}
	}
}

#[test]
fn vec_index_empty_returns_empty() {
	let idx: VecIndex = VecIndex::new(4);
	let query = test_vector(4, 1.0);
	let results = idx.search(&query, 10).unwrap();
	assert!(results.is_empty());
}

#[test]
fn vec_index_replace_on_duplicate_id() {
	let mut idx = VecIndex::new(4);
	idx.insert("X".to_string(), test_vector(4, 1.0)).unwrap();
	idx.insert("X".to_string(), test_vector(4, 2.0)).unwrap();
	assert_eq!(idx.len(), 1);
}

/// Stronger upsert check: the prior `vec_index_replace_on_duplicate_id`
/// asserts only `len() == 1`. Because `test_vector` normalises, both
/// `test_vector(4, 1.0)` and `test_vector(4, 2.0)` collapse to the same
/// unit vector — a regression that silently kept the old vector in the
/// HNSW would still pass. Here we replace a direction with a near-orthogonal
/// one and confirm the new direction is the search winner.
#[test]
fn vec_index_replace_swaps_search_direction() {
	let dim = 8;
	let mut idx = VecIndex::new(dim);

	// e0 unit vector
	let mut v_old = vec![0.0f32; dim];
	v_old[0] = 1.0;

	// e3 unit vector (orthogonal to e0)
	let mut v_new = vec![0.0f32; dim];
	v_new[3] = 1.0;

	idx.insert("X".into(), v_old.clone()).unwrap();

	// Sanity: query e0 returns X with score ~1.0.
	let hits = idx.search(&v_old, 4).unwrap();
	assert_eq!(hits[0].0, "X");
	assert!(hits[0].1 > 0.99, "pre-replace self-score should be near 1.0, was {}", hits[0].1);

	// Replace direction.
	idx.insert("X".into(), v_new.clone()).unwrap();
	assert_eq!(idx.len(), 1, "upsert must keep len at 1");

	// Query the OLD direction. X should now score near zero against e0
	// (cosine of orthogonal vectors). A regression that left the stale
	// HNSW edges in place would keep returning ~1.0.
	let hits = idx.search(&v_old, 4).unwrap();
	assert!(
		hits.is_empty() || hits[0].1.abs() < 0.01,
		"after replace, score against old direction must be ~0 (stale neighbour edges?); got {hits:?}"
	);

	// Query the NEW direction returns X near 1.0.
	let hits = idx.search(&v_new, 4).unwrap();
	assert_eq!(hits[0].0, "X");
	assert!(
		hits[0].1 > 0.99,
		"post-replace self-score on new direction should be near 1.0, was {}",
		hits[0].1,
	);
}

#[test]
fn vec_index_persistence() {
	let dir = tempdir().unwrap();
	let path = dir.path().join("vec.idx");

	let mut idx = VecIndex::new(4);
	idx.insert("a".to_string(), test_vector(4, 1.0)).unwrap();
	idx.insert("b".to_string(), test_vector(4, 2.0)).unwrap();
	idx.to_disk(&path).unwrap();

	let loaded = VecIndex::from_disk(&path).unwrap();
	assert_eq!(loaded.len(), 2);

	let query = test_vector(4, 1.5);
	let orig_results = idx.search(&query, 10).unwrap();
	let loaded_results = loaded.search(&query, 10).unwrap();
	assert_eq!(orig_results, loaded_results);
}

#[test]
fn vec_index_dim_mismatch_errors() {
	let mut idx = VecIndex::new(4);
	let result = idx.insert("bad".to_string(), vec![1.0, 2.0, 3.0]);
	assert!(result.is_err());
}

#[test]
fn item_id_keyed_lookup_preserves_string() {
	let mut idx = VecIndex::new(4);
	idx.insert("my-doc-42".to_string(), test_vector(4, 1.0))
		.unwrap();
	idx.insert("other-doc".to_string(), test_vector(4, 2.0))
		.unwrap();
	let query = test_vector(4, 1.0);
	let results = idx.search(&query, 10).unwrap();
	let ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
	assert!(ids.contains(&"my-doc-42"), "missing my-doc-42 in {ids:?}");
	assert!(ids.contains(&"other-doc"), "missing other-doc in {ids:?}");
}

#[test]
fn zero_vector_skipped_with_warning() {
	let mut idx = VecIndex::new(4);
	idx.insert("valid".to_string(), test_vector(4, 1.0))
		.unwrap();
	assert_eq!(idx.len(), 1);

	// Insert a zero vector — should be skipped
	let zero = vec![0.0; 4];
	idx.insert("zero".to_string(), zero).unwrap();
	assert_eq!(idx.len(), 1, "zero vector should be skipped");
}

/// Regression: prior implementation rebuilt the inner HNSW on every insert,
/// making N inserts O(N² log N). For N = 500 that exceeded several seconds
/// even with mock data; for N = 1870 it was minutes. Incremental insert is
/// O(log N) per call. We assert a generous wall-clock budget so the test is
/// stable on slow CI, while still catching a regression to quadratic behavior.
#[test]
fn vec_index_inserts_scale_better_than_quadratic() {
	use std::time::Instant;

	let dim = 64;
	let n = 500;
	let mut idx = VecIndex::new(dim);
	let start = Instant::now();
	for i in 0..n {
		let id = format!("row-{i}");
		let vec = test_vector(dim, (i as f32) + 1.0);
		idx.insert(id, vec).unwrap();
	}
	let elapsed = start.elapsed();
	assert_eq!(idx.len(), n);
	// 500 incremental HNSW inserts should comfortably fit in a few seconds
	// even in debug builds. The old O(n²) path on this size took 30s+.
	assert!(
		elapsed.as_secs() < 10,
		"insertion took {:?} for {n} items; suspected quadratic regression",
		elapsed,
	);
}

