//! Periodic session reaper + intent expirer.
//!
//! Every `REAP_INTERVAL` the reaper checks each registered session's pid via
//! `kill(pid, 0)`. Dead sessions are deregistered and a `peer_left` event is
//! broadcast. Every `INTENT_INTERVAL` stale intents are swept.

use std::{sync::Arc, time::Duration};

use nix::{sys::signal, unistd::Pid};
use tokio::{
	sync::{RwLock, broadcast},
	time::interval,
};

use crate::{conn::BrokerEvent, state::BrokerState};

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
) {
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
			},
		}
	}
}
