//! FEAT-784 — NAPI wrapper around `KnowledgeSubscription` for the
//! MemoryStatusController.
//!
//! Lifecycle:
//! - `knowledge_subscribe` opens a fresh socket, sends `subscribe`, spawns
//!   a reader thread, and stashes the live `KnowledgeSubscription` in a
//!   process-global registry. Returns a numeric handle.
//! - Event frames invoke the supplied `ThreadsafeFunction<String>` (JSON
//!   payload) on the libuv main thread.
//! - `knowledge_unsubscribe` removes the registry entry; Drop sends
//!   `unsubscribe`, closes the socket, joins the reader thread.
//!
//! Failure mode: any error during `subscribe` (socket missing, daemon
//! refused, malformed response) returns a NAPI `Error`. Callers MUST
//! treat this as the fallback-to-polling signal — no logging, no UI noise.

#![cfg(unix)]

use std::{
	collections::HashMap,
	sync::{
		Arc, LazyLock, Mutex,
		atomic::{AtomicU32, Ordering},
	},
};

use napi::{
	Result,
	bindgen_prelude::Error,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

use crate::knowledge_client::KnowledgeSubscription;

/// Process-global registry of live subscriptions. Keyed by a monotonic
/// `u32` handed back to JS.
static REGISTRY: LazyLock<Mutex<HashMap<u32, KnowledgeSubscription>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

/// Next handle id. Wraps at u32::MAX; collisions checked on insert.
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Open a push-subscribe channel against the knowledge daemon.
///
/// `on_event` is invoked for every event frame; the argument is the raw
/// JSON-encoded frame string (the controller can parse selectively or
/// just treat any event as a poll-kick).
///
/// Returns a numeric handle to pass to `knowledgeUnsubscribe`. On daemon
/// failure (unreachable / refused / malformed) throws a NAPI error.
#[napi(js_name = "knowledgeSubscribe")]
pub fn knowledge_subscribe(
	repo_handle: String,
	lanes: Vec<String>,
	on_event: ThreadsafeFunction<String, ()>,
) -> Result<u32> {
	let tsfn = Arc::new(on_event);
	let tsfn_for_cb = Arc::clone(&tsfn);
	let sub = KnowledgeSubscription::subscribe(
		repo_handle,
		lanes,
		Box::new(move |frame| {
			let payload = frame.to_string();
			let _ = tsfn_for_cb.call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
		}),
	)
	.map_err(|e| Error::from_reason(format!("knowledge subscribe failed: {e}")))?;

	let mut reg = REGISTRY
		.lock()
		.map_err(|_| Error::from_reason("knowledge registry poisoned"))?;
	let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
	reg.insert(id, sub);
	Ok(id)
}

/// Tear down a subscription created by `knowledgeSubscribe`. Idempotent:
/// unknown ids are silently ignored (lifecycle races are common during
/// session teardown).
#[napi(js_name = "knowledgeUnsubscribe")]
pub fn knowledge_unsubscribe(handle: u32) {
	if let Ok(mut reg) = REGISTRY.lock() {
		reg.remove(&handle);
	}
}
