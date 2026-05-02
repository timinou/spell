//! Broker accept loop + grace-period exit.
//!
//! `run_server` binds a `UnixListener`, spins up the reaper, and accepts
//! connections. When the live connection count drops to 0 a grace-period
//! timer starts; if it elapses with no new connections the listener is
//! closed, the socket file removed, and `run_server` returns.

use std::{path::PathBuf, sync::Arc, time::Duration};

use tokio::{
	net::UnixListener,
	signal::unix::{SignalKind, signal},
	sync::{RwLock, broadcast, mpsc, oneshot},
	time::sleep,
};

use crate::{
	conn::{BrokerEvent, ConnContext, ConnTick, handle},
	error::Result,
	reaper,
	state::BrokerState,
};

/// Broker runtime options.
#[derive(Debug, Clone)]
pub struct BrokerOptions {
	pub socket_path:        PathBuf,
	pub grace:              Duration,
	pub broadcast_capacity: usize,
	pub journal_path:       Option<PathBuf>,
}

impl Default for BrokerOptions {
	fn default() -> Self {
		Self {
			socket_path:        PathBuf::from("edit-broker.sock"),
			grace:              Duration::from_secs(30),
			broadcast_capacity: 256,
			journal_path:       None,
		}
	}
}

/// Run the broker event loop until:
/// - SIGTERM / SIGINT arrives, or
/// - no clients are connected and the grace period elapses.
pub async fn run_server(opts: BrokerOptions) -> Result<()> {
	let BrokerOptions { socket_path, grace, broadcast_capacity, journal_path } = opts;

	if socket_path.exists() {
		let _ = std::fs::remove_file(&socket_path);
	}
	if let Some(parent) = socket_path.parent()
		&& !parent.as_os_str().is_empty()
	{
		std::fs::create_dir_all(parent)?;
	}
	let listener = UnixListener::bind(&socket_path)?;

	let state = Arc::new(RwLock::new(BrokerState::new()));
	let (bus, _keep_alive_rx) = broadcast::channel::<BrokerEvent>(broadcast_capacity);
	let (tick_tx, mut tick_rx) = mpsc::unbounded_channel::<ConnTick>();
	let (reaper_shutdown, reaper_rx) = oneshot::channel::<()>();
	let reaper_handle = {
		let state = state.clone();
		let bus = bus.clone();
		let jp = journal_path.clone();
		tokio::spawn(async move { reaper::run(state, bus, reaper_rx, jp).await })
	};

	let ctx = Arc::new(ConnContext { state: state.clone(), bus, tick_tx, journal_path });

	let mut sigterm = signal(SignalKind::terminate())?;
	let mut sigint = signal(SignalKind::interrupt())?;
	let mut live: i64 = 0;
	let mut grace_timer: Option<tokio::task::JoinHandle<()>> = None;
	let (grace_fire_tx, mut grace_fire_rx) = mpsc::unbounded_channel::<()>();

	loop {
		tokio::select! {
			biased;
			_ = sigterm.recv() => break,
			_ = sigint.recv() => break,
			_ = grace_fire_rx.recv() => {
				if live <= 0 {
					break;
				}
			},
			Some(tick) = tick_rx.recv() => {
				match tick {
					ConnTick::Connected => {
						live = live.saturating_add(1);
						if let Some(handle) = grace_timer.take() {
							handle.abort();
						}
					},
					ConnTick::Disconnected => {
						live = live.saturating_sub(1);
						if live <= 0 {
							let fire = grace_fire_tx.clone();
							grace_timer = Some(tokio::spawn(async move {
								sleep(grace).await;
								let _ = fire.send(());
							}));
						}
					},
				}
			},
			accepted = listener.accept() => {
				let Ok((stream, _addr)) = accepted else { continue };
				let ctx = ctx.clone();
				tokio::spawn(async move { handle(stream, ctx).await });
			},
		}
	}

	let _ = reaper_shutdown.send(());
	let _ = reaper_handle.await;
	if let Some(handle) = grace_timer {
		handle.abort();
	}
	let _ = std::fs::remove_file(&socket_path);
	Ok(())
}
