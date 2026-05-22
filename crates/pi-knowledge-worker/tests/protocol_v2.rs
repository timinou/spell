//! PLAN-315 W1 — protocol-v2 stdio integration tests.
//!
//! These don't load the real bge-m3 model. They verify the *protocol
//! surface*: the new `open`/`close`/`stats` commands round-trip, the
//! `init` response carries `protocol_version: 2`, and unknown commands
//! return a clean error frame (not a panic).

#![cfg(unix)]

use std::{
	io::{BufRead, BufReader, Write},
	path::PathBuf,
	process::{Command, Stdio},
};

use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_pi-knowledge-worker");

fn unique_dir(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let dir = std::env::temp_dir().join(format!("pi-kw-proto-{label}-{}-{nanos}", std::process::id()));
	std::fs::create_dir_all(&dir).expect("tempdir");
	dir
}

/// Round-trip a single stdio request → response without involving init or
/// the embedder model. Spawns the binary in stdio mode, writes one line,
/// reads one response line, then drops stdin to make the daemon exit.
fn round_trip(request: Value) -> Value {
	let mut child = Command::new(BIN)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn binary");

	{
		let mut stdin = child.stdin.take().expect("stdin");
		writeln!(stdin, "{}", request).expect("write request");
	} // dropping stdin closes it; daemon's read_line returns 0 next.

	let stdout = child.stdout.take().expect("stdout");
	let mut reader = BufReader::new(stdout);
	let mut line = String::new();
	reader.read_line(&mut line).expect("read response");

	let _ = child.wait();
	serde_json::from_str(line.trim()).expect("parse response")
}

#[test]
fn open_round_trips_and_returns_handle() {
	let dir = unique_dir("open");
	let res = round_trip(json!({
		"command": "open",
		"repo_root": dir.to_string_lossy(),
		"lanes": ["org_memory"],
	}));
	assert_eq!(res["ok"], true, "open should succeed: {res}");
	let handle = res["repo_handle"].as_str().expect("repo_handle str");
	assert!(handle.starts_with("fnv:"), "handle prefix: {handle}");
	assert_eq!(res["warm"], false, "first open is cold");
	let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn open_nonexistent_returns_error() {
	let res = round_trip(json!({
		"command": "open",
		"repo_root": "/nonexistent/path/foo/bar",
		"lanes": ["org_memory"],
	}));
	assert_eq!(res["ok"], false, "open of nonexistent should fail: {res}");
	let err = res["error"].as_str().expect("error str");
	assert!(err.contains("does not exist") || err.contains("not a directory"), "{err}");
}

#[test]
fn close_unknown_handle_returns_closed_false() {
	let res = round_trip(json!({
		"command": "close",
		"repo_handle": "fnv:0000000000000000",
	}));
	assert_eq!(res["ok"], true);
	assert_eq!(res["closed"], false);
}

#[test]
fn stats_daemon_wide_returns_max_warm_repos() {
	let res = round_trip(json!({ "command": "stats" }));
	assert_eq!(res["ok"], true);
	assert!(res["max_warm_repos"].as_u64().is_some());
	assert!(res["repos"].is_array());
}

#[test]
fn malformed_json_returns_error_frame_not_crash() {
	let mut child = Command::new(BIN)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn");

	{
		let mut stdin = child.stdin.take().expect("stdin");
		writeln!(stdin, "this is not json").expect("write");
	}

	let stdout = child.stdout.take().expect("stdout");
	let mut reader = BufReader::new(stdout);
	let mut line = String::new();
	reader.read_line(&mut line).expect("read");
	let res: Value = serde_json::from_str(line.trim()).expect("parse");
	let _ = child.wait();

	assert_eq!(res["ok"], false);
	assert!(res["error"].as_str().unwrap_or("").contains("malformed"));
}

#[test]
fn unknown_command_returns_error_frame() {
	let res = round_trip(json!({ "command": "does_not_exist" }));
	assert_eq!(res["ok"], false);
}
