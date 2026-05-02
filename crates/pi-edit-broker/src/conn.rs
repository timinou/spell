//! Per-connection handler — one task per Unix socket client.
//!
//! Each client task:
//! 1. Reads newline-delimited JSON `ClientMessage`s.
//! 2. Mutates `BrokerState` via the shared `RwLock`.
//! 3. Emits `ServerMessage`s on its own writer half.
//! 4. Receives `BrokerEvent`s from the broadcast bus and forwards the ones
//!    matching its subscriptions.
//! 5. On disconnect, deregisters its session and broadcasts `peer_left`.

use std::{path::PathBuf, sync::Arc};

use serde_json::Value;
use tokio::{
	io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
	net::UnixStream,
	sync::{RwLock, broadcast, mpsc},
};

use crate::{
	protocol::{
		ClientMessage, CommitRecord, IntentConflictItem,
		MultiCommitRevision, PeerCommittedFile, PeerSummary, ServerMessage, SessionId, TxnId,
	},
	state::{
		BrokerState, CommitDecision, IntentDecision, RegisterOutcome, SessionRecord, now_ms,
	},
	txn_journal::{TxnJournalEntry, append_entry},
};

const SERVER_VERSION: &str = "1";
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// Event broadcast from the state core to all subscribers.
#[derive(Debug, Clone)]
pub enum BrokerEvent {
	PeerJoined { session_id: SessionId },
	PeerLeft { session_id: SessionId },
	PeerCommitted { file: PathBuf, record: CommitRecord },
	MultiPeerCommitted {
		txn_id:     TxnId,
		session_id: SessionId,
		files:      Vec<PeerCommittedFile>,
		ts:         u64,
		org_items:  Option<Vec<serde_json::Value>>,
	},
	MultiPeerRolledBack {
		txn_id: TxnId,
		files:  Vec<PathBuf>,
		reason: String,
	},
}

/// Signals the accept loop should start / cancel the grace-period countdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnTick {
	Connected,
	Disconnected,
}

pub struct ConnContext {
	pub state:        Arc<RwLock<BrokerState>>,
	pub bus:          broadcast::Sender<BrokerEvent>,
	pub tick_tx:      mpsc::UnboundedSender<ConnTick>,
	pub journal_path: Option<PathBuf>,
}

pub async fn handle(stream: UnixStream, ctx: Arc<ConnContext>) {
	let _ = ctx.tick_tx.send(ConnTick::Connected);
	let (reader, mut writer) = stream.into_split();
	let mut reader = BufReader::new(reader);
	let mut rx = ctx.bus.subscribe();
	let mut registered: Option<SessionId> = None;
	let mut subscriptions: Vec<PathBuf> = Vec::new();
	let mut line = String::new();

	loop {
		tokio::select! {
			biased;
			read = reader.read_line(&mut line) => match read {
				Ok(0) => break,
				Ok(n) if n > MAX_LINE_BYTES => {
					let _ = write_msg(&mut writer, &ServerMessage::Error {
						code: "MESSAGE_TOO_LARGE".into(),
						message: format!("line {n} bytes exceeds cap {MAX_LINE_BYTES}"),
					}).await;
					break;
				},
				Ok(_) => {
					let parsed: std::result::Result<ClientMessage, _> = serde_json::from_str(line.trim_end());
					let trimmed = line.trim_end().to_string();
					line.clear();
					if let Ok(msg) = parsed {
						if handle_message(msg, &ctx, &mut registered, &mut subscriptions, &mut writer)
							.await
							.is_break()
						{
							break;
						}
					} else {
						let code = if let Ok(Value::Object(map)) =
							serde_json::from_str::<Value>(&trimmed)
							&& map.get("type").is_some()
						{
							"UNKNOWN_TYPE"
						} else {
							"BAD_JSON"
						};
						let _ = write_msg(&mut writer, &ServerMessage::Error {
							code:    code.into(),
							message: format!("could not parse client message: {trimmed}"),
						})
						.await;
					}
				},
				Err(_) => break,
			},
			event = rx.recv() => {
				if let Ok(event) = event
					&& should_forward(&event, registered.as_deref(), &subscriptions)
					&& write_event(&mut writer, &event).await.is_err()
				{
					break;
				}
			},
		}
	}

	if let Some(session_id) = registered.take() {
		let removed = {
			let mut guard = ctx.state.write().await;
			guard.deregister(&session_id).is_some()
		};
		if removed {
			let _ = ctx.bus.send(BrokerEvent::PeerLeft { session_id });
		}
	}
	let _ = ctx.tick_tx.send(ConnTick::Disconnected);
}

enum Step {
	Continue,
	Break,
}

impl Step {
	const fn is_break(&self) -> bool {
		matches!(self, Self::Break)
	}
}

async fn handle_message(
	msg: ClientMessage,
	ctx: &ConnContext,
	registered: &mut Option<SessionId>,
	subscriptions: &mut Vec<PathBuf>,
	writer: &mut tokio::net::unix::OwnedWriteHalf,
) -> Step {
	match msg {
		ClientMessage::Hello { session_id, pid, cwd, project_name, started_at, open_files } => {
			let record = SessionRecord {
				pid,
				cwd,
				project_name,
				started_at,
				open_files,
				last_heartbeat: now_ms(),
			};
			let peers: Vec<PeerSummary> = {
				let mut guard = ctx.state.write().await;
				let outcome = guard.register(session_id.clone(), record);
				if outcome == RegisterOutcome::Replaced {
					// Duplicate session id; prior task will disconnect on its
					// next read and clean up naturally.
				}
				guard.peer_summaries(&session_id)
			};
			*registered = Some(session_id.clone());
			let _ = ctx.bus.send(BrokerEvent::PeerJoined { session_id });
			if write_msg(writer, &ServerMessage::Welcome {
				server_version: SERVER_VERSION.into(),
				peers,
			})
			.await
			.is_err()
			{
				return Step::Break;
			}
		},
		ClientMessage::Subscribe { files } => {
			let Some(session_id) = registered.clone() else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code:    "NOT_REGISTERED".into(),
					message: "subscribe before hello".into(),
				})
				.await;
				return Step::Break;
			};
			{
				let mut guard = ctx.state.write().await;
				guard.subscribe(&session_id, &files);
			}
			for file in &files {
				if !subscriptions.contains(file) {
					subscriptions.push(file.clone());
				}
			}
		},
		ClientMessage::Intent { file, code_paths, base_revision, ttl_ms } => {
			let Some(session_id) = registered.clone() else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code:    "NOT_REGISTERED".into(),
					message: "intent before hello".into(),
				})
				.await;
				return Step::Break;
			};
			let decision = {
				let mut guard = ctx.state.write().await;
				guard.record_intent(&session_id, &file, &code_paths, ttl_ms, base_revision)
			};
			let reply = match decision {
				IntentDecision::Granted => ServerMessage::IntentAck { file, code_paths, granted: true },
				IntentDecision::Conflict { code_path, conflicting_session, peer_intent_ts } => {
					ServerMessage::IntentConflict {
						file,
						code_path,
						conflicting_session,
						peer_intent_ts,
					}
				},
			};
			if write_msg(writer, &reply).await.is_err() {
				return Step::Break;
			}
		},
		ClientMessage::Commit {
			file,
			revision,
			parent_revision,
			code_paths,
			diff_hash,
			byte_len: _,
		} => {
			let Some(session_id) = registered.clone() else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code:    "NOT_REGISTERED".into(),
					message: "commit before hello".into(),
				})
				.await;
				return Step::Break;
			};
			let (decision, record) = {
				let mut guard = ctx.state.write().await;
				guard.record_commit(
					&session_id,
					&file,
					revision,
					parent_revision,
					code_paths.clone(),
					diff_hash.clone(),
				)
			};
			match decision {
				CommitDecision::Accepted => {
					if write_msg(writer, &ServerMessage::CommitAck { file: file.clone(), revision })
						.await
						.is_err()
					{
						return Step::Break;
					}
					let _ = ctx.bus.send(BrokerEvent::PeerCommitted { file, record });
				},
				CommitDecision::Conflict {
					code_path,
					conflicting_session,
					peer_revision,
					peer_commit_ts,
				} => {
					if write_msg(writer, &ServerMessage::CommitConflict {
						file,
						code_path,
						conflicting_session,
						peer_revision,
						peer_commit_ts,
					})
					.await
					.is_err()
					{
						return Step::Break;
					}
				},
			}
		},
		ClientMessage::ReleaseIntent { file, code_paths } => {
			if let Some(session_id) = registered.clone() {
				let mut guard = ctx.state.write().await;
				guard.release_intent(&session_id, &file, &code_paths);
			}
		},
		ClientMessage::MultiIntent { txn_id, files, ttl_ms } => {
			let Some(session_id) = registered.clone() else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code:    "NOT_REGISTERED".into(),
					message: "multi_intent before hello".into(),
				})
				.await;
				return Step::Break;
			};

			// Journal the txn start
			if let Some(ref jp) = ctx.journal_path {
				let _ = append_entry(jp, &TxnJournalEntry::TxnStarted {
					txn_id: txn_id.clone(),
					session_id: session_id.clone(),
					files: files.iter().map(|f| (f.file.clone(), f.base_revision)).collect(),
					started_at: now_ms(),
				});
			}

			let result = {
				let mut guard = ctx.state.write().await;
				guard.try_grant_multi(&txn_id, &session_id, files, ttl_ms)
			};

			match result {
				Ok(()) => {
					if write_msg(writer, &ServerMessage::MultiIntentAck {
						txn_id,
						granted: true,
						conflicts: Vec::new(),
					})
					.await
					.is_err()
					{
						return Step::Break;
					}
				},
				Err(conflicts) => {
					let conflict_items: Vec<IntentConflictItem> = conflicts
						.into_iter()
						.map(|(file, code_path, conflicting_session)| IntentConflictItem {
							file,
							code_path,
							conflicting_session,
						})
						.collect();

					if write_msg(writer, &ServerMessage::MultiIntentAck {
						txn_id,
						granted: false,
						conflicts: conflict_items,
					})
					.await
					.is_err()
					{
						return Step::Break;
					}
				},
			}
		},
		ClientMessage::MultiCommit { txn_id, files } => {
			let Some(session_id) = registered.clone() else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code:    "NOT_REGISTERED".into(),
					message: "multi_commit before hello".into(),
				})
				.await;
				return Step::Break;
			};

			// Verify txn exists and belongs to this session
			let txn_files = {
				let guard = ctx.state.read().await;
				guard.active_txns.get(&txn_id).map(|txn| {
					(txn.session_id.clone(), txn.files.clone())
				})
			};

			let Some((txn_session_id, _)) = txn_files else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code: "MULTI_COMMIT_INVALID_TXN".into(),
					message: format!("no active txn '{txn_id}' for this session"),
				})
				.await;
				return Step::Break;
			};

			if txn_session_id != session_id {
				let _ = write_msg(writer, &ServerMessage::Error {
					code: "MULTI_COMMIT_INVALID_TXN".into(),
					message: format!("txn '{txn_id}' belongs to a different session"),
				})
				.await;
				return Step::Break;
			}

			let now = now_ms();

			// Record each file commit
			let mut revisions = Vec::new();
			let mut peer_files = Vec::new();
			let mut all_accepted = true;

			for fc in &files {
				let (decision, _record) = {
					let mut guard = ctx.state.write().await;
					guard.record_commit(
						&session_id,
						&fc.file,
						fc.revision,
						fc.parent_revision,
						fc.code_paths.clone(),
						fc.diff_hash.clone(),
					)
				};

				match decision {
					CommitDecision::Accepted => {
						revisions.push(MultiCommitRevision {
							file: fc.file.clone(),
							revision: fc.revision,
						});
						peer_files.push(PeerCommittedFile {
							file: fc.file.clone(),
							revision: fc.revision,
							code_paths: fc.code_paths.clone(),
							diff_hash: fc.diff_hash.clone(),
						});
					},
					CommitDecision::Conflict { code_path, .. } => {
						all_accepted = false;
						let _ = write_msg(writer, &ServerMessage::Error {
							code: "MULTI_COMMIT_CONFLICT".into(),
							message: format!("commit conflict on {}: {}", fc.file.display(), code_path),
						})
						.await;
						break;
					},
				}
			}

			if all_accepted {
				// Mark txn committed
				{
					let mut guard = ctx.state.write().await;
					guard.mark_txn_committed(&txn_id);
				}

				// Journal the commit
				if let Some(ref jp) = ctx.journal_path {
					let _ = append_entry(jp, &TxnJournalEntry::TxnCommitted {
						txn_id: txn_id.clone(),
						files: revisions.iter().map(|r| (r.file.clone(), r.revision)).collect(),
						ts: now,
					});
				}

				if write_msg(writer, &ServerMessage::MultiCommitAck {
					txn_id: txn_id.clone(),
					revisions: revisions.clone(),
				})
				.await
				.is_err()
				{
					return Step::Break;
				}

				// Broadcast MultiPeerCommitted
				let _ = ctx.bus.send(BrokerEvent::MultiPeerCommitted {
					txn_id,
					session_id,
					files: peer_files,
					ts: now,
					org_items: None,
				});
			}
		},
		ClientMessage::MultiAbort { txn_id } => {
			let Some(session_id) = registered.clone() else {
				let _ = write_msg(writer, &ServerMessage::Error {
					code:    "NOT_REGISTERED".into(),
					message: "multi_abort before hello".into(),
				})
				.await;
				return Step::Break;
			};

			let released = {
				let mut guard = ctx.state.write().await;
				let txn = guard.active_txns.get(&txn_id).cloned();
				if let Some(ref t) = txn {
					if t.session_id != session_id {
						None // not this session's txn
					} else {
						guard.release_txn(&txn_id)
					}
				} else {
					None
				}
			};

			if let Some(released_txn) = released {
				let files: Vec<PathBuf> = released_txn.files.iter().map(|f| f.file.clone()).collect();

				// Journal rollback
				if let Some(ref jp) = ctx.journal_path {
					let _ = append_entry(jp, &TxnJournalEntry::TxnRolledBack {
						txn_id: txn_id.clone(),
						reason: "client abort".into(),
						ts: now_ms(),
					});
				}

				let _ = ctx.bus.send(BrokerEvent::MultiPeerRolledBack {
					txn_id,
					files,
					reason: "client abort".into(),
				});
			}
		},
		ClientMessage::Heartbeat => {
			if let Some(session_id) = registered.clone() {
				let mut guard = ctx.state.write().await;
				guard.heartbeat(&session_id);
			}
		},
		ClientMessage::Bye => return Step::Break,
	}
	Step::Continue
}

fn should_forward(event: &BrokerEvent, self_id: Option<&str>, subscriptions: &[PathBuf]) -> bool {
	match event {
		BrokerEvent::PeerJoined { session_id } | BrokerEvent::PeerLeft { session_id } => {
			self_id.is_none_or(|id| id != session_id)
		},
		BrokerEvent::PeerCommitted { file, record } => {
			if self_id == Some(record.session_id.as_str()) {
				return false;
			}
			subscriptions.iter().any(|sub| sub == file)
		},
		BrokerEvent::MultiPeerCommitted { session_id, .. } => {
			self_id.is_none_or(|id| id != session_id)
		},
		BrokerEvent::MultiPeerRolledBack { .. } => true,
	}
}

async fn write_msg(
	writer: &mut tokio::net::unix::OwnedWriteHalf,
	msg: &ServerMessage,
) -> std::io::Result<()> {
	let mut bytes = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
	bytes.push(b'\n');
	writer.write_all(&bytes).await
}

async fn write_event(
	writer: &mut tokio::net::unix::OwnedWriteHalf,
	event: &BrokerEvent,
) -> std::io::Result<()> {
	let msg = match event {
		BrokerEvent::PeerJoined { session_id } => {
			ServerMessage::PeerJoined { session_id: session_id.clone() }
		},
		BrokerEvent::PeerLeft { session_id } => {
			ServerMessage::PeerLeft { session_id: session_id.clone() }
		},
		BrokerEvent::PeerCommitted { file, record } => ServerMessage::PeerCommitted {
			file:       file.clone(),
			session_id: record.session_id.clone(),
			revision:   record.revision,
			code_paths: record.code_paths.clone(),
			diff_hash:  record.diff_hash.clone(),
			ts:         record.ts,
			org_items:  None,
		},
		BrokerEvent::MultiPeerCommitted {
			txn_id,
			session_id,
			files,
			ts,
			org_items,
		} => ServerMessage::MultiPeerCommitted {
			txn_id: txn_id.clone(),
			session_id: session_id.clone(),
			files: files.clone(),
			ts: *ts,
			org_items: org_items.clone(),
		},
		BrokerEvent::MultiPeerRolledBack { txn_id, files, reason } => {
			ServerMessage::MultiPeerRolledBack {
				txn_id: txn_id.clone(),
				files: files.clone(),
				reason: reason.clone(),
			}
		},
	};
	write_msg(writer, &msg).await
}
