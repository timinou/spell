//! #diff qualifier resolution — git-backed working-tree diffs.
//!
//! Uses `git diff` subprocess (not `git2` crate) to avoid vendored
//! OpenSSL build issues. The qualifier name `diff` is declared in
//! `pi-code-path/src/dialects/fs/qualifiers.rs` as an `UnsupportedOperation`
//! stub; the pi-natives outer dispatch layer in `napi.rs` intercepts it
//! via `is_diff_qualifier()` before the FsResolver fallthrough and routes
//! here.
//!
//! # Supported forms
//! - `<path>#diff` — working-tree diff for file vs HEAD
//! - `<path>#diff[base=HEAD~1]` — diff vs an arbitrary ref
//! - `<path>#diff[since=2026-05-01]` — diff vs the commit at-or-before that
//!   date
//! - `#diff` (bare, no path) — workspace-wide diff (one NodeRef per changed
//!   file)
//!
//! # Edge cases
//! - Clean tree → empty Vec, no diagnostic
//! - Non-git workspace → Diagnostic::UnsupportedOperation
//! - Binary files → placeholder content "Binary files … differ"
//! - Submodules → silently skipped

use std::{collections::HashMap, path::Path, process::Command};

use pi_code_path::{
	ast::Qualifier,
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

/// Resolve a `#diff` qualifier for the given node and root.
///
/// `node` may be a bare root (`.` locator, `§dir` kind) for workspace-wide
/// `#diff`, or a specific file node for per-file diff.
pub fn resolve(node: &NodeRef, qual: &Qualifier, root: &Path) -> Result<Vec<NodeRef>, Diagnostic> {
	// 1. Validate git repository
	if !is_git_repo(root) {
		return Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: "not a git repository".into(),
			span:    None,
		});
	}

	// 2. Parse qualifier arguments
	let base_ref = parse_base(qual);
	let since_ref = parse_since(qual, root);

	// `since` takes precedence over `base`
	let rev = since_ref.or(base_ref);

	// 3. Determine target — bare `#diff` means workspace-wide
	let is_workspace = node.locator == "." || node.locator.is_empty() || node.kind == "§dir";

	if is_workspace {
		resolve_workspace_diff(root, rev.as_deref())
	} else {
		resolve_file_diff(root, &node.locator, rev.as_deref())
	}
}

// ── Git helpers ──────────────────────────────────────────────────

/// Returns `true` if `dir` is inside a git repository.
fn is_git_repo(dir: &Path) -> bool {
	Command::new("git")
		.args(["rev-parse", "--git-dir"])
		.current_dir(dir)
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.status()
		.map(|s| s.success())
		.unwrap_or(false)
}

/// Parse a `base=<ref>` argument from the qualifier.
fn parse_base(qual: &Qualifier) -> Option<String> {
	extract_arg(qual, "base")
}

/// Parse a `since=<date>` argument, resolving it to the commit hash at or
/// before that date via `git log --before`.
fn parse_since(qual: &Qualifier, root: &Path) -> Option<String> {
	let date = extract_arg(qual, "since")?;

	let output = Command::new("git")
		.args(["log", "--before", &date, "-1", "--format=%H", "--"])
		.current_dir(root)
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::null())
		.output()
		.ok()?;

	if output.status.success() {
		let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
		if !hash.is_empty() {
			return Some(hash);
		}
	}
	None
}

/// Extract a named argument from a qualifier's args string.
/// Handles `name=value` and `name = value` formats.
fn extract_arg(qual: &Qualifier, name: &str) -> Option<String> {
	let args = qual.args.as_deref()?;
	let eq = format!("{name}=");
	let eq_spaced = format!("{name} = ");
	for part in args.split(',') {
		let trimmed = part.trim();
		if let Some(val) = trimmed.strip_prefix(&eq) {
			return Some(val.trim().to_string());
		}
		if let Some(val) = trimmed.strip_prefix(&eq_spaced) {
			return Some(val.trim().to_string());
		}
	}
	None
}

/// Parse additions/deletions from a diff body (lines starting with +/-,
/// excluding the `---`/`+++` header lines).
fn parse_diff_stats(diff: &str) -> (u64, u64) {
	let mut additions = 0u64;
	let mut deletions = 0u64;
	for line in diff.lines() {
		if line.starts_with('+') && !line.starts_with("+++") {
			additions += 1;
		} else if line.starts_with('-') && !line.starts_with("---") {
			deletions += 1;
		}
	}
	(additions, deletions)
}

/// Classify the change kind from a git diff header (the preamble before
/// the first `@@` hunk).
fn classify_change_kind(diff: &str) -> &'static str {
	let header_end = diff.find("\n@@").unwrap_or(diff.len());
	let header = &diff[..header_end];
	if header.contains("new file mode") {
		"added"
	} else if header.contains("deleted file mode") {
		"deleted"
	} else if header.contains("rename from") && header.contains("rename to") {
		"renamed"
	} else {
		"modified"
	}
}

/// Extract the relative file path from a `diff --git a/... b/...` header.
fn file_path_from_diff_header(diff: &str) -> Option<String> {
	for line in diff.lines() {
		if let Some(rest) = line.strip_prefix("diff --git a/") {
			if let Some(b_path) = rest.split_once(" b/") {
				let path = b_path.1.trim();
				if !path.is_empty() {
					return Some(path.to_string());
				}
			}
		}
	}
	None
}

// ── Single-file diff ─────────────────────────────────────────────

fn resolve_file_diff(
	root: &Path,
	locator: &str,
	rev: Option<&str>,
) -> Result<Vec<NodeRef>, Diagnostic> {
	let file_path = Path::new(locator);

	// Clamp: make sure the path is relative. If absolute, try to make it relative.
	let rel_path = if file_path.is_absolute() {
		file_path
			.strip_prefix(root)
			.unwrap_or(file_path)
			.to_path_buf()
	} else {
		file_path.to_path_buf()
	};

	let rev_arg = rev.unwrap_or("HEAD");

	// Run `git diff <rev> -- <path>`
	let output = Command::new("git")
		.arg("diff")
		.arg("--find-renames")
		.arg(rev_arg)
		.arg("--")
		.arg(&rel_path)
		.current_dir(root)
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|e| Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("git diff failed: {e}"),
			span:    None,
		})?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		return Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("git diff error: {stderr}"),
			span:    None,
		});
	}

	let diff_text = String::from_utf8_lossy(&output.stdout).to_string();
	if diff_text.trim().is_empty() {
		return Ok(Vec::new());
	}

	let (additions, deletions) = parse_diff_stats(&diff_text);
	let change_kind = classify_change_kind(&diff_text);

	// Check for binary diff
	let is_binary = diff_text.contains("Binary files") || diff_text.contains("GIT binary patch");

	let content = if is_binary {
		format!("Binary files {rev_arg} and working tree differ")
	} else {
		diff_text.clone()
	};

	let mut metadata = HashMap::new();
	metadata.insert("additions".into(), serde_json::Value::Number(additions.into()));
	metadata.insert("deletions".into(), serde_json::Value::Number(deletions.into()));
	metadata.insert("change_kind".into(), serde_json::Value::String(change_kind.to_string()));
	metadata.insert("rev".into(), serde_json::Value::String(rev_arg.to_string()));

	let node = NodeRef {
		locator: rel_path.to_string_lossy().to_string(),
		range: 0..diff_text.len(),
		kind: "§diff".to_string(),
		content: Some(Content::Text { value: content }),
		metadata,
		diagnostics: Vec::new(),
	};

	Ok(vec![node])
}

// ── Workspace-wide diff ──────────────────────────────────────────

fn resolve_workspace_diff(root: &Path, rev: Option<&str>) -> Result<Vec<NodeRef>, Diagnostic> {
	let rev_arg = rev.unwrap_or("HEAD");

	let output = Command::new("git")
		.arg("diff")
		.arg("--find-renames")
		.arg(rev_arg)
		.current_dir(root)
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.output()
		.map_err(|e| Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("git diff failed: {e}"),
			span:    None,
		})?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		return Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: format!("git diff error: {stderr}"),
			span:    None,
		});
	}

	let full_diff = String::from_utf8_lossy(&output.stdout).to_string();
	if full_diff.trim().is_empty() {
		return Ok(Vec::new());
	}

	// Split into per-file diffs
	let file_diffs = split_file_diffs(&full_diff);

	let mut nodes = Vec::new();
	for file_diff in file_diffs {
		let path = match file_path_from_diff_header(&file_diff) {
			Some(p) => p,
			None => continue,
		};

		// Skip submodules (no content diff beyond the header line)
		if file_diff.trim().lines().count() <= 2 {
			continue;
		}

		let (additions, deletions) = parse_diff_stats(&file_diff);
		let change_kind = classify_change_kind(&file_diff);

		let is_binary = file_diff.contains("Binary files") || file_diff.contains("GIT binary patch");
		let content = if is_binary {
			format!("Binary files {rev_arg} and working tree differ")
		} else {
			file_diff.clone()
		};

		let mut metadata = HashMap::new();
		metadata.insert("additions".into(), serde_json::Value::Number(additions.into()));
		metadata.insert("deletions".into(), serde_json::Value::Number(deletions.into()));
		metadata.insert("change_kind".into(), serde_json::Value::String(change_kind.to_string()));
		metadata.insert("rev".into(), serde_json::Value::String(rev_arg.to_string()));

		nodes.push(NodeRef {
			locator: path,
			range: 0..file_diff.len(),
			kind: "§diff".to_string(),
			content: Some(Content::Text { value: content }),
			metadata,
			diagnostics: Vec::new(),
		});
	}

	Ok(nodes)
}

/// Split a unified diff containing multiple files into per-file strings.
/// Each split starts at a `diff --git` line and includes everything up to
/// (but not including) the next `diff --git` line.
fn split_file_diffs(full_diff: &str) -> Vec<String> {
	let marker = "diff --git ";
	let mut files = Vec::new();
	let mut start = None;

	for (i, line) in full_diff.lines().enumerate() {
		if line.starts_with(marker) {
			if let Some(pos) = start {
				let end = byte_offset_for_line(full_diff, i);
				files.push(full_diff[pos..end].to_string());
			}
			start = Some(byte_offset_for_line(full_diff, i));
		}
	}

	// Last file
	if let Some(pos) = start {
		files.push(full_diff[pos..].to_string());
	}

	files
}

/// Compute the byte offset for a given 0-indexed line number.
fn byte_offset_for_line(text: &str, line: usize) -> usize {
	let mut offset = 0;
	for _ in 0..line {
		match text[offset..].find('\n') {
			Some(pos) => offset += pos + 1,
			None => break,
		}
	}
	offset
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;
	use crate::embedding_worker::lock_test_env_read;

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

	fn qual(args: Option<&str>) -> Qualifier {
		Qualifier { name: "diff".to_string(), args: args.map(|s| s.to_string()) }
	}

	fn init_git_repo(dir: &Path) {
		Command::new("git")
			.args(["init"])
			.current_dir(dir)
			.output()
			.unwrap();
		Command::new("git")
			.args(["config", "user.email", "test@test.com"])
			.current_dir(dir)
			.output()
			.unwrap();
		Command::new("git")
			.args(["config", "user.name", "Test"])
			.current_dir(dir)
			.output()
			.unwrap();
	}

	fn git_commit_all(dir: &Path, msg: &str) {
		Command::new("git")
			.args(["add", "-A"])
			.current_dir(dir)
			.output()
			.unwrap();
		Command::new("git")
			.args(["commit", "-m", msg])
			.current_dir(dir)
			.output()
			.unwrap();
	}

	// ── Test 1: Clean tree ───────────────────────────────────────

	#[test]
	fn clean_tree_returns_empty() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);
		fs::write(root.join("f.txt"), "hello\n").unwrap();
		git_commit_all(&root, "initial");

		let n = node("f.txt", "§file");
		let results = resolve(&n, &qual(None), &root).unwrap();
		assert!(
			results.is_empty(),
			"expected empty diff for clean tree, got {} results",
			results.len()
		);
	}

	// ── Test 2: Modified file returns diff ───────────────────────

	#[test]
	fn modified_file_returns_diff() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);
		fs::write(root.join("f.txt"), "hello\n").unwrap();
		git_commit_all(&root, "initial");
		fs::write(root.join("f.txt"), "hello\nworld\n").unwrap();

		let n = node("f.txt", "§file");
		let results = resolve(&n, &qual(None), &root).unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].kind, "§diff");
		let c = results[0].content.as_ref().expect("expected content");
		let text = match c {
			Content::Text { value } => value.as_str(),
			_ => panic!("expected text content"),
		};
		assert!(text.contains("+world"), "expected +world in diff");

		let adds = results[0]
			.metadata
			.get("additions")
			.and_then(|v| v.as_u64())
			.unwrap();
		let dels = results[0]
			.metadata
			.get("deletions")
			.and_then(|v| v.as_u64())
			.unwrap();
		assert_eq!(adds, 1, "expected 1 addition");
		assert_eq!(dels, 0, "expected 0 deletions (hello is context)");
		assert_eq!(
			results[0]
				.metadata
				.get("change_kind")
				.and_then(|v| v.as_str())
				.unwrap(),
			"modified"
		);
	}

	// ── Test 3: New file ──────────────────────────────────────────

	#[test]
	fn new_file_shows_as_additions() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);
		fs::write(root.join("existing.txt"), "a\n").unwrap();
		git_commit_all(&root, "initial");

		// Create and stage new file after commit
		fs::write(root.join("new.txt"), "new content\n").unwrap();
		Command::new("git")
			.args(["add", "new.txt"])
			.current_dir(&root)
			.output()
			.unwrap();

		let n = node("new.txt", "§file");
		let results = resolve(&n, &qual(None), &root).unwrap();
		assert_eq!(results.len(), 1);
		let adds = results[0]
			.metadata
			.get("additions")
			.and_then(|v| v.as_u64())
			.unwrap();
		assert!(adds > 0, "expected additions for new file");
		assert_eq!(
			results[0]
				.metadata
				.get("change_kind")
				.and_then(|v| v.as_str())
				.unwrap(),
			"added"
		);
	}

	// ── Test 4: Deleted file ──────────────────────────────────────

	#[test]
	fn deleted_file_shows_as_deletions() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);
		fs::write(root.join("f.txt"), "content to delete\n").unwrap();
		git_commit_all(&root, "initial");

		fs::remove_file(root.join("f.txt")).unwrap();

		let n = node("f.txt", "§file");
		let results = resolve(&n, &qual(None), &root).unwrap();
		assert_eq!(results.len(), 1);
		let dels = results[0]
			.metadata
			.get("deletions")
			.and_then(|v| v.as_u64())
			.unwrap();
		assert!(dels > 0, "expected deletions for deleted file");
		assert_eq!(
			results[0]
				.metadata
				.get("change_kind")
				.and_then(|v| v.as_str())
				.unwrap(),
			"deleted"
		);
	}

	// ── Test 5: Workspace bare #diff ──────────────────────────────

	#[test]
	fn workspace_diff_returns_multi_file() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);
		fs::write(root.join("a.txt"), "a\n").unwrap();
		fs::write(root.join("b.txt"), "b\n").unwrap();
		git_commit_all(&root, "initial");
		fs::write(root.join("a.txt"), "a-modified\n").unwrap();
		fs::write(root.join("b.txt"), "b-modified\n").unwrap();

		let n = node(".", "§dir");
		let results = resolve(&n, &qual(None), &root).unwrap();
		assert_eq!(results.len(), 2, "expected 2 files in workspace diff");
		assert!(results.iter().any(|r| r.locator == "a.txt"));
		assert!(results.iter().any(|r| r.locator == "b.txt"));
		for r in &results {
			assert_eq!(r.kind, "§diff");
			assert!(r.content.is_some());
		}
	}

	// ── Test 6: base=HEAD~1 ───────────────────────────────────────

	#[test]
	fn diff_against_historical_rev() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);

		fs::write(root.join("f.txt"), "first\n").unwrap();
		git_commit_all(&root, "first");

		fs::write(root.join("f.txt"), "first\nsecond\n").unwrap();
		git_commit_all(&root, "second");

		fs::write(root.join("f.txt"), "first\nsecond\nthird\n").unwrap();

		let n = node("f.txt", "§file");
		let results = resolve(&n, &qual(Some("base=HEAD~1")), &root).unwrap();
		assert_eq!(results.len(), 1);
		let adds = results[0]
			.metadata
			.get("additions")
			.and_then(|v| v.as_u64())
			.unwrap();
		assert_eq!(adds, 2, "expected 2 additions from HEAD~1 (vs first commit)");
	}

	// ── Test 7: Non-git directory ─────────────────────────────────

	#[test]
	fn non_git_returns_unsupported() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		fs::write(root.join("f.txt"), "data\n").unwrap();

		let n = node("f.txt", "§file");
		let err = resolve(&n, &qual(None), &root).unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::UnsupportedOperation);
		assert!(err.message.contains("not a git repository"));
	}

	// ── Test 8: since= date filter ────────────────────────────────

	#[test]
	fn diff_since_date_resolves_commit() {
		let _env_guard = lock_test_env_read();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		init_git_repo(&root);

		fs::write(root.join("f.txt"), "base\n").unwrap();
		git_commit_all(&root, "base");

		// Small delay to ensure distinct timestamps
		std::thread::sleep(std::time::Duration::from_millis(1100));

		fs::write(root.join("f.txt"), "base\nlater\n").unwrap();
		git_commit_all(&root, "later");

		fs::write(root.join("f.txt"), "base\nlater\nnow\n").unwrap();

		let n = node("f.txt", "§file");
		let results = resolve(&n, &qual(Some("since=2000-01-01")), &root).unwrap();
		assert_eq!(results.len(), 1, "should diff against earliest commit");
		let rev = results[0]
			.metadata
			.get("rev")
			.and_then(|v| v.as_str())
			.unwrap();
		assert!(!rev.is_empty(), "rev should not be empty");
	}
}
