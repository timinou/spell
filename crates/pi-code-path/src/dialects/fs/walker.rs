use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use ignore::WalkBuilder;

use crate::{
	ast::{FsLocator, FsSegment},
	parser,
	resolver::traits::CancellationToken,
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

/// Options controlling filesystem walk behaviour.
#[derive(Debug, Clone)]
pub struct WalkOpts {
	pub hidden:    bool,
	pub gitignore: bool,
	pub root:      PathBuf,
}

impl Default for WalkOpts {
	fn default() -> Self {
		WalkOpts { hidden: true, gitignore: true, root: PathBuf::new() }
	}
}

/// Eagerly walk the filesystem matching `loc`, returning a `Vec` of
/// `Result<NodeRef, Diagnostic>`.
///
/// Cancellation is checked every 100 entries.  Permission-denied
/// entries yield `Err(Diagnostic)` but do **not** abort the walk.
pub fn walk(
	loc: &FsLocator,
	opts: &WalkOpts,
	cancel: &CancellationToken,
) -> Vec<Result<NodeRef, Diagnostic>> {
	let pattern = fs_locator_to_glob(loc);
	let mut builder = WalkBuilder::new(&opts.root);
	builder.hidden(!opts.hidden);
	builder.git_ignore(opts.gitignore);
	// Honour `.gitignore` even outside a git repo (e.g. tempdir tests, project
	// subtrees).
	if opts.gitignore {
		builder.add_custom_ignore_filename(".gitignore");
	}

	let globset = build_globset(&pattern);
	let negative_globsets = build_negative_globsets(loc);

	let mut results = Vec::new();
	let mut count = 0;

	for entry in builder.build() {
		count += 1;
		if count % 100 == 0 && cancel.is_cancelled() {
			break;
		}

		match entry {
			Ok(ent) => {
				let path = ent.path();
				let rel = match path.strip_prefix(&opts.root) {
					Ok(r) => r,
					Err(_) => continue,
				};
				let rel_str = rel.to_string_lossy().to_string();

				if let Some(ref gs) = globset {
					if !gs.is_match(rel) {
						continue;
					}
				}
				if negative_globsets.iter().any(|ngs| ngs.is_match(rel)) {
					continue;
				}

				let (kind, size) = match ent.file_type() {
					Some(ft) if ft.is_dir() => ("§dir".to_string(), 0u64),
					Some(ft) if ft.is_symlink() => ("§symlink".to_string(), 0u64),
					_ => {
						let sz = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
						("§file".to_string(), sz)
					},
				};

				let range = 0..size as usize;

				results.push(Ok(NodeRef {
					locator: rel_str,
					range,
					kind,
					content: None,
					metadata: HashMap::new(),
					diagnostics: Vec::new(),
				}));
			},
			Err(err) => {
				// `ignore::Error` doesn't expose the path uniformly across variants;
				// stringify the error which already includes path context.
				let path = err.to_string();
				let is_perm = err
					.io_error()
					.map(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
					.unwrap_or(false);
				let msg = if is_perm {
					format!("permission denied: {path}")
				} else {
					format!("walk error: {path}: {err}")
				};
				results.push(Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: msg,
					span:    None,
				}));
			},
		}
	}

	results
}

fn build_globset(pattern: &str) -> Option<globset::GlobSet> {
	if pattern.is_empty() || pattern == "**" {
		return None;
	}
	let mut builder = globset::GlobSetBuilder::new();
	match globset::Glob::new(pattern) {
		Ok(glob) => {
			builder.add(glob);
		},
		Err(_) => return None,
	}
	builder.build().ok()
}
fn build_negative_globsets(loc: &FsLocator) -> Vec<globset::GlobSet> {
	let segments = if loc.segments.len() == 1 {
		if let FsSegment::Literal(raw) = &loc.segments[0] {
			parser::tokenise_fs_path(raw).unwrap_or_else(|_| loc.segments.clone())
		} else {
			loc.segments.clone()
		}
	} else {
		loc.segments.clone()
	};

	let mut result = Vec::new();
	for (i, seg) in segments.iter().enumerate() {
		if let FsSegment::Brace { items: _, exclusions } = seg {
			for excl in exclusions {
				let mut pattern = String::new();
				for (j, s) in segments.iter().enumerate() {
					match s {
						FsSegment::Literal(s) => {
							if s == "/" {
								pattern.push('/');
							} else {
								for c in s.chars() {
									if matches!(c, '*' | '?' | '[' | ']' | '{' | '}') {
										pattern.push('[');
										pattern.push(c);
										pattern.push(']');
									} else {
										pattern.push(c);
									}
								}
							}
						},
						FsSegment::Star => pattern.push('*'),
						FsSegment::DoubleStar => pattern.push_str("**"),
						FsSegment::Question => pattern.push('?'),
						FsSegment::CharClass(chars) => {
							pattern.push('[');
							for c in chars {
								pattern.push(*c);
							}
							pattern.push(']');
						},
						FsSegment::Brace { items, exclusions: _ } => {
							if i == j {
								pattern.push('{');
								pattern.push_str(excl);
								pattern.push('}');
							} else {
								pattern.push('{');
								pattern.push_str(&items.join(","));
								pattern.push('}');
							}
						},
					}
				}
				if let Some(gs) = build_globset(&pattern) {
					result.push(gs);
				}
			}
		}
	}
	result
}
fn fs_locator_to_glob(loc: &FsLocator) -> String {
	let segments = if loc.segments.len() == 1 {
		if let FsSegment::Literal(raw) = &loc.segments[0] {
			parser::tokenise_fs_path(raw).unwrap_or_else(|_| loc.segments.clone())
		} else {
			loc.segments.clone()
		}
	} else {
		loc.segments.clone()
	};

	let mut out = String::new();
	for seg in &segments {
		match seg {
			FsSegment::Literal(s) => {
				if s == "/" {
					out.push('/');
				} else {
					for c in s.chars() {
						if matches!(c, '*' | '?' | '[' | ']' | '{' | '}') {
							out.push('[');
							out.push(c);
							out.push(']');
						} else {
							out.push(c);
						}
					}
				}
			},
			FsSegment::Star => out.push('*'),
			FsSegment::DoubleStar => out.push_str("**"),
			FsSegment::Question => out.push('?'),
			FsSegment::CharClass(chars) => {
				out.push('[');
				for c in chars {
					out.push(*c);
				}
				out.push(']');
			},
			FsSegment::Brace { items, exclusions: _ } => {
				out.push('{');
				out.push_str(&items.join(","));
				out.push('}');
			},
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	fn make_walker_root() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
		fs::write(root.join("src/lib.rs"), "pub fn lib() {}").unwrap();
		fs::create_dir(root.join("tests")).unwrap();
		fs::write(root.join("tests/a.rs"), "").unwrap();
		(dir, root)
	}

	#[test]
	fn walk_all_files() {
		let (_dir, root) = make_walker_root();
		let loc = FsLocator { segments: vec![FsSegment::Literal("**".to_string())] };
		let opts = WalkOpts { hidden: true, gitignore: true, root };
		let results = walk(&loc, &opts, &CancellationToken::new());
		let nodes: Vec<_> = results.into_iter().filter_map(|r| r.ok()).collect();
		let locators: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
		assert!(locators.contains(&"src".to_string()));
		assert!(locators.contains(&"src/main.rs".to_string()));
		assert!(locators.contains(&"tests/a.rs".to_string()));
	}

	#[test]
	fn walk_glob_filter() {
		let (_dir, root) = make_walker_root();
		let loc = FsLocator {
			segments: vec![
				FsSegment::Literal("src".to_string()),
				FsSegment::Literal("/".to_string()),
				FsSegment::Star,
				FsSegment::Literal(".rs".to_string()),
			],
		};
		let opts = WalkOpts { hidden: true, gitignore: true, root };
		let results = walk(&loc, &opts, &CancellationToken::new());
		let nodes: Vec<_> = results.into_iter().filter_map(|r| r.ok()).collect();
		assert_eq!(nodes.len(), 2);
		assert!(nodes.iter().any(|n| n.locator == "src/main.rs"));
		assert!(nodes.iter().any(|n| n.locator == "src/lib.rs"));
	}

	#[test]
	fn walk_hidden_excluded_when_hidden_false() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join(".hidden")).unwrap();
		fs::write(root.join(".hidden/secret.rs"), "").unwrap();
		fs::write(root.join("visible.rs"), "").unwrap();

		let loc = FsLocator { segments: vec![FsSegment::Literal("**".to_string())] };
		let opts = WalkOpts { hidden: false, gitignore: true, root: root.clone() };
		let results = walk(&loc, &opts, &CancellationToken::new());
		let nodes: Vec<_> = results.into_iter().filter_map(|r| r.ok()).collect();
		let locators: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
		assert!(!locators.contains(&".hidden/secret.rs".to_string()));
		assert!(locators.contains(&"visible.rs".to_string()));
	}

	#[test]
	fn walk_hidden_included_when_hidden_true() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join(".hidden")).unwrap();
		fs::write(root.join(".hidden/secret.rs"), "").unwrap();

		let loc = FsLocator { segments: vec![FsSegment::Literal("**".to_string())] };
		let opts = WalkOpts { hidden: true, gitignore: true, root: root.clone() };
		let results = walk(&loc, &opts, &CancellationToken::new());
		let nodes: Vec<_> = results.into_iter().filter_map(|r| r.ok()).collect();
		let locators: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
		assert!(locators.contains(&".hidden/secret.rs".to_string()));
	}

	#[test]
	fn walk_gitignore_respected() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
		fs::write(root.join("kept.rs"), "").unwrap();
		fs::write(root.join("ignored.rs"), "").unwrap();

		let loc = FsLocator { segments: vec![FsSegment::Literal("*.rs".to_string())] };
		let opts = WalkOpts { hidden: true, gitignore: true, root: root.clone() };
		let results = walk(&loc, &opts, &CancellationToken::new());
		let nodes: Vec<_> = results.into_iter().filter_map(|r| r.ok()).collect();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].locator, "kept.rs");
	}

	#[test]
	fn walk_cancellation_stops_early() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		for i in 0..250 {
			fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
		}

		let loc = FsLocator { segments: vec![FsSegment::Literal("*.txt".to_string())] };
		let cancel = CancellationToken::new();
		let opts = WalkOpts { hidden: true, gitignore: true, root: root.clone() };

		// Cancel immediately
		cancel.cancel();
		let results = walk(&loc, &opts, &cancel);
		let nodes: Vec<_> = results.into_iter().filter_map(|r| r.ok()).collect();
		assert!(nodes.len() < 250);
	}
}
