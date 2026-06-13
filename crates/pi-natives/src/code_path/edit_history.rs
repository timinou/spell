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

thread_local! {
	/// The group id stamped onto every `EditEntry` recorded on THIS thread.
	///
	/// Set by the edit command handler for the duration of one logical `edit`
	/// tool invocation (via [`EditGroupGuard`]) and read by the edit recorder.
	/// The recorder fires synchronously on the same blocking-task thread as the
	/// `edit_transaction` that triggered it, so a thread-local cleanly carries
	/// the group identity to every fan-out write (TS multi-op batch AND a
	/// kernel-side multi-file rename) without threading a parameter through
	/// `edit_transaction`'s signature and all its callers.
	static CURRENT_EDIT_GROUP: std::cell::RefCell<Option<String>> =
		const { std::cell::RefCell::new(None) };
}

/// Read the group id active on the current thread, if any.
pub fn current_edit_group() -> Option<String> {
	CURRENT_EDIT_GROUP.with(|g| g.borrow().clone())
}

/// RAII guard that sets the current-thread edit group for its lifetime and
/// restores the prior value on drop. Restoring (rather than clearing) keeps
/// nested/reentrant edit dispatches correct.
pub struct EditGroupGuard(Option<String>);

impl EditGroupGuard {
	/// Activate `group` on this thread. A `None` group is a no-op carrier
	/// (entries fall back to singleton groups), so callers can pass through an
	/// optional id unconditionally.
	pub fn new(group: Option<String>) -> Self {
		let prior = CURRENT_EDIT_GROUP.with(|g| g.replace(group));
		Self(prior)
	}
}

impl Drop for EditGroupGuard {
	fn drop(&mut self) {
		let prior = self.0.take();
		CURRENT_EDIT_GROUP.with(|g| *g.borrow_mut() = prior);
	}
}

thread_local! {
	/// The session dir active on THIS thread (PLAN-338 B). When set, the edit
	/// recorder writes to `<session_dir>/edit-history.jsonl` — ONE unified log
	/// per session — instead of the per-workspace-shard
	/// `workspace_root_for(file)/.spell/edit-history.jsonl`. This kills the bug
	/// where a target-less undo only saw the session-cwd shard's log and missed
	/// edits made in sibling subtrees of a monorepo. Same thread-local carrier
	/// pattern as the edit group: the recorder runs synchronously on the edit
	/// thread, so no signature threading is needed. `None` => legacy per-shard
	/// path (headless/test, and the natural "fresh start" for old sessions).
	static CURRENT_SESSION_DIR: std::cell::RefCell<Option<PathBuf>> =
		const { std::cell::RefCell::new(None) };
}

/// Read the session dir active on the current thread, if any.
pub fn current_session_dir() -> Option<PathBuf> {
	CURRENT_SESSION_DIR.with(|d| d.borrow().clone())
}

/// The session-unified edit-history log path for a session dir.
pub fn session_log_path(session_dir: &Path) -> PathBuf {
	session_dir.join("edit-history.jsonl")
}

/// RAII guard that sets the current-thread session dir for its lifetime and
/// restores the prior value on drop (mirrors [`EditGroupGuard`]).
pub struct SessionDirGuard(Option<PathBuf>);

impl SessionDirGuard {
	/// Activate `dir` on this thread. A `None` dir is a no-op carrier (recorder
	/// falls back to the legacy per-workspace path).
	pub fn new(dir: Option<PathBuf>) -> Self {
		let prior = CURRENT_SESSION_DIR.with(|d| d.replace(dir));
		Self(prior)
	}
}

impl Drop for SessionDirGuard {
	fn drop(&mut self) {
		let prior = self.0.take();
		CURRENT_SESSION_DIR.with(|d| *d.borrow_mut() = prior);
	}
}

/// One edit committed by a single agent session.
///
/// `group_id` (PLAN: undo-atomicity) ties together every entry produced by a
/// single logical `edit` tool invocation. A rename that rewrites N files fans
/// out to N `EditEntry` rows sharing one `group_id`; undo/redo then operate on
/// the whole group atomically so a multi-file operation is never left
/// half-reverted. `None` = a standalone entry (its own singleton group),
/// preserving the meaning of pre-grouping logs.
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
	#[serde(default)]
	pub group_id:    Option<String>,
	/// Absolute workspace root this edit's file belongs to (PLAN-338 B). With
	/// the session-unified log a single log spans multiple workspaces, so each
	/// entry records its own workspace for display/filtering.
	/// `#[serde(default)]` (empty) keeps pre-unification logs readable.
	#[serde(default)]
	pub workspace:   String,
}

/// Builder-style query for the history log.
#[derive(Default, Clone, Debug)]
pub struct HistoryQuery {
	pub session_id:       Option<String>,
	pub agent_label:      Option<String>,
	pub file_glob:        Option<String>,
	/// Exact entry id to target (PLAN-338 B). When set, revert/reapply act on
	/// the entry with this id (and its group), enabling id-precise undo/redo
	/// driven by the `status command:"history"` listing.
	pub entry_id:         Option<String>,
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

	pub fn entry_id(mut self, id: impl Into<String>) -> Self {
		self.entry_id = Some(id.into());
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

/// Result of a revert/reapply operation.
///
/// `Success` carries the *effective* change(s) the operation produced so
/// callers can render diff cells (PLAN-332 Thesis D / FEAT-809). A single
/// logical undo/redo may touch MULTIPLE files when the original edit was a
/// grouped operation (e.g. a cross-file rename): `files` lists one
/// `(path, effective_diff)` per reverted entry, in application order. For
/// `revert` each effective diff is after→before (recorded diff reversed); for
/// `reapply` it is before→after (recorded diff as-is). `entry_id` is the id of
/// the primary (most-recent) entry in the group, retained for back-compat with
/// single-entry callers and result rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertOutcome {
	Success {
		entry_id: String,
		group_id: Option<String>,
		files:    Vec<RevertedFile>,
	},
	/// PLAN-338 C: the targeted group includes file(s) already committed to git.
	/// Undo DECLINES by default rather than silently rewriting durably-saved
	/// work (the data-loss class from BUG-470). Caller may retry with `force`.
	/// Nothing is written when this is returned.
	Declined {
		entries: Vec<DeclinedEntry>,
	},
	NotFound,
	Error(String),
}

/// One committed entry that blocked an undo (PLAN-338 C).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclinedEntry {
	pub entry_id: String,
	pub file:     PathBuf,
	pub commit:   Option<String>,
}

/// One file touched by a revert/reapply, with the effective diff applied to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertedFile {
	pub entry_id: String,
	pub file:     PathBuf,
	pub diff:     String,
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
	/// Revert the matching group, unconditionally (no commit guard). Equivalent
	/// to `revert_guarded(q, true, _)`. Kept as the simple entry point for
	/// tests and headless callers that don't care about commit-awareness.
	fn revert(&self, q: HistoryQuery) -> RevertOutcome;
	/// PLAN-338 C: revert with a commit guard. When `force` is false, the whole
	/// targeted group is first checked with `is_committed`; if ANY member file
	/// is committed, returns [`RevertOutcome::Declined`] and writes nothing.
	/// `force = true` skips the check (the deliberate override). `is_committed`
	/// is injected so this layer stays git-free and unit-testable.
	fn revert_guarded(
		&self,
		q: HistoryQuery,
		force: bool,
		is_committed: &dyn Fn(&Path) -> bool,
	) -> RevertOutcome;
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
		// Unconditional revert = guarded with force + a never-committed predicate.
		self.revert_guarded(q, true, &|_| false)
	}

	fn revert_guarded(
		&self,
		q: HistoryQuery,
		force: bool,
		is_committed: &dyn Fn(&Path) -> bool,
	) -> RevertOutcome {
		let mut entries = self.read_all();
		// Primary = most-recent non-reverted entry matching the query.
		let Some(primary) = entries
			.iter()
			.rposition(|e| !e.reverted && query_matches(&q, e))
		else {
			return RevertOutcome::NotFound;
		};
		// Expand to the whole group: every still-applied entry sharing the
		// primary's group_id. A `None` group_id is a singleton (its own group),
		// matched by entry id so pre-grouping logs behave exactly as before.
		let group_id = entries[primary].group_id.clone();
		let members = group_member_indices(&entries, primary, group_id.as_deref(), false);

		// PLAN-338 C: commit guard. Unless forced, decline if ANY member file is
		// already committed — reverting would silently rewrite durably-saved work.
		// All-or-nothing: one committed member blocks the whole group (consistent
		// with the atomic-group contract).
		if !force {
			// Committed-ness is the LIVE git state of the file (is_committed),
			// never `entry.commit` — that field is the HEAD sha the edit was
			// recorded *against* (provenance), which is `Some` for nearly every
			// edit in a repo and must NOT by itself block an undo.
			let declined: Vec<DeclinedEntry> = members
				.iter()
				.filter(|&&i| is_committed(&entries[i].file))
				.map(|&i| DeclinedEntry {
					entry_id: entries[i].id.clone(),
					file:     entries[i].file.clone(),
					commit:   entries[i].commit.clone(),
				})
				.collect();
			if !declined.is_empty() {
				return RevertOutcome::Declined { entries: declined };
			}
		}

		// Undo order = reverse application order (newest edit undone first) so
		// overlapping edits to one file peel off in LIFO order.
		let mut order = members;
		order.sort_unstable();
		order.reverse();

		match apply_group(&entries, &order, RevertDir::Undo) {
			Ok(reverted) => {
				for &i in &order {
					entries[i].reverted = true;
				}
				self.write_all(&entries);
				RevertOutcome::Success {
					entry_id: entries[primary].id.clone(),
					group_id,
					files: reverted,
				}
			},
			Err(e) => RevertOutcome::Error(e),
		}
	}

	fn reapply(&self, q: HistoryQuery) -> RevertOutcome {
		let mut entries = self.read_all();
		// Inverse of revert: primary = most-recently *reverted* entry matching q.
		let Some(primary) = entries
			.iter()
			.rposition(|e| e.reverted && query_matches(&q, e))
		else {
			return RevertOutcome::NotFound;
		};
		let group_id = entries[primary].group_id.clone();
		let members = group_member_indices(&entries, primary, group_id.as_deref(), true);
		// Redo order = forward application order (oldest edit re-applied first),
		// the exact inverse of the undo LIFO peel.
		let mut order = members;
		order.sort_unstable();

		match apply_group(&entries, &order, RevertDir::Redo) {
			Ok(reapplied) => {
				for &i in &order {
					entries[i].reverted = false;
				}
				self.write_all(&entries);
				RevertOutcome::Success {
					entry_id: entries[primary].id.clone(),
					group_id,
					files: reapplied,
				}
			},
			Err(e) => RevertOutcome::Error(e),
		}
	}
}

/// Direction of a group apply: undo reverts after→before, redo re-applies
/// before→after. Folded into one routine so the atomic-rollback machinery is
/// shared and the two directions can never drift apart.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RevertDir {
	Undo,
	Redo,
}

/// Does an entry satisfy the session/file filters of a query? (The
/// reverted-state filter is applied by the caller, since undo wants
/// not-yet-reverted and redo wants already-reverted.)
fn query_matches(q: &HistoryQuery, e: &EditEntry) -> bool {
	if let Some(ref sid) = q.session_id
		&& e.session_id != *sid
	{
		return false;
	}
	// entry_id is the most specific selector: an exact id match (PLAN-338 B,
	// id-precise undo/redo). When present it overrides the file filter — the
	// caller named one entry, scope expands to its group afterwards.
	if let Some(ref id) = q.entry_id {
		return e.id == *id;
	}
	if let Some(ref glob) = q.file_glob
		&& !glob_match(glob, &e.file)
	{
		return false;
	}
	true
}

/// Indices of every entry belonging to the primary's group.
///
/// `want_reverted` selects which side we collapse onto: undo gathers
/// still-applied members (`reverted == false`), redo gathers reverted members
/// (`reverted == true`) — so a half-undone group can never be re-expanded into
/// the wrong direction. A `None` `group_id` is a singleton: only the primary
/// index, preserving exact pre-grouping (one-entry-per-undo) semantics.
fn group_member_indices(
	entries: &[EditEntry],
	primary: usize,
	group_id: Option<&str>,
	want_reverted: bool,
) -> Vec<usize> {
	match group_id {
		None => vec![primary],
		Some(gid) => entries
			.iter()
			.enumerate()
			.filter(|(_, e)| e.group_id.as_deref() == Some(gid) && e.reverted == want_reverted)
			.map(|(i, _)| i)
			.collect(),
	}
}

/// Apply a whole group atomically in the given direction.
///
/// Computes the new content for every member's file first (in `order`), then
/// commits the writes. If any member can't be applied cleanly OR any write
/// fails, every file already written in THIS call is restored to the content
/// it had on entry — so a group undo/redo is all-or-nothing on disk and never
/// leaves a cross-file rename half-applied. Returns one `RevertedFile` per
/// member (effective diff: reversed for undo, as-recorded for redo).
fn apply_group(
	entries: &[EditEntry],
	order: &[usize],
	dir: RevertDir,
) -> std::result::Result<Vec<RevertedFile>, String> {
	// Snapshot each touched file's on-entry content for rollback. Keyed by path
	// so repeated edits to one file restore to the pre-group state, not an
	// intermediate one.
	let mut snapshots: std::collections::HashMap<PathBuf, Option<String>> =
		std::collections::HashMap::new();
	let mut written: Vec<PathBuf> = Vec::new();
	let mut results: Vec<RevertedFile> = Vec::new();

	let rollback = |snapshots: &std::collections::HashMap<PathBuf, Option<String>>,
	                written: &[PathBuf]| {
		for p in written {
			match snapshots.get(p) {
				Some(Some(prior)) => {
					let _ = std::fs::write(p, prior);
				},
				Some(None) => {
					let _ = std::fs::remove_file(p);
				},
				None => {},
			}
		}
	};

	for &i in order {
		let entry = &entries[i];
		let file = &entry.file;
		if let Some(parent) = file.parent() {
			let _ = std::fs::create_dir_all(parent);
		}
		// `from` = the state this direction expects on disk, `to` = the target
		// state. Undo: after→before. Redo: before→after.
		let (from, to) = match dir {
			RevertDir::Undo => (&entry.after, &entry.before),
			RevertDir::Redo => (&entry.before, &entry.after),
		};
		let current = std::fs::read_to_string(file).unwrap_or_else(|_| from.clone());
		let new_content = if current == *from {
			to.clone()
		} else if let Some(s) = revert_chunk_replace(&current, from, to) {
			s
		} else {
			rollback(&snapshots, &written);
			let verb = match dir {
				RevertDir::Undo => "revert",
				RevertDir::Redo => "reapply",
			};
			return Err(format!(
				"cannot {verb} {} cleanly: file changed since edit and chunk replace failed; group \
				 left untouched",
				entry.id
			));
		};
		snapshots
			.entry(file.clone())
			.or_insert_with(|| std::fs::read_to_string(file).ok());
		if let Err(e) = std::fs::write(file, &new_content) {
			rollback(&snapshots, &written);
			return Err(format!("write failed: {e}; group left untouched"));
		}
		written.push(file.clone());
		let effective_diff = match dir {
			RevertDir::Undo => reverse_unified_diff(&entry.diff),
			RevertDir::Redo => entry.diff.clone(),
		};
		results.push(RevertedFile {
			entry_id: entry.id.clone(),
			file:     file.clone(),
			diff:     effective_diff,
		});
	}
	Ok(results)
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
			group_id:    None,
			workspace:   String::new(),
		}
	}

	/// Build an entry with explicit id / before / after / group, used by the
	/// grouping + property tests. `diff` is synthesised from before/after so the
	/// reversed-diff effective-output assertions stay meaningful.
	fn entry_full(
		id: &str,
		sid: &str,
		file: &str,
		before: &str,
		after: &str,
		group_id: Option<&str>,
	) -> EditEntry {
		EditEntry {
			id:          id.into(),
			session_id:  sid.into(),
			agent_label: "".into(),
			file:        PathBuf::from(file),
			before:      before.into(),
			after:       after.into(),
			diff:        format!("@@ -1 +1 @@\n-{before}\n+{after}\n"),
			timestamp:   SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
			group_id:    group_id.map(|s| s.into()),
			workspace:   String::new(),
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
			RevertOutcome::Success { files, .. } => {
				assert_eq!(files.len(), 1, "single-entry undo touches one file");
				let rf = &files[0];
				// Undo's effective diff is after→before: signs flipped.
				assert!(rf.diff.contains("+BEFORE"), "diff: {}", rf.diff);
				assert!(rf.diff.contains("-AFTER"), "diff: {}", rf.diff);
				assert_eq!(rf.file, f);
			},
			other => panic!("expected Success, got {other:?}"),
		}
		assert_eq!(std::fs::read_to_string(&f).unwrap(), "BEFORE\n");
		let _ = std::fs::remove_file(&f);
	}
}

#[cfg(test)]
mod group_tests {
	use std::time::SystemTime;

	use proptest::prelude::*;
	use tempfile::TempDir;

	use super::*;

	/// Build an entry with explicit fields. `diff` is synthesised from
	/// before/after so reversed-diff assertions stay meaningful.
	fn ent(id: &str, file: &Path, before: &str, after: &str, group: Option<&str>) -> EditEntry {
		EditEntry {
			id:          id.into(),
			session_id:  "S1".into(),
			agent_label: String::new(),
			file:        file.to_path_buf(),
			before:      before.into(),
			after:       after.into(),
			diff:        format!("@@ -1 +1 @@\n-{before}\n+{after}\n"),
			timestamp:   SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
			group_id:    group.map(Into::into),
			workspace:   String::new(),
		}
	}

	fn read(p: &Path) -> String {
		std::fs::read_to_string(p).unwrap()
	}

	// ── Operation-aware grouping: a multi-file rename undoes/redoes atomically ──

	/// A cross-file rename fans out to N entries sharing one group_id. A single
	/// undo must revert ALL of them (every file back to `before`); a single redo
	/// must re-apply ALL of them. This is the operation-aware guarantee: a
	/// `rename` is never left half-reverted.
	#[test]
	fn grouped_rename_undo_and_redo_are_atomic() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.rs");
		let b = dir.path().join("b.rs");
		let c = dir.path().join("c.rs");
		// after-rename state on disk (the edit already applied).
		std::fs::write(&a, "use newName;\n").unwrap();
		std::fs::write(&b, "call newName()\n").unwrap();
		std::fs::write(&c, "newName impl\n").unwrap();

		let h = JsonlHistory::in_memory();
		h.record(ent("1", &a, "use oldName;\n", "use newName;\n", Some("G")));
		h.record(ent("2", &b, "call oldName()\n", "call newName()\n", Some("G")));
		h.record(ent("3", &c, "oldName impl\n", "newName impl\n", Some("G")));

		// One undo (targeting any single member) reverts the WHOLE group.
		let out = h.revert(
			HistoryQuery::default()
				.session_id("S1")
				.file_glob(b.to_string_lossy()),
		);
		match out {
			RevertOutcome::Success { files, group_id, .. } => {
				assert_eq!(group_id.as_deref(), Some("G"));
				assert_eq!(files.len(), 3, "all 3 group members reverted");
			},
			other => panic!("expected Success, got {other:?}"),
		}
		assert_eq!(read(&a), "use oldName;\n");
		assert_eq!(read(&b), "call oldName()\n");
		assert_eq!(read(&c), "oldName impl\n");

		// One redo re-applies the WHOLE group.
		let out = h.reapply(
			HistoryQuery::default()
				.session_id("S1")
				.file_glob(a.to_string_lossy()),
		);
		match out {
			RevertOutcome::Success { files, .. } => assert_eq!(files.len(), 3),
			other => panic!("expected Success, got {other:?}"),
		}
		assert_eq!(read(&a), "use newName;\n");
		assert_eq!(read(&b), "call newName()\n");
		assert_eq!(read(&c), "newName impl\n");
	}

	/// After a grouped undo, ALL members are flagged reverted; after redo, none.
	#[test]
	fn grouped_undo_marks_every_member_reverted() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &a, "A0\n", "A1\n", Some("G")));
		h.record(ent("2", &b, "B0\n", "B1\n", Some("G")));
		h.revert(HistoryQuery::default().session_id("S1"));
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert!(all.iter().all(|e| e.reverted), "every member reverted");
		h.reapply(HistoryQuery::default().session_id("S1"));
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert!(all.iter().all(|e| !e.reverted), "every member re-applied");
	}

	// ── Targeting (fix A): undo honours the file target ──

	/// Two independent single-file edits (no shared group). A targeted undo
	/// reverts the NAMED file, not merely the most-recent one. This is the
	/// regression guard for the original bug (target silently discarded).
	#[test]
	fn targeted_undo_reverts_named_file_not_most_recent() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		// `a` edited first, `b` edited last (most-recent).
		h.record(ent("1", &a, "A0\n", "A1\n", None));
		h.record(ent("2", &b, "B0\n", "B1\n", None));
		// Target `a` explicitly: must revert a, leave b alone.
		let out = h.revert(
			HistoryQuery::default()
				.session_id("S1")
				.file_glob(a.to_string_lossy()),
		);
		assert!(matches!(out, RevertOutcome::Success { .. }));
		assert_eq!(read(&a), "A0\n", "targeted file reverted");
		assert_eq!(read(&b), "B1\n", "untargeted file untouched");
	}

	/// Target-less undo still reverts the single most-recent edit (legacy path).
	#[test]
	fn targetless_undo_reverts_most_recent_singleton() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &a, "A0\n", "A1\n", None));
		h.record(ent("2", &b, "B0\n", "B1\n", None));
		h.revert(HistoryQuery::default().session_id("S1"));
		assert_eq!(read(&a), "A1\n", "older edit untouched");
		assert_eq!(read(&b), "B0\n", "most-recent edit reverted");
	}

	// ── Edge: multiple edits to ONE file within a group (LIFO peel) ──

	/// A group containing two sequential edits to the SAME file must peel them
	/// in reverse application order (newest first) so the file lands back at the
	/// original pre-group content, then redo re-stacks them forward.
	#[test]
	fn group_with_stacked_same_file_edits_round_trips() {
		let dir = TempDir::new().unwrap();
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v2\n").unwrap();
		let h = JsonlHistory::in_memory();
		// v0 -> v1 -> v2, both in group G.
		h.record(ent("1", &f, "v0\n", "v1\n", Some("G")));
		h.record(ent("2", &f, "v1\n", "v2\n", Some("G")));
		h.revert(HistoryQuery::default().session_id("S1"));
		assert_eq!(read(&f), "v0\n", "stacked edits peel back to original");
		h.reapply(HistoryQuery::default().session_id("S1"));
		assert_eq!(read(&f), "v2\n", "redo re-stacks to latest");
	}

	// ── Edge: atomic rollback when one member can't be reverted cleanly ──

	/// If any member of a group can't be applied cleanly, the WHOLE group is
	/// left untouched on disk — no partial revert. We poison one member by
	/// rewriting its file to content that matches neither `before` nor `after`
	/// and contains no locatable chunk.
	#[test]
	fn group_revert_is_all_or_nothing_on_dirty_member() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		// `b` diverged: neither B1 nor B0, and no B1 chunk to locate.
		std::fs::write(&b, "COMPLETELY DIFFERENT\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &a, "A0\n", "A1\n", Some("G")));
		h.record(ent("2", &b, "B0\n", "B1\n", Some("G")));
		let out = h.revert(HistoryQuery::default().session_id("S1"));
		assert!(matches!(out, RevertOutcome::Error(_)), "got {out:?}");
		// Neither file changed; flags untouched.
		assert_eq!(read(&a), "A1\n", "clean member rolled back too");
		assert_eq!(read(&b), "COMPLETELY DIFFERENT\n");
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert!(all.iter().all(|e| !e.reverted), "no member marked reverted");
	}

	// ── Edge: nothing to undo / redo ──

	#[test]
	fn undo_on_empty_history_is_not_found() {
		let h = JsonlHistory::in_memory();
		assert!(matches!(
			h.revert(HistoryQuery::default().session_id("S1")),
			RevertOutcome::NotFound
		));
		assert!(matches!(
			h.reapply(HistoryQuery::default().session_id("S1")),
			RevertOutcome::NotFound
		));
	}

	/// Redo with nothing undone is NotFound; undo when all already reverted too.
	#[test]
	fn redo_without_prior_undo_is_not_found() {
		let dir = TempDir::new().unwrap();
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &f, "v0\n", "v1\n", None));
		assert!(matches!(
			h.reapply(HistoryQuery::default().session_id("S1")),
			RevertOutcome::NotFound
		));
		h.revert(HistoryQuery::default().session_id("S1"));
		assert!(
			matches!(h.revert(HistoryQuery::default().session_id("S1")), RevertOutcome::NotFound,),
			"second undo finds nothing still-applied"
		);
	}

	// ── Edge: repeated undo/redo cycles never lose data ──

	/// Five undo/redo cycles on a group must return to the exact start state
	/// every time — no drift, no loss.
	#[test]
	fn repeated_undo_redo_cycles_are_stable() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &a, "A0\n", "A1\n", Some("G")));
		h.record(ent("2", &b, "B0\n", "B1\n", Some("G")));
		for _ in 0..5 {
			h.revert(HistoryQuery::default().session_id("S1"));
			assert_eq!(read(&a), "A0\n");
			assert_eq!(read(&b), "B0\n");
			h.reapply(HistoryQuery::default().session_id("S1"));
			assert_eq!(read(&a), "A1\n");
			assert_eq!(read(&b), "B1\n");
		}
	}

	// ── Edge: distinct groups undo independently, newest group first ──

	#[test]
	fn distinct_groups_undo_in_reverse_group_order() {
		let dir = TempDir::new().unwrap();
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v2\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &f, "v0\n", "v1\n", Some("G1")));
		h.record(ent("2", &f, "v1\n", "v2\n", Some("G2")));
		// Target-less undo hits the newest group (G2) first.
		h.revert(HistoryQuery::default().session_id("S1"));
		assert_eq!(read(&f), "v1\n");
		// Then G1.
		h.revert(HistoryQuery::default().session_id("S1"));
		assert_eq!(read(&f), "v0\n");
	}

	// ── Persistence: group_id survives a JSONL round-trip (serde default) ──

	#[test]
	fn group_id_persists_through_jsonl_roundtrip() {
		let dir = TempDir::new().unwrap();
		let log = dir.path().join("edit-history.jsonl");
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v1\n").unwrap();
		{
			let h = JsonlHistory::new(log.clone());
			h.record(ent("1", &f, "v0\n", "v1\n", Some("G")));
		}
		// Re-open from disk: group_id must round-trip.
		let h = JsonlHistory::new(log);
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert_eq!(all.len(), 1);
		assert_eq!(all[0].group_id.as_deref(), Some("G"));
	}

	/// A legacy entry serialized WITHOUT a group_id field deserializes to
	/// `group_id: None` (serde default) — old logs stay readable, undo treats
	/// each as a singleton.
	#[test]
	fn legacy_entry_without_group_id_field_defaults_to_none() {
		let legacy = r#"{"id":"1","session_id":"S1","agent_label":"","file":"/tmp/x","before":"a","after":"b","diff":"d","timestamp":{"secs_since_epoch":0,"nanos_since_epoch":0},"commit":null,"reverted":false}"#;
		let e: EditEntry = serde_json::from_str(legacy).unwrap();
		assert_eq!(e.group_id, None);
	}

	// ── Thread-local group guard ──

	#[test]
	fn edit_group_guard_sets_and_restores() {
		assert_eq!(current_edit_group(), None);
		{
			let _g = EditGroupGuard::new(Some("OUTER".into()));
			assert_eq!(current_edit_group().as_deref(), Some("OUTER"));
			{
				let _g2 = EditGroupGuard::new(Some("INNER".into()));
				assert_eq!(current_edit_group().as_deref(), Some("INNER"));
			}
			// Nested guard restores the OUTER value, not None.
			assert_eq!(current_edit_group().as_deref(), Some("OUTER"));
		}
		assert_eq!(current_edit_group(), None);
	}

	#[test]
	fn session_dir_guard_sets_and_restores() {
		assert_eq!(current_session_dir(), None);
		{
			let _g = SessionDirGuard::new(Some(PathBuf::from("/sess/a")));
			assert_eq!(current_session_dir(), Some(PathBuf::from("/sess/a")));
			{
				let _g2 = SessionDirGuard::new(Some(PathBuf::from("/sess/b")));
				assert_eq!(current_session_dir(), Some(PathBuf::from("/sess/b")));
			}
			assert_eq!(current_session_dir(), Some(PathBuf::from("/sess/a")));
		}
		assert_eq!(current_session_dir(), None);
	}

	// ── PLAN-338 B: entry_id-precise undo/redo ──

	/// An undo targeting a SPECIFIC entry id reverts that entry (not the most
	/// recent), then redo by the same id re-applies it. Other edits untouched.
	#[test]
	fn entry_id_targets_a_specific_edit() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("e-a", &a, "A0\n", "A1\n", None));
		h.record(ent("e-b", &b, "B0\n", "B1\n", None));
		// Undo the OLDER entry by id (not most-recent).
		let out = h.revert(HistoryQuery::default().session_id("S1").entry_id("e-a"));
		match out {
			RevertOutcome::Success { entry_id, .. } => assert_eq!(entry_id, "e-a"),
			other => panic!("expected Success, got {other:?}"),
		}
		assert_eq!(read(&a), "A0\n", "targeted id reverted");
		assert_eq!(read(&b), "B1\n", "other edit untouched");
		// Redo by the same id.
		h.reapply(HistoryQuery::default().session_id("S1").entry_id("e-a"));
		assert_eq!(read(&a), "A1\n");
	}

	/// entry_id expands to the whole group: undoing one member's id reverts all.
	#[test]
	fn entry_id_expands_to_group() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("e-a", &a, "A0\n", "A1\n", Some("G")));
		h.record(ent("e-b", &b, "B0\n", "B1\n", Some("G")));
		let out = h.revert(HistoryQuery::default().session_id("S1").entry_id("e-b"));
		match out {
			RevertOutcome::Success { files, .. } => assert_eq!(files.len(), 2, "id expands to group"),
			other => panic!("expected Success, got {other:?}"),
		}
		assert_eq!(read(&a), "A0\n");
		assert_eq!(read(&b), "B0\n");
	}

	// ── PLAN-338 C: commit guard (decline / force) ──

	/// With force=false and a predicate that reports the file committed, undo
	/// DECLINES and writes nothing. With force=true it reverts regardless.
	#[test]
	fn commit_guard_declines_then_force_reverts() {
		let dir = TempDir::new().unwrap();
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &f, "v0\n", "v1\n", None));
		// Predicate: everything is "committed".
		let committed = |_: &Path| true;
		// Default (force=false) → declined, file untouched.
		let out = h.revert_guarded(HistoryQuery::default().session_id("S1"), false, &committed);
		match out {
			RevertOutcome::Declined { entries } => {
				assert_eq!(entries.len(), 1);
				assert_eq!(entries[0].entry_id, "1");
			},
			other => panic!("expected Declined, got {other:?}"),
		}
		assert_eq!(read(&f), "v1\n", "declined undo writes nothing");
		// Not marked reverted.
		assert!(!h.query(HistoryQuery::default().session_id("S1"))[0].reverted);
		// force=true → reverts.
		let out = h.revert_guarded(HistoryQuery::default().session_id("S1"), true, &committed);
		assert!(matches!(out, RevertOutcome::Success { .. }));
		assert_eq!(read(&f), "v0\n", "force reverts past the guard");
	}

	/// One committed member declines the WHOLE group (all-or-nothing); nothing
	/// is written and no member is flagged reverted.
	#[test]
	fn commit_guard_one_member_declines_whole_group() {
		let dir = TempDir::new().unwrap();
		let a = dir.path().join("a.txt");
		let b = dir.path().join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &a, "A0\n", "A1\n", Some("G")));
		h.record(ent("2", &b, "B0\n", "B1\n", Some("G")));
		// Only `b` is committed.
		let b_path = b.clone();
		let committed = move |p: &Path| p == b_path.as_path();
		let out = h.revert_guarded(HistoryQuery::default().session_id("S1"), false, &committed);
		match out {
			RevertOutcome::Declined { entries } => {
				assert_eq!(entries.len(), 1, "only the committed member is reported");
				assert_eq!(entries[0].entry_id, "2");
			},
			other => panic!("expected Declined, got {other:?}"),
		}
		// Nothing written; no member flagged.
		assert_eq!(read(&a), "A1\n");
		assert_eq!(read(&b), "B1\n");
		assert!(
			h.query(HistoryQuery::default().session_id("S1"))
				.iter()
				.all(|e| !e.reverted)
		);
	}

	/// `revert` (the unconditional entry point) ignores the commit guard —
	/// equivalent to force — so existing callers/tests keep their semantics.
	#[test]
	fn plain_revert_ignores_commit_state() {
		let dir = TempDir::new().unwrap();
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v1\n").unwrap();
		let h = JsonlHistory::in_memory();
		h.record(ent("1", &f, "v0\n", "v1\n", None));
		// Plain revert reverts even though (hypothetically) committed.
		assert!(matches!(
			h.revert(HistoryQuery::default().session_id("S1")),
			RevertOutcome::Success { .. }
		));
		assert_eq!(read(&f), "v0\n");
	}

	// ── PLAN-338 B: workspace field round-trips ──

	#[test]
	fn workspace_field_persists_through_jsonl() {
		let dir = TempDir::new().unwrap();
		let log = dir.path().join("edit-history.jsonl");
		let f = dir.path().join("f.txt");
		std::fs::write(&f, "v1\n").unwrap();
		{
			let h = JsonlHistory::new(log.clone());
			let mut e = ent("1", &f, "v0\n", "v1\n", None);
			e.workspace = "/work/space".into();
			h.record(e);
		}
		let h = JsonlHistory::new(log);
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert_eq!(all[0].workspace, "/work/space");
	}

	/// A legacy entry without `workspace`/`group_id` fields still deserializes
	/// (both serde-default), confirming forward-compat of the unified-log
	/// schema.
	#[test]
	fn legacy_entry_without_workspace_defaults_empty() {
		let legacy = r#"{"id":"1","session_id":"S1","agent_label":"","file":"/tmp/x","before":"a","after":"b","diff":"d","timestamp":{"secs_since_epoch":0,"nanos_since_epoch":0},"commit":null,"reverted":false}"#;
		let e: EditEntry = serde_json::from_str(legacy).unwrap();
		assert_eq!(e.workspace, "");
		assert_eq!(e.group_id, None);
	}

	// ── Property: group undo/redo is a perfect round-trip ──

	proptest! {
		#![proptest_config(ProptestConfig::with_cases(120))]

		/// For any group of 1..=6 single-line file edits (distinct files), a
		/// group undo restores every file to its `before` and a following redo
		/// restores every file to its `after`. The core no-data-loss invariant.
		#[test]
		fn prop_group_undo_redo_round_trips(
			n in 1usize..=6,
			seed in any::<u64>(),
		) {
			let dir = TempDir::new().unwrap();
			let h = JsonlHistory::in_memory();
			let mut befores = Vec::new();
			let mut afters = Vec::new();
			let mut paths = Vec::new();
			for i in 0..n {
				let p = dir.path().join(format!("f{i}.txt"));
				// Derive deterministic-but-varied contents from seed+i.
				let before = format!("before-{}-{}\n", seed.wrapping_add(i as u64), i);
				let after = format!("after-{}-{}\n", seed.wrapping_mul(i as u64 + 1), i);
				std::fs::write(&p, &after).unwrap();
				h.record(ent(&i.to_string(), &p, &before, &after, Some("G")));
				befores.push(before);
				afters.push(after);
				paths.push(p);
			}
			// Undo the whole group.
			let undo_ok = matches!(
				h.revert(HistoryQuery::default().session_id("S1")),
				RevertOutcome::Success { .. }
			);
			prop_assert!(undo_ok);
			for (p, b) in paths.iter().zip(&befores) {
				prop_assert_eq!(&read(p), b);
			}
			// Redo the whole group.
			let redo_ok = matches!(
				h.reapply(HistoryQuery::default().session_id("S1")),
				RevertOutcome::Success { .. }
			);
			prop_assert!(redo_ok);
			for (p, a) in paths.iter().zip(&afters) {
				prop_assert_eq!(&read(p), a);
			}
		}

		/// reverse_unified_diff is an involution for WELL-FORMED recorded diffs:
		/// reversing twice yields the original. Recorded diffs are canonical
		/// unified diffs — within a change block every removal (`-`) precedes every
		/// addition (`+`) — so the generator emits all `-` lines then all `+` lines
		/// (interleaved input is not a shape the recorder ever produces, and the
		/// reverser legitimately re-canonicalises it to minus-first).
		#[test]
		fn prop_reverse_diff_is_involution(
			removed in proptest::collection::vec("[a-zA-Z0-9 ]{1,20}", 1..6),
			added in proptest::collection::vec("[a-zA-Z0-9 ]{1,20}", 1..6),
		) {
			let mut diff = String::from("@@ -1,2 +1,2 @@\n");
			for l in &removed {
				diff.push_str(&format!("-{l}\n"));
			}
			for l in &added {
				diff.push_str(&format!("+{l}\n"));
			}
			let twice = reverse_unified_diff(&reverse_unified_diff(&diff));
			prop_assert_eq!(twice, diff);
		}
	}
}
