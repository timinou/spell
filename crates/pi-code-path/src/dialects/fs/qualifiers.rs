use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use crate::{
	ast::Qualifier,
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};

/// Resolve an FS qualifier for the given node.
///
/// `#listing` returns one-level children.  `#tree[depth=N]` returns a
/// recursive listing capped at depth *N*.  `#stat` returns metadata.
///
/// `#diff` is declared here but must be resolved via the pi-natives outer
/// dispatch layer (napi.rs `is_diff_qualifier` routing). The kernel returns
/// `UnsupportedOperation`; the outer layer catches this before the FsResolver
/// fallthrough and routes to `diff_qualifier::resolve()`.
pub fn resolve(node: &NodeRef, qual: &Qualifier, root: &Path) -> Result<Vec<NodeRef>, Diagnostic> {
	match qual.name.as_str() {
		"listing" => resolve_listing(node, root),
		"tree" => resolve_tree(node, qual.args.as_deref(), root),
		"stat" => resolve_stat(node, root),
		"diff" => Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: "#diff must be resolved via pi-natives outer dispatch layer".into(),
			span:    None,
		}),
		_ => Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("unknown qualifier: {}", qual.name),
			span:    None,
		}),
	}
}

fn resolve_listing(node: &NodeRef, root: &Path) -> Result<Vec<NodeRef>, Diagnostic> {
	let path = Path::new(&node.locator);
	let full_path = resolve_full_path(path, root);

	let entries = std::fs::read_dir(&full_path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("cannot read directory: {e}"),
		span:    None,
	})?;

	let mut nodes = Vec::new();
	for entry in entries {
		// BUG-371: resilient mid-walk errors — record as §inaccessible
		// with a per-node diagnostic instead of aborting the listing.
		let entry = match entry {
			Ok(e) => e,
			Err(e) => {
				nodes.push(NodeRef {
					locator:     path.to_string_lossy().to_string(),
					range:       0..0,
					kind:        "§inaccessible".into(),
					content:     None,
					metadata:    HashMap::new(),
					diagnostics: vec![Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: format!("directory entry error: {e}"),
						span:    None,
					}],
				});
				continue;
			},
		};
		let name = entry.file_name().to_string_lossy().to_string();
		let meta = match entry.metadata() {
			Ok(m) => m,
			Err(e) => {
				let child_path = path.join(&name);
				nodes.push(NodeRef {
					locator:     child_path.to_string_lossy().to_string(),
					range:       0..0,
					kind:        "§inaccessible".into(),
					content:     None,
					metadata:    HashMap::new(),
					diagnostics: vec![Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: format!("metadata error: {e}"),
						span:    None,
					}],
				});
				continue;
			},
		};
		let kind = if meta.is_dir() {
			"§dir".to_string()
		} else if meta.is_symlink() {
			"§symlink".to_string()
		} else {
			"§file".to_string()
		};
		let child_path = path.join(&name);
		let locator = child_path.to_string_lossy().to_string();
		let size = meta.len();
		nodes.push(NodeRef {
			locator,
			range: 0..size as usize,
			kind,
			content: None,
			metadata: HashMap::new(),
			diagnostics: Vec::new(),
		});
	}
	Ok(nodes)
}

fn resolve_tree(
	node: &NodeRef,
	args: Option<&str>,
	root: &Path,
) -> Result<Vec<NodeRef>, Diagnostic> {
	let max_depth = args
		.and_then(|s| {
			s.strip_prefix("depth=")
				.or_else(|| s.strip_prefix("depth = "))
				.and_then(|n| n.parse::<usize>().ok())
		})
		.unwrap_or(usize::MAX);

	let base = Path::new(&node.locator);
	let mut results = Vec::new();
	let mut stack = vec![(base.to_path_buf(), 0usize)];

	while let Some((path, depth)) = stack.pop() {
		if depth > max_depth {
			continue;
		}

		let full_path = resolve_full_path(&path, root);

		// BUG-371: use symlink_metadata so dangling symlinks don't abort
		// the entire walk. The *first* (entry-point) node may still hard-
		// error with ?; mid-walk failures produce per-node diagnostics.
		let first = results.is_empty();
		let meta = match std::fs::symlink_metadata(&full_path) {
			Ok(m) => m,
			Err(e) => {
				if first {
					return Err(Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: format!("metadata error: {e}"),
						span:    None,
					});
				}
				results.push(NodeRef {
					locator:     path.to_string_lossy().to_string(),
					range:       0..0,
					kind:        "§inaccessible".into(),
					content:     None,
					metadata:    HashMap::new(),
					diagnostics: vec![Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: format!("metadata error: {e}"),
						span:    None,
					}],
				});
				continue;
			},
		};

		let kind = if meta.is_dir() {
			"§dir".to_string()
		} else if meta.is_symlink() {
			"§symlink".to_string()
		} else {
			"§file".to_string()
		};

		let size = meta.len();

		// BUG-371: detect dangling symlinks so the caller gets a per-node
		// diagnostic instead of a hard crash on a later stat() call.
		let mut diagnostics = Vec::new();
		if meta.is_symlink() && std::fs::metadata(&full_path).is_err() {
			diagnostics.push(Diagnostic {
				variant: DiagnosticVariant::Inaccessible,
				message: "dangling symlink: target does not exist".into(),
				span:    None,
			});
		}

		results.push(NodeRef {
			locator: path.to_string_lossy().to_string(),
			range: 0..size as usize,
			kind,
			content: None,
			metadata: HashMap::new(),
			diagnostics,
		});

		if meta.is_dir() && depth < max_depth {
			let entries = match std::fs::read_dir(&full_path) {
				Ok(e) => e,
				Err(e) => {
					results.push(NodeRef {
						locator:     path.to_string_lossy().to_string(),
						range:       0..0,
						kind:        "§inaccessible".into(),
						content:     None,
						metadata:    HashMap::new(),
						diagnostics: vec![Diagnostic {
							variant: DiagnosticVariant::Inaccessible,
							message: format!("read_dir error: {e}"),
							span:    None,
						}],
					});
					continue;
				},
			};
			for entry in entries {
				let entry = match entry {
					Ok(e) => e,
					Err(e) => {
						results.push(NodeRef {
							locator:     path.to_string_lossy().to_string(),
							range:       0..0,
							kind:        "§inaccessible".into(),
							content:     None,
							metadata:    HashMap::new(),
							diagnostics: vec![Diagnostic {
								variant: DiagnosticVariant::Inaccessible,
								message: format!("directory entry error: {e}"),
								span:    None,
							}],
						});
						continue;
					},
				};
				let name = entry.file_name();
				let child_path = path.join(&name);
				stack.push((child_path, depth + 1));
			}
		}
	}

	Ok(results)
}

fn resolve_stat(node: &NodeRef, root: &Path) -> Result<Vec<NodeRef>, Diagnostic> {
	let path = Path::new(&node.locator);
	let full_path = resolve_full_path(path, root);

	let meta = std::fs::metadata(&full_path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("metadata error: {e}"),
		span:    None,
	})?;

	let kind = if meta.is_dir() {
		"§dir".to_string()
	} else if meta.is_symlink() {
		"§symlink".to_string()
	} else {
		"§file".to_string()
	};

	let size = meta.len();
	let mtime = meta.modified().ok();

	let mut metadata = HashMap::new();
	metadata.insert("size".to_string(), serde_json::Value::Number(size.into()));
	if let Some(t) = mtime {
		let secs = t
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_secs();
		metadata.insert("mtime".to_string(), serde_json::Value::Number(secs.into()));
	}
	metadata.insert("kind".to_string(), serde_json::Value::String(kind.clone()));

	if !meta.is_dir() {
		if let Some(count) = line_count_for_stat(&full_path, size) {
			metadata.insert("lineCount".to_string(), serde_json::Value::Number(count.into()));
		}
	}

	let mut node = node.clone();
	node.metadata = metadata;
	node.kind = kind;
	node.range = 0..size as usize;

	Ok(vec![node])
}

fn resolve_full_path(path: &Path, root: &Path) -> PathBuf {
	if path.is_absolute() {
		path.to_path_buf()
	} else {
		root.join(path)
	}
}

/// Counts addressable lines in a regular file for `#stat`.
///
/// Returns `None` for binary files (UTF-8 sniff fails on first 8 KiB) so
/// `lineCount` is omitted from `#stat` metadata. For text files we count
/// `\n` bytes; if the file is non-empty and does not end in `\n` we add 1
/// because the unterminated final line is still addressable by `:N` (this
/// diverges from `wc -l` deliberately — agents need addressable lines, not
/// strictly terminated ones).
fn line_count_for_stat(path: &Path, size: u64) -> Option<u64> {
	if size == 0 {
		return Some(0);
	}
	let bytes = std::fs::read(path).ok()?;
	let sniff_end = std::cmp::min(bytes.len(), 8192);
	if std::str::from_utf8(&bytes[..sniff_end]).is_err() {
		return None;
	}
	let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
	let trailing = if bytes.last() == Some(&b'\n') { 0 } else { 1 };
	Some(newlines + trailing)
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	fn node(locator: &str, kind: &str) -> NodeRef {
		NodeRef {
			locator:     locator.to_string(),
			range:       0..0,
			kind:        kind.to_string(),
			content:     None,
			metadata:    Default::default(),
			diagnostics: vec![],
		}
	}

	#[test]
	fn qualifier_listing_one_level() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();
		fs::write(root.join("src/b.rs"), "").unwrap();

		let n = node("src", "§dir");
		let qual = Qualifier { name: "listing".to_string(), args: None };
		let children = resolve(&n, &qual, &root).unwrap();
		assert_eq!(children.len(), 2);
		assert!(children.iter().any(|c| c.locator == "src/a.rs"));
		assert!(children.iter().any(|c| c.locator == "src/b.rs"));
	}

	#[test]
	fn qualifier_tree_depth_capped() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("a")).unwrap();
		fs::create_dir(root.join("a/b")).unwrap();
		fs::write(root.join("a/b/c.rs"), "").unwrap();

		let n = node("a", "§dir");
		let qual = Qualifier { name: "tree".to_string(), args: Some("depth=1".to_string()) };
		let results = resolve(&n, &qual, &root).unwrap();
		let locators: Vec<_> = results.iter().map(|r| r.locator.clone()).collect();
		assert!(locators.contains(&"a".to_string()));
		assert!(locators.contains(&"a/b".to_string()));
		assert!(!locators.contains(&"a/b/c.rs".to_string()));
	}

	#[test]
	fn qualifier_stat_metadata() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("file.rs"), "hello").unwrap();

		let n = node("file.rs", "§file");
		let qual = Qualifier { name: "stat".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		assert_eq!(results.len(), 1);
		let meta = &results[0].metadata;
		assert!(meta.contains_key("size"));
		assert!(meta.contains_key("mtime"));
		assert_eq!(meta.get("kind"), Some(&serde_json::Value::String("§file".to_string())));
	}

	fn line_count(meta: &HashMap<String, serde_json::Value>) -> Option<u64> {
		meta.get("lineCount")?.as_u64()
	}

	#[test]
	fn qualifier_stat_line_count_terminated() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("f.txt"), "a\nb\nc\n").unwrap();

		let n = node("f.txt", "§file");
		let qual = Qualifier { name: "stat".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		assert_eq!(line_count(&results[0].metadata), Some(3));
	}

	#[test]
	fn qualifier_stat_line_count_unterminated() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("f.txt"), "a\nb\nc").unwrap();

		let n = node("f.txt", "§file");
		let qual = Qualifier { name: "stat".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		// `wc -l` would say 2; we count the unterminated line as addressable.
		assert_eq!(line_count(&results[0].metadata), Some(3));
	}

	#[test]
	fn qualifier_stat_line_count_empty() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("empty.txt"), "").unwrap();

		let n = node("empty.txt", "§file");
		let qual = Qualifier { name: "stat".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		assert_eq!(line_count(&results[0].metadata), Some(0));
	}

	#[test]
	fn qualifier_stat_line_count_omitted_for_binary() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		// PNG signature + a NUL run — fails UTF-8 sniff.
		let bytes: Vec<u8> =
			vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
		fs::write(root.join("img.png"), &bytes).unwrap();

		let n = node("img.png", "§file");
		let qual = Qualifier { name: "stat".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		assert!(!results[0].metadata.contains_key("lineCount"));
	}

	// ─────────────────────────────────────────────────────────────
	// BUG-371: a single dangling symlink must not abort the entire
	// `#tree` walk. The user reproduction (running `/abs/cais/#tree`
	// on a repo with a Node-built phoenix-colocated symlink) failed
	// with a bare `metadata error: No such file or directory` because
	// resolve_tree propagated `?` on the first stat() that followed a
	// dangling link. Expected: per-entry diagnostic, walk continues.
	// ─────────────────────────────────────────────────────────────
	#[test]
	#[cfg(unix)]
	fn bug371_tree_walk_swallows_dangling_symlinks() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("keep")).unwrap();
		fs::write(root.join("keep/real.txt"), "x").unwrap();
		// Dangling symlink pointing at a path that does not exist.
		std::os::unix::fs::symlink(root.join("nope/target"), root.join("keep/broken")).unwrap();

		let n = node("", "§dir");
		let qual = Qualifier { name: "tree".to_string(), args: None };
		let res = resolve(&n, &qual, &root);
		assert!(
			res.is_ok(),
			"a single dangling symlink must not abort the whole tree walk; got: {:?}",
			res.as_ref().err().map(|d| &d.message)
		);
		let nodes = res.unwrap();
		// Real children survive.
		assert!(
			nodes.iter().any(|n| n.locator.ends_with("keep/real.txt")),
			"healthy entries must survive a dangling sibling; got: {:?}",
			nodes.iter().map(|n| &n.locator).collect::<Vec<_>>()
		);
		// The broken link is reported with a diagnostic attached to its
		// own node, not as a hard error.
		let broken = nodes
			.iter()
			.find(|n| n.locator.ends_with("keep/broken"))
			.expect("dangling entry must appear in the result set");
		assert!(!broken.diagnostics.is_empty(), "dangling entry must carry a per-node diagnostic");
	}
}
