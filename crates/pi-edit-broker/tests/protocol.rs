//! Protocol correctness tests — scenarios 4, 5, 6, 8, 11.

mod common;

use std::{path::PathBuf, time::Duration};

use common::{TestBroker, TestClient};
use pi_edit_broker::{ClientMessage, ServerMessage};
use tokio::{io::AsyncWriteExt, time::sleep};

/// Scenario 4: First intent on an unclaimed node is granted.
#[tokio::test]
async fn intent_grant_on_unclaimed_node() {
	let broker = TestBroker::start().await;
	let mut a = TestClient::connect(&broker.socket_path, "s1").await;
	a.hello(std::process::id()).await;
	a.send(&ClientMessage::Intent {
		file:          PathBuf::from("/tmp/p1.ts"),
		code_paths:    vec!["::Foo.bar#body".into()],
		base_revision: 41,
		ttl_ms:        5_000,
	})
	.await;
	match a.recv().await.expect("intent_ack") {
		ServerMessage::IntentAck { granted: true, .. } => {},
		other => panic!("expected IntentAck granted, got {other:?}"),
	}
	broker.shutdown().await;
}

/// Scenario 5: Second intent on the same node from a peer is rejected.
#[tokio::test]
async fn intent_conflict_when_peer_holds() {
	let broker = TestBroker::start().await;
	let mut a = TestClient::connect(&broker.socket_path, "s1").await;
	a.hello(std::process::id()).await;
	let mut b = TestClient::connect(&broker.socket_path, "s2").await;
	b.hello(std::process::id()).await;
	let _ = a.recv_within(Duration::from_millis(200)).await;

	let file = PathBuf::from("/tmp/p2.ts");
	a.send(&ClientMessage::Intent {
		file:          file.clone(),
		code_paths:    vec!["::Foo.bar#body".into()],
		base_revision: 1,
		ttl_ms:        5_000,
	})
	.await;
	let _ = a.recv().await;

	b.send(&ClientMessage::Intent {
		file,
		code_paths: vec!["::Foo.bar#body".into()],
		base_revision: 1,
		ttl_ms: 5_000,
	})
	.await;
	match b.recv().await.expect("intent_conflict") {
		ServerMessage::IntentConflict { conflicting_session, code_path, .. } => {
			assert_eq!(conflicting_session, "s1");
			assert_eq!(code_path, "::Foo.bar#body");
		},
		other => panic!("expected IntentConflict, got {other:?}"),
	}
	broker.shutdown().await;
}

/// Scenario 6: Expired intents are auto-released.
#[tokio::test]
async fn intent_auto_expires_after_ttl() {
	let broker = TestBroker::start().await;
	let mut a = TestClient::connect(&broker.socket_path, "s1").await;
	a.hello(std::process::id()).await;
	let mut b = TestClient::connect(&broker.socket_path, "s2").await;
	b.hello(std::process::id()).await;
	let _ = a.recv_within(Duration::from_millis(200)).await;

	let file = PathBuf::from("/tmp/p3.ts");
	a.send(&ClientMessage::Intent {
		file:          file.clone(),
		code_paths:    vec!["::Foo.bar#body".into()],
		base_revision: 1,
		ttl_ms:        200,
	})
	.await;
	let _ = a.recv().await;

	// After 300ms the intent must have expired and b's retry should succeed.
	sleep(Duration::from_millis(1_200)).await;
	b.send(&ClientMessage::Intent {
		file,
		code_paths: vec!["::Foo.bar#body".into()],
		base_revision: 1,
		ttl_ms: 5_000,
	})
	.await;
	match b.recv().await.expect("intent_ack") {
		ServerMessage::IntentAck { granted: true, .. } => {},
		other => panic!("expected IntentAck granted after expiry, got {other:?}"),
	}
	broker.shutdown().await;
}

/// Scenario 8: Second commit against the same parent is rejected once the
/// first landed.
#[tokio::test]
async fn commit_conflict_when_parent_outdated() {
	let broker = TestBroker::start().await;
	let mut a = TestClient::connect(&broker.socket_path, "s1").await;
	a.hello(std::process::id()).await;
	let mut b = TestClient::connect(&broker.socket_path, "s2").await;
	b.hello(std::process::id()).await;
	let _ = a.recv_within(Duration::from_millis(200)).await;

	let file = PathBuf::from("/tmp/p4.ts");
	a.send(&ClientMessage::Commit {
		file:            file.clone(),
		revision:        42,
		parent_revision: 41,
		code_paths:      vec!["::foo".into()],
		diff_hash:       "blake3:a".into(),
		byte_len:        16,
	})
	.await;
	let _ = a.recv().await;

	b.send(&ClientMessage::Commit {
		file,
		revision: 43,
		parent_revision: 41, // stale parent
		code_paths: vec!["::foo".into()],
		diff_hash: "blake3:b".into(),
		byte_len: 16,
	})
	.await;
	match b.recv().await.expect("commit_conflict") {
		ServerMessage::CommitConflict { peer_revision, conflicting_session, .. } => {
			assert_eq!(peer_revision, 42);
			assert_eq!(conflicting_session, "s1");
		},
		other => panic!("expected CommitConflict, got {other:?}"),
	}
	broker.shutdown().await;
}

/// Scenario 11: Unknown message type yields an `error` reply and the
/// connection stays alive.
#[tokio::test]
async fn protocol_rejects_unknown_message_type() {
	let broker = TestBroker::start().await;
	let mut a = TestClient::connect(&broker.socket_path, "s1").await;
	a.hello(std::process::id()).await;
	// Send raw JSON bypassing the ClientMessage enum.
	a.writer
		.write_all(b"{\"type\":\"bogus\"}\n")
		.await
		.expect("write bogus");
	match a.recv().await.expect("error reply") {
		ServerMessage::Error { code, .. } => assert_eq!(code, "UNKNOWN_TYPE"),
		other => panic!("expected Error, got {other:?}"),
	}
	// Connection remains alive — subsequent heartbeat does not close it.
	a.send(&ClientMessage::Heartbeat).await;
	sleep(Duration::from_millis(100)).await;
	broker.shutdown().await;
}
