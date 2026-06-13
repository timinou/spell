//! Gate 3 — lock-liveness via owner reclaim (PLAN-334 / P3.5).
//!
//! The decisive property behind the BEAM warm-kernel lock-liveness guarantee:
//! when an owner holding an edit-intent dies, the intent is reclaimed so a
//! second owner can acquire it — no permanent deadlock.
//!
//! For a BEAM mini-session owner this is wired as: a per-owner held connection
//! (a `UnixStream` wrapped in a `ResourceArc`) whose `Drop` (fired by the
//! `:DOWN` monitor when the BEAM process dies) closes the stream → the broker
//! sees the disconnect → its existing `deregister`-on-disconnect (conn.rs:134)
//! frees that owner's intents. This test proves the BROKER end of that path: a
//! dropped client connection reclaims its intents and a second client then
//! acquires the same file. The BEAM-side :DOWN-monitor -> ResourceArc(held-
//! connection) trigger that FIRES this reclaim is wired in beam/pi_kernel_nif
//! (P3.8, broker_reclaim_test.exs); this test proves the broker reclaim end.
//!
//! Why the broker reclaim (not the pid reaper) is the BEAM path: the reaper
//! (reaper.rs) probes liveness via `kill(pid, 0)`, but a killed BEAM *process*
//! shares the node OS pid, so the reaper would see it alive. The owner must be
//! reclaimed via connection-drop, which is exactly what this test exercises.

mod common;

use std::{path::PathBuf, time::Duration};

use common::{TestBroker, TestClient};
use pi_edit_broker::{ClientMessage, ServerMessage};

/// Gate 3: owner A holds an intent; A dies (connection dropped); owner B then
/// acquires the SAME file's intent — proving the dead owner's hold was reclaimed.
#[tokio::test]
async fn dead_owner_intent_is_reclaimed_so_a_new_owner_can_acquire() {
	let broker = TestBroker::start().await;
	let file = PathBuf::from("/tmp/gate3.ts");
	let code_path = "::Widget.render#body".to_string();

	// Owner A connects and claims an intent on the file.
	let mut a = TestClient::connect(&broker.socket_path, "ownerA").await;
	a.hello(std::process::id()).await;
	a.send(&ClientMessage::Intent {
		file:          file.clone(),
		code_paths:    vec![code_path.clone()],
		base_revision: 1,
		ttl_ms:        60_000, // long TTL: prove RECLAIM, not expiry
	})
	.await;
	assert!(
		matches!(a.recv().await, Some(ServerMessage::IntentAck { granted: true, .. })),
		"owner A should be granted the intent",
	);

	// Owner B is rejected while A holds it (baseline: the lock is real).
	let mut b = TestClient::connect(&broker.socket_path, "ownerB").await;
	b.hello(std::process::id()).await;
	let _ = b.recv_within(Duration::from_millis(200)).await; // drain any peer event
	b.send(&ClientMessage::Intent {
		file:          file.clone(),
		code_paths:    vec![code_path.clone()],
		base_revision: 1,
		ttl_ms:        60_000,
	})
	.await;
	match b.recv().await.expect("B should see a conflict while A holds") {
		ServerMessage::IntentConflict { conflicting_session, .. } => {
			assert_eq!(conflicting_session, "ownerA");
		},
		ServerMessage::IntentAck { granted: false, .. } => { /* also a valid rejection */ },
		other => panic!("expected a conflict while A holds, got {other:?}"),
	}

	// ── Owner A DIES: drop its connection (the BEAM :DOWN → ResourceArc Drop). ──
	drop(a);

	// Give the broker a beat to process the disconnect + deregister.
	tokio::time::sleep(Duration::from_millis(200)).await;

	// Owner B retries — the dead owner's intent must have been RECLAIMED, so B
	// is now granted the SAME file's intent. This is the no-deadlock guarantee.
	b.send(&ClientMessage::Intent {
		file:          file.clone(),
		code_paths:    vec![code_path.clone()],
		base_revision: 1,
		ttl_ms:        60_000,
	})
	.await;
	// Skip past any broadcast peer events (e.g. PeerLeft{ownerA}) to find B's ack.
	let granted = loop {
		match b.recv().await.expect("B should get a response after A died") {
			ServerMessage::IntentAck { granted, .. } => break granted,
			ServerMessage::IntentConflict { conflicting_session, .. } => panic!(
				"after owner A died, B must NOT still see a conflict (held by {conflicting_session})",
			),
			_ => continue, // PeerLeft / other broadcast — keep reading
		}
	};
	assert!(
		granted,
		"after owner A died, owner B must acquire the RECLAIMED intent (no deadlock)",
	);

	broker.shutdown().await;
}
