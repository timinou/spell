//! PLAN-315 W2 — daemon-side `pi_knowledge_core::Embedder` adapter.
//!
//! Wraps the existing `EmbeddingEngine` (which loads bge-m3 via fastembed)
//! and exposes the trait `pi_knowledge_core::recall::recall` requires.
//!
//! The adapter borrows the static engine slot from `main.rs` via the same
//! `with_engine` pattern, so a single in-process model is shared across
//! all repos opened in the daemon.

use pi_knowledge_core::{Error as KError, Result as KResult, recall::Embedder};

use crate::engine::{EMBEDDER_DIM, EmbeddingEngine};

/// `Embedder` impl that defers each call to the engine slot. The engine is
/// initialised lazily on first query (matches the existing protocol).
pub struct DaemonEmbedder;

impl Embedder for DaemonEmbedder {
	fn embed_query(&self, text: &str) -> KResult<Vec<f32>> {
		crate::with_engine(|engine: &EmbeddingEngine| engine.embed_query(text))
			.map_err(|e| KError::Embedder(format!("daemon embedder: {e}")))
	}

	fn embed_batch(&self, texts: &[&str]) -> KResult<Vec<Vec<f32>>> {
		crate::with_engine(|engine: &EmbeddingEngine| engine.embed_batch(texts, None))
			.map_err(|e| KError::Embedder(format!("daemon embedder: {e}")))
	}

	fn dim(&self) -> usize {
		// bge-m3 output dimensionality. Keep this in sync with
		// `pi-natives::embedding_worker::EMBEDDER_DIM`. PLAN-310 W2.5.
		EMBEDDER_DIM
	}
}
