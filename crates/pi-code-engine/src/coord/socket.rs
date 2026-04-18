//! `SocketCoordClient` — talks to a running `pi-edit-broker` via its Unix
//! socket protocol.
//!
//! This FEAT-577 scaffold provides the connection-establishment helpers and
//! the blocking protocol wrapper; the full wiring into `edit_transaction`
//! lands with the `BufferRegistry` surface in a follow-up iteration.
//!
//! **Degraded-no-op policy.** Every broker call has a short budget (150ms by
//! default). On timeout or disconnect the client downgrades to the
//! [`super::NullCoordClient`] semantics for the remainder of the call so the
//! edit path never blocks on an unreachable broker.

use std::{
	io::{BufRead, BufReader, Write},
	os::unix::net::UnixStream,
	path::{Path, PathBuf},
	sync::{Mutex, MutexGuard},
	time::Duration,
};

use serde::{Deserialize, Serialize};

use super::client::{CommitResult, CoordClient, IntentResult, PeerEdit, PeerState, SessionId};

const DEFAULT_BUDGET: Duration = Duration::from_millis(150);

/// Lightweight line-based client for the broker protocol.
///
/// The wire format is duplicated as plain JSON rather than depending on the
/// broker crate so this module is unit-testable without tokio and without the
/// broker binary.
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
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutboundMessage<'a> {
	Hello {
		#[serde(rename = "sessionId")]
		session_id: &'a str,
		pid:        u32,
		cwd:        &'a Path,
		#[serde(rename = "startedAt")]
		started_at: u64,
		#[serde(rename = "openFiles")]
		open_files: Vec<&'a Path>,
	},
	Intent {
		file:          &'a Path,
		#[serde(rename = "codePaths")]
		code_paths:    &'a [String],
		#[serde(rename = "baseRevision")]
		base_revision: u64,
		#[serde(rename = "ttlMs")]
		ttl_ms:        u64,
	},
	Commit {
		file:            &'a Path,
		revision:        u64,
		#[serde(rename = "parentRevision")]
		parent_revision: u64,
		#[serde(rename = "codePaths")]
		code_paths:      &'a [String],
		#[serde(rename = "diffHash")]
		diff_hash:       &'a str,
		#[serde(rename = "byteLen")]
		byte_len:        u64,
	},
	Bye,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundMessage {
	Welcome,
	IntentAck {
		granted: bool,
	},
	IntentConflict {
		#[serde(rename = "codePath")]
		code_path:           String,
		#[serde(rename = "conflictingSession")]
		conflicting_session: SessionId,
		#[serde(rename = "peerIntentTs")]
		peer_intent_ts:      u64,
	},
	CommitAck,
	CommitConflict {
		#[serde(rename = "codePath")]
		code_path:           String,
		#[serde(rename = "conflictingSession")]
		conflicting_session: SessionId,
		#[serde(rename = "peerRevision")]
		peer_revision:       u64,
		#[serde(rename = "peerCommitTs")]
		peer_commit_ts:      u64,
	},
	PeerJoined,
	PeerLeft,
	PeerCommitted,
	Error {
		#[allow(dead_code, reason = "retained for future logging")]
		code:    String,
		#[allow(dead_code, reason = "retained for future logging")]
		message: String,
	},
}

/// Blocking client that runs its own per-call connect/send/recv cycle to the
/// broker.
///
/// Connections are not pooled in this FEAT — each request opens a new
/// socket. The broker handles this cheaply; pooling lands in a follow-up if
/// the per-call latency profile justifies it.
#[derive(Debug)]
pub struct SocketCoordClient {
	endpoint: BrokerEndpoint,
	#[allow(dead_code, reason = "reserved for future pooled-connection work")]
	lock:     Mutex<()>,
}

impl SocketCoordClient {
	#[must_use]
	pub const fn new(endpoint: BrokerEndpoint) -> Self {
		Self { endpoint, lock: Mutex::new(()) }
	}

	fn open(&self) -> Option<(UnixStream, BufReader<UnixStream>)> {
		let stream = UnixStream::connect(&self.endpoint.socket).ok()?;
		stream.set_read_timeout(Some(self.endpoint.budget)).ok()?;
		stream.set_write_timeout(Some(self.endpoint.budget)).ok()?;
		let reader = BufReader::new(stream.try_clone().ok()?);
		Some((stream, reader))
	}

	fn handshake(&self, stream: &mut UnixStream, reader: &mut BufReader<UnixStream>) -> Option<()> {
		let hello = OutboundMessage::Hello {
			session_id: &self.endpoint.session_id,
			pid:        std::process::id(),
			cwd:        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
			started_at: super::blake3_short(self.endpoint.session_id.as_bytes())
				.chars()
				.map(|c| c as u32 as u64)
				.sum(),
			open_files: Vec::new(),
		};
		write_json(stream, &hello).ok()?;
		loop {
			match read_message(reader)? {
				InboundMessage::Welcome => return Some(()),
				InboundMessage::Error { .. } => return None,
				_ => {},
			}
		}
	}

	fn with_session<T>(
		&self,
		operation: impl FnOnce(&mut UnixStream, &mut BufReader<UnixStream>) -> Option<T>,
	) -> Option<T> {
		let _guard: MutexGuard<'_, ()> = self.lock.lock().ok()?;
		let (mut stream, mut reader) = self.open()?;
		self.handshake(&mut stream, &mut reader)?;
		let out = operation(&mut stream, &mut reader);
		let _ = write_json(&mut stream, &OutboundMessage::Bye);
		out
	}
}

fn write_json<T: Serialize>(stream: &mut UnixStream, msg: &T) -> std::io::Result<()> {
	let mut bytes = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
	bytes.push(b'\n');
	stream.write_all(&bytes)
}

fn read_message(reader: &mut BufReader<UnixStream>) -> Option<InboundMessage> {
	let mut line = String::new();
	match reader.read_line(&mut line) {
		Ok(0) | Err(_) => None,
		Ok(_) => serde_json::from_str(line.trim_end()).ok(),
	}
}

impl CoordClient for SocketCoordClient {
	fn on_open(&self, _session: &str, _file: &Path, _revision: u64) {
		// No-op: subscription is implicit; the broker learns about open files
		// on the next `hello` cycle. Refined in a follow-up.
	}

	fn intent(
		&self,
		_session: &str,
		file: &Path,
		code_paths: &[String],
		base_revision: u64,
	) -> IntentResult {
		let result: Option<IntentResult> = self.with_session(|stream, reader| {
			write_json(stream, &OutboundMessage::Intent {
				file,
				code_paths,
				base_revision,
				ttl_ms: 5_000,
			})
			.ok()?;
			loop {
				match read_message(reader)? {
					InboundMessage::IntentAck { granted: true } => {
						return Some(IntentResult::Granted);
					},
					InboundMessage::IntentAck { granted: false } => {
						return Some(IntentResult::Conflict {
							peer_session:   String::new(),
							code_path:      code_paths.first().cloned().unwrap_or_default(),
							peer_intent_ts: 0,
						});
					},
					InboundMessage::IntentConflict {
						code_path,
						conflicting_session,
						peer_intent_ts,
					} => {
						return Some(IntentResult::Conflict {
							peer_session: conflicting_session,
							code_path,
							peer_intent_ts,
						});
					},
					InboundMessage::Error { .. } => return None,
					_ => {},
				}
			}
		});
		result.unwrap_or(IntentResult::Granted)
	}

	fn commit(
		&self,
		_session: &str,
		file: &Path,
		revision: u64,
		parent_revision: u64,
		code_paths: &[String],
		diff_hash: &str,
		byte_len: u64,
	) -> CommitResult {
		let result: Option<CommitResult> = self.with_session(|stream, reader| {
			write_json(stream, &OutboundMessage::Commit {
				file,
				revision,
				parent_revision,
				code_paths,
				diff_hash,
				byte_len,
			})
			.ok()?;
			loop {
				match read_message(reader)? {
					InboundMessage::CommitAck => return Some(CommitResult::Ok),
					InboundMessage::CommitConflict {
						code_path,
						conflicting_session,
						peer_revision,
						peer_commit_ts,
					} => {
						return Some(CommitResult::Conflict {
							peer_session: conflicting_session,
							code_path,
							peer_revision,
							peer_commit_ts,
						});
					},
					InboundMessage::Error { .. } => return None,
					_ => {},
				}
			}
		});
		result.unwrap_or(CommitResult::Ok)
	}

	fn recent_peer_edits(&self, _file: &Path, _since_ms: u64, _limit: usize) -> Vec<PeerEdit> {
		// Broker currently replies to these only in `welcome.recent_commits`;
		// a dedicated query message lands with FEAT-578. Until then return
		// empty.
		Vec::new()
	}

	fn peer_state(&self, _file: &Path) -> PeerState {
		PeerState { peers: Vec::new(), recent_commits: Vec::new(), latest_revision: None }
	}

	fn on_close(&self, _session: &str, _file: &Path) {
		// Deregistration happens implicitly when the per-call session closes.
	}
}
