//! Code resolver — pi-natives view.
//!
//! P3.1 (PLAN-334): the host-agnostic READ resolver (`CodeResolverImpl`,
//! `evaluate_query`, predicate evaluation) now lives in the `pi-kernel` crate.
//! This module re-exports it (so existing `super::walker::*` / `super::
//! CodeResolverImpl` references keep compiling unchanged) and adds the
//! pi-natives-only WRITE layer:
//!   - `NativeResolver` (native.rs): a newtype over the kernel resolver that
//!     carries the mutation methods + `impl MutationResolver`. It must be local
//!     to pi-natives — the orphan rule forbids `impl MutationResolver (foreign)
//!     for CodeResolverImpl (foreign)`.
//!   - `mutation` (mutation.rs): the write path, touching `crate::code_buffer`
//!     / `crate::buffer_registry()` — bridge-only, never moves to the kernel.

pub mod mutation;
pub mod native;

/// Re-export shim: the read resolver now lives in `pi-kernel`. Keeps
/// `super::walker::CodeResolverImpl` / `super::walker::evaluate_query` call
/// sites (the ~10 cfg(test) qualifier-test files + mutation.rs) compiling
/// unchanged.
pub mod walker {
	pub use pi_kernel::walker::{CodeResolverImpl, evaluate_query};
}

#[cfg(test)]
mod css_qualifier_tests;
#[cfg(test)]
mod go_qualifier_tests;
#[cfg(test)]
mod hs_qualifier_tests;
#[cfg(test)]
mod html_qualifier_tests;
#[cfg(test)]
mod mdorg_qualifier_tests;
#[cfg(test)]
mod name_predicate_tests;
#[cfg(test)]
mod py_qualifier_tests;
#[cfg(test)]
mod qualifier_tests;
// NOTE: ts_qualifier_tests.rs is orphan (pre-existing failures unrelated to
// PLAN-318; tracked separately). Universal-alias tests for TS live in
// `kind_alias_tests.rs` to stay isolated.
#[cfg(test)]
mod kind_alias_tests;

pub use native::NativeResolver;
pub use pi_kernel::walker::CodeResolverImpl;

use pi_code_path::types::Diagnostic;

/// Convenience constructor: a write-capable [`NativeResolver`] backed by the
/// built-in language registry. Read-only callers use it through `Deref` (the
/// `CodeResolver::resolve` method autoderefs to the kernel resolver); write
/// callers reach the inherent mutation methods directly.
pub fn new() -> Result<NativeResolver, Diagnostic> {
	Ok(NativeResolver(pi_kernel::read::new()?))
}
