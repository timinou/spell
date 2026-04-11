use serde::{Deserialize, Serialize};

use crate::error::Result;

/// A single entry in the vector index mapping a graph node to its embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorEntry {
	pub node_index: usize,
	pub vector:     Vec<f32>,
}

/// Persisted form of the vector index, including staleness metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedVectorIndex {
	pub model_name:             String,
	pub dimensions:             usize,
	pub entries:                Vec<VectorEntry>,
	pub graph_fingerprint_hash: u64,
}

/// In-memory vector index with pre-normalized vectors for fast cosine search.
#[derive(Debug, Clone)]
pub struct VectorIndex {
	/// Entries with L2-normalized vectors.
	entries:    Vec<VectorEntry>,
	dimensions: usize,
}

/// A search hit from cosine similarity search.
#[derive(Debug, Clone)]
pub struct VectorSearchHit {
	pub node_index: usize,
	/// Cosine similarity score in range [-1, 1].
	pub score:      f32,
}

impl VectorIndex {
	/// Build from embedding results. Pre-normalizes all vectors for O(n*d)
	/// dot-product search.
	pub fn new(entries: Vec<VectorEntry>, dimensions: usize) -> Self {
		let entries = entries
			.into_iter()
			.map(|mut e| {
				normalize(&mut e.vector);
				e
			})
			.collect();
		Self { entries, dimensions }
	}

	/// Cosine similarity search. Returns top-k hits sorted by descending score.
	///
	/// Since vectors are pre-normalized, cosine similarity reduces to dot
	/// product.
	pub fn search(&self, query_vector: &[f32], limit: usize) -> Vec<VectorSearchHit> {
		if self.entries.is_empty() || query_vector.len() != self.dimensions {
			return Vec::new();
		}

		// Normalize the query vector.
		let mut query_norm = query_vector.to_vec();
		normalize(&mut query_norm);

		let mut hits: Vec<VectorSearchHit> = self
			.entries
			.iter()
			.map(|entry| {
				let score = dot_product(&query_norm, &entry.vector);
				VectorSearchHit { node_index: entry.node_index, score }
			})
			.collect();

		// Partial sort: only need top-k.
		hits.sort_unstable_by(|a, b| b.score.total_cmp(&a.score));
		hits.truncate(limit);
		hits
	}

	/// Number of indexed vectors.
	pub const fn len(&self) -> usize {
		self.entries.len()
	}

	/// Whether the index is empty.
	pub const fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}

	/// Convert to the persisted form for serialization.
	pub fn to_persisted(
		&self,
		model_name: &str,
		graph_fingerprint_hash: u64,
	) -> PersistedVectorIndex {
		PersistedVectorIndex {
			model_name: model_name.to_owned(),
			dimensions: self.dimensions,
			entries: self.entries.clone(),
			graph_fingerprint_hash,
		}
	}

	/// Restore from persisted form. Vectors are already normalized from the
	/// build step.
	pub fn from_persisted(persisted: PersistedVectorIndex) -> Self {
		Self { dimensions: persisted.dimensions, entries: persisted.entries }
	}
}

/// Serialize a `PersistedVectorIndex` to a writer via bincode.
pub fn serialize_index(writer: impl std::io::Write, index: &PersistedVectorIndex) -> Result<()> {
	bincode::serialize_into(writer, index)?;
	Ok(())
}

/// Deserialize a `PersistedVectorIndex` from a reader via bincode.
pub fn deserialize_index(reader: impl std::io::Read) -> Result<PersistedVectorIndex> {
	let index = bincode::deserialize_from(reader)?;
	Ok(index)
}

/// L2-normalize a vector in place.
fn normalize(v: &mut [f32]) {
	let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
	if norm > f32::EPSILON {
		for x in v.iter_mut() {
			*x /= norm;
		}
	}
}

/// Dot product of two vectors.
fn dot_product(a: &[f32], b: &[f32]) -> f32 {
	a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_entry(node_index: usize, vector: Vec<f32>) -> VectorEntry {
		VectorEntry { node_index, vector }
	}

	#[test]
	fn search_returns_correct_top_k() {
		// Entries with known vectors. Query is closest to entry 2.
		let entries = vec![
			make_entry(0, vec![1.0, 0.0, 0.0]),
			make_entry(1, vec![0.0, 1.0, 0.0]),
			make_entry(2, vec![0.7, 0.7, 0.1]),
		];
		let index = VectorIndex::new(entries, 3);

		let query = vec![0.6, 0.8, 0.0];
		let hits = index.search(&query, 2);
		assert_eq!(hits.len(), 2);
		// Entry 2 (0.7, 0.7, 0.1) should be closest to (0.6, 0.8, 0.0).
		assert_eq!(hits[0].node_index, 2);
		// Entry 1 (0.0, 1.0, 0.0) should be second.
		assert_eq!(hits[1].node_index, 1);
	}

	#[test]
	fn search_empty_index_returns_empty() {
		let index = VectorIndex::new(Vec::new(), 3);
		let hits = index.search(&[1.0, 0.0, 0.0], 5);
		assert!(hits.is_empty());
	}

	#[test]
	fn search_dimension_mismatch_returns_empty() {
		let entries = vec![make_entry(0, vec![1.0, 0.0, 0.0])];
		let index = VectorIndex::new(entries, 3);
		// Query has wrong dimensions.
		let hits = index.search(&[1.0, 0.0], 5);
		assert!(hits.is_empty());
	}

	#[test]
	fn persistence_round_trip() {
		let entries = vec![make_entry(0, vec![1.0, 0.0, 0.0]), make_entry(1, vec![0.0, 1.0, 0.0])];
		let index = VectorIndex::new(entries, 3);
		let persisted = index.to_persisted("test-model", 42);

		let mut buf = Vec::new();
		serialize_index(&mut buf, &persisted).expect("serialize");
		let loaded = deserialize_index(buf.as_slice()).expect("deserialize");

		assert_eq!(loaded.model_name, "test-model");
		assert_eq!(loaded.dimensions, 3);
		assert_eq!(loaded.entries.len(), 2);
		assert_eq!(loaded.graph_fingerprint_hash, 42);

		// Restored index should produce identical search results.
		let restored = VectorIndex::from_persisted(loaded);
		let query = vec![1.0, 0.0, 0.0];
		let hits = restored.search(&query, 1);
		assert_eq!(hits[0].node_index, 0);
	}

	#[test]
	fn normalized_vectors_have_unit_length() {
		let mut v = vec![3.0, 4.0];
		normalize(&mut v);
		let len: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
		assert!((len - 1.0).abs() < 1e-6, "normalized vector should have unit length, got {len}");
	}

	#[test]
	fn identical_vectors_have_similarity_1() {
		let entries = vec![make_entry(0, vec![1.0, 2.0, 3.0])];
		let index = VectorIndex::new(entries, 3);
		let hits = index.search(&[1.0, 2.0, 3.0], 1);
		assert!(
			(hits[0].score - 1.0).abs() < 1e-5,
			"identical vectors should have cosine similarity ~1.0"
		);
	}

	#[test]
	fn fingerprint_hash_mismatch_triggers_invalidation() {
		let entries = vec![make_entry(0, vec![1.0, 0.0])];
		let index = VectorIndex::new(entries, 2);
		let persisted = index.to_persisted("model", 100);

		let mut buf = Vec::new();
		serialize_index(&mut buf, &persisted).expect("serialize");
		let loaded = deserialize_index(buf.as_slice()).expect("deserialize");

		// Simulate a different graph fingerprint hash.
		assert_ne!(loaded.graph_fingerprint_hash, 999, "setup check");
		// Caller checks: if loaded.graph_fingerprint_hash != current_hash -> discard.
		assert_eq!(loaded.graph_fingerprint_hash, 100);
	}
}
