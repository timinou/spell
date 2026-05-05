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
	ast::{Action, ActionKind, CodePath, EdgeKind, MutationOutcome, Query, UriLocator},
	types::{Diagnostic, NodeRef},
};

// ── CancellationToken ────────────────────────────────────────────

/// Hand-rolled cancellation token so resolvers can short-circuit
/// without adding a new crate dependency.
#[derive(Debug, Clone)]
pub struct CancellationToken {
	flag: Arc<AtomicBool>,
}

impl CancellationToken {
	pub fn new() -> Self {
		CancellationToken { flag: Arc::new(AtomicBool::new(false)) }
	}

	pub fn cancel(&self) {
		self.flag.store(true, Ordering::Relaxed);
	}

	pub fn is_cancelled(&self) -> bool {
		self.flag.load(Ordering::Relaxed)
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

/// Resolves URI locators to NodeRefs.
pub trait UriResolver: Send + Sync {
	fn resolve(
		&self,
		uri: &UriLocator,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic>;
}

/// Per-scheme handler for custom URI schemes.
pub trait SchemeHandler: Send + Sync {
	fn handle(&self, path: &str, cancel: &CancellationToken) -> Result<NodeRef, Diagnostic>;
	fn scheme(&self) -> &'static str;
}

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
	/// Whether this resolver claims responsibility for `(path, kind)`.
	///
	/// FEAT-689: dispatchers MUST consult `path` (not just `kind`) so a
	/// symbol-target Delete is not silently routed to FsResolver, which
	/// would `remove_file` the entire host file.
	fn supports(&self, path: &CodePath, kind: ActionKind) -> bool {
		let _ = (path, kind);
		false
	}

	fn apply(
		&self,
		target: &CodePath,
		action: &Action,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, Diagnostic> {
		let _ = (target, action, cancel);
		Err(Diagnostic {
			variant: crate::types::DiagnosticVariant::UnsupportedOperation,
			message: format!("unsupported action: {:?}", action.kind()),
			span: None,
		})
	}
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
}
