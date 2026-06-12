use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub type SessionId = String;

/// Typed owner identity for the coordination lock table (PLAN-334 / P3.2).
///
/// The opaque token that owns an edit intent / lock. A Node session owner is
/// its session-id string; a BEAM mini-session owner is a pid-derived string
/// (e.g. `"beam:<pid>"`). The newtype gives the owner *identity* so a host
/// can't accidentally pass an arbitrary `&str` where an owner is meant
/// (cross-owner safety). It is `#[serde(transparent)]`, so on the wire it is
/// byte-identical to its inner `String` — the edit-broker protocol (which keys
/// its lock table by `session_id: String`) is untouched.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OwnerId(pub String);

impl OwnerId {
	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl From<&str> for OwnerId {
	fn from(s: &str) -> Self {
		Self(s.to_string())
	}
}

impl From<String> for OwnerId {
	fn from(s: String) -> Self {
		Self(s)
	}
}

impl AsRef<str> for OwnerId {
	fn as_ref(&self) -> &str {
		&self.0
	}
}

impl std::fmt::Display for OwnerId {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

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
	fn on_open(&self, owner: &OwnerId, file: &Path, revision: u64);
	fn intent(
		&self,
		owner: &OwnerId,
		file: &Path,
		code_paths: &[String],
		base_revision: u64,
	) -> IntentResult;
	#[allow(clippy::too_many_arguments, reason = "broker protocol pins 8 fields")]
	fn commit(
		&self,
		owner: &OwnerId,
		file: &Path,
		revision: u64,
		parent_revision: u64,
		code_paths: &[String],
		diff_hash: &str,
		byte_len: u64,
	) -> CommitResult;
	fn recent_peer_edits(&self, file: &Path, since_ms: u64, limit: usize) -> Vec<PeerEdit>;
	fn peer_state(&self, file: &Path) -> PeerState;
	fn on_close(&self, owner: &OwnerId, file: &Path);

	/// Reclaim all coordination state (edit intents, locks) held by `owner`
	/// (PLAN-334 / P3.2). The host calls this when it detects an owner's death
	/// out-of-band — e.g. a BEAM `:DOWN` monitor message, or Node async-context
	/// teardown. The *trigger* (death detection) is host-owned; this is the
	/// coordination-backend *action*.
	///
	/// Default: no-op (in-process / mock backends hold nothing reclaimable).
	/// The socket backend's functional implementation lands with the
	/// persistent-connection client (a BEAM owner's held connection is closed,
	/// and the broker's existing disconnect-deregister frees its intents). On
	/// today's connection-per-call client nothing is held across calls, so this
	/// is a documented no-op.
	fn reclaim(&self, _owner: &OwnerId) {}

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

#[cfg(test)]
mod tests {
	use super::OwnerId;

	#[test]
	fn owner_id_serializes_transparently_as_bare_string() {
		// P3.2 safety property: OwnerId must be byte-identical to its inner String
		// on the wire so the edit-broker protocol (SessionId = String) is untouched.
		let owner = OwnerId::from("beam:4823");
		let json = serde_json::to_string(&owner).unwrap();
		assert_eq!(json, "\"beam:4823\"", "OwnerId must serialize as a bare string");

		// A bare string deserializes back into an OwnerId (wire compatibility both ways).
		let back: OwnerId = serde_json::from_str("\"sess-1\"").unwrap();
		assert_eq!(back, OwnerId::from("sess-1"));
	}

	#[test]
	fn owner_id_conversions_round_trip() {
		assert_eq!(OwnerId::from("x").as_str(), "x");
		assert_eq!(OwnerId::from(String::from("y")).to_string(), "y");
		let o = OwnerId::from("z");
		let r: &str = o.as_ref();
		assert_eq!(r, "z");
	}
}
