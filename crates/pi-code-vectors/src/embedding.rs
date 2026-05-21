use std::sync::Mutex;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

use crate::error::{Error, Result};

/// Wraps fastembed's `TextEmbedding` for bge-m3 model lifecycle.
/// PLAN-310 W2.5 unified the embedder model across code-graph + memory lanes.
///
/// Thread-safe via internal `Mutex` since `TextEmbedding::embed` requires `&mut
/// self`.
pub struct EmbeddingEngine {
	model: Mutex<TextEmbedding>,
}

// SAFETY: `TextEmbedding` uses `ort::Session` internally which is `Send +
// Sync`. The `Mutex` wrapper provides exclusive access for the `&mut self`
// requirement.
unsafe impl Sync for EmbeddingEngine {}

impl EmbeddingEngine {
	/// Initialize with BAAI/bge-m3 (1024-dim, multilingual). Downloads the model
	/// (~1.2 GB on disk; ~2.5 GB resident) on first call if not already cached.
	pub fn new(show_progress: bool) -> Result<Self> {
		let options = TextInitOptions::new(EmbeddingModel::BGEM3)
			.with_show_download_progress(show_progress);
		let model = TextEmbedding::try_new(options).map_err(|e| Error::Embedding(e.to_string()))?;
		Ok(Self { model: Mutex::new(model) })
	}

	/// Embed a batch of documents. Returns `Vec<Vec<f32>>` of 1024-dim vectors.
	/// fastembed handles tokenization and batching internally.
	pub fn embed_batch(
		&self,
		documents: &[&str],
		batch_size: Option<usize>,
	) -> Result<Vec<Vec<f32>>> {
		let docs: Vec<String> = documents.iter().map(|s| (*s).to_owned()).collect();
		self
			.model
			.lock()
			.map_err(|e| Error::Embedding(format!("mutex poisoned: {e}")))?
			.embed(docs, batch_size)
			.map_err(|e| Error::Embedding(e.to_string()))
	}

	/// Embed a single query string.
	pub fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
		let mut results = self
			.model
			.lock()
			.map_err(|e| Error::Embedding(format!("mutex poisoned: {e}")))?
			.embed(vec![query.to_owned()], None)
			.map_err(|e| Error::Embedding(e.to_string()))?;
		if results.is_empty() {
			return Err(Error::Embedding("Empty embedding result".into()));
		}
		Ok(results.swap_remove(0))
	}
}

#[cfg(all(test, feature = "test-embedding"))]
mod tests {
	use super::*;

	#[test]
	#[ignore = "requires model download (~500 MB)"]
	fn embed_batch_returns_1024_dim_vectors() {
		let engine = EmbeddingEngine::new(false).expect("engine init");
		let docs = &["fn hello() { println!(\"hello\"); }", "class Foo { bar() {} }"];
		let vectors = engine.embed_batch(docs, None).expect("embed_batch");
		assert_eq!(vectors.len(), 2);
		for v in &vectors {
			assert_eq!(v.len(), 1024);
		}
	}

	#[test]
	#[ignore = "requires model download (~500 MB)"]
	fn embed_query_returns_1024_dim_vector() {
		let engine = EmbeddingEngine::new(false).expect("engine init");
		let vector = engine
			.embed_query("find rate limiting logic")
			.expect("embed_query");
		assert_eq!(vector.len(), 1024);
	}

	#[test]
	#[ignore = "requires model download (~500 MB)"]
	fn similar_code_has_higher_similarity() {
		let engine = EmbeddingEngine::new(false).expect("engine init");
		let sort_a = "fn bubble_sort(arr: &mut [i32]) { for i in 0..arr.len() { for j in \
		              0..arr.len()-1-i { if arr[j] > arr[j+1] { arr.swap(j, j+1); } } } }";
		let sort_b = "function quickSort(arr) { if (arr.length <= 1) return arr; const pivot = \
		              arr[0]; const left = arr.filter(x => x < pivot); const right = arr.filter(x \
		              => x > pivot); return [...quickSort(left), pivot, ...quickSort(right)]; }";
		let http = "async fn handle_request(req: Request) -> Response { let body = \
		            req.body().await; Response::ok(body) }";

		let vecs = engine
			.embed_batch(&[sort_a, sort_b, http], None)
			.expect("embed_batch");
		let sim_sorts = cosine_similarity(&vecs[0], &vecs[1]);
		let sim_sort_http = cosine_similarity(&vecs[0], &vecs[2]);
		assert!(
			sim_sorts > sim_sort_http,
			"Two sort implementations ({sim_sorts:.4}) should be more similar than sort vs HTTP \
			 handler ({sim_sort_http:.4})"
		);
	}

	fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
		let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
		let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
		let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
		dot / (norm_a * norm_b)
	}
}
