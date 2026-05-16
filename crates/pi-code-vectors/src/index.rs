use std::{
	io::{Read, Write},
	sync::Arc,
};

use hnsw_rs::prelude::*;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const MAGIC_V2: &[u8; 12] = b"SPELL_VEC_V2";
const MAGIC_V1: &[u8; 12] = b"SPELL_VEC_V1";

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

/// In-memory vector index with hnsw_rs-backed approximate nearest neighbor
/// search.
pub struct VectorIndex {
	hnsw:       Arc<Hnsw<'static, f32, DistCosine>>,
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
	/// Build from embedding results. Pre-normalizes all vectors.
	pub fn new(entries: Vec<VectorEntry>, dimensions: usize) -> Self {
		let n = entries.len();
		let hnsw = Arc::new(Hnsw::new(16, n.max(1), 16, 200, DistCosine {}));
		let mut normalized_entries = Vec::with_capacity(n);
		for mut e in entries {
			normalize(&mut e.vector);
			normalized_entries.push(e);
		}
		for entry in &normalized_entries {
			hnsw.insert_slice((entry.vector.as_slice(), entry.node_index));
		}
		Self { hnsw, entries: normalized_entries, dimensions }
	}

	/// Append a single entry to the index using `hnsw_rs`' incremental
	/// `insert_slice`. O(log n) on the existing graph — no rebuild.
	///
	/// The caller chooses `entry.node_index` (typically `self.len()` for a
	/// fresh node). The vector is normalized in place before insertion.
	/// Zero-norm vectors are inserted as-is (cosine similarity will be
	/// undefined for them; the caller should filter zero-norm inputs).
	pub fn insert(&mut self, mut entry: VectorEntry) -> Result<()> {
		if entry.vector.len() != self.dimensions {
			return Err(Error::DimensionMismatch {
				expected: self.dimensions,
				actual:   entry.vector.len(),
			});
		}
		normalize(&mut entry.vector);
		self
			.hnsw
			.insert_slice((entry.vector.as_slice(), entry.node_index));
		self.entries.push(entry);
		Ok(())
	}

	/// Cosine similarity search via HNSW.
	pub fn search(&self, query_vector: &[f32], limit: usize) -> Result<Vec<VectorSearchHit>> {
		if self.entries.is_empty() {
			return Ok(Vec::new());
		}
		if query_vector.len() != self.dimensions {
			return Err(Error::DimensionMismatch {
				expected: self.dimensions,
				actual:   query_vector.len(),
			});
		}

		let mut query_norm = query_vector.to_vec();
		normalize(&mut query_norm);

		let ef_search = (limit * 8).max(64);
		let neighbours = self.hnsw.search(query_norm.as_slice(), limit, ef_search);

		let hits: Vec<VectorSearchHit> = neighbours
			.iter()
			.map(|n| {
				let node_index = n.d_id;
				let similarity = 1.0 - n.distance;
				VectorSearchHit { node_index, score: similarity }
			})
			.collect();
		Ok(hits)
	}

	/// Number of indexed vectors.
	#[must_use]
	pub fn len(&self) -> usize {
		self.entries.len()
	}

	/// Whether the index is empty.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}

	/// Convert to the persisted form for serialization.
	#[must_use]
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

	/// Restore from persisted form.
	#[must_use]
	pub fn from_persisted(persisted: PersistedVectorIndex) -> Self {
		Self::new(persisted.entries, persisted.dimensions)
	}
}

impl Clone for VectorIndex {
	fn clone(&self) -> Self {
		Self::new(self.entries.clone(), self.dimensions)
	}
}

impl std::fmt::Debug for VectorIndex {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("VectorIndex")
			.field("entries", &self.entries.len())
			.field("dimensions", &self.dimensions)
			.finish()
	}
}

/// Serialize a `PersistedVectorIndex` with magic header + bincode.
pub fn serialize_index(writer: impl Write, index: &PersistedVectorIndex) -> Result<()> {
	let mut buf = Vec::new();
	bincode::serialize_into(&mut buf, index)?;
	let mut writer = writer;
	writer.write_all(MAGIC_V2)?;
	writer.write_all(&buf)?;
	Ok(())
}

/// Deserialize a `PersistedVectorIndex` from a reader with magic header.
pub fn deserialize_index(reader: impl Read) -> Result<PersistedVectorIndex> {
	let mut magic = [0u8; 12];
	let mut reader = reader;
	reader.read_exact(&mut magic)?;

	if magic == *MAGIC_V1 {
		return Err(Error::IncompatibleIndexVersion {
			found:    String::from_utf8_lossy(MAGIC_V1).to_string(),
			expected: String::from_utf8_lossy(MAGIC_V2).to_string(),
		});
	}
	if magic != *MAGIC_V2 {
		return Err(Error::Serialization(
			bincode::ErrorKind::Custom(format!("unknown magic header: {:?}", &magic[..])).into(),
		));
	}

	let mut index: PersistedVectorIndex = bincode::deserialize_from(reader)?;
	index.model_name = String::new();
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

#[cfg(test)]
mod insert_tests {
	use super::*;

	fn unit(i: usize, dim: usize) -> Vec<f32> {
		let mut v = vec![0.0f32; dim];
		v[i % dim] = 1.0;
		v
	}

	#[test]
	fn incremental_insert_grows_index_without_rebuild() {
		// Dim = 32 so basis vectors don't collide for 0..32 inserts.
		let dim = 32;
		let mut idx = VectorIndex::new(Vec::new(), dim);
		assert!(idx.is_empty());

		for i in 0..32 {
			idx
				.insert(VectorEntry { node_index: i, vector: unit(i, dim) })
				.expect("incremental insert");
		}
		assert_eq!(idx.len(), 32);

		// Self-query for node 5 should return node 5 as top hit.
		let hits = idx.search(&unit(5, dim), 4).expect("search");
		assert!(!hits.is_empty());
		assert_eq!(hits[0].node_index, 5);
		assert!((hits[0].score - 1.0).abs() < 1e-5);
	}

	#[test]
	fn insert_rejects_wrong_dimension() {
		let mut idx = VectorIndex::new(Vec::new(), 8);
		let err = idx
			.insert(VectorEntry { node_index: 0, vector: vec![1.0; 4] })
			.expect_err("wrong dim");
		assert!(matches!(err, Error::DimensionMismatch { expected: 8, actual: 4 }));
	}
}

