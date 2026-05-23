//! PLAN-315 W4 — client-side subscription end-to-end.
//!
//! Spawns the daemon binary in socket mode, opens a real
//! `KnowledgeSubscription`, triggers a re-warm via `open`, and asserts the
//! event callback fired.

#![cfg(unix)]

use std::{
	fs,
	path::PathBuf,
	process::{Child, Command, Stdio},
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

fn unique_dir(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let dir = std::env::temp_dir().join(format!(
		"pi-natives-sub-client-{label}-{}-{nanos}",
		std::process::id()
	));
	fs::create_dir_all(&dir).expect("tempdir");
	dir
}

fn knowledge_worker_bin() -> Option<PathBuf> {
	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let workspace_target = manifest_dir.join("../../target");
	for profile in ["debug", "release"] {
		let p = workspace_target.join(profile).join("pi-knowledge-worker");
		if p.is_file() {
			return Some(p);
		}
	}
	None
}

fn seed(root: &std::path::Path) {
	let mem = root.join(".spell/memory/concepts");
	fs::create_dir_all(&mem).expect("mk concepts");
	fs::write(
		mem.join("alpha.org"),
		"* CON-alpha\n:PROPERTIES:\n:CUSTOM_ID: CON-alpha\n:KIND: concept\n:END:\n",
	)
	.expect("write");
}

fn spawn_daemon(socket: &std::path::Path, pidfile: &std::path::Path, bin: &std::path::Path) -> Child {
	Command::new(bin)
		.arg("--socket").arg(socket)
		.arg("--pidfile").arg(pidfile)
		.arg("--idle-secs").arg("30")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn daemon")
}

fn wait_for_socket(socket: &std::path::Path) -> bool {
	let deadline = std::time::Instant::now() + Duration::from_secs(5);
	while std::time::Instant::now() < deadline {
		if std::os::unix::net::UnixStream::connect(socket).is_ok() {
			return true;
		}
		std::thread::sleep(Duration::from_millis(50));
	}
	false
}

#[test]
fn subscribe_receives_warm_completed_event_end_to_end() {
	use pi_natives::{embedding_worker, knowledge_client::KnowledgeSubscription};

	let Some(bin) = knowledge_worker_bin() else {
		eprintln!("skipping: pi-knowledge-worker binary not built");
		return;
	};

	embedding_worker::reset_for_tests();

	let dir = unique_dir("warm");
	seed(&dir);
	let sock = dir.join("k.sock");
	let pid = dir.join("k.pid");
	let mut daemon = spawn_daemon(&sock, &pid, &bin);
	assert!(wait_for_socket(&sock), "daemon must bind socket");

	// SAFETY: this is the only test in this binary mutating the env var.
	unsafe {
		std::env::set_var("PI_KNOWLEDGE_WORKER_SOCKET", &sock);
	}

	// Open the repo once to get a handle.
	let opened = embedding_worker::knowledge_request(
		"open",
		serde_json::json!({
			"repo_root": &dir,
			"lanes": ["org_memory"],
		}),
	)
	.expect("rpc open");
	assert_eq!(opened["ok"], true, "open: {opened}");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	// Capture received events on the client side.
	let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
	let counter = Arc::new(AtomicUsize::new(0));
	let recv_for_cb = Arc::clone(&received);
	let counter_for_cb = Arc::clone(&counter);
	let sub = KnowledgeSubscription::subscribe(
		handle.clone(),
		vec!["org_memory".to_string()],
		Box::new(move |event| {
			counter_for_cb.fetch_add(1, Ordering::SeqCst);
			if let Ok(mut v) = recv_for_cb.lock() {
				v.push(event);
			}
		}),
	)
	.expect("subscribe");
	assert!(!sub.subscription_ids().is_empty(), "subscription_ids non-empty");

	// Close + re-open to fire warm_completed.
	let _ = embedding_worker::knowledge_request(
		"close",
		serde_json::json!({ "repo_handle": &handle }),
	);
	let _ = embedding_worker::knowledge_request(
		"open",
		serde_json::json!({
			"repo_root": &dir,
			"lanes": ["org_memory"],
		}),
	);

	// Allow up to 30 seconds for the event to propagate. PLAN-316 made the
	// warm path async, so this deadline now covers cold bge-m3 model load
	// (~3-5 s from disk; longer on first download) and the embed+publish
	// pipeline. Pre-316 the warm was synchronous inside `open`, hiding the
	// model-load cost behind the open() RTT.
	let deadline = std::time::Instant::now() + Duration::from_secs(30);
	while std::time::Instant::now() < deadline {
		if counter.load(Ordering::SeqCst) > 0 {
			break;
		}
		std::thread::sleep(Duration::from_millis(50));
	}

	let events = received.lock().expect("lock").clone();
	let saw_warm = events
		.iter()
		.any(|e| e.get("event").and_then(|v| v.as_str()) == Some("warm_completed"));

	drop(sub);
	unsafe {
		std::env::remove_var("PI_KNOWLEDGE_WORKER_SOCKET");
	}
	let _ = daemon.kill();
	let _ = daemon.wait();
	let _ = fs::remove_dir_all(&dir);

	assert!(saw_warm, "expected warm_completed event among {events:?}");
}
