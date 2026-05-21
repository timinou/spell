//! pi-knowledge-core — shared knowledge layer.
//!
//! Consumed by `pi-code-graph` (code intelligence) and `pi-org-engine`
//! (org/memory). One BM25, one typed graph, one fusion algorithm,
//! one persistence shape.
//!
//! Module wiring lands incrementally per PLAN-310:
//! * W1: `bm25`, `graph`, `fusion`, `cache` (this wave)
//! * W2: `vec` (usearch)
//! * W3: `embedder` (user-scoped pi-embedding-worker client)
//! * W5: `ingest` (notify-driven watcher), `recall` (hybrid orchestrator)

pub mod bm25;
pub mod cache;
pub mod error;
pub mod fusion;
pub mod graph;

pub use error::{Error, Result};
