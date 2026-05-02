//! Periodic session reaper + intent expirer + multi-txn reaper.
//!
//! Every `REAP_INTERVAL` the reaper checks each registered session's pid via
//! `kill(pid, 0)`. Dead sessions are deregistered and a `peer_left` event is
//! broadcast. Every `INTENT_INTERVAL` stale intents and stale multi-txns are
//! swept.
//!
//! On startup, if a `journal_path` is provided, the reaper replays the
//! journal and broadcasts `MultiPeerRolledBack` for any incomplete
//! transactions.

use std::{path::PathBuf, sync::Arc, time::Duration};

use nix::{sys::signal, unistd::Pid};
use tokio::{
	sync::{RwLock, broadcast},
	time::interval,
};

use crate::{
	conn::BrokerEvent,
	state::BrokerState,
	txn_journal::{replay_journal, TxnJournalEntry},
};

pub const REAP_INTERVAL: Duration = Duration::from_secs(5);
pub const INTENT_INTERVAL: Duration = Duration::from_secs(1);

/// True when `kill(pid, 0)` indicates the pid is still running (or we lack
/// permission — errs on the side of keeping the session alive).
#[must_use]
pub fn pid_alive(pid: u32) -> bool {
	if pid == 0 || pid > i32::MAX as u32 {
		return false;
	}
	let pid = Pid::from_raw(pid as i32);
	if pid.as_raw() <= 0 {
		return false;
	}
	match signal::kill(pid, None) {
		Ok(()) => true,
		Err(nix::errno::Errno::EPERM) => true,
		Err(_) => false,
	}
}

pub async fn run(
	state: Arc<RwLock<BrokerState>>,
	bus: broadcast::Sender<BrokerEvent>,
	mut shutdown: tokio::sync::oneshot::Receiver<()>,
	journal_path: Option<PathBuf>,
) {
	// --- Startup: replay journal, roll back incomplete txns ---
	if let Some(ref jp) = journal_path {
		match replay_journal(jp) {
			Ok(replay) => {
				for (txn_id, record) in &replay.incomplete_txns {
					let files: Vec<PathBuf> = record.files.clone();
					// Broadcast rollback for this incomplete txn
					let _ = bus.send(BrokerEvent::MultiPeerRolledBack {
						txn_id: txn_id.clone(),
						files: files.clone(),
						reason: "broker restart — incomplete txn".into(),
					});
					// Append a rollback entry so it's marked completed on next restart
					let _ = crate::txn_journal::append_entry(
						jp,
						&TxnJournalEntry::TxnRolledBack {
							txn_id: txn_id.clone(),
							reason: "broker restart — incomplete txn".into(),
							ts: crate::state::now_ms(),
						},
					);
				}
			},
			Err(e) => {
				eprintln!("[reaper] journal replay failed: {e}");
			},
		}
	}

	// --- Periodic ticks ---
	let mut reap_tick = interval(REAP_INTERVAL);
	let mut intent_tick = interval(INTENT_INTERVAL);
	loop {
		tokio::select! {
			_ = &mut shutdown => break,
			_ = reap_tick.tick() => {
				let dead = {
					let guard = state.read().await;
					guard.dead_sessions(pid_alive)
				};
				if !dead.is_empty() {
					let mut guard = state.write().await;
					for session_id in dead {
						if guard.deregister(&session_id).is_some() {
							let _ = bus.send(BrokerEvent::PeerLeft { session_id });
						}
					}
				}
			},
			_ = intent_tick.tick() => {
				let mut guard = state.write().await;
				guard.expire_intents();
				let stale = guard.expire_stale_txns();
				drop(guard);

				for txn_id in stale {
					if let Some(ref jp) = journal_path {
						let _ = crate::txn_journal::append_entry(
							jp,
							&TxnJournalEntry::TxnRolledBack {
								txn_id: txn_id.clone(),
								reason: "ttl expired".into(),
								ts: crate::state::now_ms(),
							},
						);
					}
					let _ = bus.send(BrokerEvent::MultiPeerRolledBack {
						txn_id,
						files: Vec::new(),
						reason: "ttl expired".into(),
					});
				}
			},
		}
	}
}
