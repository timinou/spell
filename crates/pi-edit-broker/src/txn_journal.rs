//! Transaction journal — append-only log of multi-file txn lifecycle events.
//!
//! Each line is a JSON `TxnJournalEntry`. Written by the broker's conn
//! handlers; replayed by the reaper on startup to detect incomplete txns.

use std::{
	collections::{HashMap, HashSet},
	fs::{self, OpenOptions},
	io::{BufRead, BufReader, Write},
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::protocol::TxnId;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TxnJournalEntry {
	TxnStarted {
		#[serde(rename = "txnId")]
		txn_id:     TxnId,
		#[serde(rename = "sessionId")]
		session_id: String,
		files:      Vec<(PathBuf, u64)>,
		#[serde(rename = "startedAt")]
		started_at: u64,
	},
	TxnCommitted {
		#[serde(rename = "txnId")]
		txn_id: TxnId,
		files:  Vec<(PathBuf, u64)>,
		ts:     u64,
	},
	TxnRolledBack {
		#[serde(rename = "txnId")]
		txn_id: TxnId,
		reason: String,
		ts:     u64,
	},
}

/// Result of replaying the journal — which txns completed vs which were
/// started but never committed (and thus should be rolled back).
#[derive(Debug, Default)]
pub struct ReplayState {
	pub completed_txns:  HashSet<TxnId>,
	pub incomplete_txns: HashMap<TxnId, TxnStartedRecord>,
}

/// Minimal record of a started txn, extracted from `TxnStarted` for
/// recovery logic.
#[derive(Debug, Clone)]
pub struct TxnStartedRecord {
	pub session_id: String,
	pub files:      Vec<PathBuf>,
	pub started_at: u64,
}



/// Replay the journal file, segregating completed vs incomplete txns.
///
/// A complete txn has `TxnStarted` followed by `TxnCommitted` (or
/// `TxnRolledBack`). An incomplete txn has `TxnStarted` without a matching
/// termination entry.
pub fn replay_journal(path: &Path) -> std::io::Result<ReplayState> {
	let mut state = ReplayState::default();
	let file = match fs::File::open(path) {
		Ok(f) => f,
		Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(state),
		Err(e) => return Err(e),
	};
	let reader = BufReader::new(file);
	for line in reader.lines() {
		let line = line?;
		if line.trim().is_empty() {
			continue;
		}
		let entry: TxnJournalEntry = match serde_json::from_str(&line) {
			Ok(e) => e,
			Err(_) => continue,
		};
		match entry {
			TxnJournalEntry::TxnStarted { txn_id, session_id, files, started_at } => {
				state.incomplete_txns.insert(
					txn_id.clone(),
					TxnStartedRecord {
						session_id,
						files: files.into_iter().map(|(p, _)| p).collect(),
						started_at,
					},
				);
			},
			TxnJournalEntry::TxnCommitted { txn_id, .. }
			| TxnJournalEntry::TxnRolledBack { txn_id, .. } => {
				state.incomplete_txns.remove(&txn_id);
				state.completed_txns.insert(txn_id);
			},
		}
	}
	Ok(state)
}

/// Append one entry to the transaction journal.
pub fn append_entry(path: &Path, entry: &TxnJournalEntry) -> std::io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let mut handle = OpenOptions::new().create(true).append(true).open(path)?;
	serde_json::to_writer(&mut handle, entry)
		.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
	handle.write_all(b"\n")?;
	Ok(())
}

/// Default transaction journal path.
pub fn default_journal_path() -> PathBuf {
	let home =
		std::env::var_os("HOME").unwrap_or_else(|| std::ffi::OsString::from("/tmp"));
	PathBuf::from(home).join(".spell/edit-txn-journal.jsonl")
}
