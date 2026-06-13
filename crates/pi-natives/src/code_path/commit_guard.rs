//! Commit-awareness for undo (PLAN-338 C).
//!
//! The undo data-loss class (BUG-470) had a third root cause:
//! `EditEntry.commit` was always `None` and nothing reconciled external `git
//! commit`s, so `revert` happily rewrote work that was already durably saved in
//! git. This module is the guard: it answers "is this file's recorded edit
//! already committed?" so undo can DECLINE by default (overridable with
//! `force`).
//!
//! Design rules:
//! - FAIL-OPEN. Git absent, not a repo, command error → treat as NOT committed
//!   (return `false`). The guard must never *block* an undo just because git is
//!   unavailable; it only *adds* safety when git is present and definitive.
//! - CHEAP. One `git` subprocess per check, no repo object walking. Undo of a
//!   group is N checks; N is small (files in one logical edit).
//! - HEAD-relative. "Committed" means: the file is tracked AND has no unstaged
//!   or uncommitted diff against HEAD — i.e. the on-disk content the edit
//!   produced is what HEAD holds. If the working tree still differs from HEAD,
//!   the edit is NOT yet durably saved and undo is safe.

use std::{path::Path, process::Command};

/// Capture the current HEAD sha for the repo containing `file`, if any.
///
/// Stamped onto a freshly-recorded `EditEntry` so that even if the file later
/// diverges from HEAD we retain the sha the edit was made against. Fail-open:
/// returns `None` when git is unavailable or `file` is outside a repo.
pub fn head_sha(file: &Path) -> Option<String> {
	let dir = file.parent()?;
	let out = Command::new("git")
		.args(["rev-parse", "HEAD"])
		.current_dir(dir)
		.output()
		.ok()?;
	if !out.status.success() {
		return None;
	}
	let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
	if sha.is_empty() { None } else { Some(sha) }
}

/// Is `file` already committed at HEAD (tracked AND clean vs HEAD)?
///
/// Returns `true` only when git is present, `file` is tracked, and there is no
/// diff between the working-tree file and HEAD. Any uncertainty → `false`
/// (fail-open): undo proceeds rather than blocking on an indeterminate state.
///
/// Mechanism: `git status --porcelain -- <file>`.
/// - non-empty output → the file has uncommitted/unstaged changes → NOT
///   committed (the edit's content is not yet in HEAD) → `false`.
/// - empty output AND the file is tracked → clean vs HEAD → committed → `true`.
/// - empty output but the file is UNTRACKED → git prints nothing for an
///   ignored/untracked path under `--porcelain` only if ignored; an untracked
///   file shows as `??`. So empty ⇒ tracked-and-clean. We additionally confirm
///   tracking to avoid treating an ignored file as committed.
pub fn is_committed(file: &Path) -> bool {
	let Some(dir) = file.parent() else {
		return false;
	};
	// Porcelain status for just this path. Empty = no pending change.
	let status = Command::new("git")
		.args(["status", "--porcelain", "--"])
		.arg(file)
		.current_dir(dir)
		.output();
	let Ok(status) = status else {
		return false; // git missing → fail-open
	};
	if !status.status.success() {
		return false; // not a repo / error → fail-open
	}
	if !status.stdout.is_empty() {
		// Has a pending change (modified/untracked/staged) → not durably in HEAD.
		return false;
	}
	// Clean working tree for this path. Confirm it is TRACKED (not merely
	// ignored, which also yields empty porcelain output) before calling it
	// committed.
	is_tracked(file)
}

/// Is `file` tracked by git (known to the index)? Fail-open `false`.
fn is_tracked(file: &Path) -> bool {
	let Some(dir) = file.parent() else {
		return false;
	};
	Command::new("git")
		.args(["ls-files", "--error-unmatch", "--"])
		.arg(file)
		.current_dir(dir)
		.output()
		.map(|o| o.status.success())
		.unwrap_or(false)
}

#[cfg(test)]
mod tests {
	use std::process::Command;

	use tempfile::TempDir;

	use super::*;

	fn git(args: &[&str], dir: &Path) {
		let ok = Command::new("git")
			.args(args)
			.current_dir(dir)
			.output()
			.map(|o| o.status.success())
			.unwrap_or(false);
		assert!(ok, "git {args:?} failed");
	}

	fn init_repo(dir: &Path) {
		git(&["init", "-q"], dir);
		git(&["config", "user.email", "t@t"], dir);
		git(&["config", "user.name", "t"], dir);
		// Deterministic: no GPG, no hooks.
		git(&["config", "commit.gpgsign", "false"], dir);
	}

	#[test]
	fn untracked_file_is_not_committed() {
		let dir = TempDir::new().unwrap();
		init_repo(dir.path());
		let f = dir.path().join("a.txt");
		std::fs::write(&f, "hello\n").unwrap();
		// Untracked → not committed.
		assert!(!is_committed(&f));
	}

	#[test]
	fn committed_clean_file_is_committed() {
		let dir = TempDir::new().unwrap();
		init_repo(dir.path());
		let f = dir.path().join("a.txt");
		std::fs::write(&f, "hello\n").unwrap();
		git(&["add", "a.txt"], dir.path());
		git(&["commit", "-q", "-m", "add"], dir.path());
		assert!(is_committed(&f), "tracked + clean vs HEAD");
		assert!(head_sha(&f).is_some());
	}

	#[test]
	fn committed_then_modified_is_not_committed() {
		let dir = TempDir::new().unwrap();
		init_repo(dir.path());
		let f = dir.path().join("a.txt");
		std::fs::write(&f, "hello\n").unwrap();
		git(&["add", "a.txt"], dir.path());
		git(&["commit", "-q", "-m", "add"], dir.path());
		// Diverge from HEAD → the new content is not durably saved.
		std::fs::write(&f, "hello world\n").unwrap();
		assert!(!is_committed(&f), "dirty vs HEAD → undo is safe");
	}

	#[test]
	fn non_repo_path_fails_open_false() {
		let dir = TempDir::new().unwrap();
		// No git init here.
		let f = dir.path().join("a.txt");
		std::fs::write(&f, "x\n").unwrap();
		assert!(!is_committed(&f), "no repo → fail-open false");
		assert!(head_sha(&f).is_none());
	}
}
