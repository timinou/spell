use std::{
	collections::HashMap,
	path::PathBuf,
	sync::{Arc, Mutex},
};

use ignore::{WalkBuilder, WalkState};

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

	let mut results: Vec<Result<NodeRef, Diagnostic>> = Vec::new();
	let globset = match build_globset(&pattern) {
		Ok(gs) => gs,
		Err(msg) => {
			// BUG-405 (PLAN-318 W0): invalid glob compile MUST surface as a
			// diagnostic + zero matches, not as an unfiltered walk. Most common
			// trigger is `*.ts[mtime>...]` (predicate-lookalike CharClass).
			results.push(Err(Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!(
					"{msg} \u{2014} predicate brackets need a `::\u{a7}file[...]` axis, e.g. \
					 `*.ts::\u{a7}file[mtime>2026-05-01]`"
				),
				span:    None,
			}));
			return results;
		},
	};
	let negative_globsets = build_negative_globsets(loc);

	// Parallel walk: `WalkBuilder::build_parallel` drives a per-thread visitor
	// closure. Cross-file order becomes nondeterministic, but `find` results are
	// set-valued downstream (TextResolver re-groups by file). Diagnostics are
	// preserved in the same Vec for caller compatibility.
	let collector: Arc<Mutex<Vec<Result<NodeRef, Diagnostic>>>> = Arc::new(Mutex::new(results));
	let globset = Arc::new(globset);
	let negative_globsets = Arc::new(negative_globsets);
	let root = Arc::new(opts.root.clone());

	builder.build_parallel().run(|| {
		let collector = Arc::clone(&collector);
		let globset = Arc::clone(&globset);
		let negative_globsets = Arc::clone(&negative_globsets);
		let root = Arc::clone(&root);
		let cancel = cancel.clone();
		Box::new(move |entry| {
			// Relaxed AtomicBool load is ~1ns; cheap enough to check every entry.
			if cancel.is_cancelled() {
				return WalkState::Quit;
			}
			match entry {
				Ok(ent) => {
					let path = ent.path();
					let Ok(rel) = path.strip_prefix(root.as_path()) else {
						return WalkState::Continue;
					};
					if let Some(ref gs) = *globset {
						if !gs.is_match(rel) {
							return WalkState::Continue;
						}
					}
					if negative_globsets.iter().any(|ngs| ngs.is_match(rel)) {
						return WalkState::Continue;
					}
					let rel_str = rel.to_string_lossy().to_string();
					let (kind, size) = match ent.file_type() {
						Some(ft) if ft.is_dir() => ("§dir".to_string(), 0u64),
						Some(ft) if ft.is_symlink() => ("§symlink".to_string(), 0u64),
						_ => {
							let sz = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
							("§file".to_string(), sz)
						},
					};
					collector.lock().unwrap().push(Ok(NodeRef {
						locator: rel_str,
						range: 0..size as usize,
						kind,
						content: None,
						metadata: HashMap::new(),
						diagnostics: Vec::new(),
					}));
				},
				Err(err) => {
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
					collector.lock().unwrap().push(Err(Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: msg,
						span:    None,
					}));
				},
			}
			WalkState::Continue
		})
	});

	Arc::try_unwrap(collector)
		.unwrap_or_else(|arc| Mutex::new(std::mem::take(&mut *arc.lock().unwrap())))
		.into_inner()
		.unwrap()
}

/// Compile a glob pattern into a [`globset::GlobSet`].
///
/// Returns:
/// - `Ok(None)` for empty or pure-`**` patterns (no filter applied).
/// - `Ok(Some(gs))` for valid compiled patterns.
/// - `Err(msg)` when the pattern is non-empty but globset rejects it. The
///   caller MUST treat this as zero matches + diagnostic; legacy behaviour was
///   to treat compile failure as "no filter" which produced pathological
///   unfiltered walks (BUG-405).
fn build_globset(pattern: &str) -> Result<Option<globset::GlobSet>, String> {
	if pattern.is_empty() || pattern == "**" {
		return Ok(None);
	}
	let mut builder = globset::GlobSetBuilder::new();
	match globset::Glob::new(pattern) {
		Ok(glob) => {
			builder.add(glob);
		},
		Err(e) => return Err(format!("invalid glob pattern `{pattern}`: {e}")),
	}
	builder
		.build()
		.map(Some)
		.map_err(|e| format!("invalid glob pattern `{pattern}`: {e}"))
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
				if let Ok(Some(gs)) = build_globset(&pattern) {
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
	// BUG-372: `.` and `./` are the cwd alias — walk the root unfiltered.
	// build_globset returns None for an empty pattern, which is exactly the
	// "no glob filter" path the walker already honours for `**`.
	if out == "." || out == "./" {
		return String::new();
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

	// BUG-405 (PLAN-318 W0): invalid glob (predicate-lookalike that globset
	// rejects) must yield zero matches + diagnostic, NOT fall through to
	// unfiltered walk.
	#[test]
	fn glob_invalid_pattern_returns_empty_with_diagnostic() {
		let (_dir, root) = make_walker_root();
		// Mimics parser output for `*.ts[mtime>2026-05-20]`:
		// `*` + `.ts` + CharClass([m,t,i,m,e,>,2,0,2,6,-,0,5,-,2,0]).
		// CharClass contains invalid ranges `2-0` and `5-2`, so globset rejects.
		let loc = FsLocator {
			segments: vec![
				FsSegment::Star,
				FsSegment::Literal(".ts".to_string()),
				FsSegment::CharClass(vec![
					'm', 't', 'i', 'm', 'e', '>', '2', '0', '2', '6', '-', '0', '5', '-', '2', '0',
				]),
			],
		};
		let opts = WalkOpts { hidden: true, gitignore: true, root };
		let results = walk(&loc, &opts, &CancellationToken::new());

		let nodes: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
		let diags: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();

		assert!(
			nodes.is_empty(),
			"invalid glob must not return any matches; got {} nodes: {:?}",
			nodes.len(),
			nodes.iter().take(5).map(|n| &n.locator).collect::<Vec<_>>(),
		);
		assert!(
			diags
				.iter()
				.any(|d| d.message.to_lowercase().contains("glob")
					&& (d.message.contains("invalid") || d.message.contains("compile"))),
			"expected a diagnostic naming the invalid glob; got: {:?}",
			diags.iter().map(|d| &d.message).collect::<Vec<_>>(),
		);
	}
}
