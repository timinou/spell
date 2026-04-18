//! Wire protocol for `pi-edit-broker`.
//!
//! Newline-delimited JSON. The tag field `type` discriminates variants.
//!
//! The exact shape is pinned by the design spec; FEAT-577's
//! `SocketCoordClient` reuses these types as its serde contract.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub type SessionId = String;

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
	},
	PeerJoined {
		#[serde(rename = "sessionId")]
		session_id: SessionId,
	},
	PeerLeft {
		#[serde(rename = "sessionId")]
		session_id: SessionId,
	},
	Error {
		code:    String,
		message: String,
	},
}
