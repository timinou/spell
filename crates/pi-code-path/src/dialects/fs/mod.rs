//! FS dialect resolver.
//!
//! Per `specs/code-graph/code-path-dialects/00-fs.md`. Kernel-baked dialect
//! shipping the walker, anchor classifier, predicate evaluator, qualifier
//! resolver, and suffix-fallback fuzzy matcher.

pub mod anchors;
pub mod mutation;
pub mod predicates;
pub mod qualifiers;
pub mod suffix_fallback;
pub mod walker;

use std::{collections::HashMap, path::PathBuf, sync::Arc};

pub use anchors::{DefaultFsAnchorContext, FsAnchor, classify};
pub use predicates::eval as eval_predicate;
pub use qualifiers::resolve as resolve_qualifier;
use suffix_fallback::fs_locator_to_string;
pub use suffix_fallback::{SuffixFallbackResult, try_suffix_match};
pub use walker::{WalkOpts, walk};

use crate::{
	ast::{CodePath, Locator},
	resolver::{CancellationToken, Resolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

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
			match try_suffix_match(loc, &self.root) {
				SuffixFallbackResult::Match(n) => nodes.push(n),
				SuffixFallbackResult::Ambiguous(candidates) => {
					let input = fs_locator_to_string(loc);
					let total = candidates.len();
					let shown: Vec<_> = candidates.iter().take(5).cloned().collect();
					let msg = if total > 5 {
						format!(
							"[DID_YOU_MEAN] No exact match for {}; candidates: {:?} (... and {} more)",
							input,
							shown,
							total - 5
						)
					} else {
						format!("[DID_YOU_MEAN] No exact match for {}; candidates: {:?}", input, shown)
					};
					nodes.push(NodeRef {
						locator:     input,
						range:       0..0,
						kind:        "§not-found".into(),
						content:     None,
						metadata:    {
							let mut m = HashMap::new();
							m.insert(
								"did_you_mean".into(),
								serde_json::to_value(&candidates).unwrap_or_default(),
							);
							m
						},
						diagnostics: vec![Diagnostic {
							variant: DiagnosticVariant::Inaccessible,
							message: msg,
							span:    None,
						}],
					});
				},
				SuffixFallbackResult::NotFound => {},
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

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;
	use crate::ast::{FsLocator, FsSegment};

	#[test]
	fn glob_with_exclusion_excludes_d_ts() {
		let temp = tempfile::tempdir().unwrap();
		fs::write(temp.path().join("foo.ts"), "").unwrap();
		fs::write(temp.path().join("foo.d.ts"), "").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![
					FsSegment::Star,
					FsSegment::Literal(".".to_string()),
					FsSegment::Brace {
						items:      vec!["ts".to_string()],
						exclusions: vec!["d.ts".to_string()],
					},
				],
			}),
			query:     None,
			qualifier: None,
		};
		let resolver = FsResolver::new(temp.path().to_path_buf());
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();

		let names: Vec<_> = nodes
			.iter()
			.map(|n| {
				std::path::Path::new(&n.locator)
					.file_name()
					.unwrap()
					.to_string_lossy()
					.to_string()
			})
			.collect();
		assert!(names.contains(&"foo.ts".to_string()));
		assert!(!names.contains(&"foo.d.ts".to_string()));
	}

	#[test]
	fn resolver_ambiguous_suffix_emits_not_found_node_with_diagnostic() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("a")).unwrap();
		fs::create_dir(root.join("b")).unwrap();
		fs::write(root.join("a/foo.ts"), b"1").unwrap();
		fs::write(root.join("b/foo.ts"), b"2").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("foo.ts".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].kind, "§not-found");
		assert!(!nodes[0].diagnostics.is_empty());
		let diag = &nodes[0].diagnostics[0];
		assert!(
			diag.message.contains("[DID_YOU_MEAN]"),
			"expected DID_YOU_MEAN marker, got: {}",
			diag.message
		);
		assert!(diag.message.contains("a/foo.ts"));
		assert!(diag.message.contains("b/foo.ts"));
		// Metadata should carry the raw candidate list
		let did_you_mean = nodes[0].metadata.get("did_you_mean").unwrap();
		let arr = did_you_mean.as_array().unwrap();
		assert_eq!(arr.len(), 2);
	}
}
