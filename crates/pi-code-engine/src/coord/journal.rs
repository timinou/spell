use std::{
	fs::{self, OpenOptions},
	io::{BufRead, BufReader, Write},
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::blake3_short;
use crate::{error::Result, file_lock::with_exclusive_lock};

/// One attribution record appended to the per-file journal. The journal is the
/// authoritative persistent history of who edited what; the broker holds only
/// the live ring buffer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JournalEntry {
	pub ts:              u64,
	pub session_id:      String,
	pub pid:             u32,
	pub kind:            String,
	pub revision:        u64,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub parent_revision: Option<u64>,
	pub code_paths:      Vec<String>,
	pub diff_hash:       String,
	pub byte_len:        u64,
}

/// Writer handle — static methods only; each append opens, locks, writes,
/// releases. No persistent file handle is held.
pub struct JournalWriter;

/// Reader handle — static methods only.
pub struct JournalReader;

fn canonical_or_self(path: &Path) -> PathBuf {
	fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Derive the on-disk journal path for `(repo_root, file)` under
/// `journal_root`. Shape: `<journal_root>/<blake3_short(canonical
/// repo_root)>/<blake3_short(canonical file)>.jsonl`.
///
/// The hashes are deterministic per canonicalized input; safe to use as stable
/// keys.
pub fn journal_path_for(journal_root: &Path, repo_root: &Path, file: &Path) -> PathBuf {
	let repo = canonical_or_self(repo_root);
	let file = canonical_or_self(file);
	let repo_key = blake3_short(repo.as_os_str().as_encoded_bytes());
	let file_key = blake3_short(file.as_os_str().as_encoded_bytes());
	journal_root
		.join(repo_key)
		.join(format!("{file_key}.jsonl"))
}

/// Default journal root — `$HOME/.spell/edit-journal`.
pub fn default_journal_root() -> PathBuf {
	std::env::var_os("HOME").map_or_else(
		|| PathBuf::from(".spell/edit-journal"),
		|home| PathBuf::from(home).join(".spell/edit-journal"),
	)
}

impl JournalWriter {
	/// Append one entry atomically. The journal file itself is advisory-locked
	/// during the write so concurrent appends from sibling threads or processes
	/// never interleave bytes within one line.
	///
	/// Failure (e.g. unwritable journal root) propagates as an error — callers
	/// decide whether to degrade.
	pub fn append(root: &Path, repo_root: &Path, file: &Path, entry: &JournalEntry) -> Result<()> {
		let path = journal_path_for(root, repo_root, file);
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent)?;
		}
		with_exclusive_lock(&path, std::time::Duration::from_millis(100), || {
			let mut handle = OpenOptions::new().create(true).append(true).open(&path)?;
			serde_json::to_writer(&mut handle, entry)
				.map_err(|err| crate::error::CodeEngineError::Io(std::io::Error::other(err)))?;
			handle.write_all(b"\n")?;
			Ok(())
		})
	}
}

impl JournalReader {
	/// Read the last `n` entries in reverse chronological order (newest first).
	/// Silently skips blank lines; a malformed line aborts with a parse error
	/// so the caller learns.
	pub fn tail(path: &Path, n: usize) -> Result<Vec<JournalEntry>> {
		let file = fs::File::open(path)?;
		let reader = BufReader::new(file);
		let mut entries: Vec<JournalEntry> = Vec::new();
		for line in reader.lines() {
			let line = line?;
			if line.trim().is_empty() {
				continue;
			}
			let entry: JournalEntry = serde_json::from_str(&line)
				.map_err(|err| crate::error::CodeEngineError::Io(std::io::Error::other(err)))?;
			entries.push(entry);
		}
		entries.reverse();
		entries.truncate(n);
		Ok(entries)
	}
}
