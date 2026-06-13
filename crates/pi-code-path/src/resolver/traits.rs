//! Resolver trait contracts.
//!
//! No concrete implementations live here; sub-resolvers are wired by
//! PROJ-066/067/068/069.

use std::{
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use crate::{
	ast::{CodePath, EdgeKind, MutationOutcome, Query},
	types::{Diagnostic, NodeRef},
};

// ── CancellationToken ────────────────────────────────────────────

/// Hand-rolled cancellation token so resolvers can short-circuit
/// without adding a new crate dependency.
///
/// Two cancellation sources, both surfaced through `is_cancelled()`:
/// - the `flag`: flipped by `cancel()` (in-tree, e.g. a resolver giving up).
/// - an optional `host_probe`: a host-supplied closure polled on each check, so
///   an EXTERNAL abort (napi `AbortSignal` / timeout deadline) reflects LIVE into
///   the kernel's mid-walk guards (FUP-132). The probe result is latched into
///   `flag` the first time it returns true, so it is polled at most until the
///   first abort and every clone then short-circuits on the shared flag.
#[derive(Clone)]
pub struct CancellationToken {
	flag:       Arc<AtomicBool>,
	host_probe: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl std::fmt::Debug for CancellationToken {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("CancellationToken")
			.field("cancelled", &self.flag.load(Ordering::Relaxed))
			.field("host_probe", &self.host_probe.is_some())
			.finish()
	}
}

impl CancellationToken {
	pub fn new() -> Self {
		CancellationToken { flag: Arc::new(AtomicBool::new(false)), host_probe: None }
	}

	/// Create a token whose cancellation is driven by a host-supplied probe
	/// (FUP-132). The probe is polled on every `is_cancelled()` until it first
	/// returns true, at which point the result latches into the shared flag.
	pub fn with_host_probe<F>(probe: F) -> Self
	where
		F: Fn() -> bool + Send + Sync + 'static,
	{
		CancellationToken { flag: Arc::new(AtomicBool::new(false)), host_probe: Some(Arc::new(probe)) }
	}

	pub fn cancel(&self) {
		self.flag.store(true, Ordering::Relaxed);
	}

	pub fn is_cancelled(&self) -> bool {
		if self.flag.load(Ordering::Relaxed) {
			return true;
		}
		// Consult the host probe; latch a positive into the shared flag so the
		// poll happens at most once per abort and all clones short-circuit after.
		if let Some(probe) = &self.host_probe
			&& probe()
		{
			self.flag.store(true, Ordering::Relaxed);
			return true;
		}
		false
	}
}

impl Default for CancellationToken {
	fn default() -> Self {
		Self::new()
	}
}

// ── Top-level resolver ───────────────────────────────────────────

/// The resolver trait — implementations are dialect/system-specific.
pub trait Resolver {
	/// Resolve a parsed CodePath to a sequence of NodeRefs.
	fn resolve(
		&self,
		path: &CodePath,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic>;
}

// ── Sub-resolver traits ──────────────────────────────────────────

/// Resolves code queries inside a single file.
pub trait CodeResolver: Send + Sync {
	fn resolve(
		&self,
		file: &Path,
		query: &Query,
		qualifier: Option<&crate::ast::Qualifier>,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic>;
}

/// Resolves graph-edge traversals.
pub trait EdgeResolver: Send + Sync {
	fn resolve(
		&self,
		source: &NodeRef,
		kind: EdgeKind,
		depth: Option<usize>,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic>;
}

// FEAT-722-era UriResolver + SchemeHandler traits removed in PLAN-310.
// Kernel SchemeRegistry (scheme_dispatch.rs) is the canonical surface.

/// Filesystem anchor context — tells the resolver how to classify
/// file extensions and basenames.
pub trait FsAnchorContext: Send + Sync {
	fn is_code_extension(&self, ext: &str) -> bool;
	fn is_image_extension(&self, ext: &str) -> bool;
	fn is_doc_extension(&self, ext: &str) -> bool;
	fn is_lockfile_basename(&self, name: &str) -> bool;
	/// Root directory for resolving relative paths.
	fn root(&self) -> Option<&std::path::Path> {
		None
	}
}

/// Extracts text from binary or structured formats (pdf, docx, …).
pub trait FormatExtractor: Send + Sync {
	fn extracts(&self, ext: &str) -> bool;
	fn extract(&self, bytes: &[u8], cancel: &CancellationToken) -> Result<String, Diagnostic>;
}

/// Applies mutations (edit actions) to a resolved target.
pub trait MutationResolver: Send + Sync {
	/// Returns Some(_) iff this resolver owns the Op's variant family.
	/// Returns None to defer to the next resolver in the dispatch chain.
	///
	/// The dispatcher (napi.rs::dispatch_op) statically proves exactly
	/// one resolver owns each Op variant via exhaustive match; in practice
	/// Some(_) is mandatory when dispatch_op routes here.
	///
	/// Wave 2 (PLAN-304): replaces `supports + apply` with typed Op-based
	/// dispatch. The exhaustive match in dispatch_op ensures totality at
	/// compile time — adding an Op variant without updating the dispatcher
	/// = compile error.
	fn try_apply(
		&self,
		op: &crate::op::Op,
		cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>>;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn token_starts_uncancelled() {
		let t = CancellationToken::new();
		assert!(!t.is_cancelled());
	}

	#[test]
	fn token_cancels() {
		let t = CancellationToken::new();
		t.cancel();
		assert!(t.is_cancelled());
	}

	#[test]
	fn token_clone_shares_state() {
		let t = CancellationToken::new();
		let t2 = t.clone();
		t2.cancel();
		assert!(t.is_cancelled());
	}

	// FUP-132: a host-abort probe makes is_cancelled() reflect an EXTERNAL abort
	// (AbortSignal/deadline) live, so the kernel's mid-walk guard fires the instant
	// the host aborts — not only at the post-match boundary.
	#[test]
	fn host_probe_drives_cancellation_live() {
		use std::sync::Arc;
		use std::sync::atomic::{AtomicBool, Ordering};

		let host_aborted = Arc::new(AtomicBool::new(false));
		let probe_flag = host_aborted.clone();
		let t = CancellationToken::with_host_probe(move || probe_flag.load(Ordering::Relaxed));

		// Not aborted yet → walk continues.
		assert!(!t.is_cancelled());

		// Host aborts MID-WALK → the very next guard check observes it.
		host_aborted.store(true, Ordering::Relaxed);
		assert!(t.is_cancelled());
	}

	// FUP-132: the probe result latches — once cancelled, stays cancelled even if the
	// host flag flaps back (cheap + monotonic, matches cooperative-cancel semantics).
	#[test]
	fn host_probe_latches() {
		use std::sync::Arc;
		use std::sync::atomic::{AtomicBool, Ordering};

		let host_aborted = Arc::new(AtomicBool::new(true));
		let probe_flag = host_aborted.clone();
		let t = CancellationToken::with_host_probe(move || probe_flag.load(Ordering::Relaxed));

		assert!(t.is_cancelled());
		host_aborted.store(false, Ordering::Relaxed);
		assert!(t.is_cancelled(), "cancellation must latch");
	}

	// FUP-132: a clone shares the latched flag; a probe firing on one is visible on
	// the other (the kernel clones the token down through resolvers).
	#[test]
	fn host_probe_clone_shares_latched_state() {
		use std::sync::Arc;
		use std::sync::atomic::{AtomicBool, Ordering};

		let host_aborted = Arc::new(AtomicBool::new(false));
		let probe_flag = host_aborted.clone();
		let t = CancellationToken::with_host_probe(move || probe_flag.load(Ordering::Relaxed));
		let t2 = t.clone();

		host_aborted.store(true, Ordering::Relaxed);
		// Observing on t latches the shared flag…
		assert!(t.is_cancelled());
		// …so the clone sees it too, even without re-probing.
		assert!(t2.is_cancelled());
	}
}
