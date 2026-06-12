//! `SocketCoordClient` — talks to a running `pi-edit-broker` via its Unix
//! socket protocol.

use std::{
	io::{BufRead, BufReader, Write},
	os::unix::net::UnixStream,
	path::{Path, PathBuf},
	sync::{Mutex, MutexGuard},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex as ParkingMutex;
use pi_edit_broker::{ClientMessage, PeerSummary, ServerMessage, spawn_broker_if_absent};

use super::{
	client::{CommitResult, CoordClient, IntentResult, OwnerId, PeerEdit, PeerInfo, PeerState, SessionId},
	default_journal_root,
	journal::{JournalEntry, JournalReader, journal_path_for},
	peer_state::PeerStateStore,
};

const DEFAULT_BUDGET: Duration = Duration::from_millis(150);
const JOURNAL_TAIL_LIMIT: usize = 64;

#[derive(Debug, Clone)]
pub struct BrokerEndpoint {
	pub socket:     PathBuf,
	pub session_id: SessionId,
	pub budget:     Duration,
}

impl BrokerEndpoint {
	#[must_use]
	pub const fn new(socket: PathBuf, session_id: SessionId) -> Self {
		Self { socket, session_id, budget: DEFAULT_BUDGET }
	}

	#[must_use]
	pub fn default_for(session_id: SessionId) -> Self {
		let socket = std::env::var_os("PI_EDIT_BROKER_SOCKET").map_or_else(
			|| {
				std::env::var_os("HOME").map_or_else(
					|| PathBuf::from(".spell/edit-broker.sock"),
					|home| PathBuf::from(home).join(".spell/edit-broker.sock"),
				)
			},
			PathBuf::from,
		);
		Self::new(socket, session_id)
	}
}

#[derive(Debug)]
pub struct SocketCoordClient {
	endpoint: BrokerEndpoint,
	lock:     Mutex<()>,
	state:    PeerStateStore,
	warnings: ParkingMutex<Vec<String>>,
}

impl SocketCoordClient {
	#[must_use]
	pub fn new(endpoint: BrokerEndpoint) -> Self {
		Self {
			endpoint,
			lock: Mutex::new(()),
			state: PeerStateStore::default(),
			warnings: ParkingMutex::new(Vec::new()),
		}
	}

	fn resolve_session<'a>(&'a self, session: &'a str) -> &'a str {
		if session.trim().is_empty() {
			&self.endpoint.session_id
		} else {
			session
		}
	}

	fn warn_once(&self, message: impl Into<String>) {
		let message = message.into();
		let mut warnings = self.warnings.lock();
		if !warnings.iter().any(|existing| existing == &message) {
			warnings.push(message);
		}
	}

	fn open(&self) -> Option<(UnixStream, BufReader<UnixStream>)> {
		let connect = || -> Option<(UnixStream, BufReader<UnixStream>)> {
			let stream = UnixStream::connect(&self.endpoint.socket).ok()?;
			stream.set_read_timeout(Some(self.endpoint.budget)).ok()?;
			stream.set_write_timeout(Some(self.endpoint.budget)).ok()?;
			let reader = BufReader::new(stream.try_clone().ok()?);
			Some((stream, reader))
		};
		if let Some(pair) = connect() {
			return Some(pair);
		}
		if let Err(error) = spawn_broker_if_absent(&self.endpoint.socket, None) {
			self.warn_once(format!("coord broker unavailable: {error}"));
			return None;
		}
		let pair = connect();
		if pair.is_none() {
			self.warn_once(format!(
				"coord broker socket did not accept connections at {}",
				self.endpoint.socket.display()
			));
		}
		pair
	}

	fn handshake(
		&self,
		stream: &mut UnixStream,
		reader: &mut BufReader<UnixStream>,
		session: &str,
	) -> Option<()> {
		let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
		let project_name = cwd
			.file_name()
			.and_then(|name| name.to_str())
			.map(ToOwned::to_owned);
		write_json(stream, &ClientMessage::Hello {
			session_id: session.to_string(),
			pid: std::process::id(),
			cwd,
			project_name,
			started_at: now_ms(),
			open_files: Vec::new(),
		})
		.ok()?;
		loop {
			match read_message(reader)? {
				ServerMessage::Welcome { peers, .. } => {
					self
						.state
						.replace_peers(peers.into_iter().map(peer_info_from_summary).collect());
					return Some(());
				},
				ServerMessage::Error { code, message } => {
					self.warn_once(format!("coord hello failed {code}: {message}"));
					return None;
				},
				_ => {},
			}
		}
	}

	fn with_session<T>(
		&self,
		session: &str,
		operation: impl FnOnce(&mut UnixStream, &mut BufReader<UnixStream>) -> Option<T>,
	) -> Option<T> {
		let _guard: MutexGuard<'_, ()> = self.lock.lock().ok()?;
		let (mut stream, mut reader) = self.open()?;
		let session = self.resolve_session(session).to_string();
		self.handshake(&mut stream, &mut reader, &session)?;
		let out = operation(&mut stream, &mut reader);
		let _ = write_json(&mut stream, &ClientMessage::Bye);
		out
	}

	fn workspace_root_for(path: &Path) -> PathBuf {
		let mut current = path.parent().unwrap_or(path);
		let mut last_non_root = current.to_path_buf();
		loop {
			if current.join(".git").exists() || current.join(".spell").exists() {
				return current.to_path_buf();
			}
			let Some(parent) = current.parent() else {
				return last_non_root;
			};
			last_non_root = current.to_path_buf();
			current = parent;
		}
	}

	fn read_journal_entries(&self, file: &Path, limit: usize) -> Vec<JournalEntry> {
		let journal_path =
			journal_path_for(&default_journal_root(), &Self::workspace_root_for(file), file);
		match JournalReader::tail(&journal_path, limit) {
			Ok(entries) => entries,
			Err(crate::error::CodeEngineError::Io(error))
				if error.kind() == std::io::ErrorKind::NotFound =>
			{
				Vec::new()
			},
			Err(error) => {
				self.warn_once(format!("coord journal read failed for {}: {error}", file.display()));
				Vec::new()
			},
		}
	}

	fn sync_recent_from_journal(&self, file: &Path) -> Vec<JournalEntry> {
		let entries = self.read_journal_entries(file, JOURNAL_TAIL_LIMIT);
		let edits = entries
			.iter()
			.filter(|entry| entry.session_id != self.endpoint.session_id)
			.map(peer_edit_from_entry)
			.collect();
		self.state.replace_recent(file, edits);
		entries
	}
}

fn peer_info_from_summary(summary: PeerSummary) -> PeerInfo {
	PeerInfo {
		session_id:   summary.session_id,
		pid:          0,
		cwd:          summary.cwd,
		project_name: summary.project_name.unwrap_or_default(),
		started_at:   0,
		open_files:   summary.open_files,
	}
}

fn peer_edit_from_entry(entry: &JournalEntry) -> PeerEdit {
	PeerEdit {
		session_id: entry.session_id.clone(),
		revision:   entry.revision,
		code_paths: entry.code_paths.clone(),
		diff_hash:  entry.diff_hash.clone(),
		ts:         entry.ts,
	}
}

fn write_json<T: serde::Serialize>(stream: &mut UnixStream, msg: &T) -> std::io::Result<()> {
	let mut bytes = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
	bytes.push(b'\n');
	stream.write_all(&bytes)
}

fn read_message(reader: &mut BufReader<UnixStream>) -> Option<ServerMessage> {
	let mut line = String::new();
	match reader.read_line(&mut line) {
		Ok(0) | Err(_) => None,
		Ok(_) => serde_json::from_str(line.trim_end()).ok(),
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

impl CoordClient for SocketCoordClient {
	fn on_open(&self, owner: &OwnerId, file: &Path, _revision: u64) {
		let _ = self.with_session(owner.as_str(), |_stream, _reader| Some(()));
		self.sync_recent_from_journal(file);
	}

	fn intent(
		&self,
		owner: &OwnerId,
		file: &Path,
		code_paths: &[String],
		base_revision: u64,
	) -> IntentResult {
		let result = self.with_session(owner.as_str(), |stream, reader| {
			write_json(stream, &ClientMessage::Intent {
				file: file.to_path_buf(),
				code_paths: code_paths.to_vec(),
				base_revision,
				ttl_ms: 5_000,
			})
			.ok()?;
			loop {
				match read_message(reader)? {
					ServerMessage::IntentAck { granted: true, .. } => {
						return Some(IntentResult::Granted);
					},
					ServerMessage::IntentAck { granted: false, .. } => {
						return Some(IntentResult::Conflict {
							peer_session:   String::new(),
							code_path:      code_paths.first().cloned().unwrap_or_default(),
							peer_intent_ts: 0,
						});
					},
					ServerMessage::IntentConflict {
						code_path,
						conflicting_session,
						peer_intent_ts,
						..
					} => {
						return Some(IntentResult::Conflict {
							peer_session: conflicting_session,
							code_path,
							peer_intent_ts,
						});
					},
					ServerMessage::Error { code, message } => {
						self.warn_once(format!("coord intent failed {code}: {message}"));
						return None;
					},
					_ => {},
				}
			}
		});
		if result.is_none() {
			self.warn_once(format!("coord intent degraded for {}", file.display()));
		}
		result.unwrap_or(IntentResult::Granted)
	}

	fn commit(
		&self,
		owner: &OwnerId,
		file: &Path,
		revision: u64,
		parent_revision: u64,
		code_paths: &[String],
		diff_hash: &str,
		byte_len: u64,
	) -> CommitResult {
		let result = self.with_session(owner.as_str(), |stream, reader| {
			write_json(stream, &ClientMessage::Commit {
				file: file.to_path_buf(),
				revision,
				parent_revision,
				code_paths: code_paths.to_vec(),
				diff_hash: diff_hash.to_string(),
				byte_len,
			})
			.ok()?;
			loop {
				match read_message(reader)? {
					ServerMessage::CommitAck { .. } => return Some(CommitResult::Ok),
					ServerMessage::CommitConflict {
						code_path,
						conflicting_session,
						peer_revision,
						peer_commit_ts,
						..
					} => {
						return Some(CommitResult::Conflict {
							peer_session: conflicting_session,
							code_path,
							peer_revision,
							peer_commit_ts,
						});
					},
					ServerMessage::Error { code, message } => {
						self.warn_once(format!("coord commit failed {code}: {message}"));
						return None;
					},
					_ => {},
				}
			}
		});
		if result.is_none() {
			self.warn_once(format!("coord commit degraded for {}", file.display()));
		}
		result.unwrap_or(CommitResult::Ok)
	}

	fn recent_peer_edits(&self, file: &Path, since_ms: u64, limit: usize) -> Vec<PeerEdit> {
		self.sync_recent_from_journal(file);
		self.state.recent_peer_edits(file, since_ms, limit)
	}

	fn peer_state(&self, file: &Path) -> PeerState {
		let _ = self.with_session("", |_stream, _reader| Some(()));
		let entries = self.sync_recent_from_journal(file);
		let mut state = self.state.peer_state(file);
		state.latest_revision = entries.first().map(|entry| entry.revision);
		state
	}

	fn on_close(&self, _owner: &OwnerId, _file: &Path) {}

	/// P3.2: reclaim an owner's coordination state. On today's
	/// connection-per-call client nothing is held across calls (each op ends
	/// with a `Bye` that the broker treats as disconnect-deregister), so there
	/// is nothing to reclaim — this is a documented no-op. The functional
	/// implementation lands with the persistent-connection client (P3.5): a
	/// BEAM owner's held connection is closed, and the broker's existing
	/// disconnect-deregister frees that owner's intents.
	fn reclaim(&self, _owner: &OwnerId) {}

	fn multi_intent(
		&self,
		_peers: &[String],
		_files: &[super::client::FileIntent],
		_ttl_ms: u64,
	) -> super::client::MultiIntentResult {
		// Stub — full impl will coordinate across peers via broker multi-intent
		super::client::MultiIntentResult::Acknowledged
	}

	fn multi_commit(
		&self,
		_peers: &[String],
		_files: &[super::client::FileCommit],
	) -> super::client::MultiCommitResult {
		// Stub — orchestrator handles actual broker messages
		super::client::MultiCommitResult::Acknowledged
	}

	fn multi_abort(&self, _peers: &[String], _reason: &str) {
		// Stub
	}

	fn drain_warnings(&self) -> Vec<String> {
		std::mem::take(&mut *self.warnings.lock())
	}
}
