//! FS dialect resolver.
//!
//! Per `specs/code-graph/code-path-dialects/00-fs.md`. Kernel-baked dialect
//! shipping the walker, anchor classifier, predicate evaluator, qualifier
//! resolver, and suffix-fallback fuzzy matcher.

pub mod anchors;
pub mod predicates;
pub mod qualifiers;
pub mod suffix_fallback;
pub mod walker;

pub use anchors::{DefaultFsAnchorContext, FsAnchor, classify};
pub use predicates::eval as eval_predicate;
pub use qualifiers::resolve as resolve_qualifier;
pub use suffix_fallback::try_suffix_match;
pub use walker::{WalkOpts, walk};

use std::path::PathBuf;
use std::sync::Arc;

use crate::ast::{CodePath, Locator};
use crate::resolver::{CancellationToken, Resolver};
use crate::types::{Diagnostic, DiagnosticVariant, NodeRef};

/// Top-level FS resolver implementing `Resolver`.
pub struct FsResolver {
	pub anchor_ctx: Arc<dyn crate::resolver::FsAnchorContext>,
	pub root:       PathBuf,
}

impl FsResolver {
	pub fn new(root: PathBuf) -> Self {
		Self { anchor_ctx: Arc::new(DefaultFsAnchorContext::new(root.clone())), root }
	}
}

impl Resolver for FsResolver {
	fn resolve(
		&self,
		path: &CodePath,
		cancel: &CancellationToken,
	) -> Result<Vec<NodeRef>, Diagnostic> {
		let loc = match &path.locator {
			Locator::Fs(fs) => fs,
			Locator::Uri(_) => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: "FsResolver received URI locator".into(),
					span:    None,
				});
			},
		};
		let opts = WalkOpts { hidden: true, gitignore: true, root: self.root.clone() };
		let results = walk(loc, &opts, cancel);
		let mut nodes: Vec<NodeRef> = Vec::with_capacity(results.len());
		for r in results {
			match r {
				Ok(n) => nodes.push(n),
				Err(_d) => continue, // per-entry diagnostics swallowed at this layer
			}
		}
		// Suffix fallback if no matches and the locator is plain.
		if nodes.is_empty() {
			if let Some(n) = try_suffix_match(loc, &self.root) {
				nodes.push(n);
			}
		}
		// Apply qualifier if present.
		if let Some(qual) = &path.qualifier {
			let mut out = Vec::new();
			for n in nodes {
				match qualifiers::resolve(&n, qual, &self.root) {
					Ok(more) => out.extend(more),
					Err(d) => return Err(d),
				}
			}
			nodes = out;
		}
		Ok(nodes)
	}
}
