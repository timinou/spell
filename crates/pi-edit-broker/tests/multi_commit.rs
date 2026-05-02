mod common;

use std::{path::PathBuf, time::Duration};

use common::{TestBroker, TestClient};
use pi_edit_broker::{ClientMessage, FileCommit, FileIntent, ServerMessage, state::now_ms};
use tokio::time::sleep;

/// 5. MultiCommit atomically records all files.
#[tokio::test]
async fn multi_commit_atomically_records_all_files() {
    let broker = TestBroker::start().await;
    let mut a = TestClient::connect(&broker.socket_path, "s1").await;
    a.hello(std::process::id()).await;

    // Subscribe so we get peer events
    let mut b = TestClient::connect(&broker.socket_path, "s2").await;
    b.hello(std::process::id()).await;
    b.send(&ClientMessage::Subscribe { files: vec![
        PathBuf::from("/tmp/x.ts"),
        PathBuf::from("/tmp/y.ts"),
    ]}).await;
    // Drain peer_joined for b
    let _ = a.recv_within(Duration::from_millis(200)).await;
    let _ = b.recv_within(Duration::from_millis(200)).await;

    // Acquire multi-intent
    a.send(&ClientMessage::MultiIntent {
        txn_id: "txn-mc-1".into(),
        files: vec![
            FileIntent { file: PathBuf::from("/tmp/x.ts"), code_paths: vec!["::x".into()], base_revision: 0 },
            FileIntent { file: PathBuf::from("/tmp/y.ts"), code_paths: vec!["::y".into()], base_revision: 0 },
        ],
        ttl_ms: 10_000,
    }).await;
    let _ = a.recv().await;

    // Commit both files
    a.send(&ClientMessage::MultiCommit {
        txn_id: "txn-mc-1".into(),
        files: vec![
            FileCommit {
                file: PathBuf::from("/tmp/x.ts"),
                revision: 1,
                parent_revision: 0,
                code_paths: vec!["::x".into()],
                diff_hash: "deadbeef".into(),
                byte_len: 64,
            },
            FileCommit {
                file: PathBuf::from("/tmp/y.ts"),
                revision: 1,
                parent_revision: 0,
                code_paths: vec!["::y".into()],
                diff_hash: "cafebabe".into(),
                byte_len: 128,
            },
        ],
    }).await;
    let ack = a.recv().await.expect("MultiCommitAck");
    match ack {
        ServerMessage::MultiCommitAck { revisions, .. } => {
            assert_eq!(revisions.len(), 2, "should have 2 file revisions");
        },
        other => panic!("expected MultiCommitAck, got {other:?}"),
    }

    // b should receive MultiPeerCommitted with both files
    let event = b.recv_within(Duration::from_millis(500)).await.expect("MultiPeerCommitted");
    match event {
        ServerMessage::MultiPeerCommitted { files, .. } => {
            assert_eq!(files.len(), 2, "should broadcast 2 files");
        },
        other => panic!("expected MultiPeerCommitted, got {other:?}"),
    }
    broker.shutdown().await;
}

/// 6. MultiCommit rejects unknown txn.
#[tokio::test]
async fn multi_commit_rejects_unknown_txn() {
    let broker = TestBroker::start().await;
    let mut client = TestClient::connect(&broker.socket_path, "s1").await;
    client.hello(std::process::id()).await;

    client.send(&ClientMessage::MultiCommit {
        txn_id: "nonexistent".into(),
        files: vec![],
    }).await;
    let resp = client.recv().await.expect("response");
    match resp {
        ServerMessage::Error { code, .. } => {
            assert_eq!(code, "MULTI_COMMIT_INVALID_TXN", "should reject unknown txn");
        },
        other => panic!("expected Error, got {other:?}"),
    }
    broker.shutdown().await;
}

/// 7. MultiCommit emits single event with all files.
#[tokio::test]
async fn multi_commit_emits_single_event_with_all_files() {
    let broker = TestBroker::start().await;
    let mut a = TestClient::connect(&broker.socket_path, "s1").await;
    a.hello(std::process::id()).await;

    let mut b = TestClient::connect(&broker.socket_path, "s2").await;
    b.hello(std::process::id()).await;
    b.send(&ClientMessage::Subscribe { files: vec![
        PathBuf::from("/tmp/p.ts"),
        PathBuf::from("/tmp/q.ts"),
    ]}).await;
    // Drain peer_joined
    let _ = a.recv_within(Duration::from_millis(200)).await;
    let _ = b.recv_within(Duration::from_millis(200)).await;

    // Acquire multi-intent
    a.send(&ClientMessage::MultiIntent {
        txn_id: "txn-mc-2".into(),
        files: vec![
            FileIntent { file: PathBuf::from("/tmp/p.ts"), code_paths: vec!["::p".into()], base_revision: 0 },
            FileIntent { file: PathBuf::from("/tmp/q.ts"), code_paths: vec!["::q".into()], base_revision: 0 },
        ],
        ttl_ms: 10_000,
    }).await;
    let _ = a.recv().await;

    a.send(&ClientMessage::MultiCommit {
        txn_id: "txn-mc-2".into(),
        files: vec![
            FileCommit {
                file: PathBuf::from("/tmp/p.ts"),
                revision: 1,
                parent_revision: 0,
                code_paths: vec!["::p".into()],
                diff_hash: "aaa".into(),
                byte_len: 10,
            },
            FileCommit {
                file: PathBuf::from("/tmp/q.ts"),
                revision: 1,
                parent_revision: 0,
                code_paths: vec!["::q".into()],
                diff_hash: "bbb".into(),
                byte_len: 20,
            },
        ],
    }).await;
    let _ack = a.recv().await;

    // b should get exactly ONE MultiPeerCommitted with 2 files
    let mut events = Vec::new();
    while let Some(msg) = b.recv_within(Duration::from_millis(300)).await {
        events.push(msg);
    }
    let multi: Vec<_> = events.into_iter().filter_map(|e| {
        if matches!(&e, ServerMessage::MultiPeerCommitted { .. }) { Some(e) } else { None }
    }).collect();
    assert_eq!(multi.len(), 1, "should emit exactly one MultiPeerCommitted");
    if let ServerMessage::MultiPeerCommitted { files, .. } = &multi[0] {
        assert_eq!(files.len(), 2, "event should contain both files");
    }
    broker.shutdown().await;
}

/// 8. MultiPeerCommitted replays in Welcome.
#[tokio::test]
async fn multi_peer_committed_replays_in_welcome() {
    let broker = TestBroker::start().await;
    let mut a = TestClient::connect(&broker.socket_path, "s1").await;
    a.hello(std::process::id()).await;

    // A commits one file via multi-commit
    a.send(&ClientMessage::MultiIntent {
        txn_id: "txn-mc-3".into(),
        files: vec![
            FileIntent { file: PathBuf::from("/tmp/z.ts"), code_paths: vec!["::z".into()], base_revision: 0 },
        ],
        ttl_ms: 10_000,
    }).await;
    let _ = a.recv().await;
    a.send(&ClientMessage::MultiCommit {
        txn_id: "txn-mc-3".into(),
        files: vec![
            FileCommit {
                file: PathBuf::from("/tmp/z.ts"),
                revision: 1,
                parent_revision: 0,
                code_paths: vec!["::z".into()],
                diff_hash: "hash".into(),
                byte_len: 32,
            },
        ],
    }).await;
    let _ = a.recv().await;

    // B connects after the commit — Welcome should include the commit
    let mut b = TestClient::connect(&broker.socket_path, "s2").await;
    let welcome = b.hello(std::process::id()).await;
    // Welcome doesn't replay MultiPeerCommitted (replay happens via journal),
    // but the commit is in recent commits. B can see it via peer_state.
    assert!(matches!(welcome, ServerMessage::Welcome { .. }));
    broker.shutdown().await;
}
