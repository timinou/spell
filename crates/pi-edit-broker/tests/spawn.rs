//! Auto-spawn tests — scenario 1.

mod common;

use std::{path::PathBuf, time::Duration};

use pi_edit_broker::spawn_broker_if_absent;

/// Scenario 1: spawn helper forks the daemon and the first client connects.
#[test]
fn auto_spawn_by_first_client() {
	let temp = tempfile::tempdir().expect("tempdir");
	let socket = temp.path().join("auto-spawn.sock");
	let binary = std::env::var_os("CARGO_BIN_EXE_pi-edit-broker")
		.map(PathBuf::from)
		.expect("CARGO_BIN_EXE_pi-edit-broker provided by cargo test");
	// Small grace so the broker exits quickly at teardown.
	// SAFETY: single-threaded test boundary.
	unsafe {
		std::env::set_var("PI_EDIT_BROKER_GRACE_MS", "300");
	}
	spawn_broker_if_absent(&socket, Some(&binary)).expect("spawn");
	assert!(socket.exists(), "socket should exist after spawn");
	// Probe again — idempotent.
	spawn_broker_if_absent(&socket, Some(&binary)).expect("second spawn is idempotent");
	// Give broker time to enter grace-period and clean up.
	std::thread::sleep(Duration::from_millis(700));
}
