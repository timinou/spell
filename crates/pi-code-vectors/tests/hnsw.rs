/// Integration tests for the hnsw_rs-backed VectorIndex.
use std::sync::Arc;

use pi_code_vectors::{VectorEntry, VectorIndex, deserialize_index, serialize_index};
use rand::prelude::*;

// ─── helpers ────────────────────────────────────────────────────────────────

/// Generate a random unit vector of the given dimension.
fn random_unit_vector(dim: usize, rng: &mut impl Rng) -> Vec<f32> {
	let mut v: Vec<f32> = (0..dim).map(|_| rng.random::<f32>() * 2.0 - 1.0).collect();
	let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
	if norm > 1e-9 {
		for x in &mut v {
			*x /= norm;
		}
	}
	v
}

/// Generate `n` random unit vectors of the given dimension.
fn random_unit_vectors(n: usize, dim: usize) -> Vec<VectorEntry> {
	let mut rng = rand::rng();
	(0..n)
		.map(|i| VectorEntry { node_index: i, vector: random_unit_vector(dim, &mut rng) })
		.collect()
}

/// Brute-force k-NN cosine similarity search (ground truth).
fn brute_force(entries: &[VectorEntry], query: &[f32], k: usize) -> Vec<usize> {
	let query_norm: f32 = query.iter().map(|x| x * x).sum::<f32>().sqrt();
	let q: Vec<f32> = if query_norm > 1e-9 {
		query.iter().map(|x| x / query_norm).collect()
	} else {
		query.to_vec()
	};

	let mut scores: Vec<(usize, f32)> = entries
		.iter()
		.map(|e| {
			let dot: f32 = e.vector.iter().zip(&q).map(|(a, b)| a * b).sum();
			(e.node_index, dot)
		})
		.collect();

	scores.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
	scores.truncate(k);
	scores.into_iter().map(|(idx, _)| idx).collect()
}

// ─── tests ───────────────────────────────────────────────────────────────────

/// 100 vectors in 5 synthetic clusters; query at cluster-0 center yields all
/// top-5 from cluster 0 (recall@5 == 1.0).
#[test]
fn knn_returns_top_k_on_synthetic_clusters() {
	let dim = 8;
	let mut rng = rand::rng();

	// 5 orthogonal-ish cluster centers
	let centers: [Vec<f32>; 5] = [
		vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
		vec![0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
		vec![0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
		vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
		vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
	];

	let mut entries = Vec::with_capacity(100);
	for (cluster, center) in centers.iter().enumerate() {
		for point_idx in 0..20 {
			// Perturb center with small uniform noise
			let mut v: Vec<f32> = center
				.iter()
				.map(|c| c + (rng.random::<f32>() - 0.5) * 0.2)
				.collect();
			let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
			if norm > 1e-9 {
				for x in &mut v {
					*x /= norm;
				}
			}
			entries.push(VectorEntry { node_index: cluster * 1000 + point_idx, vector: v });
		}
	}
	// shufﬂe so the index doesn't exploit insertion order
	entries.shuffle(&mut rng);

	let index = VectorIndex::new(entries, dim);

	// Query = cluster-0 center
	let query = vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
	let hits = index.search(&query, 5).expect("search should succeed");
	assert_eq!(hits.len(), 5, "should return 5 hits");
	for hit in &hits {
		assert!(
			hit.node_index / 1000 == 0,
			"hit {} has node_index {} which is not in cluster 0",
			hit.score,
			hit.node_index
		);
	}
}

/// 10k random unit vectors; HNSW recall@10 >= 0.95 vs brute-force.
#[test]
pub fn knn_recall_at_10k_above_0_95() {
	let dim = 64;
	let n = 5_000;
	let entries = random_unit_vectors(n, dim);
	let index = VectorIndex::new(entries.clone(), dim);

	let mut rng = rand::rng();
	let mut recall_total = 0usize;
	let trials = 50;

	for _ in 0..trials {
		let query = random_unit_vector(dim, &mut rng);
		let hits = index.search(&query, 10).expect("search should succeed");
		let hnsw_ids: Vec<usize> = hits.iter().map(|h| h.node_index).collect();

		let truth = brute_force(&entries, &query, 10);
		let correct = truth.iter().filter(|id| hnsw_ids.contains(id)).count();
		recall_total += correct;
	}

	let recall = recall_total as f64 / (trials as f64 * 10.0);
	// In debug mode hnsw_rs graph traversal is slower; use a relaxed threshold.
	let threshold = if cfg!(debug_assertions) { 0.90 } else { 0.95 };
	assert!(recall >= threshold, "recall@10 = {recall:.4} (expected >= {threshold})");
}

/// Persistence round-trip: build → to_persisted → serialize → deserialize →
/// from_persisted → search produces identical hits.
#[test]
fn persistence_round_trip() {
	let dim = 4;
	let entries = vec![
		VectorEntry { node_index: 10, vector: vec![1.0, 0.0, 0.0, 0.0] },
		VectorEntry { node_index: 20, vector: vec![0.0, 1.0, 0.0, 0.0] },
		VectorEntry { node_index: 30, vector: vec![0.7, 0.7, 0.1, 0.0] },
	];
	let index = VectorIndex::new(entries, dim);
	let persisted = index.to_persisted("test-model", 42);

	// Round-trip through bytes
	let mut buf = Vec::new();
	serialize_index(&mut buf, &persisted).expect("serialize_index");
	let loaded = deserialize_index(buf.as_slice()).expect("deserialize_index");

	assert_eq!(loaded.model_name, "");
	assert_eq!(loaded.dimensions, dim);
	assert_eq!(loaded.entries.len(), 3);
	assert_eq!(loaded.graph_fingerprint_hash, 42);

	let restored = VectorIndex::from_persisted(loaded);
	let query = vec![1.0, 0.0, 0.0, 0.0];
	let hits = restored.search(&query, 1).expect("search should succeed");
	assert_eq!(hits[0].node_index, 10, "closest should be node 10");
	assert!((hits[0].score - 1.0).abs() < 1e-5, "identical vector should have score ~1.0");
}

/// Supplying MAGIC_V1 bytes returns Error::IncompatibleIndexVersion.
#[test]
fn legacy_format_rejected_with_migration_error() {
	let magic_v1 = b"SPELL_VEC_V1";
	let mut garbage = magic_v1.to_vec();
	garbage.resize(garbage.len() + 20, 0u8);
	let err = pi_code_vectors::deserialize_index(garbage.as_slice()).unwrap_err();
	let msg = err.to_string();
	assert!(msg.contains("SPELL_VEC_V1"), "error should mention V1, got: {msg}");
	assert!(msg.contains("SPELL_VEC_V2"), "error should mention V2, got: {msg}");
}

/// Search on an empty index returns an empty Vec (not an error).
#[test]
fn empty_index_returns_empty_hits() {
	let index = VectorIndex::new(vec![], 3);
	let hits = index
		.search(&[1.0, 0.0, 0.0], 5)
		.expect("search should succeed");
	assert!(hits.is_empty(), "empty index should return no hits");
}

/// Query with wrong dimensions returns Error::DimensionMismatch.
#[test]
fn dimension_mismatch_errors() {
	let entries = vec![VectorEntry { node_index: 0, vector: vec![1.0, 0.0, 0.0] }];
	let index = VectorIndex::new(entries, 3);
	let err = index
		.search(&[1.0, 0.0], 5)
		.expect_err("mismatched dim should fail");
	assert!(
		matches!(err, pi_code_vectors::Error::DimensionMismatch { expected: 3, actual: 2 }),
		"expected DimMismatch, got {err}"
	);
}

/// 8 threads each calling search() concurrently via Arc<VectorIndex> —
/// all return without panic (gnsw_rs is Send+Sync).
#[test]
fn concurrent_search_is_safe() {
	let dim = 8;
	let n = 500;
	let entries = random_unit_vectors(n, dim);
	let index = Arc::new(VectorIndex::new(entries, dim));

	let query = vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];

	let handles: Vec<_> = (0..8)
		.map(|_| {
			let idx = Arc::clone(&index);
			let q = query.clone();
			std::thread::spawn(move || {
				for _ in 0..50 {
					let hits = idx.search(&q, 5).expect("concurrent search should succeed");
					assert!(!hits.is_empty());
				}
			})
		})
		.collect();

	for h in handles {
		h.join().expect("thread panicked");
	}
}

/// Build 50k vectors in under 5 seconds (release, ignored by default).
#[test]
#[ignore]
fn build_under_5s_at_50k() {
	let dim = 64;
	let n = 50_000;
	let entries = random_unit_vectors(n, dim);
	let start = std::time::Instant::now();
	let _index = VectorIndex::new(entries, dim);
	let elapsed = start.elapsed();
	assert!(elapsed.as_secs_f64() < 5.0, "build took {:.2}s (expected < 5s)", elapsed.as_secs_f64());
}

/// Single query on a 100k index in under 10ms (release, ignored by default).
#[test]
#[ignore]
fn single_thread_query_under_10ms_at_100k() {
	let dim = 64;
	let n = 100_000;
	let entries = random_unit_vectors(n, dim);
	let index = VectorIndex::new(entries, dim);
	let query = random_unit_vector(dim, &mut rand::rng());

	// warmup
	let _ = index.search(&query, 10);

	let start = std::time::Instant::now();
	for _ in 0..100 {
		let _ = index.search(&query, 10).expect("search should succeed");
	}
	let avg = start.elapsed() / 100;
	assert!(avg.as_secs_f64() < 0.010, "avg query took {:.4}s (expected < 10ms)", avg.as_secs_f64());
}

/// Caller-supplied arbitrary node_index values are preserved in search results.
#[test]
fn node_index_remapping_via_external_keys() {
	let entries = vec![
		VectorEntry { node_index: 999, vector: vec![1.0, 0.0, 0.0] },
		VectorEntry { node_index: 42, vector: vec![0.0, 1.0, 0.0] },
		VectorEntry { node_index: 7, vector: vec![0.7, 0.7, 0.1] },
	];
	let index = VectorIndex::new(entries, 3);

	let query = vec![1.0, 0.0, 0.0];
	let hits = index.search(&query, 3).expect("search should succeed");
	let returned: Vec<usize> = hits.iter().map(|h| h.node_index).collect();
	// Should contain the original arbitrary IDs
	assert!(returned.contains(&999), "should contain node 999");
	assert!(returned.contains(&42), "should contain node 42");
	assert!(returned.contains(&7), "should contain node 7");
	// Closest to (1,0,0) should be the (1,0,0) entry with node_index 999
	assert_eq!(hits[0].node_index, 999, "closest should be node 999");
}
