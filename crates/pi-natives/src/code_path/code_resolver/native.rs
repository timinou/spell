//! `NativeResolver` — the pi-natives write-capable wrapper over the kernel's
//! read resolver (P3.1 / PLAN-334).
//!
//! Why a newtype and not free functions: `mutation.rs` carries
//! `impl MutationResolver for <resolver>`. After the read resolver moved to
//! `pi-kernel`, both `MutationResolver` (pi-code-path) and `CodeResolverImpl`
//! (pi-kernel) are foreign to pi-natives, so `impl MutationResolver for
//! CodeResolverImpl` would be an E0117 orphan violation. A LOCAL newtype is the
//! only legal carrier for the foreign-trait impl + the inherent write methods.
//!
//! `Deref<Target = CodeResolverImpl>` makes the read surface transparent:
//! callers with `pi_code_path::resolver::CodeResolver` in scope invoke
//! `.resolve(..)` and it autoderefs to the kernel resolver. The inherent
//! mutation methods (defined in `mutation.rs` on `NativeResolver`) take
//! precedence and are reached directly.

use std::{ops::Deref, path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_kernel::walker::CodeResolverImpl;

/// Write-capable resolver: the kernel read resolver + the pi-natives mutation
/// methods (see `mutation.rs`).
pub struct NativeResolver(pub CodeResolverImpl);

impl NativeResolver {
	/// Wrap a fresh kernel resolver over the given registry.
	pub fn new(registry: Arc<LanguageRegistry>) -> Self {
		Self(CodeResolverImpl::new(registry))
	}

	/// Builder: set the absolutisation root (forwards to the kernel resolver).
	pub fn with_root(self, root: PathBuf) -> Self {
		Self(self.0.with_root(root))
	}

	/// Builder: set the session id (forwards to the kernel resolver).
	pub fn with_session_id(self, sid: String) -> Self {
		Self(self.0.with_session_id(sid))
	}
}

impl Deref for NativeResolver {
	type Target = CodeResolverImpl;

	fn deref(&self) -> &CodeResolverImpl {
		&self.0
	}
}
