//! pi-kernel — the host-agnostic kernel read core (PLAN-334 / P3.1).
//!
//! Carved out of `pi-natives` so a BEAM rustler skin can drive the SAME read
//! resolver that the NAPI skin uses, over `pi-code-path` / `pi-code-engine`
//! types only. Per N-2 this crate serves the READ lane (file/symbol/outline/
//! diff resolution); writes, the buffer registry, undo history, and the
//! code-graph index stay bridge-side in `pi-natives`.
//!
//! Invariant: this crate MUST NOT depend on `napi`, `rustler`, or any
//! host-specific symbol. The error type is `pi_code_path::types::Diagnostic`
//! (already host-agnostic); each skin maps it to its own error.

pub mod predicates;
pub mod read;
pub mod walker;

pub use read::resolve_read;
pub use walker::{CodeResolverImpl, evaluate_query};

/// The kernel's read-lane error. Today an alias of the resolver's native
/// `Diagnostic` (already host-agnostic); promote to an enum wrapping it if a
/// nominal boundary type is later required by the rustler skin.
pub type KernelError = pi_code_path::types::Diagnostic;
