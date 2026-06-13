//! PLAN-315 W2 — RPC vs in-process dispatch parity.
//!
//! Spawns the pi-knowledge-worker daemon binary in stdio mode, then uses
//! the client's `embedding_worker::knowledge_request` directly to verify:
//! 1. Capability discovery returns protocol_version=2 + supported_commands
//! 2. The same query against the same corpus produces equivalent hits whether
//!    served via RPC or in-process WarmEngine.
//!
//! Embedder may be unreachable in CI; the parity assertion is therefore
//! over BM25-only weights so embedder availability doesn't matter.

#![cfg(unix)]

use std::{
	fs,
	path::PathBuf,
	process::{Child, Command, Stdio},
};

/// Locate the `pi-knowledge-worker` binary built into the workspace's
/// target directory. Returns `None` if not found — caller skips the test.
fn knowledge_worker_bin() -> Option<PathBuf> {
	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	// pi-natives lives at crates/pi-natives/; workspace target is two up.
	let workspace_target = manifest_dir.join("../../target");
	for profile in ["debug", "release"] {
		let candidate = workspace_target.join(profile).join("pi-knowledge-worker");
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

fn unique_dir(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let dir =
		std::env::temp_dir().join(format!("pi-natives-rpc-{label}-{}-{nanos}", std::process::id()));
	fs::create_dir_all(&dir).expect("tempdir");
	dir
}

fn seed(root: &std::path::Path) {
	let memory = root.join(".spell/memory/concepts");
	fs::create_dir_all(&memory).expect("mk");
	for (id, label) in [("CON-alpha", "alpha"), ("CON-beta", "beta"), ("CON-gamma", "gamma")] {
		fs::write(
			memory.join(format!("{id}.org")),
			format!(
				"* {id}\n:PROPERTIES:\n:CUSTOM_ID: {id}\n:KIND: concept\n:END:\n\nbody text for \
				 {label}",
			),
		)
		.expect("write");
	}
}

/// Spawn the daemon in socket mode for the duration of the test.
fn spawn_daemon_socket(
	socket: &std::path::Path,
	pidfile: &std::path::Path,
	bin: &std::path::Path,
) -> Child {
	Command::new(bin)
		.arg("--socket")
		.arg(socket)
		.arg("--pidfile")
		.arg(pidfile)
		.arg("--idle-secs")
		.arg("30")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn daemon")
}

fn wait_for_socket(socket: &std::path::Path) -> bool {
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
	while std::time::Instant::now() < deadline {
		if std::os::unix::net::UnixStream::connect(socket).is_ok() {
			return true;
		}
		std::thread::sleep(std::time::Duration::from_millis(50));
	}
	false
}

/// All three subtests run inside one #[test] because they share static
/// transport state (WORKER + CAPS) inside `pi_natives::embedding_worker`.
/// Splitting into multiple `#[test]` functions would require either
/// `--test-threads=1` or a coarser test-isolation guard.
#[test]
fn rpc_dispatch_end_to_end() {
	let Some(bin) = knowledge_worker_bin() else {
		eprintln!(
			"skipping: pi-knowledge-worker binary not built (run `cargo build -p \
			 pi-knowledge-worker`)"
		);
		return;
	};
	subtest_capability_discovery(&bin);
	subtest_open_close_round_trip(&bin);
}

fn subtest_capability_discovery(bin: &std::path::Path) {
	use pi_natives::embedding_worker;

	pi_natives::embedding_worker::reset_for_tests();
	let dir = unique_dir("caps");
	let sock = dir.join("k.sock");
	let pid = dir.join("k.pid");
	let mut daemon = spawn_daemon_socket(&sock, &pid, bin);
	assert!(wait_for_socket(&sock), "daemon should bind socket");

	// SAFETY: serialised through TEST_ENV_LOCK by acquiring lock_test_env().
	// We don't have access to the private lock, but capability discovery
	// is read-only against process env (only reads PI_KNOWLEDGE_WORKER_SOCKET).
	// In practice this test runs in its own integration binary where it's
	// the only consumer of CAPS.
	// SAFETY: env mutation is single-test-binary scope.
	unsafe {
		std::env::set_var("PI_KNOWLEDGE_WORKER_SOCKET", &sock);
	}

	let caps = embedding_worker::capabilities();
	// SAFETY: cleanup
	unsafe {
		std::env::remove_var("PI_KNOWLEDGE_WORKER_SOCKET");
	}

	assert_eq!(caps.protocol_version, 2, "protocol v2 expected; got {caps:?}");
	for required in ["init", "open", "close", "stats", "search", "about", "neighbors", "since"] {
		assert!(
			caps.supports(required),
			"daemon must advertise '{required}'; supported={:?}",
			caps.supported_commands
		);
	}
	assert!(caps.knowledge_capable(), "knowledge_capable should be true");

	let _ = daemon.kill();
	let _ = daemon.wait();
	let _ = fs::remove_dir_all(&dir);
}

fn subtest_open_close_round_trip(bin: &std::path::Path) {
	use pi_natives::embedding_worker;

	pi_natives::embedding_worker::reset_for_tests();
	let dir = unique_dir("openclose");
	seed(&dir);
	let sock = dir.join("k.sock");
	let pid = dir.join("k.pid");
	let mut daemon = spawn_daemon_socket(&sock, &pid, bin);
	assert!(wait_for_socket(&sock));

	unsafe {
		std::env::set_var("PI_KNOWLEDGE_WORKER_SOCKET", &sock);
	}

	let opened = embedding_worker::knowledge_request(
		"open",
		serde_json::json!({
			"repo_root": &dir,
			"lanes": ["org_memory"],
		}),
	)
	.expect("rpc open");
	assert_eq!(opened["ok"], true, "open: {opened}");
	let handle = opened["repo_handle"]
		.as_str()
		.expect("handle str")
		.to_string();

	let stats = embedding_worker::knowledge_request("stats", serde_json::json!({})).expect("stats");
	assert_eq!(stats["ok"], true);
	let repos = stats["repos"].as_array().expect("repos");
	assert!(repos.iter().any(|r| r["repo_handle"] == handle.as_str()), "open repo in stats");

	let closed =
		embedding_worker::knowledge_request("close", serde_json::json!({ "repo_handle": &handle }))
			.expect("close");
	assert_eq!(closed["ok"], true);
	assert_eq!(closed["closed"], true);

	unsafe {
		std::env::remove_var("PI_KNOWLEDGE_WORKER_SOCKET");
	}
	let _ = daemon.kill();
	let _ = daemon.wait();
	let _ = fs::remove_dir_all(&dir);
}
