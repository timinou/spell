//! Per-session edit-history tracker (BUG-340).
//!
//! Even when edits auto-save, the agent can inspect or revert THIS
//! session's changes via `manage diff/undo/context`.  Sibling sessions'
//! edits survive because each entry is tagged with its session id.

use std::{
	fs::{File, OpenOptions},
	io::{BufRead, BufReader, Write},
	path::{Path, PathBuf},
	sync::{Mutex, MutexGuard},
	time::SystemTime,
};

use serde::{Deserialize, Serialize};

/// One edit committed by a single agent session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditEntry {
	pub id:            String,
	pub session_id:    String,
	pub agent_label:   String,
	pub file:          PathBuf,
	pub before:        String,
	pub after:         String,
	pub diff:          String,
	pub timestamp:     SystemTime,
	pub commit:        Option<String>,
	pub reverted:      bool,
}

/// Builder-style query for the history log.
#[derive(Default, Clone, Debug)]
pub struct HistoryQuery {
	pub session_id:       Option<String>,
	pub agent_label:      Option<String>,
	pub file_glob:        Option<String>,
	pub since:            Option<SystemTime>,
	pub uncommitted_only: bool,
}

impl HistoryQuery {
	pub fn new() -> Self { Self::default() }

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
}

/// Result of a revert operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertOutcome {
	Success { entry_id: String },
	NotFound,
	Error(String),
}

/// Storage backend for edit history.
pub trait EditHistory: Send + Sync {
	fn record(&self, entry: EditEntry);
	fn query(&self, q: HistoryQuery) -> Vec<EditEntry>;
	fn revert(&self, q: HistoryQuery) -> RevertOutcome;
}

/// JSONL-backed history stored at `<root>/.spell/edit-history.jsonl`.
pub struct JsonlHistory {
	path: PathBuf,
	_temp: Option<tempfile::NamedTempFile>,
}

impl JsonlHistory {
	pub fn new(path: PathBuf) -> Self {
		Self { path, _temp: None }
	}

	pub fn in_memory() -> Self {
		let file = tempfile::NamedTempFile::new().expect("temp file");
		let path = file.path().to_path_buf();
		Self { path, _temp: Some(file) }
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
		let mut file = OpenOptions::new()
			.append(true)
			.create(true)
			.open(&self.path)
			.expect("open history file");
		let line = serde_json::to_string(&entry).expect("serialize entry");
		writeln!(file, "{line}").expect("write history");
	}

	fn query(&self, q: HistoryQuery) -> Vec<EditEntry> {
		self.read_all()
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
				true
			})
			.collect()
	}

	fn revert(&self, q: HistoryQuery) -> RevertOutcome {
		let mut entries = self.read_all();
		let idx = entries
			.iter()
			.rposition(|e| {
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
		if let Err(e) = std::fs::write(file, &entry.before) {
			return RevertOutcome::Error(format!("write failed: {e}"));
		}
		let entry_id = entry.id.clone();
		entries[idx].reverted = true;
		self.write_all(&entries);
		RevertOutcome::Success { entry_id }
	}
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
		let h = JsonlHistory::in_memory();
		h.record(entry("S1", "a.txt"));
		h.record(entry("S1", "b.txt"));
		let r = h.revert(HistoryQuery::default().session_id("S1").file_glob("a.txt"));
		assert!(matches!(r, RevertOutcome::Success { .. }));
		let all = h.query(HistoryQuery::default().session_id("S1"));
		assert!(all[0].reverted);
		assert!(!all[1].reverted);
	}

	#[test]
	fn uncommitted_only_filter_excludes_post_commit_entries() {
		let h = JsonlHistory::in_memory();
		let mut e1 = entry("S1", "a.txt");
		let mut e2 = entry("S1", "a.txt");
		e2.commit = Some("abc".into());
		e2.id = "2".into();
		h.record(e1);
		h.record(e2);
		let r = h.query(HistoryQuery::default().session_id("S1").uncommitted_only(true));
		assert_eq!(r.len(), 1);
		assert!(r[0].commit.is_none());
	}
}
