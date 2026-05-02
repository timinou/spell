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
			assert!(
				pair[0].0 <= pair[1].0,
				"same-score ties not sorted by id: {:?}",
				&results
			);
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
	idx.insert("my-doc-42".to_string(), test_vector(4, 1.0)).unwrap();
	idx.insert("other-doc".to_string(), test_vector(4, 2.0)).unwrap();
	let query = test_vector(4, 1.0);
	let results = idx.search(&query, 10).unwrap();
	let ids: Vec<&str> = results.iter().map(|(id, _)| id.as_str()).collect();
	assert!(ids.contains(&"my-doc-42"), "missing my-doc-42 in {ids:?}");
	assert!(ids.contains(&"other-doc"), "missing other-doc in {ids:?}");
}

#[test]
fn zero_vector_skipped_with_warning() {
	let mut idx = VecIndex::new(4);
	idx.insert("valid".to_string(), test_vector(4, 1.0)).unwrap();
	assert_eq!(idx.len(), 1);

	// Insert a zero vector — should be skipped
	let zero = vec![0.0; 4];
	idx.insert("zero".to_string(), zero).unwrap();
	assert_eq!(idx.len(), 1, "zero vector should be skipped");
}
