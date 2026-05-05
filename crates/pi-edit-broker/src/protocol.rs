//! Wire protocol for `pi-edit-broker`.
//!
//! Newline-delimited JSON. The tag field `type` discriminates variants.
//!
//! The exact shape is pinned by the design spec; FEAT-577's
//! `SocketCoordClient` reuses these types as its serde contract.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub type SessionId = String;
pub type TxnId = String;
pub type OrgItemPatch = serde_json::Value;

/// One observed peer's public state in a `Welcome` message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerSummary {
	#[serde(rename = "sessionId")]
	pub session_id:   SessionId,
	pub cwd:          PathBuf,
	#[serde(rename = "openFiles")]
	pub open_files:   Vec<PathBuf>,
	#[serde(rename = "projectName", skip_serializing_if = "Option::is_none", default)]
	pub project_name: Option<String>,
}

/// One commit observed on a file, replayed into the `Welcome` or streamed
/// live via `peer_committed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitRecord {
	#[serde(rename = "sessionId")]
	pub session_id: SessionId,
	pub revision:   u64,
	#[serde(rename = "codePaths")]
	pub code_paths: Vec<String>,
	#[serde(rename = "diffHash")]
	pub diff_hash:  String,
	pub ts:         u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileIntent {
	pub file:          PathBuf,
	#[serde(rename = "codePaths")]
	pub code_paths:    Vec<String>,
	#[serde(rename = "baseRevision")]
	pub base_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileCommit {
	pub file:            PathBuf,
	pub revision:        u64,
	#[serde(rename = "parentRevision")]
	pub parent_revision: u64,
	#[serde(rename = "codePaths")]
	pub code_paths:      Vec<String>,
	#[serde(rename = "diffHash")]
	pub diff_hash:       String,
	#[serde(rename = "byteLen")]
	pub byte_len:        u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerCommittedFile {
	pub file:       PathBuf,
	pub revision:   u64,
	#[serde(rename = "codePaths")]
	pub code_paths: Vec<String>,
	#[serde(rename = "diffHash")]
	pub diff_hash:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntentConflictItem {
	pub file:                PathBuf,
	#[serde(rename = "codePath")]
	pub code_path:           String,
	#[serde(rename = "conflictingSession")]
	pub conflicting_session: SessionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MultiCommitRevision {
	pub file:     PathBuf,
	pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
	Hello {
		#[serde(rename = "sessionId")]
		session_id:   SessionId,
		pid:          u32,
		cwd:          PathBuf,
		#[serde(rename = "projectName", default, skip_serializing_if = "Option::is_none")]
		project_name: Option<String>,
		#[serde(rename = "startedAt")]
		started_at:   u64,
		#[serde(rename = "openFiles", default)]
		open_files:   Vec<PathBuf>,
	},
	Subscribe {
		files: Vec<PathBuf>,
	},
	Intent {
		file:          PathBuf,
		#[serde(rename = "codePaths")]
		code_paths:    Vec<String>,
		#[serde(rename = "baseRevision")]
		base_revision: u64,
		#[serde(rename = "ttlMs")]
		ttl_ms:        u64,
	},
	Commit {
		file:            PathBuf,
		revision:        u64,
		#[serde(rename = "parentRevision")]
		parent_revision: u64,
		#[serde(rename = "codePaths")]
		code_paths:      Vec<String>,
		#[serde(rename = "diffHash")]
		diff_hash:       String,
		#[serde(rename = "byteLen")]
		byte_len:        u64,
	},
	ReleaseIntent {
		file:       PathBuf,
		#[serde(rename = "codePaths")]
		code_paths: Vec<String>,
	},
	/// Multi-file intent: atomically claim all `files` or none.
	MultiIntent {
		#[serde(rename = "txnId")]
		txn_id: TxnId,
		files:  Vec<FileIntent>,
		#[serde(rename = "ttlMs")]
		ttl_ms: u64,
	},
	/// Multi-file commit: atomically commit all `files` under a granted txn.
	MultiCommit {
		#[serde(rename = "txnId")]
		txn_id: TxnId,
		files:  Vec<FileCommit>,
	},
	/// Abort a multi-file txn, releasing all held intents.
	MultiAbort {
		#[serde(rename = "txnId")]
		txn_id: TxnId,
	},
	Heartbeat,
	Bye,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
	Welcome {
		#[serde(rename = "serverVersion")]
		server_version: String,
		peers:          Vec<PeerSummary>,
	},
	IntentAck {
		file:       PathBuf,
		#[serde(rename = "codePaths")]
		code_paths: Vec<String>,
		granted:    bool,
	},
	IntentConflict {
		file:                PathBuf,
		#[serde(rename = "codePath")]
		code_path:           String,
		#[serde(rename = "conflictingSession")]
		conflicting_session: SessionId,
		#[serde(rename = "peerIntentTs")]
		peer_intent_ts:      u64,
	},
	CommitAck {
		file:     PathBuf,
		revision: u64,
	},
	CommitConflict {
		file:                PathBuf,
		#[serde(rename = "codePath")]
		code_path:           String,
		#[serde(rename = "conflictingSession")]
		conflicting_session: SessionId,
		#[serde(rename = "peerCommitTs")]
		peer_commit_ts:      u64,
		#[serde(rename = "peerRevision")]
		peer_revision:       u64,
	},
	PeerCommitted {
		file:       PathBuf,
		#[serde(rename = "sessionId")]
		session_id: SessionId,
		revision:   u64,
		#[serde(rename = "codePaths")]
		code_paths: Vec<String>,
		#[serde(rename = "diffHash")]
		diff_hash:  String,
		ts:         u64,
		#[serde(rename = "orgItems", default, skip_serializing_if = "Option::is_none")]
		org_items:  Option<Vec<OrgItemPatch>>,
	},
	PeerJoined {
		#[serde(rename = "sessionId")]
		session_id: SessionId,
	},
	PeerLeft {
		#[serde(rename = "sessionId")]
		session_id: SessionId,
	},
	/// Multi-intent response.
	MultiIntentAck {
		#[serde(rename = "txnId")]
		txn_id:    TxnId,
		granted:   bool,
		#[serde(default)]
		conflicts: Vec<IntentConflictItem>,
	},
	/// Multi-commit response.
	MultiCommitAck {
		#[serde(rename = "txnId")]
		txn_id:    TxnId,
		revisions: Vec<MultiCommitRevision>,
	},
	/// Broadcast: peer committed all files in a multi-file txn.
	MultiPeerCommitted {
		#[serde(rename = "txnId")]
		txn_id:     TxnId,
		#[serde(rename = "sessionId")]
		session_id: SessionId,
		files:      Vec<PeerCommittedFile>,
		ts:         u64,
		#[serde(rename = "orgItems", default, skip_serializing_if = "Option::is_none")]
		org_items:  Option<Vec<OrgItemPatch>>,
	},
	/// Broadcast: peer's multi-file txn was rolled back (crash recovery or
	/// abort).
	MultiPeerRolledBack {
		#[serde(rename = "txnId")]
		txn_id: TxnId,
		files:  Vec<PathBuf>,
		reason: String,
	},
	Error {
		code:    String,
		message: String,
	},
}
