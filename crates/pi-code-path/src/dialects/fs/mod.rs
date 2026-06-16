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
		let mut pattern_diagnostics: Vec<Diagnostic> = Vec::new();
		for r in results {
			match r {
				Ok(n) => nodes.push(n),
				Err(d) => {
					// BUG-405 (PLAN-318 W0): permission-denied and per-file walk errors
					// stay swallowed (noisy, not actionable per-entry). Pattern-level
					// errors (invalid glob, unbalanced brace, etc.) MUST propagate so
					// the caller sees why the walk returned nothing instead of
					// silently falling through to suffix fallback.
					if d.message.contains("invalid glob") {
						pattern_diagnostics.push(d);
					}
				},
			}
		}
		if !pattern_diagnostics.is_empty() && nodes.is_empty() {
			// BUG-405 (PLAN-318 W0): emit pattern-level diagnostics on a sentinel
			// §invalid-pattern node so callers see them in the chunk output
			// instead of an abrupt tool-level Err. Skip suffix-fallback —
			// searching for a basename containing the invalid CharClass is noise.
			let input = super::fs::suffix_fallback::fs_locator_to_string(loc);
			nodes.push(NodeRef {
				locator:     input,
				range:       0..0,
				kind:        "§invalid-pattern".into(),
				content:     None,
				metadata:    HashMap::new(),
				diagnostics: pattern_diagnostics,
			});
			return Ok(nodes);
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
			// Ergonomic domain redirect: `#tree` is a DIRECTORY qualifier. When the
			// caller EXPLICITLY addressed a single file with it (one resolved node,
			// a regular file), it silently returns a lone `§file` leaf — a confusing
			// no-op for someone after the file's symbol structure. Name the right
			// qualifier (`#outline`). Gated on a single explicit node so directory
			// walks (`.#tree`, `src/#tree`) that legitimately enumerate file children
			// are unaffected. Mirrors the BUG-444 grep-context domain diagnostic.
			if qual.name == "tree" && nodes.len() == 1 && nodes[0].kind == "§file" {
				// Non-fatal (BUG-444 pattern): keep the §file node so the path still
				// resolves, but attach guidance toward the symbol-structure qualifier
				// rather than throwing a hard error or returning a confusing bare leaf.
				let loc = nodes[0].locator.clone();
				nodes[0].diagnostics.push(Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: format!(
						"#tree is a directory qualifier; `{loc}` is a file — it has no tree to walk. \
						 For its symbol structure use `{loc}#outline`, or read it with `{loc}#raw`"
					),
					span:    None,
				});
				return Ok(nodes);
			}
			// Directory-recursion qualifiers (`#tree`, `#listing`) own their own walk.
			// A bare directory locator pre-resolves to its FULL recursive descendant
			// set (the glob walk), so applying the qualifier to every node would walk
			// nested subtrees repeatedly and concatenate duplicates. Collapse the set
			// to its "top" nodes — those NOT contained by another matched directory —
			// so the qualifier recurses exactly once per disjoint base. Genuinely
			// disjoint bases (e.g. `*/#tree`) survive; nested descendants are dropped.
			if matches!(qual.name.as_str(), "tree" | "listing") {
				nodes = collapse_to_top_dirs(nodes);
			}
			let mut out = Vec::new();
			for n in nodes {
				// BUG-371: §not-found is a sentinel node carrying DID_YOU_MEAN
				// diagnostics — applying #tree / #stat / #listing to it is a
				// category error. Preserve it unchanged in the output.
				if n.kind == "§not-found" {
					out.push(n);
					continue;
				}
				match qualifiers::resolve(&n, qual, &self.root) {
					Ok(more) => out.extend(more),
					Err(d) => return Err(d),
				}
			}
			nodes = out;
			// BUG-371: when a qualifier is present, strip any §not-found
			// sentinel nodes that leaked through from suffix fallback —
			// the caller asked about a specific path (e.g. `#stat`),
			// not a fuzzy DID_YOU_MEAN suggestion.
			nodes.retain(|n| n.kind != "§not-found");
		}
		Ok(nodes)
	}
}

/// Reduce a pre-walked node set to its "top" entries for a directory-recursion
/// qualifier: keep a node only when NO other node in the set is a strict path
/// ancestor of it. A bare directory locator expands (via the recursive glob
/// walk) to every descendant; without this, `#tree`/`#listing` would re-walk
/// each nested directory and emit overlapping, duplicated subtrees.
///
/// Path containment is computed on normalised `/`-separated segments so a name
/// like `srcfoo` is not treated as living under `src`. Sentinel nodes
/// (`§not-found`, `§invalid-pattern`, …) are always retained — the qualifier
/// loop handles them separately.
fn collapse_to_top_dirs(nodes: Vec<NodeRef>) -> Vec<NodeRef> {
	if nodes.len() <= 1 {
		return nodes;
	}
	fn segments(loc: &str) -> Vec<&str> {
		loc.split('/')
			.filter(|s| !s.is_empty() && *s != ".")
			.collect()
	}
	fn is_ancestor(anc: &[&str], desc: &[&str]) -> bool {
		anc.len() < desc.len() && desc.starts_with(anc)
	}
	let is_fs = |kind: &str| matches!(kind, "§dir" | "§file" | "§symlink");
	let seg_list: Vec<Vec<&str>> = nodes.iter().map(|n| segments(&n.locator)).collect();
	let mut keep = Vec::with_capacity(nodes.len());
	for (i, n) in nodes.iter().enumerate() {
		if !is_fs(&n.kind) {
			keep.push(true);
			continue;
		}
		// Drop this node if any OTHER fs node is a strict path ancestor of it.
		let contained = nodes
			.iter()
			.enumerate()
			.any(|(j, other)| j != i && is_fs(&other.kind) && is_ancestor(&seg_list[j], &seg_list[i]));
		keep.push(!contained);
	}
	nodes
		.into_iter()
		.zip(keep)
		.filter_map(|(n, k)| if k { Some(n) } else { None })
		.collect()
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

	// ─────────────────────────────────────────────────────────────
	// BUG-371: <abs-dir>/#tree must not surface bare `metadata error`
	// ─────────────────────────────────────────────────────────────

	/// A target that points to an existing directory MUST resolve as a tree,
	/// whether or not it carries a trailing slash. The grammar treats
	/// `<dir>#tree` as canonical; `<dir>/#tree` is what an agent writes
	/// after seeing `<dir>/` printed in a listing.
	#[test]
	fn bug371_trailing_slash_qualifier_equivalent_to_bare() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();

		// `<abs>/` with a trailing slash. The parser produces a final empty
		// segment after the last `/`; the walker must treat that as the
		// directory itself, identical to the no-slash form.
		let with_slash = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![
					FsSegment::Literal(root.to_string_lossy().to_string()),
					FsSegment::Literal("/".to_string()),
				],
			}),
			query:     None,
			qualifier: Some(crate::ast::Qualifier { name: "tree".to_string(), args: None }),
		};
		let without_slash = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal(root.to_string_lossy().to_string())],
			}),
			query:     None,
			qualifier: Some(crate::ast::Qualifier { name: "tree".to_string(), args: None }),
		};

		let resolver = FsResolver::new(root.clone());
		let a = resolver
			.resolve(&with_slash, &CancellationToken::new())
			.expect("trailing slash + #tree must not error on an existing dir");
		let b = resolver
			.resolve(&without_slash, &CancellationToken::new())
			.expect("control");
		assert_eq!(
			a.len(),
			b.len(),
			"`<dir>/#tree` and `<dir>#tree` must produce the same shape; got {} vs {}",
			a.len(),
			b.len()
		);
		assert!(
			a.iter().any(|n| n.locator.ends_with("src/a.rs")),
			"tree must include src/a.rs, got: {:?}",
			a.iter().map(|n| &n.locator).collect::<Vec<_>>()
		);
	}

	/// Suffix fallback is meant for plain bare-path lookups: "I typed
	/// `foo.ts` and meant `src/foo.ts`". When the CodePath carries an
	/// explicit qualifier the caller is asking about a specific path,
	/// not fuzzy-matching by basename — fallback must NOT fire.
	#[test]
	fn bug371_suffix_fallback_skipped_when_qualifier_present() {
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
			qualifier: Some(crate::ast::Qualifier { name: "stat".to_string(), args: None }),
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert!(
			!nodes.iter().any(|n| n.kind == "§not-found"),
			"§not-found from suffix fallback must not appear with a qualifier; got: {:?}",
			nodes
				.iter()
				.map(|n| (&n.kind, &n.locator))
				.collect::<Vec<_>>()
		);
	}

	/// Even if a §not-found node leaks through, qualifier resolution
	/// must be a no-op on it: applying #tree / #stat / #listing to a
	/// not-found marker is a category error.
	#[test]
	fn bug371_not_found_node_terminal_for_qualifier() {
		use crate::ast::Qualifier;
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		// Construct two basename collisions so the resolver synthesises a
		// §not-found node, then attach a qualifier.
		fs::create_dir(root.join("a")).unwrap();
		fs::create_dir(root.join("b")).unwrap();
		fs::write(root.join("a/cais"), b"").unwrap();
		fs::write(root.join("b/cais"), b"").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("cais".to_string())],
			}),
			query:     None,
			qualifier: Some(Qualifier { name: "tree".to_string(), args: None }),
		};
		let resolver = FsResolver::new(root);
		let res = resolver.resolve(&cp, &CancellationToken::new());
		assert!(
			res.is_ok(),
			"resolver must not surface a bare `metadata error` for §not-found + qualifier; got: {:?}",
			res.as_ref().err().map(|d| &d.message)
		);
	}

	// ─────────────────────────────────────────────────────────────
	// BUG-372: `.` and `.#tree` are the cwd, not hidden filenames.
	// ─────────────────────────────────────────────────────────────

	#[test]
	fn bug372_dot_alias_resolves_to_root() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("README.md"), "hi").unwrap();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(".".to_string())] }),
			query:     None,
			qualifier: None,
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert!(!nodes.is_empty(), "`.` must resolve to the walker root, got empty result");
	}

	#[test]
	fn tree_on_walk_root_has_no_duplicate_subtrees() {
		// A bare directory locator (here the walk root via `.`) pre-resolves to its
		// full recursive descendant set; `#tree` must collapse that to a single base
		// walk, NOT re-walk every nested directory and concatenate duplicates.
		use crate::ast::Qualifier;
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir_all(root.join("src/inner")).unwrap();
		fs::write(root.join("src/main.rs"), "").unwrap();
		fs::write(root.join("src/inner/lib.rs"), "").unwrap();
		fs::write(root.join("a.txt"), "").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(".".to_string())] }),
			query:     None,
			qualifier: Some(Qualifier { name: "tree".to_string(), args: None }),
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		let locators: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
		// Each path appears exactly once — no duplicated subtrees.
		let mut seen = std::collections::HashSet::new();
		for l in &locators {
			assert!(seen.insert(l.clone()), "duplicate node `{l}` in tree: {locators:?}");
		}
		// And the nested grandchild is present (full recursion happened once).
		assert!(
			locators.iter().any(|l| l.ends_with("src/inner/lib.rs")),
			"nested file present: {locators:?}"
		);
	}

	#[test]
	fn bug372_dot_with_tree_qualifier() {
		use crate::ast::Qualifier;
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(".".to_string())] }),
			query:     None,
			qualifier: Some(Qualifier { name: "tree".to_string(), args: None }),
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.ends_with("src/a.rs") || n.locator == "src/a.rs"),
			"`.#tree` must include nested entries, got: {:?}",
			nodes.iter().map(|n| &n.locator).collect::<Vec<_>>()
		);
	}

	#[test]
	fn tree_on_explicit_file_redirects_to_outline() {
		// Ergonomic domain redirect: `file#tree` (single explicit file) must error
		// with guidance toward `#outline`/`#raw` rather than returning a lone §file
		// leaf. Directory `#tree` (incl. `.#tree`) is unaffected — see bug372 above.
		use crate::ast::Qualifier;
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("f.rs"), "fn a() {}\n").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("f.rs".to_string())],
			}),
			query:     None,
			qualifier: Some(Qualifier { name: "tree".to_string(), args: None }),
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		// Non-fatal: the §file node resolves AND carries the redirect diagnostic.
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].kind, "§file");
		let msgs: Vec<_> = nodes[0]
			.diagnostics
			.iter()
			.map(|d| d.message.clone())
			.collect();
		assert!(msgs.iter().any(|m| m.contains("#outline")), "must name #outline: {msgs:?}");
		assert!(msgs.iter().any(|m| m.contains("directory qualifier")), "msgs: {msgs:?}");
	}

	#[test]
	fn bug372_dot_slash_segment_resolves() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();

		// `./src` — leading dot-slash must behave like `src`.
		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![
					FsSegment::Literal(".".to_string()),
					FsSegment::Literal("/".to_string()),
					FsSegment::Literal("src".to_string()),
				],
			}),
			query:     None,
			qualifier: None,
		};
		let resolver = FsResolver::new(root);
		let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.ends_with("src") || n.locator == "src"),
			"`./src` must resolve like `src`, got: {:?}",
			nodes.iter().map(|n| &n.locator).collect::<Vec<_>>()
		);
	}
}
