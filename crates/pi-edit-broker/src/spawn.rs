//! Auto-spawn helper: detect an existing broker or fork one.

use std::{
	env, fs,
	io::{Read, Write},
	os::unix::net::UnixStream,
	path::{Path, PathBuf},
	process::{Command, Stdio},
	thread,
	time::{Duration, Instant},
};

use crate::error::{BrokerError, Result};

const CONNECT_PROBE: Duration = Duration::from_millis(150);
const SPAWN_WAIT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Return true when `socket` exists and accepts a connection within the probe
/// budget.
#[must_use]
pub fn probe(socket: &Path) -> bool {
	let _ = CONNECT_PROBE;
	match UnixStream::connect(socket) {
		Ok(mut stream) => {
			let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
			let _ = stream.write_all(b"");
			let mut buf = [0_u8; 1];
			let _ = stream.read(&mut buf);
			true
		},
		Err(_) => false,
	}
}

/// Resolve the broker binary, in precedence order:
/// 1. env `PI_EDIT_BROKER_BIN`
/// 2. sibling of the current executable
/// 3. first `pi-edit-broker` on `PATH`
#[must_use]
pub fn resolve_binary() -> Option<PathBuf> {
	if let Some(bin) = env::var_os("PI_EDIT_BROKER_BIN") {
		let bin = PathBuf::from(bin);
		if bin.exists() {
			return Some(bin);
		}
	}
	if let Ok(current) = env::current_exe()
		&& let Some(parent) = current.parent()
	{
		let sibling = parent.join("pi-edit-broker");
		if sibling.exists() {
			return Some(sibling);
		}
	}
	if let Some(path) = env::var_os("PATH") {
		for dir in env::split_paths(&path) {
			let candidate = dir.join("pi-edit-broker");
			if candidate.exists() {
				return Some(candidate);
			}
		}
	}
	None
}

/// Spawn the broker if `socket` is not already live. Waits up to 2s for the
/// new broker's socket to appear. No-op when a broker is already running.
pub fn spawn_broker_if_absent(socket: &Path, binary: Option<&Path>) -> Result<()> {
	if probe(socket) {
		return Ok(());
	}
	if socket.exists() {
		let _ = fs::remove_file(socket);
	}
	let bin = binary
		.map(Path::to_path_buf)
		.or_else(resolve_binary)
		.ok_or(BrokerError::BrokerBinaryNotFound)?;
	let mut cmd = Command::new(&bin);
	cmd.arg("--socket")
		.arg(socket)
		.arg("--daemonize")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null());
	if let Ok(grace) = env::var("PI_EDIT_BROKER_GRACE_MS") {
		cmd.env("PI_EDIT_BROKER_GRACE_MS", grace);
	}
	cmd.spawn()?;
	let start = Instant::now();
	while start.elapsed() < SPAWN_WAIT {
		if probe(socket) {
			return Ok(());
		}
		thread::sleep(POLL_INTERVAL);
	}
	Err(BrokerError::BrokerSpawnTimeout {
		socket:     socket.to_path_buf(),
		timeout_ms: SPAWN_WAIT.as_millis().try_into().unwrap_or(u64::MAX),
	})
}
