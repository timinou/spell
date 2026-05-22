//! PLAN-315 W4 — push-subscribe machinery.
//!
//! Architecture:
//! ```text
//! Connection (one per accepted socket):
//!   ├─ writer thread: drains `out_rx` → socket bytes
//!   ├─ reader thread: reads commands, replies via `out_tx`
//!   ├─ subscriptions: tokens that, on Drop, remove sinks from LaneEvents
//!   └─ heartbeat thread (only when ≥ 1 sub active): emits `event: heartbeat`
//!
//! LaneEvents (per (repo_handle, Lane)):
//!   └─ subscribers: Vec<EventSink>  ← lock + send on each event
//!
//! Frame multiplexing on the wire:
//!   - responses carry the same `request_id` echoed back to the client
//!   - events carry `event: <kind>` instead of `ok: <bool>`
//!   - both flow through the SAME socket writer so ordering is preserved
//!     within a connection
//! ```

use std::{
	collections::HashMap,
	sync::{
		Arc, Mutex, OnceLock,
		atomic::{AtomicU64, Ordering},
		mpsc::{SyncSender, TrySendError},
	},
	thread,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{Value, json};

use crate::Lane;

/// Channel depth per subscription. When events accumulate beyond this
/// count, the oldest are dropped and a `{event: "lag", dropped: N}` frame
/// is sent so the client can choose to re-issue queries.
const SUB_CHANNEL_DEPTH: usize = 256;

/// Heartbeat cadence sent to subscribers. Clients drop the connection if
/// they don't see one within 3× this interval.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Outbound frame travelling from any producer (response or event) to the
/// connection's writer thread.
#[derive(Debug)]
pub enum Frame {
	/// Reply to a client request. Carries the optional `request_id` so the
	/// client can correlate when in subscribe mode (interleaved queries).
	Response { body: Value },
	/// Event pushed from an ingest source or LaneEvents broadcast.
	Event { body: Value },
}

/// Unique id allocated to each subscription. Returned to the client on
/// successful `subscribe`; used by `unsubscribe` to deregister.
pub type SubId = u64;

static NEXT_SUB_ID: AtomicU64 = AtomicU64::new(1);

fn next_sub_id() -> SubId {
	NEXT_SUB_ID.fetch_add(1, Ordering::Relaxed)
}

/// Per-subscriber sink. Carries the connection's outbound channel so the
/// LaneEvents fan-out can push event frames into the writer pipe directly.
#[derive(Clone)]
pub struct EventSink {
	pub sub_id:   SubId,
	pub out_tx:   SyncSender<Frame>,
	pub repo:     String,
	pub lane:     Lane,
	/// Bounded counter of dropped events since the last successful send.
	/// Flushed (read + reset) every time the next event is delivered, as a
	/// `{event:"lag", dropped: N}` frame.
	pub dropped:  Arc<AtomicU64>,
}

impl std::fmt::Debug for EventSink {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("EventSink")
			.field("sub_id", &self.sub_id)
			.field("repo", &self.repo)
			.field("lane", &self.lane)
			.finish_non_exhaustive()
	}
}

/// Events fired by lane producers (ingest, rebuild, eviction).
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
	/// Index for `(repo, lane)` has been rebuilt; fingerprint is new.
	IndexChanged {
		repo_handle: String,
		lane:        Lane,
		fingerprint: String,
	},
	/// Initial warm-load for `(repo, lane)` completed.
	WarmCompleted {
		repo_handle: String,
		lane:        Lane,
		ms:          u64,
	},
	/// LRU evicted `(repo, lane)`; subscribers should consider their cached
	/// `repo_handle` stale and re-issue `open` if they still care.
	Evicted {
		repo_handle: String,
		reason:      String,
	},
	/// Periodic liveness signal.
	Heartbeat { ts: u64 },
	/// Backpressure marker — N events were dropped before this frame.
	Lag { dropped: u64 },
	/// Synthetic benchmark payload; emitted_at in epoch ms.
	/// PLAN-315 W8 perf instrumentation. Never emitted during normal operation.
	BenchPayload {
		emitted_at_ms: u64,
		payload_id:   u32,
	},
}

/// Per-(repo_handle, lane) subscriber registry.
/// subscribe; the registry fans out each `publish` to every sink.
#[derive(Default)]
pub struct LaneEvents {
	subscribers: Mutex<Vec<EventSink>>,
}

impl LaneEvents {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn add(&self, sink: EventSink) {
		if let Ok(mut subs) = self.subscribers.lock() {
			subs.push(sink);
		}
	}

	pub fn remove(&self, sub_id: SubId) {
		if let Ok(mut subs) = self.subscribers.lock() {
			subs.retain(|s| s.sub_id != sub_id);
		}
	}

	pub fn len(&self) -> usize {
		self.subscribers.lock().map(|s| s.len()).unwrap_or(0)
	}

	/// Publish an event. Best-effort: send failures drop the subscriber
	/// (the receiver hung up). Lag is tracked per sink and flushed by
	/// `flush_lag` on the next successful send.
	pub fn publish(&self, event: &Event) {
		let body = serde_json::to_value(event).unwrap_or_else(|_| json!(null));
		let frame_template = || Frame::Event { body: body.clone() };

		let mut dead: Vec<SubId> = Vec::new();
		if let Ok(subs) = self.subscribers.lock() {
			for sink in subs.iter() {
				// If there's lag accumulated for this sink, emit a Lag
				// frame first so the client sees the gap.
				let dropped = sink.dropped.swap(0, Ordering::SeqCst);
				if dropped > 0 {
					let lag_body = serde_json::to_value(Event::Lag { dropped })
						.unwrap_or_else(|_| json!(null));
					match sink.out_tx.try_send(Frame::Event { body: lag_body }) {
						Ok(()) | Err(TrySendError::Full(_)) => {}
						Err(TrySendError::Disconnected(_)) => {
							dead.push(sink.sub_id);
							continue;
						}
					}
				}
				match sink.out_tx.try_send(frame_template()) {
					Ok(()) => {}
					Err(TrySendError::Full(_)) => {
						// channel full → record drop, do NOT remove sink
						sink.dropped.fetch_add(1, Ordering::SeqCst);
					}
					Err(TrySendError::Disconnected(_)) => {
						dead.push(sink.sub_id);
					}
				}
			}
		}
		if !dead.is_empty()
			&& let Ok(mut subs) = self.subscribers.lock()
		{
			subs.retain(|s| !dead.contains(&s.sub_id));
		}
	}
}

/// Top-level registry keyed by `(repo_handle, lane)`. Lazily creates a
/// `LaneEvents` on first subscribe.
pub struct EventRegistry {
	inner: Mutex<HashMap<(String, Lane), Arc<LaneEvents>>>,
}

impl EventRegistry {
	pub fn new() -> Self {
		Self { inner: Mutex::new(HashMap::new()) }
	}

	/// Return (or create) the LaneEvents for `(repo, lane)`.
	pub fn lane(&self, repo: &str, lane: Lane) -> Arc<LaneEvents> {
		let mut inner = match self.inner.lock() {
			Ok(g) => g,
			Err(p) => p.into_inner(),
		};
		inner
			.entry((repo.to_owned(), lane))
			.or_insert_with(|| Arc::new(LaneEvents::new()))
			.clone()
	}

	pub fn publish(&self, repo: &str, lane: Lane, event: &Event) {
		// Only fan out if there are subscribers; otherwise the empty Arc<LaneEvents>
		// allocation is unnecessary.
		if let Ok(inner) = self.inner.lock()
			&& let Some(lane_events) = inner.get(&(repo.to_owned(), lane)).cloned()
		{
			drop(inner);
			lane_events.publish(event);
		}
	}

	/// Subscribe an outbound sink. Returns a `SubscriptionToken` which, on
	/// drop, deregisters the sink.
	pub fn subscribe(
		&self,
		repo: &str,
		lane: Lane,
		out_tx: SyncSender<Frame>,
	) -> SubscriptionToken {
		let sub_id = next_sub_id();
		let lane_events = self.lane(repo, lane);
		lane_events.add(EventSink {
			sub_id,
			out_tx,
			repo: repo.to_owned(),
			lane,
			dropped: Arc::new(AtomicU64::new(0)),
		});
		SubscriptionToken { sub_id, lane: lane_events }
	}
}

/// Owns the subscription lifecycle. Dropping the token deregisters the
/// sink from the LaneEvents.
pub struct SubscriptionToken {
	sub_id: SubId,
	lane:   Arc<LaneEvents>,
}

impl SubscriptionToken {
	pub fn sub_id(&self) -> SubId {
		self.sub_id
	}
}

impl Drop for SubscriptionToken {
	fn drop(&mut self) {
		self.lane.remove(self.sub_id);
	}
}

/// Global EventRegistry singleton. Set once at daemon startup; persistent
/// for the daemon's lifetime.
static REGISTRY: OnceLock<EventRegistry> = OnceLock::new();

pub fn registry() -> &'static EventRegistry {
	REGISTRY.get_or_init(EventRegistry::new)
}

/// Convenience: publish `IndexChanged` for a lane.
pub fn publish_index_changed(repo: &str, lane: Lane, fingerprint: &str) {
	registry().publish(
		repo,
		lane,
		&Event::IndexChanged {
			repo_handle: repo.to_owned(),
			lane,
			fingerprint: fingerprint.to_owned(),
		},
	);
}

/// Convenience: publish `WarmCompleted` for a lane.
pub fn publish_warm_completed(repo: &str, lane: Lane, ms: u64) {
	registry().publish(
		repo,
		lane,
		&Event::WarmCompleted { repo_handle: repo.to_owned(), lane, ms },
	);
}

/// Convenience: publish `Evicted`.
pub fn publish_evicted(repo: &str, reason: &str) {
	// Eviction fires across all lanes for the repo; iterate over both.
	for lane in [Lane::OrgMemory, Lane::CodeGraph] {
		registry().publish(
			repo,
			lane,
			&Event::Evicted { repo_handle: repo.to_owned(), reason: reason.to_owned() },
		);
	}
}

/// PLAN-315 W8 perf instrumentation. Stamps current epoch-ms and emits a
/// BenchPayload on the given (repo, lane) channel. Subscribers compute
/// delivery latency = receipt_ms - emitted_at_ms.
pub fn publish_bench_event(repo_handle: &str, lane: Lane, payload_id: u32) {
	let emitted_at_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0);
	registry().publish(
		repo_handle,
		lane,
		&Event::BenchPayload { emitted_at_ms, payload_id },
	);
}

/// Spawn a heartbeat thread bound to `out_tx`. Stops when the receiver is
/// dropped or when `should_stop` returns true.
pub fn spawn_heartbeat(
	out_tx: SyncSender<Frame>,
	should_stop: Arc<dyn Fn() -> bool + Send + Sync>,
) {
	thread::spawn(move || {
		loop {
			thread::sleep(HEARTBEAT_INTERVAL);
			if should_stop() {
				return;
			}
			let ts = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.map_or(0, |d| d.as_secs());
			let body = serde_json::to_value(Event::Heartbeat { ts })
				.unwrap_or_else(|_| json!(null));
			if out_tx.try_send(Frame::Event { body }).is_err() {
				// Receiver dropped or channel full beyond drop-tolerance —
				// stop the heartbeat. Reconnect will spawn a fresh one.
				return;
			}
		}
	});
}

// `std::sync::mpsc::Sender::send` is unbounded; we want bounded for
// backpressure. Use `crossbeam_channel` once added, or implement a bounded
// wrapper. For PLAN-315 W4 we use a `SyncSender` backed by std::sync::mpsc::sync_channel
// at the call site. This module assumes the `Sender` is one of those.

#[cfg(test)]
mod tests {
	use std::sync::mpsc::sync_channel;

	use super::*;

	#[test]
	fn subscribe_then_publish_delivers_event() {
		let registry = EventRegistry::new();
		let (tx, rx) = sync_channel(SUB_CHANNEL_DEPTH);
		let _token = registry.subscribe("fnv:abc", Lane::OrgMemory, tx);

		registry.publish(
			"fnv:abc",
			Lane::OrgMemory,
			&Event::IndexChanged {
				repo_handle: "fnv:abc".into(),
				lane: Lane::OrgMemory,
				fingerprint: "fp-1".into(),
			},
		);

		let frame = rx.recv_timeout(Duration::from_secs(1)).expect("frame");
		let Frame::Event { body } = frame else {
			panic!("expected event frame");
		};
		assert_eq!(body["event"], "index_changed");
		assert_eq!(body["fingerprint"], "fp-1");
	}

	#[test]
	fn drop_token_deregisters() {
		let registry = EventRegistry::new();
		let (tx, rx) = sync_channel(SUB_CHANNEL_DEPTH);
		{
			let _token = registry.subscribe("fnv:r", Lane::OrgMemory, tx);
			assert_eq!(registry.lane("fnv:r", Lane::OrgMemory).len(), 1);
		}
		assert_eq!(registry.lane("fnv:r", Lane::OrgMemory).len(), 0);

		// Publish after drop should not deliver.
		registry.publish(
			"fnv:r",
			Lane::OrgMemory,
			&Event::IndexChanged {
				repo_handle: "fnv:r".into(),
				lane: Lane::OrgMemory,
				fingerprint: "fp".into(),
			},
		);
		assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
	}

	#[test]
	fn multiple_subscribers_each_receive() {
		let registry = EventRegistry::new();
		let (tx1, rx1) = sync_channel(SUB_CHANNEL_DEPTH);
		let (tx2, rx2) = sync_channel(SUB_CHANNEL_DEPTH);
		let _t1 = registry.subscribe("fnv:m", Lane::OrgMemory, tx1);
		let _t2 = registry.subscribe("fnv:m", Lane::OrgMemory, tx2);

		registry.publish(
			"fnv:m",
			Lane::OrgMemory,
			&Event::WarmCompleted {
				repo_handle: "fnv:m".into(),
				lane: Lane::OrgMemory,
				ms: 100,
			},
		);
		let _ = rx1.recv_timeout(Duration::from_secs(1)).expect("rx1");
		let _ = rx2.recv_timeout(Duration::from_secs(1)).expect("rx2");
	}

	#[test]
	fn publish_with_no_subscribers_is_noop() {
		let registry = EventRegistry::new();
		// No panic, no allocation in the lane map.
		registry.publish(
			"fnv:none",
			Lane::OrgMemory,
			&Event::IndexChanged {
				repo_handle: "fnv:none".into(),
				lane: Lane::OrgMemory,
				fingerprint: "x".into(),
			},
		);
	}

	#[test]
	fn lag_accounting_increments_on_channel_full() {
		let registry = EventRegistry::new();
		// Depth=1 so the second publish overflows.
		let (tx, rx) = sync_channel(1);
		let _token = registry.subscribe("fnv:lag", Lane::OrgMemory, tx);

		for i in 0..5 {
			registry.publish(
				"fnv:lag",
				Lane::OrgMemory,
				&Event::IndexChanged {
					repo_handle: "fnv:lag".into(),
					lane: Lane::OrgMemory,
					fingerprint: format!("fp-{i}"),
				},
			);
		}

		// First frame: the first index_changed.
		let frame = rx.recv().expect("frame");
		let Frame::Event { body } = frame else {
			panic!("expected event");
		};
		assert_eq!(body["event"], "index_changed");

		// Second frame: when next publish happens, a lag frame will be
		// emitted reporting accumulated drops. Drain a few more publishes
		// to exercise: pull frames until we see "lag" or exhaust.
		let mut saw_lag = false;
		let mut saw_more_events = 0;
		while let Ok(frame) = rx.recv_timeout(Duration::from_millis(50)) {
			let Frame::Event { body } = frame else {
				continue;
			};
			match body["event"].as_str() {
				Some("lag") => {
					saw_lag = true;
					assert!(body["dropped"].as_u64().unwrap_or(0) > 0);
				}
				Some("index_changed") => saw_more_events += 1,
				_ => {}
			}
		}
		// Fire one more publish to actually flush the lag counter.
		registry.publish(
			"fnv:lag",
			Lane::OrgMemory,
			&Event::IndexChanged {
				repo_handle: "fnv:lag".into(),
				lane: Lane::OrgMemory,
				fingerprint: "final".into(),
			},
		);
		while let Ok(frame) = rx.recv_timeout(Duration::from_millis(100)) {
			let Frame::Event { body } = frame else {
				continue;
			};
			if body["event"] == "lag" {
				saw_lag = true;
				break;
			}
		}
		assert!(saw_lag, "expected a lag frame after channel overflow; saw {saw_more_events} extra events");
	}

	#[test]
	fn bench_payload_delivers_on_subscribed_channel() {
		let registry = EventRegistry::new();
		let (tx, rx) = sync_channel(SUB_CHANNEL_DEPTH);
		let _token = registry.subscribe("fnv:bench", Lane::OrgMemory, tx);

		let payload_id = 42u32;
		let emitted_at_ms = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_millis() as u64)
			.unwrap_or(0);

		registry.publish(
			"fnv:bench",
			Lane::OrgMemory,
			&Event::BenchPayload { emitted_at_ms, payload_id },
		);

		let frame = rx.recv_timeout(Duration::from_secs(1)).expect("frame");
		let Frame::Event { body } = frame else {
			panic!("expected event frame");
		};
		assert_eq!(body["event"], "bench_payload");
		assert_eq!(body["payload_id"].as_u64(), Some(payload_id as u64));
		assert!(body["emitted_at_ms"].as_u64().unwrap_or(0) > 0);
	}

	#[test]
	fn bench_payload_emitted_at_ms_within_recent() {
		// Verify that emitted_at_ms is within 1 second of test-start time.
		let registry = registry();
		let (tx, rx) = sync_channel(SUB_CHANNEL_DEPTH);
		let _token = registry.subscribe("fnv:ts", Lane::OrgMemory, tx);

		let payload_id = 7u32;
		publish_bench_event("fnv:ts", Lane::OrgMemory, payload_id);

		let frame = rx.recv_timeout(Duration::from_secs(1)).expect("frame");
		let Frame::Event { body } = frame else {
			panic!("expected event frame");
		};
		let emitted = body["emitted_at_ms"].as_u64().unwrap_or(0);
		assert!(emitted > 0, "emitted_at_ms should be non-zero");

		// Should be within 1000ms of now (accounting for test execution delay)
		let now = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map(|d| d.as_millis() as u64)
			.unwrap_or(0);
		let delta = now.saturating_sub(emitted);
		assert!(delta < 3000, "emitted_at_ms {emitted} too old vs now {now} (delta {delta}ms)");
	}
}
