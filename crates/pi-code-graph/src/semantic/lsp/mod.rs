//! LSP-backed [`crate::semantic::SemanticBackend`].
//!
//! - [`client`] — synchronous JSON-RPC client (PLAN-319 W1 task-1)
//! - [`registry`] — per-server spawn / LRU / idle-TTL (PLAN-319 W1 task-2)
//! - [`sync`] — code_buffer ↔ didOpen/didChange/didSave/didClose (W1 task-3)
//! - [`diagnostics`] — push-notification cache (W1 task-5)
//! - [`backend`] — `LspSemanticBackend` trait impl (W1 task-4)

pub mod client;
pub mod registry;
pub mod sync;
pub mod diagnostics;
pub mod backend;

pub use backend::LspSemanticBackend;
pub use client::{LspClient, LspClientError};
pub use registry::{LspRegistry, ServerSpec};
