//! NAPI integration layer for the CodePath kernel.
//!
//! Per `specs/code-graph/code-path-extensions.md`. Concrete resolver impls
//! live here (CodeResolver via tree-sitter, EdgeResolver via pi-code-graph,
//! 9 URI scheme handlers, 11 FormatExtractors, image pipeline). The kernel
//! itself stays at `pi-code-path` (no cyclic dep into pi-code-engine /
//! pi-code-graph).

pub mod abort;
pub mod code_resolver;
pub mod dialect_registry;
pub mod edge_resolver;
pub mod edit_history;
pub mod extractors;
pub mod image_pipeline;
pub mod manage;
pub mod marshal;
pub mod napi;
pub mod uri;

#[cfg(test)]
mod dispatch_tests;
#[cfg(test)]
mod manage_tests;
#[cfg(test)]
mod routing_tests;
