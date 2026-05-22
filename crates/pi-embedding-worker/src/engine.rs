//! `EmbeddingEngine` — fastembed bge-m3 wrapper.
//!
//! Was `pi_code_vectors::EmbeddingEngine` until PLAN-310 W5 deleted that
//! crate. The wrapper is internal to the worker binary; the only consumer is
//! `main.rs`'s socket / stdio dispatch.

use std::sync::Mutex;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

/// Wraps fastembed's `TextEmbedding` for bge-m3 model lifecycle.
///
/// Thread-safe via internal `Mutex` since `TextEmbedding::embed` requires
/// `&mut self`.
pub struct EmbeddingEngine {
	model: Mutex<TextEmbedding>,
}

// SAFETY: `TextEmbedding` uses `ort::Session` internally which is `Send +
// Sync`. The `Mutex` wrapper provides exclusive access for the `&mut self`
// requirement.
unsafe impl Sync for EmbeddingEngine {}

impl EmbeddingEngine {
	/// Initialize with BAAI/bge-m3 (1024-dim, multilingual). Downloads the
	/// model (~1.2 GB on disk; ~2.5 GB resident) on first call if not
	/// already cached.
	pub fn new(show_progress: bool) -> Result<Self, String> {
		let options =
			TextInitOptions::new(EmbeddingModel::BGEM3).with_show_download_progress(show_progress);
		let model = TextEmbedding::try_new(options).map_err(|e| e.to_string())?;
		Ok(Self { model: Mutex::new(model) })
	}

	/// Embed a batch of documents. Returns `Vec<Vec<f32>>` of 1024-dim vectors.
	pub fn embed_batch(
		&self,
		documents: &[&str],
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>, String> {
		let docs: Vec<String> = documents.iter().map(|s| (*s).to_owned()).collect();
		self
			.model
			.lock()
			.map_err(|e| format!("mutex poisoned: {e}"))?
			.embed(docs, batch_size)
			.map_err(|e| e.to_string())
	}

	/// Embed a single query string.
	pub fn embed_query(&self, query: &str) -> Result<Vec<f32>, String> {
		let mut results = self
			.model
			.lock()
			.map_err(|e| format!("mutex poisoned: {e}"))?
			.embed(vec![query.to_owned()], None)
			.map_err(|e| e.to_string())?;
		if results.is_empty() {
			return Err("empty embedding result".into());
		}
		Ok(results.swap_remove(0))
	}
}
