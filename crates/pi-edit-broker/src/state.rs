//! Broker in-memory state.
//!
//! Holds sessions, intents, recent commits per file, and subscriptions. Lives
//! inside a `tokio::sync::RwLock<BrokerState>` shared by all connection tasks.

use std::{
	collections::{HashMap, HashSet, VecDeque},
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use crate::protocol::{CommitRecord, FileIntent, PeerSummary, SessionId, TxnId};

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

/// State for an active multi-file transaction.
#[derive(Debug, Clone)]
pub struct TxnState {
	pub session_id: SessionId,
	pub files:      Vec<FileIntent>,
	pub granted_at: u64,
	pub ttl_ms:     u64,
	pub committed:  bool,
}

#[derive(Debug, Default)]
pub struct BrokerState {
	pub sessions:      HashMap<SessionId, SessionRecord>,
	pub intents:       HashMap<PathBuf, Vec<Intent>>,
	pub recent:        HashMap<PathBuf, VecDeque<CommitRecord>>,
	pub subscriptions: HashMap<PathBuf, HashSet<SessionId>>,
	pub latest_rev:    HashMap<PathBuf, (SessionId, u64, u64)>,
	pub active_txns:   HashMap<TxnId, TxnState>,
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
		self
			.active_txns
			.retain(|_, txn| txn.session_id != session_id);
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

	// ---- multi-file txn methods ----

	/// Try to grant a multi-file transaction.
	///
	/// Returns `Ok(())` if all files/code-paths are free (or held by the
	/// requesting session). Returns `Err(conflicts)` with the first conflict.
	///
	/// Self-conflict (same session) is allowed — the existing single intent
	/// is replaced by the txn-level grant.
	pub fn try_grant_multi(
		&mut self,
		txn_id: &str,
		session_id: &str,
		files: Vec<FileIntent>,
		ttl_ms: u64,
	) -> Result<(), Vec<(PathBuf, String, SessionId)>> {
		let now = now_ms();
		let mut conflicts = Vec::new();

		// Check all files are free (or self-held)
		for fi in &files {
			let key = canonicalise(&fi.file);
			let entry = self.intents.entry(key).or_default();
			entry.retain(|intent| intent.expires_at > now);

			for cp in &fi.code_paths {
				if let Some(peer) = entry
					.iter()
					.find(|intent| intent.code_path == *cp && intent.session_id != session_id)
				{
					conflicts.push((fi.file.clone(), cp.clone(), peer.session_id.clone()));
				}
			}
		}

		if !conflicts.is_empty() {
			return Err(conflicts);
		}

		// Remove existing intents for this session on these files (single intents
		// get subsumed), and grant txn-level intents.
		for fi in &files {
			let key = canonicalise(&fi.file);
			let entry = self.intents.entry(key).or_default();

			// Remove any existing intents from this session for these code paths
			entry.retain(|intent| {
				intent.session_id != session_id || !fi.code_paths.contains(&intent.code_path)
			});

			// Grant txn-level intents
			for cp in &fi.code_paths {
				entry.push(Intent {
					session_id:    session_id.to_string(),
					code_path:     cp.clone(),
					base_revision: fi.base_revision,
					expires_at:    now.saturating_add(ttl_ms),
					ts:            now,
				});
			}
		}

		self.active_txns.insert(txn_id.to_string(), TxnState {
			session_id: session_id.to_string(),
			files,
			granted_at: now,
			ttl_ms,
			committed: false,
		});

		Ok(())
	}

	/// Release all intents held by a transaction (i.e. abort / rollback).
	pub fn release_txn(&mut self, txn_id: &str) -> Option<TxnState> {
		let txn = self.active_txns.remove(txn_id)?;
		for fi in &txn.files {
			let key = canonicalise(&fi.file);
			if let Some(entry) = self.intents.get_mut(&key) {
				entry.retain(|intent| {
					intent.session_id != txn.session_id || !fi.code_paths.contains(&intent.code_path)
				});
			}
		}
		Some(txn)
	}

	/// Mark a txn as committed (doesn't release intents — those are dropped
	/// during each file's commit or explicitly via `release_txn`).
	pub fn mark_txn_committed(&mut self, txn_id: &str) -> bool {
		if let Some(txn) = self.active_txns.get_mut(txn_id) {
			txn.committed = true;
			true
		} else {
			false
		}
	}

	/// Return the files owned by a transaction (for broadcasting).
	pub fn txn_files(&self, txn_id: &str) -> Option<Vec<FileIntent>> {
		self.active_txns.get(txn_id).map(|txn| txn.files.clone())
	}

	/// Expire stale (uncommitted, past TTL) multi-file transactions.
	pub fn expire_stale_txns(&mut self) -> Vec<TxnId> {
		let now = now_ms();
		let stale: Vec<TxnId> = self
			.active_txns
			.iter()
			.filter(|(_, txn)| !txn.committed && now.saturating_sub(txn.granted_at) > txn.ttl_ms)
			.map(|(id, _)| id.clone())
			.collect();

		for id in &stale {
			self.release_txn(id);
		}

		stale
	}
}
