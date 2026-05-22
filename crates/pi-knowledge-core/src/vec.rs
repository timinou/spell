//! HNSW vector index backed by `usearch`. mmap-friendly via `view()`.

use std::path::Path;
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

use crate::{Error, Result};

/// Stable 64-bit FNV-1a hash mapping a string id to a usearch `u64` key.
///
/// Used by the recall pipeline to project domain-level `String` ids onto
/// `VectorIndex`'s native key space. The same input produces the same
/// output across processes — required so an `id_hash(id)` computed on
/// rebuild matches the keys written on the previous run.
#[must_use]
pub fn id_hash(id: &str) -> u64 {
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	for b in id.bytes() {
		h ^= u64::from(b);
		h = h.wrapping_mul(0x0000_0001_0000_01b3);
	}
	h
}

/// A single entry mapping a node id to its embedding. (Pre-W2: `node_index: usize`.)
#[derive(Debug, Clone)]
pub struct VectorEntry {
	pub node_id: u64,
	pub vector:  Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct VectorSearchHit {
	pub node_id: u64,
	/// Cosine similarity in [-1, 1] (higher = more similar).
	pub score:   f32,
}

pub struct VectorIndex {
	inner: Index,
	dim:   usize,
}

impl std::fmt::Debug for VectorIndex {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("VectorIndex")
			.field("dim", &self.dim)
			.field("len", &self.inner.size())
			.finish()
	}
}

// usearch::Index is Send + Sync.

impl VectorIndex {
	/// Build an empty index with the given dimensionality. Reserves capacity
	/// up front; growing past the hint costs a (cheap) reallocation.
	pub fn new(dimensions: usize, capacity_hint: usize) -> Result<Self> {
		let opts = IndexOptions {
			dimensions,
			metric: MetricKind::Cos,
			quantization: ScalarKind::F32,
			multi: false, // upsert semantics: replace on duplicate key
			..Default::default()
		};
		let inner = Index::new(&opts).map_err(usearch_err)?;
		inner.reserve(capacity_hint.max(1)).map_err(usearch_err)?;
		Ok(Self { inner, dim: dimensions })
	}

	pub fn from_entries(entries: &[VectorEntry], dimensions: usize) -> Result<Self> {
		let mut idx = Self::new(dimensions, entries.len().max(1))?;
		for e in entries {
			idx.upsert(e.clone())?;
		}
		Ok(idx)
	}

	pub fn upsert(&mut self, entry: VectorEntry) -> Result<()> {
		if entry.vector.len() != self.dim {
			return Err(Error::Other(format!(
				"dim mismatch: expected {}, got {}",
				self.dim,
				entry.vector.len()
			)));
		}
		// multi=false ⇒ add replaces on duplicate key.
		if self.inner.size() + 1 >= self.inner.capacity() {
			// Double capacity on growth.
			let new_cap = self.inner.capacity().max(1) * 2;
			self.inner.reserve(new_cap).map_err(usearch_err)?;
		}
		// usearch's high-level wrapper rejects duplicate keys even with multi=false;
		// remove any existing entry first to implement upsert semantics.
		if self.inner.contains(entry.node_id) {
			self.inner.remove(entry.node_id).map_err(usearch_err)?;
		}
		self.inner.add(entry.node_id, &entry.vector).map_err(usearch_err)?;
		Ok(())
	}

	pub fn remove(&mut self, node_id: u64) -> Result<()> {
		self.inner.remove(node_id).map_err(usearch_err)?;
		Ok(())
	}

	pub fn search(&self, query: &[f32], limit: usize) -> Result<Vec<VectorSearchHit>> {
		if query.len() != self.dim {
			return Err(Error::Other(format!(
				"dim mismatch on query: expected {}, got {}",
				self.dim,
				query.len()
			)));
		}
		if self.inner.size() == 0 || limit == 0 {
			return Ok(Vec::new());
		}
		let matches = self.inner.search(query, limit).map_err(usearch_err)?;
		Ok(matches
			.keys
			.into_iter()
			.zip(matches.distances)
			.map(|(k, d)| VectorSearchHit { node_id: k, score: 1.0_f32 - d })
			.collect())
	}

	pub fn len(&self) -> usize {
		self.inner.size()
	}
	pub fn is_empty(&self) -> bool {
		self.inner.size() == 0
	}
	pub const fn dim(&self) -> usize {
		self.dim
	}

	/// Save with `.tmp` + atomic rename.
	pub fn save(&self, path: &Path) -> Result<()> {
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent)?;
		}
		let tmp = path.with_extension("uidx.tmp");
		let tmp_str = tmp.to_str().ok_or_else(|| Error::Other("non-utf8 path".into()))?;
		self.inner.save(tmp_str).map_err(usearch_err)?;
		std::fs::rename(&tmp, path)?;
		Ok(())
	}

	/// Load (RAM-resident copy).
	pub fn load(path: &Path) -> Result<Self> {
		let p = path.to_str().ok_or_else(|| Error::Other("non-utf8 path".into()))?;
		let inner = Index::restore(p).map_err(usearch_err)?;
		let dim = inner.dimensions();
		Ok(Self { inner, dim })
	}

	/// Open via mmap (read-only across processes).
	pub fn view(path: &Path) -> Result<Self> {
		let p = path.to_str().ok_or_else(|| Error::Other("non-utf8 path".into()))?;
		let inner = Index::restore_view(p).map_err(usearch_err)?;
		let dim = inner.dimensions();
		Ok(Self { inner, dim })
	}

	/// Read header without loading the index. Returns (dim, count).
	pub fn metadata(path: &Path) -> Result<(usize, usize)> {
		let p = path.to_str().ok_or_else(|| Error::Other("non-utf8 path".into()))?;
		let m = Index::metadata(p).map_err(usearch_err)?;
		Ok((m.dimensions as usize, m.count_present as usize))
	}
}

/// Convert any usearch (`cxx::Exception`) error into our Error type. Generic
/// over `Display` so we don't have to name `cxx::Exception` (cxx isn't a direct dep).
fn usearch_err<E: std::fmt::Display>(e: E) -> Error {
	Error::Usearch(e.to_string())
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::f32;

	fn unit(i: usize, dim: usize) -> Vec<f32> {
		let mut v = vec![0.0f32; dim];
		v[i % dim] = 1.0;
		v
	}

	#[test]
	fn new_empty_index_searches_empty() {
		let idx = VectorIndex::new(8, 1).unwrap();
		assert!(idx.is_empty());
		let hits = idx.search(&[1.0f32; 8], 4).unwrap();
		assert!(hits.is_empty());
	}

	#[test]
	fn upsert_adds_one_vector() {
		let dim = 8;
		let mut idx = VectorIndex::new(dim, 1).unwrap();
		idx.upsert(VectorEntry { node_id: 42, vector: unit(3, dim) })
			.unwrap();
		assert_eq!(idx.len(), 1);
		let hits = idx.search(&unit(3, dim), 1).unwrap();
		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].node_id, 42);
		assert!((hits[0].score - 1.0).abs() < 1e-5);
	}

	#[test]
	fn upsert_replaces_on_same_key() {
		let dim = 8;
		let mut idx = VectorIndex::new(dim, 1).unwrap();
		idx.upsert(VectorEntry {
			node_id: 1,
			vector: unit(0, dim),
		})
		.unwrap();
		idx.upsert(VectorEntry {
			node_id: 1,
			vector: unit(1, dim),
		})
		.unwrap();
		assert_eq!(idx.len(), 1);

		// Search for the new vector should find key 1.
		let hits = idx.search(&unit(1, dim), 1).unwrap();
		assert_eq!(hits[0].node_id, 1);
		assert!((hits[0].score - 1.0).abs() < 1e-5);

		// Search for the old vector should NOT find key 1 (or score should be low).
		let hits = idx.search(&unit(0, dim), 1).unwrap();
		// It may return nothing or a low score; either way node_id != 1 or score < 0.9.
		if !hits.is_empty() && hits[0].node_id == 1 {
			assert!(hits[0].score < 0.9, "expected low score, got {}", hits[0].score);
		}
	}

	#[test]
	fn remove_drops_vector() {
		let dim = 8;
		let mut idx = VectorIndex::new(dim, 3).unwrap();
		for i in 0..3 {
			idx.upsert(VectorEntry {
				node_id: i as u64,
				vector: unit(i, dim),
			})
			.unwrap();
		}
		assert_eq!(idx.len(), 3);
		idx.remove(1).unwrap();
		assert_eq!(idx.len(), 2);
	}

	#[test]
	fn search_returns_topk_ordered_by_similarity() {
		let dim = 4;
		let mut idx = VectorIndex::new(dim, 3).unwrap();
		// Basis vectors.
		idx.upsert(VectorEntry {
			node_id: 0,
			vector: unit(0, dim),
		})
		.unwrap();
		idx.upsert(VectorEntry {
			node_id: 1,
			vector: unit(1, dim),
		})
		.unwrap();
		idx.upsert(VectorEntry {
			node_id: 2,
			vector: unit(2, dim),
		})
		.unwrap();

		// Query aligned with unit(1) should return node 1 first.
		let hits = idx.search(&unit(1, dim), 3).unwrap();
		assert_eq!(hits.len(), 3);
		assert_eq!(hits[0].node_id, 1);
		assert!((hits[0].score - 1.0).abs() < 1e-5);
		// Scores should be descending.
		for w in hits.windows(2) {
			assert!(w[0].score >= w[1].score);
		}
	}

	#[test]
	fn dim_mismatch_errors() {
		let mut idx = VectorIndex::new(8, 1).unwrap();
		let err = idx
			.upsert(VectorEntry {
				node_id: 0,
				vector: vec![1.0f32; 4],
			})
			.unwrap_err();
		assert!(matches!(err, Error::Other(_)));
		assert!(err.to_string().contains("dim mismatch"));
	}

	#[test]
	fn save_load_round_trip() {
		let dim = 8;
		let mut idx = VectorIndex::new(dim, 2).unwrap();
		idx.upsert(VectorEntry {
			node_id: 7,
			vector: unit(3, dim),
		})
		.unwrap();
		idx.upsert(VectorEntry {
			node_id: 9,
			vector: unit(5, dim),
		})
		.unwrap();

		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("vectors.uidx");
		idx.save(&path).unwrap();

		let loaded = VectorIndex::load(&path).unwrap();
		assert_eq!(loaded.len(), 2);
		assert_eq!(loaded.dim(), dim);

		let hits = loaded.search(&unit(3, dim), 1).unwrap();
		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].node_id, 7);
		assert!((hits[0].score - 1.0).abs() < 1e-5);
	}

	#[test]
	fn save_view_round_trip_mmap() {
		let dim = 8;
		let mut idx = VectorIndex::new(dim, 2).unwrap();
		idx.upsert(VectorEntry {
			node_id: 10,
			vector: unit(2, dim),
		})
		.unwrap();
		idx.upsert(VectorEntry {
			node_id: 20,
			vector: unit(4, dim),
		})
		.unwrap();

		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("vectors.uidx");
		idx.save(&path).unwrap();

		let viewed = VectorIndex::view(&path).unwrap();
		assert_eq!(viewed.len(), 2);
		assert_eq!(viewed.dim(), dim);

		let hits = viewed.search(&unit(4, dim), 1).unwrap();
		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].node_id, 20);
		assert!((hits[0].score - 1.0).abs() < 1e-5);
	}

	#[test]
	fn view_is_read_only() {
		let dim = 4;
		let mut idx = VectorIndex::new(dim, 1).unwrap();
		idx.upsert(VectorEntry {
			node_id: 1,
			vector: unit(0, dim),
		})
		.unwrap();

		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("vectors.uidx");
		idx.save(&path).unwrap();

		let _v1 = VectorIndex::view(&path).unwrap();
		let _v2 = VectorIndex::view(&path).unwrap();
		// Both opens succeeded — no panic, no error.
	}

	#[test]
	fn metadata_reads_dim_and_count() {
		let dim = 16;
		let mut idx = VectorIndex::new(dim, 5).unwrap();
		for i in 0..5 {
			idx.upsert(VectorEntry {
				node_id: i as u64,
				vector: unit(i, dim),
			})
			.unwrap();
		}
		let tmp = tempfile::tempdir().unwrap();
		let path = tmp.path().join("vectors.uidx");
		idx.save(&path).unwrap();

		let (d, c) = VectorIndex::metadata(&path).unwrap();
		assert_eq!(d, dim);
		assert_eq!(c, 5);
	}

	#[test]
	fn score_is_similarity_not_distance() {
		let dim = 2;
		let mut idx = VectorIndex::new(dim, 2).unwrap();
		// Two vectors with known cosine similarity 0.5.
		let v1 = vec![1.0f32, 0.0f32];
		let v2 = vec![0.5f32, 0.866_025_4f32]; // cos = 0.5
		idx.upsert(VectorEntry { node_id: 1, vector: v1.clone() })
			.unwrap();
		idx.upsert(VectorEntry { node_id: 2, vector: v2.clone() })
			.unwrap();

		// Search with v1; hit for node 2 should have score ≈ 0.5.
		let hits = idx.search(&v1, 2).unwrap();
		let hit2 = hits.iter().find(|h| h.node_id == 2).expect("node 2 in results");
		assert!(
			(hit2.score - 0.5).abs() < 1e-5,
			"expected score ≈ 0.5, got {}",
			hit2.score
		);
	}
}
