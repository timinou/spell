//! Per-session edit-history tracker (BUG-340).
//!
//! Even when edits auto-save, the agent can inspect or revert THIS
//! session's changes via `manage diff/undo/context`.  Sibling sessions'
//! edits survive because each entry is tagged with its session id.

use std::{
	fs::{File, OpenOptions},
	io::{BufRead, BufReader, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::SystemTime,
};

use serde::{Deserialize, Serialize};

static ENTRY_ID: AtomicU64 = AtomicU64::new(0);

/// Generate a monotonic entry id.
pub fn next_entry_id() -> String {
	ENTRY_ID.fetch_add(1, Ordering::SeqCst).to_string()
}

/// One edit committed by a single agent session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditEntry {
	pub id:          String,
	pub session_id:  String,
	pub agent_label: String,
	pub file:        PathBuf,
	pub before:      String,
	pub after:       String,
	pub diff:        String,
	pub timestamp:   SystemTime,
	pub commit:      Option<String>,
	pub reverted:    bool,
}

/// Builder-style query for the history log.
#[derive(Default, Clone, Debug)]
pub struct HistoryQuery {
	pub session_id:       Option<String>,
	pub agent_label:      Option<String>,
	pub file_glob:        Option<String>,
	pub since:            Option<SystemTime>,
	pub uncommitted_only: bool,
	pub exclude_reverted: bool,
}

impl HistoryQuery {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn session_id(mut self, s: impl Into<String>) -> Self {
		self.session_id = Some(s.into());
		self
	}

	pub fn agent_label(mut self, s: impl Into<String>) -> Self {
		self.agent_label = Some(s.into());
		self
	}

	pub fn file_glob(mut self, g: impl Into<String>) -> Self {
		self.file_glob = Some(g.into());
		self
	}

	pub fn since(mut self, t: SystemTime) -> Self {
		self.since = Some(t);
		self
	}

	pub fn uncommitted_only(mut self, b: bool) -> Self {
		self.uncommitted_only = b;
		self
	}

	pub fn exclude_reverted(mut self, b: bool) -> Self {
		self.exclude_reverted = b;
		self
	}
}

/// Result of a revert operation.
///
/// `Success` carries the *effective* change the operation produced so callers
/// can render a diff cell (PLAN-332 Thesis D / FEAT-809): for `revert` the
/// effective diff is after→before (the recorded diff, reversed); for `reapply`
/// it is before→after (the recorded diff as-is). `file` is the absolute path
/// that changed, for the cell title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertOutcome {
	Success { entry_id: String, file: PathBuf, diff: String },
	NotFound,
	Error(String),
}

/// Reverse a recorded edit diff: swap `+`/`-` line prefixes and the two sides
/// of each `@@ -a,b +c,d @@` header, turning a before→after diff into the
/// effective undo diff (after→before).
///
/// Recorded diffs come solely from `pi_code_engine::diff_lines`, which emits
/// ONLY `@@` hunk headers and bare `+`/`-` content lines — never `---`/`+++`
/// file headers. We deliberately do NOT special-case `--- `/`+++ `: a removed
/// source line whose text begins with `-- ` (Lua/SQL/Haskell comment)
/// serialises to a diff line `--- …`, and treating that as a file header would
/// corrupt it (wrong sign, dropped prefix). The generic single-char `+`/`-`
/// branches reverse every content line correctly, headers included. Context
/// lines (leading space) and any other line pass through unchanged.
pub(crate) fn reverse_unified_diff(diff: &str) -> String {
	let mut out = String::with_capacity(diff.len());
	// BUG-459: a change block lists removals (`-`) before additions (`+`) by
	// unified-diff convention. Reversing must preserve that ordering, so we
	// can't just swap signs in place (that would emit `+`-before-`-`). Instead
	// we buffer each contiguous run of +/- lines and, on flush, emit the
	// formerly-`+` lines (now `-`) first, then the formerly-`-` lines (now `+`).
	let mut pending_minus: Vec<String> = Vec::new(); // become `-` (were `+`)
	let mut pending_plus: Vec<String> = Vec::new(); // become `+` (were `-`)

	let flush = |out: &mut String, minus: &mut Vec<String>, plus: &mut Vec<String>| {
		for l in minus.drain(..) {
			out.push_str(&l);
		}
		for l in plus.drain(..) {
			out.push_str(&l);
		}
	};

	for line in diff.split_inclusive('\n') {
		let (body, nl) = match line.strip_suffix('\n') {
			Some(b) => (b, "\n"),
			None => (line, ""),
		};
		if let Some(rest) = body.strip_prefix("@@ ") {
			// A hunk header ends the current change block.
			flush(&mut out, &mut pending_minus, &mut pending_plus);
			// `@@ -a,b +c,d @@` → `@@ -c,d +a,b @@`
			if let Some(close) = rest.find(" @@") {
				let ranges = &rest[..close];
				let tail = &rest[close..];
				let parts: Vec<&str> = ranges.split(' ').collect();
				if parts.len() == 2
					&& let (Some(minus), Some(plus)) =
						(parts[0].strip_prefix('-'), parts[1].strip_prefix('+'))
				{
					out.push_str(&format!("@@ -{plus} +{minus}{tail}{nl}"));
					continue;
				}
			}
			out.push_str(line);
		} else if let Some(rest) = body.strip_prefix('+') {
			pending_minus.push(format!("-{rest}{nl}"));
		} else if let Some(rest) = body.strip_prefix('-') {
			pending_plus.push(format!("+{rest}{nl}"));
		} else {
			// Context (leading space) or any other line ends the change block
			// and passes through unchanged.
			flush(&mut out, &mut pending_minus, &mut pending_plus);
			out.push_str(line);
		}
	}
	flush(&mut out, &mut pending_minus, &mut pending_plus);
	out
}

/// Storage backend for edit history.
pub trait EditHistory: Send + Sync {
	fn record(&self, entry: EditEntry);
	fn query(&self, q: HistoryQuery) -> Vec<EditEntry>;
	fn revert(&self, q: HistoryQuery) -> RevertOutcome;
	/// Re-apply the most-recently-reverted matching entry (the inverse of
	/// [`EditHistory::revert`]): restores `before→after` and clears the
	/// `reverted` flag so a subsequent `revert` can undo it again.
	fn reapply(&self, q: HistoryQuery) -> RevertOutcome;
}

/// JSONL-backed history stored at `<root>/.spell/edit-history.jsonl`.
pub struct JsonlHistory {
	path: PathBuf,
}

impl JsonlHistory {
	pub fn new(path: PathBuf) -> Self {
		Self { path }
	}

	#[cfg(test)]
	pub fn in_memory() -> Self {
		static COUNTER: AtomicU64 = AtomicU64::new(0);
		let n = COUNTER.fetch_add(1, Ordering::SeqCst);
		let path =
			std::env::temp_dir().join(format!("edit-history-{}-{}.jsonl", std::process::id(), n));
		let _ = std::fs::remove_file(&path);
		Self { path }
	}

	fn read_all(&self) -> Vec<EditEntry> {
		let file = match File::open(&self.path) {
			Ok(f) => f,
			Err(_) => return Vec::new(),
		};
		let reader = BufReader::new(file);
		reader
			.lines()
			.filter_map(|line| {
				let line = line.ok()?;
				serde_json::from_str::<EditEntry>(&line).ok()
			})
			.collect()
	}

	fn write_all(&self, entries: &[EditEntry]) {
		let mut file = OpenOptions::new()
			.write(true)
			.create(true)
			.truncate(true)
			.open(&self.path)
			.expect("open history file");
		for entry in entries {
			let line = serde_json::to_string(entry).expect("serialize entry");
			writeln!(file, "{line}").expect("write history");
		}
	}
}

impl EditHistory for JsonlHistory {
	fn record(&self, entry: EditEntry) {
		if let Some(parent) = self.path.parent() {
			let _ = std::fs::create_dir_all(parent);
		}
		let mut file = match OpenOptions::new()
			.append(true)
			.create(true)
			.open(&self.path)
		{
			Ok(f) => f,
			Err(_) => return, // history is best-effort; never block the edit
		};
		let line = match serde_json::to_string(&entry) {
			Ok(s) => s,
			Err(_) => return,
		};
		let _ = writeln!(file, "{line}");
	}

	fn query(&self, q: HistoryQuery) -> Vec<EditEntry> {
		self
			.read_all()
			.into_iter()
			.filter(|e| {
				if let Some(ref sid) = q.session_id {
					if e.session_id != *sid {
						return false;
					}
				}
				if let Some(ref label) = q.agent_label {
					if e.agent_label != *label {
						return false;
					}
				}
				if let Some(ref glob) = q.file_glob {
					if !glob_match(glob, &e.file) {
						return false;
					}
				}
				if let Some(since) = q.since {
					if e.timestamp < since {
						return false;
					}
				}
				if q.uncommitted_only && e.commit.is_some() {
					return false;
				}
				if q.exclude_reverted && e.reverted {
					return false;
				}
				true
			})
			.collect()
	}

	fn revert(&self, q: HistoryQuery) -> RevertOutcome {
		let mut entries = self.read_all();
		let idx = entries.iter().rposition(|e| {
			if e.reverted {
				return false;
			}
			if let Some(ref sid) = q.session_id {
				if e.session_id != *sid {
					return false;
				}
			}
			if let Some(ref glob) = q.file_glob {
				if !glob_match(glob, &e.file) {
					return false;
				}
			}
			true
		});
		let idx = match idx {
			Some(i) => i,
			None => return RevertOutcome::NotFound,
		};

		let entry = &entries[idx];
		let file = &entry.file;
		if let Some(parent) = file.parent() {
			let _ = std::fs::create_dir_all(parent);
		}
		let current = std::fs::read_to_string(file).unwrap_or_else(|_| entry.after.clone());
		let new_content = if current == entry.after {
			entry.before.clone()
		} else {
			match revert_chunk_replace(&current, &entry.after, &entry.before) {
				Some(s) => s,
				None => {
					return RevertOutcome::Error(format!(
						"cannot revert {} cleanly: file changed since edit and chunk replace failed",
						entry.id
					));
				},
			}
		};
		if let Err(e) = std::fs::write(file, &new_content) {
			return RevertOutcome::Error(format!("write failed: {e}"));
		}
		let entry_id = entry.id.clone();
		// Effective change of an undo is after→before: reverse the recorded diff.
		let effective_diff = reverse_unified_diff(&entry.diff);
		let file_path = entry.file.clone();
		entries[idx].reverted = true;
		self.write_all(&entries);
		RevertOutcome::Success { entry_id, file: file_path, diff: effective_diff }
	}

	fn reapply(&self, q: HistoryQuery) -> RevertOutcome {
		let mut entries = self.read_all();
		// Inverse of revert: target the most-recently *reverted* entry.
		let idx = entries.iter().rposition(|e| {
			if !e.reverted {
				return false;
			}
			if let Some(ref sid) = q.session_id {
				if e.session_id != *sid {
					return false;
				}
			}
			if let Some(ref glob) = q.file_glob {
				if !glob_match(glob, &e.file) {
					return false;
				}
			}
			true
		});
		let idx = match idx {
			Some(i) => i,
			None => return RevertOutcome::NotFound,
		};

		let entry = &entries[idx];
		let file = &entry.file;
		if let Some(parent) = file.parent() {
			let _ = std::fs::create_dir_all(parent);
		}
		// Re-apply before→after. If the file already matches `before`, swap to
		// `after`; otherwise locate the `before` chunk and replace it (symmetric
		// with revert_chunk_replace, args swapped).
		let current = std::fs::read_to_string(file).unwrap_or_else(|_| entry.before.clone());
		let new_content = if current == entry.before {
			entry.after.clone()
		} else {
			match revert_chunk_replace(&current, &entry.before, &entry.after) {
				Some(s) => s,
				None => {
					return RevertOutcome::Error(format!(
						"cannot reapply {} cleanly: file changed since undo and chunk replace failed",
						entry.id
					));
				},
			}
		};
		if let Err(e) = std::fs::write(file, &new_content) {
			return RevertOutcome::Error(format!("write failed: {e}"));
		}
		let entry_id = entry.id.clone();
		// Effective change of a redo is before→after: the recorded diff as-is.
		let effective_diff = entry.diff.clone();
		let file_path = entry.file.clone();
		entries[idx].reverted = false;
		self.write_all(&entries);
		RevertOutcome::Success { entry_id, file: file_path, diff: effective_diff }
	}
}

/// Compute file content with `from→to` change reverted.
/// Walks line-by-line through `before` and `after`, identifies the first
/// minimal differing chunk, and replaces it in `current`. Returns None if
/// the chunk isn't found verbatim (overlap with another edit).
fn revert_chunk_replace(current: &str, after: &str, before: &str) -> Option<String> {
	let a_lines: Vec<&str> = after.split_inclusive('\n').collect();
	let b_lines: Vec<&str> = before.split_inclusive('\n').collect();
	// Find minimal differing range: skip identical prefix and suffix.
	let mut start = 0;
	while start < a_lines.len() && start < b_lines.len() && a_lines[start] == b_lines[start] {
		start += 1;
	}
	let mut a_end = a_lines.len();
	let mut b_end = b_lines.len();
	while a_end > start && b_end > start && a_lines[a_end - 1] == b_lines[b_end - 1] {
		a_end -= 1;
		b_end -= 1;
	}
	let after_chunk: String = a_lines[start..a_end].concat();
	let before_chunk: String = b_lines[start..b_end].concat();
	if after_chunk == before_chunk {
		return Some(current.to_string()); // no-op
	}
	if !current.contains(&after_chunk) {
		return None;
	}
	Some(current.replacen(&after_chunk, &before_chunk, 1))
}

/// Very simple glob: exact match or "*" wildcard prefix/suffix.
fn glob_match(pattern: &str, path: &Path) -> bool {
	let s = path.to_string_lossy();
	if pattern == "*" || pattern == "**" {
		return true;
	}
	if pattern.contains('*') {
		let parts: Vec<&str> = pattern.split('*').collect();
		if parts.len() == 2 {
			let prefix = parts[0];
			let suffix = parts[1];
			return s.starts_with(prefix) && s.ends_with(suffix);
		}
	}
	s == pattern
}

#[cfg(test)]
mod tests {
	use super::*;

	fn entry(sid: &str, file: &str) -> EditEntry {
		EditEntry {
			id:          "1".into(),
			session_id:  sid.into(),
			agent_label: "".into(),
			file:        PathBuf::from(file),
			before:      "before".into(),
			after:       "after".into(),
			diff:        "diff".into(),
			timestamp:   SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
		}
	}

	#[test]
	fn history_query_filters_by_session() {
		let h = JsonlHistory::in_memory();
		h.record(entry("S1", "a.txt"));
		h.record(entry("S2", "a.txt"));
		let r = h.query(HistoryQuery::default().session_id("S1"));
		assert_eq!(r.len(), 1);
		assert_eq!(r[0].session_id, "S1");
	}

	#[test]
	fn revert_undoes_only_targeted_entry() {
		let tmp = std::env::temp_dir();
		let a = tmp.join(format!("history-test-a-{}.txt", std::process::id()));
		let b = tmp.join(format!("history-test-b-{}.txt", std::process::id()));
		std::fs::write(&a, "after").unwrap();
		std::fs::write(&b, "after").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(entry("S1", a.to_str().unwrap()));
		h.record(entry("S1", b.to_str().unwrap()));
		let r = h.revert(
			HistoryQuery::default()
				.session_id("S1")
				.file_glob(a.to_str().unwrap()),
		);
		assert!(matches!(r, RevertOutcome::Success { .. }), "got {r:?}");
		let _ = std::fs::remove_file(&a);
		let _ = std::fs::remove_file(&b);
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert!(all[0].reverted);
		assert!(!all[1].reverted);
	}

	#[test]
	fn uncommitted_only_filter_excludes_post_commit_entries() {
		let h = JsonlHistory::in_memory();
		let e1 = entry("S1", "a.txt");
		let mut e2 = entry("S1", "a.txt");
		e2.commit = Some("abc".into());
		e2.id = "2".into();
		h.record(e1);
		h.record(e2);
		let r = h.query(
			HistoryQuery::default()
				.session_id("S1")
				.uncommitted_only(true),
		);
		assert_eq!(r.len(), 1);
		assert!(r[0].commit.is_none());
	}

	// PLAN-332 Thesis D / FEAT-809: undo/redo surface the effective diff.
	#[test]
	fn reverse_unified_diff_swaps_signs_and_ranges() {
		// Recorded diffs are headerless (only `@@` + bare `+`/`-` lines).
		let forward = "@@ -1,2 +1,2 @@\n-old line\n+new line\n ctx\n";
		let reversed = reverse_unified_diff(forward);
		// BUG-459: the reversed hunk keeps unified-diff order — removals (`-`)
		// before additions (`+`) — so the formerly-`+` line becomes the leading
		// `-` and the formerly-`-` line becomes the trailing `+`.
		assert_eq!(reversed, "@@ -1,2 +1,2 @@\n-new line\n+old line\n ctx\n");
		// Reversing twice is the identity (both sides are well-formed minus-first).
		assert_eq!(reverse_unified_diff(&reversed), forward);
	}

	// Review P2 regression: a removed/added source line whose TEXT begins with
	// `-- ` / `++ ` must NOT be mistaken for a `---`/`+++` file header. The
	// reversed line keeps its content; only the leading diff sign flips.
	#[test]
	fn reverse_unified_diff_preserves_comment_content_lines() {
		// `-- note` is a Lua/SQL/Haskell comment; in a forward diff the removed
		// line serialises as `--- note` (diff sign `-` + text `-- note`).
		let forward = "@@ -1 +1 @@\n--- note\n+++ kept\n";
		let reversed = reverse_unified_diff(forward);
		// Undo flips signs AND keeps minus-first order (BUG-459): the formerly-`+`
		// line (`+++ kept`) becomes the leading `-++ kept`, the formerly-`-` line
		// (`--- note`) becomes the trailing `+-- note`. Crucially the CONTENT
		// (`++ kept`, `-- note`) is preserved — not mistaken for a file header.
		assert_eq!(reversed, "@@ -1 +1 @@\n-++ kept\n+-- note\n");
		assert_eq!(reverse_unified_diff(&reversed), forward);
	}

	// BUG-459: a multi-line change block must reverse to minus-first order — all
	// removals before all additions — not interleaved or plus-first.
	#[test]
	fn reverse_unified_diff_multiline_block_is_minus_first() {
		let forward = "@@ -1,3 +1,3 @@\n-a\n-b\n+x\n+y\n";
		let reversed = reverse_unified_diff(forward);
		assert_eq!(reversed, "@@ -1,3 +1,3 @@\n-x\n-y\n+a\n+b\n");
		assert_eq!(reverse_unified_diff(&reversed), forward);
	}

	#[test]
	fn revert_returns_effective_after_to_before_diff() {
		let tmp = std::env::temp_dir();
		let f = tmp.join(format!("history-diff-{}.txt", std::process::id()));
		std::fs::write(&f, "AFTER\n").unwrap();
		let h = JsonlHistory::in_memory();
		let mut e = entry("S1", f.to_str().unwrap());
		e.before = "BEFORE\n".into();
		e.after = "AFTER\n".into();
		e.diff = "@@ -1 +1 @@\n-BEFORE\n+AFTER\n".into();
		h.record(e);
		let out = h.revert(HistoryQuery::default().session_id("S1"));
		match out {
			RevertOutcome::Success { diff, file, .. } => {
				// Undo's effective diff is after→before: signs flipped.
				assert!(diff.contains("+BEFORE"), "diff: {diff}");
				assert!(diff.contains("-AFTER"), "diff: {diff}");
				assert_eq!(file, f);
			},
			other => panic!("expected Success, got {other:?}"),
		}
		assert_eq!(std::fs::read_to_string(&f).unwrap(), "BEFORE\n");
		let _ = std::fs::remove_file(&f);
	}
}
