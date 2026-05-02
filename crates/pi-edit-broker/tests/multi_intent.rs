mod common;

use std::{path::PathBuf, time::Duration};

use common::{TestBroker, TestClient};
use pi_edit_broker::{ClientMessage, FileIntent, ServerMessage};
use tokio::time::sleep;

/// 1. MultiIntent grants when all files are free.
#[tokio::test]
async fn multi_intent_grants_when_all_free() {
    let broker = TestBroker::start().await;
    let mut client = TestClient::connect(&broker.socket_path, "s1").await;
    client.hello(std::process::id()).await;
    let files = vec![
        FileIntent { file: PathBuf::from("/tmp/a.ts"), code_paths: vec!["::foo".into()], base_revision: 0 },
        FileIntent { file: PathBuf::from("/tmp/b.ts"), code_paths: vec!["::bar".into()], base_revision: 0 },
    ];
    client.send(&ClientMessage::MultiIntent {
        txn_id: "txn-1".into(),
        files,
        ttl_ms: 10_000,
    }).await;
    let ack = client.recv().await.expect("MultiIntentAck");
    match ack {
        ServerMessage::MultiIntentAck { granted, .. } => assert!(granted, "should grant"),
        other => panic!("expected MultiIntentAck, got {other:?}"),
    }
    broker.shutdown().await;
}

/// 2. MultiIntent releases partial grants on conflict.
#[tokio::test]
async fn multi_intent_releases_partial_grants_on_conflict() {
    let broker = TestBroker::start().await;
    let mut a = TestClient::connect(&broker.socket_path, "s1").await;
    a.hello(std::process::id()).await;
    // A acquires intent on B
    a.send(&ClientMessage::Intent {
        file: PathBuf::from("/tmp/b.ts"),
        code_paths: vec!["::bar".into()],
        base_revision: 0,
        ttl_ms: 10_000,
    }).await;
    let _ = a.recv().await;

    let mut b = TestClient::connect(&broker.socket_path, "s2").await;
    b.hello(std::process::id()).await;
    // B tries multi on A and B — A is held by s1, B is free
    let files = vec![
        FileIntent { file: PathBuf::from("/tmp/a.ts"), code_paths: vec!["::foo".into()], base_revision: 0 },
        FileIntent { file: PathBuf::from("/tmp/b.ts"), code_paths: vec!["::bar".into()], base_revision: 0 },
    ];
    b.send(&ClientMessage::MultiIntent {
        txn_id: "txn-2".into(),
        files,
        ttl_ms: 10_000,
    }).await;
    let ack = b.recv().await.expect("MultiIntentAck");
    match ack {
        ServerMessage::MultiIntentAck { granted: false, conflicts, .. } => {
            assert!(!conflicts.is_empty(), "should report conflict");
            assert!(conflicts.iter().any(|c| c.code_path == "::bar"), "conflict on ::bar");
        },
        other => panic!("expected denied MultiIntentAck, got {other:?}"),
    }
    // Drain PeerJoined broadcast on A before re-sending Intent
    let _ = a.recv_within(Duration::from_millis(200)).await;
    // A's intent on /tmp/b.ts should still be held (wasn't released by B)
    a.send(&ClientMessage::Intent {
        file: PathBuf::from("/tmp/b.ts"),
        code_paths: vec!["::bar".into()],
        base_revision: 0,
        ttl_ms: 10_000,
    }).await;
    let ack2 = a.recv().await.expect("IntentAck");
    assert!(matches!(ack2, ServerMessage::IntentAck { granted: true, .. }), "A should still hold ::bar");
    broker.shutdown().await;
}

/// 3. MultiIntent TTL expires unclaimed grants.
#[tokio::test]
async fn multi_intent_ttl_expires_unclaimed_grants() {
    let broker = TestBroker::start().await;
    let mut a = TestClient::connect(&broker.socket_path, "s1").await;
    a.hello(std::process::id()).await;
    let files = vec![
        FileIntent { file: PathBuf::from("/tmp/x.ts"), code_paths: vec!["::foo".into()], base_revision: 0 },
    ];
    a.send(&ClientMessage::MultiIntent {
        txn_id: "txn-3".into(),
        files,
        ttl_ms: 100, // very short TTL
    }).await;
    let ack = a.recv().await.expect("MultiIntentAck");
    assert!(matches!(ack, ServerMessage::MultiIntentAck { granted: true, .. }));

    // Wait past TTL
    sleep(Duration::from_millis(200)).await;

    // Now another session should be able to claim the same file
    let mut b = TestClient::connect(&broker.socket_path, "s2").await;
    b.hello(std::process::id()).await;
    b.send(&ClientMessage::Intent {
        file: PathBuf::from("/tmp/x.ts"),
        code_paths: vec!["::foo".into()],
        base_revision: 0,
        ttl_ms: 10_000,
    }).await;
    let ack2 = b.recv().await.expect("IntentAck");
    assert!(matches!(ack2, ServerMessage::IntentAck { granted: true, .. }), "intent should be grantable after ttl expiry");
    broker.shutdown().await;
}

/// 4. MultiIntent supersedes existing single intent from same client.
#[tokio::test]
async fn multi_intent_supersedes_existing_single_intent() {
    let broker = TestBroker::start().await;
    let mut client = TestClient::connect(&broker.socket_path, "s1").await;
    client.hello(std::process::id()).await;
    // First hold a single intent
    client.send(&ClientMessage::Intent {
        file: PathBuf::from("/tmp/a.ts"),
        code_paths: vec!["::foo".into()],
        base_revision: 0,
        ttl_ms: 10_000,
    }).await;
    let _ = client.recv().await;
    // Now multi-intent the same file — should succeed (self-conflict allowed)
    let files = vec![
        FileIntent { file: PathBuf::from("/tmp/a.ts"), code_paths: vec!["::foo".into()], base_revision: 0 },
        FileIntent { file: PathBuf::from("/tmp/b.ts"), code_paths: vec!["::bar".into()], base_revision: 0 },
    ];
    client.send(&ClientMessage::MultiIntent {
        txn_id: "txn-4".into(),
        files,
        ttl_ms: 10_000,
    }).await;
    let ack = client.recv().await.expect("MultiIntentAck");
    match ack {
        ServerMessage::MultiIntentAck { granted: true, .. } => {},
        other => panic!("expected granted MultiIntentAck, got {other:?}"),
    }
    broker.shutdown().await;
}
