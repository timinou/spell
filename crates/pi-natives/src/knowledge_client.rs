//! PLAN-315 W4 — client-side push-subscribe handle.
//!
//! `KnowledgeSubscription` opens its OWN socket connection to the daemon
//! (separate from `embedding_worker`'s shared transport) and spawns a
//! background thread that reads event frames + dispatches them to a
//! user-provided callback. Drop the handle to unsubscribe and close.
//!
//! Falls back gracefully when:
//! - the daemon socket isn't reachable (returns Err on `subscribe`)
//! - the daemon doesn't advertise `subscribe` in its capabilities
//!
//! ```ignore
//! let sub = KnowledgeSubscription::subscribe(
//!     repo_handle,
//!     vec!["org_memory".to_string()],
//!     Box::new(|event| { eprintln!("event: {event}"); }),
//! )?;
//! // ...do work; subscription stays live...
//! drop(sub); // closes connection, daemon-side token Drop deregisters
//! ```

#![cfg(unix)]

use std::{
	io::{BufRead, BufReader, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

use serde_json::{Value, json};

/// Callback invoked for each event frame received from the daemon.
/// Runs on the subscription's background thread.
pub type EventCallback = Box<dyn Fn(Value) + Send + Sync + 'static>;

/// A live subscription against the knowledge daemon. Drop to unsubscribe
/// (sends an explicit unsubscribe frame, then closes the socket).
pub struct KnowledgeSubscription {
	/// Connection writer side, used for sending Unsubscribe on drop.
	writer:           Arc<Mutex<UnixStream>>,
	/// Subscription ids on the daemon side (one per lane).
	subscription_ids: Vec<u64>,
	/// Background thread reading event frames.
	reader_thread:    Option<JoinHandle<()>>,
	/// Signal to the reader thread that we're shutting down.
	stopped:          Arc<AtomicBool>,
}

impl KnowledgeSubscription {
	/// Open a fresh connection to the daemon, send a `subscribe` command,
	/// spawn the event-reading thread. Returns `Err` if the daemon is
	/// unreachable or refuses the subscription.
	pub fn subscribe(
		repo_handle: impl Into<String>,
		lanes: Vec<String>,
		on_event: EventCallback,
	) -> Result<Self, String> {
		let socket_path = resolve_socket_path()?;
		let stream = UnixStream::connect(&socket_path)
			.map_err(|e| format!("connect {}: {e}", socket_path.display()))?;
		stream
			.set_read_timeout(Some(Duration::from_secs(120)))
			.map_err(|e| format!("set read_timeout: {e}"))?;

		let mut writer = stream
			.try_clone()
			.map_err(|e| format!("clone stream: {e}"))?;
		let reader_stream = stream;

		// Send subscribe request.
		let request = json!({
			"command": "subscribe",
			"repo_handle": repo_handle.into(),
			"lanes": lanes,
		});
		serde_json::to_writer(&mut writer, &request)
			.map_err(|e| format!("encode subscribe: {e}"))?;
		writer
			.write_all(b"\n")
			.map_err(|e| format!("write subscribe: {e}"))?;
		writer.flush().map_err(|e| format!("flush subscribe: {e}"))?;

		// Read subscribe response (one line) BEFORE spawning the event
		// reader, so we can synchronously validate the subscription.
		let mut reader = BufReader::new(reader_stream);
		let mut line = String::new();
		reader
			.read_line(&mut line)
			.map_err(|e| format!("read subscribe response: {e}"))?;
		let response: Value = serde_json::from_str(line.trim())
			.map_err(|e| format!("parse subscribe response: {e}"))?;
		if response.get("ok") != Some(&Value::Bool(true)) {
			let err = response
				.get("error")
				.and_then(Value::as_str)
				.unwrap_or("unknown");
			return Err(format!("subscribe refused: {err}"));
		}
		let subscription_ids: Vec<u64> = response
			.get("subscription_ids")
			.and_then(Value::as_array)
			.map(|arr| arr.iter().filter_map(Value::as_u64).collect())
			.unwrap_or_default();
		if subscription_ids.is_empty() {
			return Err("subscribe response missing subscription_ids".into());
		}

		// Spawn reader thread that dispatches event frames.
		let stopped = Arc::new(AtomicBool::new(false));
		let stopped_for_thread = Arc::clone(&stopped);
		let reader_thread = thread::spawn(move || {
			let mut reader = reader;
			let mut line = String::new();
			while !stopped_for_thread.load(Ordering::Relaxed) {
				line.clear();
				match reader.read_line(&mut line) {
					Ok(0) => return, // socket closed
					Ok(_) => {
						let trimmed = line.trim();
						if trimmed.is_empty() {
							continue;
						}
						let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
							continue;
						};
						// Event frames have "event"; responses have "ok" or
						// "subscription_ids". Only dispatch events.
						if value.get("event").is_some() {
							on_event(value);
						}
					},
					Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
						|| e.kind() == std::io::ErrorKind::TimedOut =>
					{
						// Read timeout — loop and check stopped flag.
					},
					Err(_) => return,
				}
			}
		});

		Ok(Self {
			writer: Arc::new(Mutex::new(writer)),
			subscription_ids,
			reader_thread: Some(reader_thread),
			stopped,
		})
	}

	pub fn subscription_ids(&self) -> &[u64] {
		&self.subscription_ids
	}
}

impl Drop for KnowledgeSubscription {
	fn drop(&mut self) {
		// Best-effort: send unsubscribe, then close the socket.
		self.stopped.store(true, Ordering::Relaxed);
		if let Ok(mut writer) = self.writer.lock() {
			let request = json!({
				"command": "unsubscribe",
				"subscription_ids": self.subscription_ids,
			});
			let _ = serde_json::to_writer(&mut *writer, &request);
			let _ = writer.write_all(b"\n");
			let _ = writer.flush();
			let _ = writer.shutdown(std::net::Shutdown::Both);
		}
		if let Some(handle) = self.reader_thread.take() {
			let _ = handle.join();
		}
	}
}

/// Resolve the daemon socket path the same way `embedding_worker` does.
/// Prefer the canonical name, fall back to the legacy name for one release.
fn resolve_socket_path() -> Result<PathBuf, String> {
	if let Some(value) = std::env::var_os("PI_KNOWLEDGE_WORKER_SOCKET")
		.or_else(|| std::env::var_os("PI_EMBEDDING_WORKER_SOCKET"))
		&& !value.is_empty()
	{
		return Ok(PathBuf::from(value));
	}
	let base: PathBuf = if let Some(xdg) =
		std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty())
	{
		PathBuf::from(xdg).join("spell")
	} else {
		// SAFETY: getuid is signal-safe + always returns.
		let uid = unsafe { libc::getuid() };
		PathBuf::from(format!("/tmp/spell-{uid}"))
	};
	let primary = base.join("knowledge.sock");
	let legacy = base.join("embed.sock");
	if !primary.exists() && legacy.exists() {
		return Ok(legacy);
	}
	Ok(primary)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn subscribe_returns_err_when_daemon_unreachable() {
		// SAFETY: env mutation is process-global; the test holds the lock.
		let _g = crate::embedding_worker::lock_test_env();
		// SAFETY: env mutation inside test lock; restored at scope end.
		unsafe {
			std::env::set_var(
				"PI_KNOWLEDGE_WORKER_SOCKET",
				"/tmp/pi-natives-no-such-socket-PLAN315.sock",
			);
		}
		let result = KnowledgeSubscription::subscribe(
			"fnv:abc",
			vec!["org_memory".to_string()],
			Box::new(|_| {}),
		);
		// SAFETY: cleanup.
		unsafe {
			std::env::remove_var("PI_KNOWLEDGE_WORKER_SOCKET");
		}
		assert!(result.is_err(), "expected error when daemon unreachable");
	}
}
