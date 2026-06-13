//! NAPI integration layer for the CodePath kernel.
//!
//! Per `specs/code-graph/code-path-extensions.md`. Concrete resolver impls
//! live here (CodeResolver via tree-sitter, EdgeResolver via pi-code-graph,
//! 9 URI scheme handlers, 11 FormatExtractors, image pipeline). The kernel
//! itself stays at `pi-code-path` (no cyclic dep into pi-code-engine /
//! pi-code-graph).

pub mod abort;
pub mod code_resolver;
pub mod commit_guard;
pub mod css_resolver;
/// Re-export shim: `dialect_registry` now lives in `pi-kernel` (P3.3a). Keeps
/// `dialect_registry::select_dialect` call sites (napi.rs select_lexer,
/// dispatch_tests) compiling unchanged.
pub mod dialect_registry {
	pub use pi_kernel::dialect_registry::*;
}
pub mod diff_qualifier;
pub mod edge_dispatch;
// P5.A (PLAN-336): the edge resolver moved to pi-kernel (host-agnostic, shared
// with the BEAM NIF). Re-exported so `code_path::edge_resolver::*` resolves.
pub use pi_kernel::edge_resolver;
pub mod edit_history;
pub mod extractors;
pub mod heading_resolver;
pub mod image_pipeline;
pub mod introspection_napi;
pub mod manage;
pub mod marshal;
pub mod napi;
pub mod runtime_schemes;
pub mod scheme_callback;
pub mod semantic_dispatch;
pub mod type_resolver;
pub mod uri;

#[cfg(test)]
mod dispatch_tests;
#[cfg(test)]
mod kernel_parity_tests;
#[cfg(test)]
mod language_matrix_tests;
#[cfg(test)]
mod manage_tests;
#[cfg(test)]
mod op_matrix_tests;
#[cfg(test)]
mod routing_tests;
#[cfg(test)]
mod unified_tests;
