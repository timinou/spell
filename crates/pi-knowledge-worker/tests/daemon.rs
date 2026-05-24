//! Daemon lifecycle tests for PLAN-310 W3. Exercises pidfile lock, idle exit,
//! SIGTERM drain, and stale-socket recovery WITHOUT triggering real bge-m3
//! model load (no init / embed_* requests).
//!
//! Cross-platform: only built on unix; on other targets the binary's socket
//! mode is unimplemented anyway.

#![cfg(unix)]

use std::{
	fs,
	os::unix::net::UnixStream,
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	thread,
	time::{Duration, Instant},
};

const BIN: &str = env!("CARGO_BIN_EXE_pi-knowledge-worker");

fn unique_dir(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let dir = std::env::temp_dir().join(format!("pi-embed-test-{label}-{}-{nanos}", std::process::id()));
	fs::create_dir_all(&dir).expect("tempdir");
	dir
}

fn spawn_daemon(socket: &Path, pidfile: &Path, idle_secs: u64) -> Child {
	Command::new(BIN)
		.arg("--socket").arg(socket)
		.arg("--pidfile").arg(pidfile)
		.arg("--idle-secs").arg(idle_secs.to_string())
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn worker")
}

fn wait_for_socket(socket: &Path, timeout: Duration) -> bool {
	let start = Instant::now();
	while start.elapsed() < timeout {
		if UnixStream::connect(socket).is_ok() {
			return true;
		}
		thread::sleep(Duration::from_millis(50));
	}
	false
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
	let start = Instant::now();
	while start.elapsed() < timeout {
		if let Ok(Some(_)) = child.try_wait() {
			return true;
		}
		thread::sleep(Duration::from_millis(100));
	}
	false
}

#[test]
fn pidfile_lock_prevents_second_daemon() {
	let dir = unique_dir("pidlock");
	let sock = dir.join("embed.sock");
	let pidfile = dir.join("embed.pid");

	let mut a = spawn_daemon(&sock, &pidfile, 60);
	assert!(wait_for_socket(&sock, Duration::from_secs(5)), "first daemon should bind");
	let pid_a = fs::read_to_string(&pidfile).expect("pidfile written").trim().to_owned();
	assert!(!pid_a.is_empty(), "pidfile content");

	let mut b = spawn_daemon(&sock, &pidfile, 60);
	assert!(wait_for_exit(&mut b, Duration::from_secs(5)), "second daemon should exit (flock denied)");
	let pid_after = fs::read_to_string(&pidfile).expect("pidfile still present").trim().to_owned();
	assert_eq!(pid_after, pid_a, "first daemon's pid still in pidfile");

	let _ = a.kill();
	let _ = a.wait();
	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn idle_exit_after_configured_seconds() {
	let dir = unique_dir("idle");
	let sock = dir.join("embed.sock");
	let pidfile = dir.join("embed.pid");

	let mut child = spawn_daemon(&sock, &pidfile, 2);
	assert!(wait_for_socket(&sock, Duration::from_secs(5)), "should bind socket");

	// Don't send any request. Wait up to 8s for the idle watchdog to fire.
	assert!(wait_for_exit(&mut child, Duration::from_secs(8)), "should self-exit on idle");
	assert!(!sock.exists(), "socket cleaned up after idle exit");
	assert!(!pidfile.exists(), "pidfile cleaned up after idle exit");

	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn sigterm_drains_and_exits_cleanly() {
	use nix::sys::signal::{kill, Signal};
	use nix::unistd::Pid;

	let dir = unique_dir("sigterm");
	let sock = dir.join("embed.sock");
	let pidfile = dir.join("embed.pid");

	let mut child = spawn_daemon(&sock, &pidfile, 60);
	assert!(wait_for_socket(&sock, Duration::from_secs(5)), "should bind socket");

	// Open a connection but don't send a request. SIGTERM should still drain
	// cleanly even with an idle connection waiting.
	let _conn = UnixStream::connect(&sock).expect("connect");

	let pid = child.id();
	kill(Pid::from_raw(pid as i32), Signal::SIGTERM).expect("SIGTERM");

	assert!(wait_for_exit(&mut child, Duration::from_secs(8)), "should exit after SIGTERM");
	let status = child.wait().expect("wait");
	assert!(status.success(), "clean exit");
	assert!(!sock.exists(), "socket cleaned up");
	assert!(!pidfile.exists(), "pidfile cleaned up");

	let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stale_socket_file_is_cleared_on_startup() {
	let dir = unique_dir("stale");
	let sock = dir.join("embed.sock");
	let pidfile = dir.join("embed.pid");

	// Plant a regular file at the socket path; daemon should clear it.
	fs::write(&sock, b"stale").expect("plant file");

	let mut child = spawn_daemon(&sock, &pidfile, 60);
	assert!(wait_for_socket(&sock, Duration::from_secs(5)), "should bind despite stale file");

	let _ = child.kill();
	let _ = child.wait();
	let _ = fs::remove_dir_all(&dir);
}
