//! HNSW vector recall lane keyed by org item id.
//!
//! Wraps `pi_code_vectors::VectorIndex` with a `String`-keyed id mapping and
//! disk serialization. Duplicate inserts replace the old vector (O(n) rebuild).

use std::{
	collections::HashMap,
	io::{BufReader, BufWriter, Read, Write},
	path::Path,
};

use pi_code_vectors::{VectorEntry, VectorIndex as InnerIndex};
use tracing::warn;

use crate::{Error, Result};

/// Magic bytes for the container format.
const MAGIC: &[u8; 12] = b"SPELL_REC_V1";

/// In-memory vector index mapping string ids to embedding vectors.
///
/// Internally delegates to `pi_code_vectors::VectorIndex` (HNSW). On
/// duplicate-`id` insert, the entire index is rebuilt in O(n).
pub struct VecIndex {
	inner:      InnerIndex,
	id_to_node: HashMap<String, usize>,
	node_to_id: Vec<String>,
	/// Shadow vector storage used during O(n) rebuild on duplicate insert.
	vectors:    Vec<Vec<f32>>,
	dim:        usize,
}

impl VecIndex {
	/// Create a new empty index with the given vector dimensionality.
	pub fn new(dim: usize) -> Self {
		Self {
			inner: InnerIndex::new(Vec::new(), dim),
			id_to_node: HashMap::new(),
			node_to_id: Vec::new(),
			vectors: Vec::new(),
			dim,
		}
	}

	/// Insert a vector by string id.
	///
	/// If `id` already exists, the old vector is replaced (triggers an O(n)
	/// rebuild of the HNSW graph).
	///
	/// Zero-norm vectors (`‖v‖ < 1e-9`) are logged as warnings and skipped.
	pub fn insert(&mut self, id: String, vector: Vec<f32>) -> Result<()> {
		if vector.len() != self.dim {
			return Err(Error::DimensionMismatch { expected: self.dim, actual: vector.len() });
		}

		// Detect zero-norm vector → skip
		let norm: f32 = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
		if norm < 1e-9 {
			warn!("skipping zero-norm vector for id={id}: ‖v‖={norm:e} < 1e-9",);
			return Ok(());
		}

		if let Some(&existing_node) = self.id_to_node.get(&id) {
			// Replace: update the vector at the existing position
			self.vectors[existing_node] = vector;
		} else {
			// New id
			let node_idx = self.node_to_id.len();
			self.id_to_node.insert(id.clone(), node_idx);
			self.node_to_id.push(id);
			self.vectors.push(vector);
		}

		// Rebuild the inner index from scratch
		let entries: Vec<VectorEntry> = self
			.vectors
			.iter()
			.enumerate()
			.map(|(node_idx, v)| VectorEntry { node_index: node_idx, vector: v.clone() })
			.collect();
		self.inner = InnerIndex::new(entries, self.dim);
		Ok(())
	}

	/// Search for nearest neighbours by cosine similarity.
	/// Results are sorted by descending score, with ties broken by ascending id.
	pub fn search(&self, query: &[f32], limit: usize) -> Result<Vec<(String, f32)>> {
		let hits = self.inner.search(query, limit)?;
		let mut results: Vec<(String, f32)> = hits
			.into_iter()
			.map(|hit| {
				let id = self
					.node_to_id
					.get(hit.node_index)
					.cloned()
					.unwrap_or_default();
				(id, hit.score)
			})
			.collect();
		// Sort: descending by score, then ascending by id for ties
		results.sort_by(|a, b| {
			b.1.total_cmp(&a.1) // score descending
				.then_with(|| a.0.cmp(&b.0)) // id ascending
		});
		results.truncate(limit);
		Ok(results)
	}

	/// Dimensionality of indexed vectors.
	pub fn dim(&self) -> usize {
		self.dim
	}

	/// Number of indexed entries.
	pub fn len(&self) -> usize {
		self.node_to_id.len()
	}

	/// Whether the index is empty.
	pub fn is_empty(&self) -> bool {
		self.node_to_id.is_empty()
	}

	/// Serialize to a file path.
	pub fn to_disk(&self, path: &Path) -> Result<()> {
		let file = std::fs::File::create(path)?;
		let mut writer = BufWriter::new(file);

		// Write outer magic
		writer.write_all(MAGIC)?;

		// Write id_to_node and node_to_id as bincode
		bincode::serialize_into(&mut writer, &self.id_to_node)
			.map_err(|e| Error::Serialization(e.to_string()))?;
		bincode::serialize_into(&mut writer, &self.node_to_id)
			.map_err(|e| Error::Serialization(e.to_string()))?;

		// Write inner persisted index
		let persisted = self.inner.to_persisted("", 0);
		pi_code_vectors::serialize_index(&mut writer, &persisted)?;

		writer.flush()?;
		Ok(())
	}

	/// Deserialize from a file path.
	pub fn from_disk(path: &Path) -> Result<Self> {
		let file = std::fs::File::open(path)?;
		let mut reader = BufReader::new(file);

		// Read and validate outer magic
		let mut magic = [0u8; 12];
		reader.read_exact(&mut magic)?;
		if magic != *MAGIC {
			return Err(Error::Serialization(format!(
				"unknown magic bytes: expected SPELL_REC_V1, got {:?}",
				std::str::from_utf8(&magic).unwrap_or("invalid utf8"),
			)));
		}

		// Read id_to_node and node_to_id
		let id_to_node: HashMap<String, usize> = bincode::deserialize_from(&mut reader)
			.map_err(|e| Error::Serialization(format!("id_to_node: {e}")))?;
		let node_to_id: Vec<String> = bincode::deserialize_from(&mut reader)
			.map_err(|e| Error::Serialization(format!("node_to_id: {e}")))?;

		// Read inner persisted index
		let persisted = pi_code_vectors::deserialize_index(&mut reader)?;
		let dim = persisted.dimensions;
		// Extract vectors from persisted entries before consuming
		let vectors: Vec<Vec<f32>> = persisted.entries.iter().map(|e| e.vector.clone()).collect();
		let inner = InnerIndex::from_persisted(persisted);

		Ok(Self { inner, id_to_node, node_to_id, vectors, dim })
	}
}
