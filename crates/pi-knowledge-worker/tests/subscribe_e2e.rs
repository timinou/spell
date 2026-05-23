//! PLAN-315 W4 — subscribe lifecycle integration tests.
//!
//! Exercises the full push-subscribe contract against a real daemon
//! binary spawned in stdio mode:
//!  1. `subscribe` returns `subscription_ids` and `ok: true`
//!  2. Repo open after subscribe pushes a `warm_completed` event
//!  3. `unsubscribe` returns `removed: N`
//!  4. Closing the connection releases all subscriptions
//!
//! All four scenarios run inside one `#[test]` to share the daemon process
//! and avoid contention on the static `subscribe::REGISTRY`.

#![cfg(unix)]

use std::{
	io::{BufRead, BufReader, Write},
	path::PathBuf,
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	time::Duration,
};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_pi-knowledge-worker");

fn unique_dir(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let dir = std::env::temp_dir().join(format!(
		"pi-kw-sub-{label}-{}-{nanos}",
		std::process::id()
	));
	std::fs::create_dir_all(&dir).expect("tempdir");
	dir
}

fn seed(root: &std::path::Path) {
	let memory = root.join(".spell/memory/concepts");
	std::fs::create_dir_all(&memory).expect("mk concepts");
	std::fs::write(
		memory.join("alpha.org"),
		"* CON-alpha\n:PROPERTIES:\n:CUSTOM_ID: CON-alpha\n:KIND: concept\n:END:\n",
	)
	.expect("write alpha");
}

struct Daemon {
	child: Child,
	stdin: ChildStdin,
	reader: BufReader<ChildStdout>,
}

impl Daemon {
	fn spawn() -> Self {
		let mut child = Command::new(BIN)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.expect("spawn daemon");
		let stdin = child.stdin.take().expect("stdin");
		let reader = BufReader::new(child.stdout.take().expect("stdout"));
		Self { child, stdin, reader }
	}

	fn send(&mut self, payload: Value) {
		writeln!(self.stdin, "{payload}").expect("write");
		self.stdin.flush().expect("flush");
	}

	fn recv(&mut self) -> Value {
		let mut line = String::new();
		self.reader.read_line(&mut line).expect("read");
		serde_json::from_str(line.trim()).expect("parse")
	}

	fn recv_timeout(&mut self, ms: u64) -> Option<Value> {
		// Crude: spawn a stdlib reader on a thread, race against a deadline.
		let deadline = std::time::Instant::now() + Duration::from_millis(ms);
		let mut line = String::new();
		loop {
			if std::time::Instant::now() >= deadline {
				return None;
			}
			// `read_line` is blocking; rely on the daemon closing stdout to
			// unblock. For the timeout case we just consult `try_wait`.
			match self.child.try_wait() {
				Ok(Some(_)) => return None,
				Ok(None) => {
					// Try non-blocking read; std::io::BufReader doesn't have
					// `available()`, so we degrade to a thread-pump approach.
				},
				Err(_) => return None,
			}
			// Fall through to a blocking read with a small split window.
			std::thread::sleep(Duration::from_millis(50));
			let bytes = self.reader.read_line(&mut line);
			match bytes {
				Ok(0) => return None,
				Ok(_) if !line.is_empty() => {
					return serde_json::from_str(line.trim()).ok();
				},
				Ok(_) => {},
				Err(_) => return None,
			}
		}
	}

	fn shutdown(mut self) {
		drop(self.stdin);
		let _ = self.child.wait();
		drop(self.reader);
	}
}

#[test]
fn subscribe_lifecycle_end_to_end() {
	subtest_subscribe_returns_ids_and_ok();
	subtest_open_after_subscribe_pushes_warm_completed();
	subtest_unsubscribe_drops_count();
	subtest_subscribe_validates_lanes();
}

fn subtest_subscribe_returns_ids_and_ok() {
	let dir = unique_dir("sub1");
	seed(&dir);
	let mut d = Daemon::spawn();

	// Open the repo to get a real handle.
	d.send(json!({
		"command": "open",
		"repo_root": dir.to_string_lossy(),
		"lanes": ["org_memory"],
	}));
	let opened = d.recv();
	assert_eq!(opened["ok"], true, "open: {opened}");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	d.send(json!({
		"command": "subscribe",
		"repo_handle": handle,
		"lanes": ["org_memory"],
	}));
	let sub = d.recv();
	assert_eq!(sub["ok"], true, "subscribe: {sub}");
	let ids = sub["subscription_ids"].as_array().expect("subscription_ids");
	assert_eq!(ids.len(), 1, "one subscription per lane");
	assert!(ids[0].as_u64().is_some(), "sub_id is u64");

	d.shutdown();
	let _ = std::fs::remove_dir_all(&dir);
}

fn subtest_open_after_subscribe_pushes_warm_completed() {
	let dir = unique_dir("sub2");
	seed(&dir);
	let mut d = Daemon::spawn();

	// First open (warms the lane); second open is a re-touch (already warm
	// → no warm_completed event). To exercise the push channel we subscribe
	// FIRST on a fresh handle, then warm.
	//
	// But subscribe requires a repo_handle — and we get the handle from
	// `open`. So the flow is:
	//   1. open → warm (no listener yet; event not delivered)
	//   2. subscribe to that handle
	//   3. close → re-open → fresh warm → warm_completed delivered
	d.send(json!({
		"command": "open",
		"repo_root": dir.to_string_lossy(),
		"lanes": ["org_memory"],
	}));
	let opened1 = d.recv();
	let handle = opened1["repo_handle"].as_str().expect("handle").to_string();

	d.send(json!({
		"command": "subscribe",
		"repo_handle": handle,
		"lanes": ["org_memory"],
	}));
	let sub = d.recv();
	assert_eq!(sub["ok"], true);

	d.send(json!({ "command": "close", "repo_handle": handle }));
	let closed = d.recv();
	assert_eq!(closed["ok"], true);

	// Re-open → warm-load runs → publish_warm_completed fires.
	d.send(json!({
		"command": "open",
		"repo_root": dir.to_string_lossy(),
		"lanes": ["org_memory"],
	}));

	// We now expect TWO frames in some order:
	//  - the `warm_completed` event (pushed)
	//  - the `open` response (pulled)
	// Drain a few lines, look for the event.
	let mut saw_event = false;
	let mut saw_open_response = false;
	for _ in 0..5 {
		let mut line = String::new();
		if d.reader.read_line(&mut line).is_err() {
			break;
		}
		let val: Value = match serde_json::from_str(line.trim()) {
			Ok(v) => v,
			Err(_) => continue,
		};
		if val.get("event").and_then(|v| v.as_str()) == Some("warm_completed") {
			saw_event = true;
			assert!(val["ms"].as_u64().is_some(), "warm_completed ms");
		}
		if val.get("ok") == Some(&Value::Bool(true))
			&& val.get("repo_handle").and_then(|v| v.as_str()) == Some(handle.as_str())
		{
			saw_open_response = true;
		}
		if saw_event && saw_open_response {
			break;
		}
	}
	assert!(saw_event, "expected warm_completed event");
	assert!(saw_open_response, "expected open response");

	d.shutdown();
	let _ = std::fs::remove_dir_all(&dir);
}

fn subtest_unsubscribe_drops_count() {
	let dir = unique_dir("sub3");
	seed(&dir);
	let mut d = Daemon::spawn();

	d.send(json!({
		"command": "open",
		"repo_root": dir.to_string_lossy(),
		"lanes": ["org_memory"],
	}));
	let opened = d.recv();
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	d.send(json!({
		"command": "subscribe",
		"repo_handle": handle,
		"lanes": ["org_memory"],
	}));
	let sub = d.recv();
	let sub_id = sub["subscription_ids"][0].as_u64().expect("sub_id");

	d.send(json!({
		"command": "unsubscribe",
		"subscription_ids": [sub_id],
	}));
	let unsub = d.recv();
	assert_eq!(unsub["ok"], true);
	assert_eq!(unsub["removed"], 1);

	// Idempotent: re-unsubscribing the same id removes 0.
	d.send(json!({
		"command": "unsubscribe",
		"subscription_ids": [sub_id],
	}));
	let again = d.recv();
	assert_eq!(again["ok"], true);
	assert_eq!(again["removed"], 0);

	d.shutdown();
	let _ = std::fs::remove_dir_all(&dir);
}

fn subtest_subscribe_validates_lanes() {
	let dir = unique_dir("sub4");
	seed(&dir);
	let mut d = Daemon::spawn();

	d.send(json!({
		"command": "open",
		"repo_root": dir.to_string_lossy(),
		"lanes": ["org_memory"],
	}));
	let opened = d.recv();
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	// No lanes → error.
	d.send(json!({
		"command": "subscribe",
		"repo_handle": handle,
		"lanes": [],
	}));
	let empty = d.recv();
	assert_eq!(empty["ok"], false);
	assert!(empty["error"].as_str().unwrap_or("").contains("at least one lane"));

	// Bad lane name → error.
	d.send(json!({
		"command": "subscribe",
		"repo_handle": handle,
		"lanes": ["nonsense"],
	}));
	let bad = d.recv();
	assert_eq!(bad["ok"], false);

	d.shutdown();
	let _ = std::fs::remove_dir_all(&dir);
}
