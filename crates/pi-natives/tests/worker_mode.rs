//! W5 cutover — `PI_KNOWLEDGE_WORKER` mode dispatch tests.
//!
//! Verifies that:
//! 1. `Inprocess` mode bypasses RPC and uses the in-process `WarmEngine`.
//! 2. `Daemon` mode (default) fails loud when no daemon is reachable.

#![cfg(unix)]

use std::{
	ffi::OsString,
	fs,
	path::PathBuf,
	sync::{Mutex, OnceLock},
};

/// Serialise env-var mutation across the two tests in this file. Integration
/// tests run in parallel by default and both tests touch process-global state.
static WORKER_MODE_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
fn test_lock() -> &'static Mutex<()> {
	WORKER_MODE_TEST_LOCK.get_or_init(|| Mutex::new(()))
}

/// RAII guard that saves and restores env vars + resets caches.
struct EnvSnapshot {
	_guard:       std::sync::MutexGuard<'static, ()>,
	prior_mode:   Option<OsString>,
	prior_worker: Option<OsString>,
}

impl EnvSnapshot {
	fn new() -> Self {
		let guard = test_lock().lock().expect("test lock poisoned");
		let prior_mode = std::env::var_os("PI_KNOWLEDGE_WORKER");
		let prior_worker = std::env::var_os("PI_EMBEDDING_WORKER");
		Self { _guard: guard, prior_mode, prior_worker }
	}

	fn set_mode(&self, value: &str) {
		unsafe { std::env::set_var("PI_KNOWLEDGE_WORKER", value) };
		pi_natives::embedding_worker::reset_worker_mode_for_tests();
	}

	fn set_worker_env(&self, value: &str) {
		unsafe { std::env::set_var("PI_EMBEDDING_WORKER", value) };
	}
}

impl Drop for EnvSnapshot {
	fn drop(&mut self) {
		unsafe {
			match &self.prior_mode {
				Some(v) => std::env::set_var("PI_KNOWLEDGE_WORKER", v),
				None => std::env::remove_var("PI_KNOWLEDGE_WORKER"),
			}
			match &self.prior_worker {
				Some(v) => std::env::set_var("PI_EMBEDDING_WORKER", v),
				None => std::env::remove_var("PI_EMBEDDING_WORKER"),
			}
		}
		pi_natives::embedding_worker::reset_worker_mode_for_tests();
		pi_natives::embedding_worker::reset_for_tests();
	}
}

fn temp_repo(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let dir = std::env::temp_dir()
		.join(format!("pi-natives-worker-mode-{label}-{}-{nanos}", std::process::id()));
	fs::create_dir_all(&dir).expect("tempdir");
	dir
}

fn seed(root: &std::path::Path) {
	let tasks = root.join("!tasks");
	fs::create_dir_all(&tasks).expect("mk tasks");
	fs::write(tasks.join("A.org"), "* TODO A\n:PROPERTIES:\n:CUSTOM_ID: A-1\n:END:\n\nbody of A\n")
		.expect("write item");
	fs::write(tasks.join("B.org"), "* TODO B\n:PROPERTIES:\n:CUSTOM_ID: B-1\n:END:\n\nbody of B\n")
		.expect("write item");
}

#[test]
fn inprocess_mode_skips_rpc_and_uses_warm_engine() {
	let env = EnvSnapshot::new();
	// Inprocess mode + no worker binary → WarmEngine runs with BM25-only
	// (vector lane gracefully disabled). Query must succeed.
	env.set_mode("inprocess");
	env.set_worker_env("/nonexistent/pi-knowledge-worker-inprocess-test");
	pi_natives::embedding_worker::reset_for_tests();

	let repo = temp_repo("inprocess");
	seed(&repo);

	let query = pi_knowledge_core::recall::RecallQuery {
		text: Some("body of A".into()),
		limit: 10,
		..Default::default()
	};

	let result = pi_natives::recall_engine::query(&repo, query);
	assert!(result.is_ok(), "inprocess mode should serve recall via WarmEngine: {:?}", result);

	let hits = result.unwrap();
	assert!(!hits.is_empty(), "inprocess mode should return BM25 hits");
	assert!(hits.iter().any(|h| h.id == "A-1"), "should surface item A-1; got {hits:?}");

	let _ = fs::remove_dir_all(repo);
	// env drops last, restoring env vars + resetting caches.
}

#[test]
fn daemon_mode_propagates_rpc_failure() {
	let env = EnvSnapshot::new();
	// Daemon mode (default) + no worker binary → must fail loud because no
	// daemon is reachable and the RPC path can't fall through to WarmEngine.
	env.set_worker_env("/nonexistent/pi-knowledge-worker-daemon-test");
	// Do NOT set PI_KNOWLEDGE_WORKER — defaults to Daemon.
	pi_natives::embedding_worker::reset_for_tests();

	let repo = temp_repo("daemon");
	seed(&repo);

	let query = pi_knowledge_core::recall::RecallQuery {
		text: Some("body of B".into()),
		limit: 10,
		..Default::default()
	};

	let err = pi_natives::recall_engine::query(&repo, query)
		.expect_err("daemon mode should fail when no daemon is reachable");
	assert!(
		err.contains("PI_KNOWLEDGE_WORKER=inprocess") || err.contains("set PI_KNOWLEDGE_WORKER"),
		"error should mention the escape hatch: {err}"
	);

	let _ = fs::remove_dir_all(repo);
	// env drops last, restoring env vars + resetting caches.
}
