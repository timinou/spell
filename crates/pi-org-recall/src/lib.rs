//! Hybrid org item recall: BM25 + HNSW + typed-graph fusion.
//!
//! Provides three retrieval lanes that compose via Reciprocal Rank Fusion
//! into a single `recall(query)` entry point. See `specs/org-graph-memory.md`
//! for the full architecture.

pub mod embedder;
pub mod error;
pub mod fts;
pub mod personal;
pub mod recall;
pub mod vec;

pub use error::{Error, Result};
