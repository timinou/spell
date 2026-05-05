use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub type SessionId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerInfo {
	pub session_id:   SessionId,
	pub pid:          u32,
	pub cwd:          PathBuf,
	pub project_name: String,
	pub started_at:   u64,
	pub open_files:   Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerEdit {
	pub session_id: SessionId,
	pub revision:   u64,
	pub code_paths: Vec<String>,
	pub diff_hash:  String,
	pub ts:         u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerState {
	pub peers:           Vec<PeerInfo>,
	pub recent_commits:  Vec<PeerEdit>,
	pub latest_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntentResult {
	Granted,
	Conflict { peer_session: SessionId, code_path: String, peer_intent_ts: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitResult {
	Ok,
	Conflict {
		peer_session:   SessionId,
		code_path:      String,
		peer_revision:  u64,
		peer_commit_ts: u64,
	},
}

/// A file the client intends to modify as part of a multi-file transaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileIntent {
	pub file:          PathBuf,
	pub code_paths:    Vec<String>,
	pub base_revision: u64,
}

/// A file the client commits as part of a multi-file transaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileCommit {
	pub file:            PathBuf,
	pub revision:        u64,
	pub parent_revision: u64,
	pub code_paths:      Vec<String>,
	pub diff_hash:       String,
	pub byte_len:        u64,
}

/// Result of a multi-intent operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MultiIntentResult {
	Acknowledged,
	Conflict,
}

/// Result of a multi-commit operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MultiCommitResult {
	Acknowledged,
}

pub trait CoordClient: Send + Sync {
	fn on_open(&self, session: &str, file: &Path, revision: u64);
	fn intent(
		&self,
		session: &str,
		file: &Path,
		code_paths: &[String],
		base_revision: u64,
	) -> IntentResult;
	#[allow(clippy::too_many_arguments, reason = "broker protocol pins 8 fields")]
	fn commit(
		&self,
		session: &str,
		file: &Path,
		revision: u64,
		parent_revision: u64,
		code_paths: &[String],
		diff_hash: &str,
		byte_len: u64,
	) -> CommitResult;
	fn recent_peer_edits(&self, file: &Path, since_ms: u64, limit: usize) -> Vec<PeerEdit>;
	fn peer_state(&self, file: &Path) -> PeerState;
	fn on_close(&self, session: &str, file: &Path);

	/// Multi-file intent: atomically claim all `files` or none across peers.
	fn multi_intent(
		&self,
		_peers: &[SessionId],
		_files: &[FileIntent],
		_ttl_ms: u64,
	) -> MultiIntentResult {
		MultiIntentResult::Acknowledged
	}

	/// Multi-file commit: atomically commit all `files` under a granted txn.
	fn multi_commit(&self, _peers: &[SessionId], _files: &[FileCommit]) -> MultiCommitResult {
		MultiCommitResult::Acknowledged
	}

	/// Abort a multi-file txn.
	fn multi_abort(&self, _peers: &[SessionId], _reason: &str) {}

	fn drain_warnings(&self) -> Vec<String> {
		Vec::new()
	}
}
