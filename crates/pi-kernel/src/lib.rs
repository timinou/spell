//! pi-kernel — the host-agnostic kernel read core (PLAN-334 / P3.1).
//!
//! Carved out of `pi-natives` so a BEAM rustler skin can drive the SAME read
//! resolver that the NAPI skin uses, over `pi-code-path` / `pi-code-engine`
//! types only. Per N-2 this crate serves the READ lane (file/symbol/outline/
//! diff resolution).
//!
//! P5.A (PLAN-336): the code-graph INDEX (`graph_cache`) and the EDGE resolver
//! (`edge_resolver`) now live here too — both depend only on host-agnostic
//! `pi-code-graph`, so a BEAM NIF can serve `def→/ref→/call→/import→/bind→`
//! edges from ONE warm resident index shared across N agents (WS-B). Writes,
//! the buffer registry, and undo history stay bridge-side in `pi-natives`.
//!
//! Invariant: this crate MUST NOT depend on `napi`, `rustler`, or any
//! host-specific symbol. The error type is `pi_code_path::types::Diagnostic`
//! (already host-agnostic); each skin maps it to its own error.

pub mod dialect_registry;
pub mod edge_resolver;
pub mod edges;
pub mod edit_ops;
pub mod graph_cache;
pub mod parse;
pub mod predicates;
pub mod read;
pub mod walker;

pub use edge_resolver::EdgeResolverImpl;
pub use edges::{EdgeOutput, edge_position, resolve_edges};
pub use edit_ops::{ApplyEditOutcome, apply_edit};
pub use graph_cache::{
	CachedGraph, DiskCacheState, disk_cache_state, get_or_build_graph, invalidate,
	invalidate_for_file, peek, warm_count,
};
pub use parse::{ResolveOutput, resolve_target, select_lexer};
pub use read::resolve_read;
pub use walker::{CodeResolverImpl, evaluate_query};

/// The kernel's read-lane error. Today an alias of the resolver's native
/// `Diagnostic` (already host-agnostic); promote to an enum wrapping it if a
/// nominal boundary type is later required by the rustler skin.
pub type KernelError = pi_code_path::types::Diagnostic;
