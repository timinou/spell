//! Resolve dispatch engine.
//!
//! Routes a CodePath to the appropriate sub-resolver based on locator kind.
//! Currently a stub: FS branch executes a closure-stub; URI/Edge emit
//! diagnostics until PROJ-066/067 wire concrete impls.

use std::collections::HashMap;
use std::sync::Arc;

use crate::ast::{CodePath, Locator};
use crate::resolver::traits::{
	CancellationToken, CodeResolver, EdgeResolver, FormatExtractor, FsAnchorContext,
	SchemeHandler,
};
use crate::types::{Diagnostic, DiagnosticVariant, NodeRef};

/// Shared context passed through every resolve call.
pub struct ResolveContext {
	pub fs_anchor:   Arc<dyn FsAnchorContext>,
	pub extractors:  Vec<Arc<dyn FormatExtractor>>,
	pub schemes:     HashMap<String, Arc<dyn SchemeHandler>>,
	pub code_resolver: Option<Arc<dyn CodeResolver>>,
	pub edge_resolver: Option<Arc<dyn EdgeResolver>>,
	pub cancel:      CancellationToken,
}

/// Dispatch engine: routes CodePath to sub-resolvers.
pub struct DispatchEngine;

impl DispatchEngine {
	pub fn new() -> Self {
		DispatchEngine
	}

	/// Dispatch a CodePath through the appropriate resolver branch.
	pub fn dispatch(
		&self,
		cp: &CodePath,
		_ctx: &ResolveContext,
	) -> Result<Vec<NodeRef>, Diagnostic> {
		match &cp.locator {
			Locator::Fs(_fs) => {
				// Stub: FS resolver will be wired by PROJ-066.
				Ok(vec![])
			},
			Locator::Uri(uri) => {
				let msg = format!("dispatch routing not yet implemented for uri-{}", uri.scheme);
				Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: msg,
					span:    None,
				})
			},
		}
	}
}

impl Default for DispatchEngine {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ast::{FsLocator, FsSegment, UriLocator};

	/// A no-op FsAnchorContext for tests.
	struct NoopFsAnchor;

	impl FsAnchorContext for NoopFsAnchor {
		fn is_code_extension(&self, _ext: &str) -> bool {
			false
		}
		fn is_image_extension(&self, _ext: &str) -> bool {
			false
		}
		fn is_doc_extension(&self, _ext: &str) -> bool {
			false
		}
		fn is_lockfile_basename(&self, _name: &str) -> bool {
			false
		}
	}

	fn empty_context() -> ResolveContext {
		ResolveContext {
			fs_anchor:     Arc::new(NoopFsAnchor),
			extractors:    vec![],
			schemes:       HashMap::new(),
			code_resolver: None,
			edge_resolver: None,
			cancel:        CancellationToken::new(),
		}
	}

	#[test]
	fn fs_branch_executes() {
		let engine = DispatchEngine::new();
		let ctx = empty_context();
		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("src".to_string()), FsSegment::Literal("/".to_string()), FsSegment::Literal("main.rs".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let res = engine.dispatch(&cp, &ctx);
		assert!(res.is_ok());
		assert_eq!(res.unwrap().len(), 0);
	}

	#[test]
	fn uri_branch_emits_diagnostic() {
		let engine = DispatchEngine::new();
		let ctx = empty_context();
		let cp = CodePath {
			locator:   Locator::Uri(UriLocator {
				scheme: "artifact".to_string(),
				path:   "abc".to_string(),
			}),
			query:     None,
			qualifier: None,
		};
		let res = engine.dispatch(&cp, &ctx);
		assert!(res.is_err());
		let diag = res.unwrap_err();
		assert!(matches!(diag.variant, DiagnosticVariant::ParseError));
		assert!(diag.message.contains("dispatch routing not yet implemented"));
		assert!(diag.message.contains("uri-artifact"));
	}
}
