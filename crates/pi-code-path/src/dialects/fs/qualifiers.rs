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
		"listing" => resolve_listing(node, qual.args.as_deref(), root),
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

/// Parsed flags for `#tree` / `#listing` args.
///
/// Grammar (inside the qualifier brackets, whitespace- or comma-separated):
///   `depth=N`  — max recursion depth (tree only; listing is always one level)
///   `ignored`  — include `.gitignore`d entries (default: excluded)
///   `hidden`   — include dotfiles / hidden entries (default: excluded)
///   `all`      — shorthand for `ignored hidden`
///
/// Examples: `#tree[depth=2]`, `#tree[ignored]`, `#tree[depth=3 ignored
/// hidden]`.
struct WalkFlags {
	max_depth:       usize,
	include_ignored: bool,
	include_hidden:  bool,
}

fn parse_walk_flags(args: Option<&str>, default_depth: usize) -> WalkFlags {
	let mut flags =
		WalkFlags { max_depth: default_depth, include_ignored: false, include_hidden: false };
	let Some(s) = args else { return flags };
	for raw in s.split(|c: char| c == ',' || c.is_whitespace()) {
		let tok = raw.trim();
		if tok.is_empty() {
			continue;
		}
		if let Some(n) = tok
			.strip_prefix("depth=")
			.or_else(|| tok.strip_prefix("depth ="))
		{
			if let Ok(d) = n.trim().parse::<usize>() {
				flags.max_depth = d;
			}
		} else if tok.eq_ignore_ascii_case("ignored") {
			flags.include_ignored = true;
		} else if tok.eq_ignore_ascii_case("hidden") {
			flags.include_hidden = true;
		} else if tok.eq_ignore_ascii_case("all") {
			flags.include_ignored = true;
			flags.include_hidden = true;
		}
		// Unknown tokens are ignored for forward-compatibility.
	}
	flags
}

/// One `§inaccessible` node carrying a per-entry diagnostic, so a mid-walk
/// failure (permission denied, transient IO) records itself instead of
/// aborting the whole walk (BUG-371).
fn inaccessible_node(locator: String, message: String) -> NodeRef {
	NodeRef {
		locator,
		range: 0..0,
		kind: "§inaccessible".into(),
		content: None,
		metadata: HashMap::new(),
		diagnostics: vec![Diagnostic {
			variant: DiagnosticVariant::Inaccessible,
			message,
			span: None,
		}],
	}
}

/// Gitignore-aware directory walk shared by `#listing` and `#tree`.
///
/// Reuses the `ignore` crate (same engine as the glob path) so a single tool —
/// `find` — is internally consistent: `**/*.rs` and `dir/#tree` both honour
/// `.gitignore` by default. Parent `.gitignore` files are consulted too, so a
/// repo-root `node_modules/` rule prunes a subdirectory walk. Hidden entries
/// and ignored entries are excluded by default and re-enabled only via the
/// explicit `[hidden]` / `[ignored]` qualifier flags.
///
/// Each emitted node carries `depth` (walk distance from `base`, root = 0) and
/// `name` (basename) metadata so the host renderer can draw an indented tree
/// without re-deriving structure from path strings.
///
/// `include_root` keeps the base directory node itself (`#tree` wants it as the
/// header; `#listing` drops it and returns children only). Output locators stay
/// relative to the resolver `root`, anchored on the caller's `base` locator, so
/// both absolute and relative addressing round-trip unchanged.
fn walk_fs_nodes(
	base: &str,
	root: &Path,
	flags: &WalkFlags,
	include_root: bool,
) -> Result<Vec<NodeRef>, Diagnostic> {
	use ignore::WalkBuilder;

	let base_path = Path::new(base);
	let full_path = resolve_full_path(base_path, root);

	// Entry-point must exist — hard error (parity with the previous resolvers).
	// `symlink_metadata` so a dangling base symlink reports cleanly rather than
	// chasing a missing target.
	let base_meta = std::fs::symlink_metadata(&full_path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("metadata error: {e}"),
		span:    None,
	})?;

	// A non-directory base has no children. `#listing` on a file is an error
	// (mirrors the old `read_dir` failure); `#tree` returns the lone file node.
	if !base_meta.is_dir() {
		if !include_root {
			return Err(Diagnostic {
				variant: DiagnosticVariant::Inaccessible,
				message: "cannot read directory: not a directory".into(),
				span:    None,
			});
		}
		let kind = if base_meta.is_symlink() {
			"§symlink"
		} else {
			"§file"
		};
		let mut metadata = HashMap::new();
		metadata.insert("depth".to_string(), serde_json::Value::from(0u64));
		if let Some(name) = base_path.file_name() {
			metadata.insert(
				"name".to_string(),
				serde_json::Value::String(name.to_string_lossy().to_string()),
			);
		}
		return Ok(vec![NodeRef {
			locator: base.to_string(),
			range: 0..base_meta.len() as usize,
			kind: kind.to_string(),
			content: None,
			metadata,
			diagnostics: Vec::new(),
		}]);
	}

	let mut builder = WalkBuilder::new(&full_path);
	builder.hidden(!flags.include_hidden);
	builder.follow_links(false);
	// Deterministic ordering makes the rendered tree stable and readable.
	builder.sort_by_file_name(std::cmp::Ord::cmp);
	if flags.include_ignored {
		// Disable every ignore source so nothing is filtered out.
		builder.git_ignore(false);
		builder.git_global(false);
		builder.git_exclude(false);
		builder.ignore(false);
		builder.parents(false);
	} else {
		builder.git_ignore(true);
		builder.git_global(true);
		builder.git_exclude(true);
		builder.ignore(true);
		builder.parents(true);
		// Honour `.gitignore` even outside a git repo (tempdir tests, detached
		// subtrees) — same treatment as the glob walker.
		builder.add_custom_ignore_filename(".gitignore");
	}
	// `#listing` is one level; `#tree` honours its depth flag. WalkBuilder counts
	// the base as depth 0, so a one-level listing needs max_depth=1.
	let effective_depth = if include_root { flags.max_depth } else { 1 };
	if effective_depth != usize::MAX {
		builder.max_depth(Some(effective_depth));
	}

	let mut nodes = Vec::new();
	for result in builder.build() {
		let entry = match result {
			Ok(e) => e,
			Err(err) => {
				nodes.push(inaccessible_node(base.to_string(), format!("walk error: {err}")));
				continue;
			},
		};
		let depth = entry.depth();
		if depth == 0 && !include_root {
			continue;
		}
		let abs = entry.path();
		let rel_from_base = abs
			.strip_prefix(&full_path)
			.unwrap_or_else(|_| Path::new(""));
		let display = if rel_from_base.as_os_str().is_empty() {
			base_path.to_path_buf()
		} else {
			base_path.join(rel_from_base)
		};
		let locator = display.to_string_lossy().to_string();
		let name = display
			.file_name()
			.map(|n| n.to_string_lossy().to_string())
			.unwrap_or_else(|| locator.clone());

		let ft = entry.file_type();
		let (kind, size, diagnostics) = match ft {
			Some(t) if t.is_dir() => ("§dir".to_string(), 0u64, Vec::new()),
			Some(t) if t.is_symlink() => {
				// Detect dangling symlinks so the caller gets a per-node diagnostic
				// (BUG-371) rather than silence — `metadata` follows the link.
				let mut diags = Vec::new();
				if std::fs::metadata(abs).is_err() {
					diags.push(Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: "dangling symlink: target does not exist".into(),
						span:    None,
					});
				}
				("§symlink".to_string(), 0u64, diags)
			},
			_ => {
				let sz = std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
				("§file".to_string(), sz, Vec::new())
			},
		};

		let mut metadata = HashMap::new();
		metadata.insert("depth".to_string(), serde_json::Value::from(depth as u64));
		metadata.insert("name".to_string(), serde_json::Value::String(name));
		nodes.push(NodeRef {
			locator,
			range: 0..size as usize,
			kind,
			content: None,
			metadata,
			diagnostics,
		});
	}
	Ok(nodes)
}

fn resolve_listing(
	node: &NodeRef,
	args: Option<&str>,
	root: &Path,
) -> Result<Vec<NodeRef>, Diagnostic> {
	let flags = parse_walk_flags(args, 1);
	walk_fs_nodes(&node.locator, root, &flags, false)
}

fn resolve_tree(
	node: &NodeRef,
	args: Option<&str>,
	root: &Path,
) -> Result<Vec<NodeRef>, Diagnostic> {
	// Default depth is unbounded; `#tree[depth=N]` caps it. The base directory
	// node is included (depth 0) so the host renderer can use it as the header.
	let flags = parse_walk_flags(args, usize::MAX);
	walk_fs_nodes(&node.locator, root, &flags, true)
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
		// Base dir included at depth 0 (header), its child dir at depth 1, but the
		// grandchild file at depth 2 is pruned by depth=1.
		assert!(locators.contains(&"a".to_string()), "base dir present: {locators:?}");
		assert!(locators.contains(&"a/b".to_string()), "depth-1 child present: {locators:?}");
		assert!(
			!locators.contains(&"a/b/c.rs".to_string()),
			"depth-2 grandchild pruned: {locators:?}"
		);
		// depth metadata is carried for the host renderer.
		let base = results.iter().find(|r| r.locator == "a").unwrap();
		assert_eq!(base.metadata.get("depth").and_then(|v| v.as_u64()), Some(0));
		let child = results.iter().find(|r| r.locator == "a/b").unwrap();
		assert_eq!(child.metadata.get("depth").and_then(|v| v.as_u64()), Some(1));
	}

	#[test]
	fn qualifier_tree_excludes_gitignored_by_default() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join(".gitignore"), "node_modules/\nbuild.log\n").unwrap();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/main.rs"), "").unwrap();
		fs::create_dir(root.join("node_modules")).unwrap();
		fs::write(root.join("node_modules/dep.js"), "").unwrap();
		fs::write(root.join("build.log"), "").unwrap();

		let n = node("", "§dir");
		let qual = Qualifier { name: "tree".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		let locators: Vec<_> = results.iter().map(|r| r.locator.clone()).collect();
		assert!(
			locators.iter().any(|l| l.ends_with("src/main.rs")),
			"tracked file present: {locators:?}"
		);
		assert!(
			!locators.iter().any(|l| l.contains("node_modules")),
			"gitignored dir excluded by default: {locators:?}"
		);
		assert!(
			!locators.iter().any(|l| l.ends_with("build.log")),
			"gitignored file excluded by default: {locators:?}"
		);
	}

	#[test]
	fn qualifier_tree_ignored_flag_includes_gitignored() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
		fs::create_dir(root.join("node_modules")).unwrap();
		fs::write(root.join("node_modules/dep.js"), "").unwrap();

		let n = node("", "§dir");
		let qual = Qualifier { name: "tree".to_string(), args: Some("ignored".to_string()) };
		let results = resolve(&n, &qual, &root).unwrap();
		let locators: Vec<_> = results.iter().map(|r| r.locator.clone()).collect();
		assert!(
			locators.iter().any(|l| l.contains("node_modules")),
			"`[ignored]` flag includes gitignored entries: {locators:?}"
		);
	}

	#[test]
	fn qualifier_tree_excludes_hidden_by_default() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("visible.rs"), "").unwrap();
		fs::write(root.join(".hidden"), "").unwrap();

		let n = node("", "§dir");
		let qual = Qualifier { name: "tree".to_string(), args: None };
		let results = resolve(&n, &qual, &root).unwrap();
		let locators: Vec<_> = results.iter().map(|r| r.locator.clone()).collect();
		assert!(locators.iter().any(|l| l.ends_with("visible.rs")), "visible: {locators:?}");
		assert!(
			!locators.iter().any(|l| l.ends_with(".hidden")),
			"hidden excluded by default: {locators:?}"
		);

		let qual_hidden = Qualifier { name: "tree".to_string(), args: Some("hidden".to_string()) };
		let with_hidden = resolve(&n, &qual_hidden, &root).unwrap();
		assert!(
			with_hidden.iter().any(|r| r.locator.ends_with(".hidden")),
			"`[hidden]` flag includes dotfiles"
		);
	}

	#[test]
	fn qualifier_listing_carries_depth_and_name_metadata() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::create_dir(root.join("src")).unwrap();
		fs::write(root.join("src/a.rs"), "").unwrap();

		let n = node("src", "§dir");
		let qual = Qualifier { name: "listing".to_string(), args: None };
		let children = resolve(&n, &qual, &root).unwrap();
		// Listing drops the base node, returns children only, all at depth 1.
		assert!(children.iter().all(|c| c.locator != "src"), "base dir omitted from listing");
		let a = children.iter().find(|c| c.locator == "src/a.rs").unwrap();
		assert_eq!(a.metadata.get("depth").and_then(|v| v.as_u64()), Some(1));
		assert_eq!(a.metadata.get("name").and_then(|v| v.as_str()), Some("a.rs"));
	}

	#[test]
	fn qualifier_parse_walk_flags_grammar() {
		assert_eq!(parse_walk_flags(None, 9).max_depth, 9);
		assert_eq!(parse_walk_flags(Some("depth=2"), 9).max_depth, 2);
		let all = parse_walk_flags(Some("all"), 9);
		assert!(all.include_ignored && all.include_hidden);
		let combo = parse_walk_flags(Some("depth=3 ignored"), 9);
		assert_eq!(combo.max_depth, 3);
		assert!(combo.include_ignored && !combo.include_hidden);
		let comma = parse_walk_flags(Some("ignored,hidden"), 9);
		assert!(comma.include_ignored && comma.include_hidden);
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
