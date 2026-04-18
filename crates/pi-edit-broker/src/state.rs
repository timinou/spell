//! Broker in-memory state.
//!
//! Holds sessions, intents, recent commits per file, and subscriptions. Lives
//! inside a `tokio::sync::RwLock<BrokerState>` shared by all connection tasks.

use std::{
	collections::{HashMap, HashSet, VecDeque},
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use crate::protocol::{CommitRecord, PeerSummary, SessionId};

const RECENT_COMMIT_RING_SIZE: usize = 64;

/// Canonicalise a path for use as a map key. Errors (e.g. non-existent path)
/// fall back to the as-supplied path — broker doesn't need the path to exist.
#[must_use]
pub fn canonicalise(path: &Path) -> PathBuf {
	std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Unix-ms timestamp. Broker treats ts as opaque and only compares values it
/// produced; clock skew across hosts is irrelevant since the broker is
/// single-host.
#[must_use]
pub fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

#[derive(Debug, Clone)]
pub struct SessionRecord {
	pub pid:            u32,
	pub cwd:            PathBuf,
	pub project_name:   Option<String>,
	pub started_at:     u64,
	pub open_files:     Vec<PathBuf>,
	pub last_heartbeat: u64,
}

#[derive(Debug, Clone)]
pub struct Intent {
	pub session_id:    SessionId,
	pub code_path:     String,
	pub base_revision: u64,
	pub expires_at:    u64,
	pub ts:            u64,
}

#[derive(Debug, Default)]
pub struct BrokerState {
	pub sessions:      HashMap<SessionId, SessionRecord>,
	pub intents:       HashMap<PathBuf, Vec<Intent>>,
	pub recent:        HashMap<PathBuf, VecDeque<CommitRecord>>,
	pub subscriptions: HashMap<PathBuf, HashSet<SessionId>>,
	pub latest_rev:    HashMap<PathBuf, (SessionId, u64, u64)>,
}

/// What to do about a peer connection when a duplicate `hello` arrives for the
/// same session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegisterOutcome {
	Fresh,
	Replaced,
}

/// Structural result of an `intent` request.
#[derive(Debug, Clone)]
pub enum IntentDecision {
	Granted,
	Conflict {
		code_path:           String,
		conflicting_session: SessionId,
		peer_intent_ts:      u64,
	},
}

/// Structural result of a `commit` request.
#[derive(Debug, Clone)]
pub enum CommitDecision {
	Accepted,
	Conflict {
		code_path:           String,
		conflicting_session: SessionId,
		peer_revision:       u64,
		peer_commit_ts:      u64,
	},
}

impl BrokerState {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Register a session. Returns `Replaced` when an existing registration is
	/// overwritten (prior connection must be closed by the caller).
	pub fn register(&mut self, session_id: SessionId, record: SessionRecord) -> RegisterOutcome {
		let existed = self.sessions.insert(session_id, record).is_some();
		if existed {
			RegisterOutcome::Replaced
		} else {
			RegisterOutcome::Fresh
		}
	}

	pub fn deregister(&mut self, session_id: &str) -> Option<SessionRecord> {
		for intents in self.intents.values_mut() {
			intents.retain(|intent| intent.session_id != session_id);
		}
		for subs in self.subscriptions.values_mut() {
			subs.remove(session_id);
		}
		self.sessions.remove(session_id)
	}

	pub fn heartbeat(&mut self, session_id: &str) {
		if let Some(record) = self.sessions.get_mut(session_id) {
			record.last_heartbeat = now_ms();
		}
	}

	pub fn subscribe(&mut self, session_id: &str, files: &[PathBuf]) {
		for file in files {
			self
				.subscriptions
				.entry(canonicalise(file))
				.or_default()
				.insert(session_id.to_string());
		}
	}

	/// Record or reject a new intent. Non-conflicting intents are appended; a
	/// session re-intending its own code path is allowed (refreshed ttl).
	pub fn record_intent(
		&mut self,
		session_id: &str,
		file: &Path,
		code_paths: &[String],
		ttl_ms: u64,
		base_revision: u64,
	) -> IntentDecision {
		let key = canonicalise(file);
		let now = now_ms();
		let entry = self.intents.entry(key).or_default();
		entry.retain(|intent| intent.expires_at > now);
		for code_path in code_paths {
			if let Some(peer) = entry
				.iter()
				.find(|intent| intent.code_path == *code_path && intent.session_id != session_id)
			{
				return IntentDecision::Conflict {
					code_path:           code_path.clone(),
					conflicting_session: peer.session_id.clone(),
					peer_intent_ts:      peer.ts,
				};
			}
		}
		entry.retain(|intent| {
			intent.session_id != session_id || !code_paths.contains(&intent.code_path)
		});
		for code_path in code_paths {
			entry.push(Intent {
				session_id: session_id.to_string(),
				code_path: code_path.clone(),
				base_revision,
				expires_at: now.saturating_add(ttl_ms),
				ts: now,
			});
		}
		IntentDecision::Granted
	}

	/// Release specific intents held by `session_id`.
	pub fn release_intent(&mut self, session_id: &str, file: &Path, code_paths: &[String]) {
		let key = canonicalise(file);
		if let Some(entry) = self.intents.get_mut(&key) {
			entry.retain(|intent| {
				intent.session_id != session_id || !code_paths.contains(&intent.code_path)
			});
		}
	}

	/// Expire intents whose `expires_at` has passed. Called periodically.
	pub fn expire_intents(&mut self) {
		let now = now_ms();
		for entry in self.intents.values_mut() {
			entry.retain(|intent| intent.expires_at > now);
		}
	}

	/// Record or reject a commit. Accepted commits update `latest_rev` and
	/// append to the per-file ring buffer, and drop the committing session's
	/// intents for the touched code paths.
	pub fn record_commit(
		&mut self,
		session_id: &str,
		file: &Path,
		revision: u64,
		parent_revision: u64,
		code_paths: Vec<String>,
		diff_hash: String,
	) -> (CommitDecision, CommitRecord) {
		let key = canonicalise(file);
		let now = now_ms();
		if let Some((peer_session, peer_rev, peer_ts)) = self.latest_rev.get(&key)
			&& *peer_rev > parent_revision
		{
			let conflict_path = code_paths.first().cloned().unwrap_or_default();
			return (
				CommitDecision::Conflict {
					code_path:           conflict_path,
					conflicting_session: peer_session.clone(),
					peer_revision:       *peer_rev,
					peer_commit_ts:      *peer_ts,
				},
				CommitRecord {
					session_id: session_id.to_string(),
					revision,
					code_paths,
					diff_hash,
					ts: now,
				},
			);
		}
		let record = CommitRecord {
			session_id: session_id.to_string(),
			revision,
			code_paths: code_paths.clone(),
			diff_hash,
			ts: now,
		};
		self
			.latest_rev
			.insert(key.clone(), (session_id.to_string(), revision, now));
		let ring = self.recent.entry(key.clone()).or_default();
		if ring.len() == RECENT_COMMIT_RING_SIZE {
			ring.pop_front();
		}
		ring.push_back(record.clone());
		if let Some(entry) = self.intents.get_mut(&key) {
			entry.retain(|intent| {
				intent.session_id != session_id || !code_paths.contains(&intent.code_path)
			});
		}
		(CommitDecision::Accepted, record)
	}

	pub fn subscribers_for(&self, file: &Path) -> HashSet<SessionId> {
		self
			.subscriptions
			.get(&canonicalise(file))
			.cloned()
			.unwrap_or_default()
	}

	#[must_use]
	pub fn peer_summaries(&self, exclude: &str) -> Vec<PeerSummary> {
		self
			.sessions
			.iter()
			.filter(|(id, _)| id.as_str() != exclude)
			.map(|(id, record)| PeerSummary {
				session_id:   id.clone(),
				cwd:          record.cwd.clone(),
				open_files:   record.open_files.clone(),
				project_name: record.project_name.clone(),
			})
			.collect()
	}

	/// Session ids whose pid is no longer reachable. Called by the reaper.
	#[must_use]
	pub fn dead_sessions<F>(&self, mut is_alive: F) -> Vec<SessionId>
	where
		F: FnMut(u32) -> bool,
	{
		self
			.sessions
			.iter()
			.filter_map(|(id, record)| {
				if is_alive(record.pid) {
					None
				} else {
					Some(id.clone())
				}
			})
			.collect()
	}
}
