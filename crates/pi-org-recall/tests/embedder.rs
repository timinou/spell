//! Mock-only tests for MockEmbedder.
//!
//! These tests use the deterministic `MockEmbedder` and do NOT require a real
//! embedding worker. Run with `cargo test -p pi-org-recall --features
//! test-mock`.

#![cfg(feature = "test-mock")]

use pi_org_recall::embedder::{Embedder, MockEmbedder};

#[test]
fn mock_embed_query_returns_dim_768() {
	let embedder = MockEmbedder::new();
	let vec = embedder.embed_query("hello").expect("query should succeed");
	assert_eq!(vec.len(), 768);
}

#[test]
fn mock_embed_batch_returns_one_vector_per_input() {
	let embedder = MockEmbedder::new();
	let texts = &["a", "b", "c"];
	let vectors = embedder.embed_batch(texts).expect("batch should succeed");
	assert_eq!(vectors.len(), 3);
	for v in &vectors {
		assert_eq!(v.len(), 768);
	}
}

/// Compile-time assertion that MockEmbedder implements Send + Sync.
#[test]
fn mock_embedder_is_send_sync() {
	fn assert_send_sync<T: Send + Sync>() {}
	assert_send_sync::<MockEmbedder>();
}

#[test]
fn mock_dimension_consistent_across_calls() {
	let embedder = MockEmbedder::new();
	assert_eq!(embedder.dim(), 768);

	let q = embedder.embed_query("test").unwrap();
	assert_eq!(q.len(), 768);

	let batch = embedder.embed_batch(&["x", "y"]).unwrap();
	for v in &batch {
		assert_eq!(v.len(), 768);
	}
}
