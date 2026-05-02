mod common;

use std::{
    path::PathBuf,
    time::Duration,
};

use tempfile::TempDir;

use common::{TestBroker, TestClient};
use pi_edit_broker::{
    BrokerOptions, ClientMessage, ServerMessage, run_server,
    state::now_ms, txn_journal::{self, TxnJournalEntry},
};
use tokio::time::sleep;
/// Helper: start broker with a journal for recovery tests.
async fn start_with_journal(temp: &TempDir) -> TestBroker {
    let socket_path = temp.path().join("edit-broker.sock");
    let journal_path = temp.path().join("txn-journal.jsonl");
    let opts = BrokerOptions {
        socket_path: socket_path.clone(),
        grace: Duration::from_secs(1),
        broadcast_capacity: 256,
        journal_path: Some(journal_path),
    };
    let broker = TestBroker::start_with(Duration::from_secs(1), socket_path.clone(), opts).await;
    broker
}

/// 9. Broker restart replays complete journal entry.
#[tokio::test]
async fn broker_restart_replays_complete_journal_entry() {
    let temp = tempfile::tempdir().expect("tempdir");
    let socket_path = temp.path().join("edit-broker.sock");
    let journal_path = temp.path().join("txn-journal.jsonl");
    let opts = BrokerOptions {
        socket_path: socket_path.clone(),
        grace: Duration::from_secs(1),
        broadcast_capacity: 256,
        journal_path: Some(journal_path.clone()),
    };
    // Write a complete txn to the journal
    let now = now_ms();
    txn_journal::append_entry(&journal_path, &TxnJournalEntry::TxnStarted {
        txn_id: "txn-rec-1".into(),
        session_id: "s1".into(),
        files: vec![(PathBuf::from("/tmp/a.ts"), 0)],
        started_at: now,
    }).expect("append started");
    txn_journal::append_entry(&journal_path, &TxnJournalEntry::TxnCommitted {
        txn_id: "txn-rec-1".into(),
        files: vec![(PathBuf::from("/tmp/a.ts"), 1)],
        ts: now,
    }).expect("append committed");

    // Start broker — should replay successfully (no incomplete txns)
    let handle = tokio::spawn(async move {
        run_server(opts).await.expect("broker exits cleanly");
    });
    sleep(Duration::from_millis(300)).await;

    // Connect and verify nothing is amiss
    let mut client = TestClient::connect(&socket_path, "s2").await;
    client.hello(std::process::id()).await;

    // Txn was completed, so new client should be able to hold the same file
    client.send(&ClientMessage::Intent {
        file: PathBuf::from("/tmp/a.ts"),
        code_paths: vec!["::a".into()],
        base_revision: 0,
        ttl_ms: 10_000,
    }).await;
    let ack = client.recv().await.expect("IntentAck");
    assert!(matches!(ack, ServerMessage::IntentAck { granted: true, .. }),
        "completed txn should not block new intents");

    handle.abort();
}

/// 10. Broker restart rolls back incomplete journal entry.
#[tokio::test]
async fn broker_restart_rolls_back_incomplete_journal_entry() {
    let temp = tempfile::tempdir().expect("tempdir");
    let socket_path = temp.path().join("edit-broker.sock");
    let journal_path = temp.path().join("txn-journal.jsonl");
    let opts = BrokerOptions {
        socket_path: socket_path.clone(),
        grace: Duration::from_secs(1),
        broadcast_capacity: 256,
        journal_path: Some(journal_path.clone()),
    };
    // Write ONLY TxnStarted — no TxnCommitted
    let now = now_ms();
    txn_journal::append_entry(&journal_path, &TxnJournalEntry::TxnStarted {
        txn_id: "txn-rec-2".into(),
        session_id: "s1".into(),
        files: vec![(PathBuf::from("/tmp/b.ts"), 0)],
        started_at: now,
    }).expect("append started");

    // Start broker — should roll back the incomplete txn
    let handle = tokio::spawn(async move {
        run_server(opts).await.expect("broker exits cleanly");
    });
    sleep(Duration::from_millis(300)).await;

    // Verify journal now has a rollback entry
    let replay = txn_journal::replay_journal(&journal_path).expect("replay");
    assert!(replay.completed_txns.contains("txn-rec-2"),
        "incomplete txn should be marked as completed (rolled back)");

    // File should be free
    let mut client = TestClient::connect(&socket_path, "s2").await;
    client.hello(std::process::id()).await;
    client.send(&ClientMessage::Intent {
        file: PathBuf::from("/tmp/b.ts"),
        code_paths: vec!["::b".into()],
        base_revision: 0,
        ttl_ms: 10_000,
    }).await;
    let ack = client.recv().await.expect("IntentAck");
    assert!(matches!(ack, ServerMessage::IntentAck { granted: true, .. }),
        "rolled-back txn should not block intents");

    handle.abort();
}

/// 11. Journal replay segregates completed vs incomplete.
#[tokio::test]
async fn journal_replay_segregates_completed_vs_incomplete() {
    let temp = tempfile::tempdir().expect("tempdir");
    let journal_path = temp.path().join("txn-journal.jsonl");
    let now = now_ms();

    // Write 2 completed txns and 1 incomplete
    for i in 1..=2 {
        txn_journal::append_entry(&journal_path, &TxnJournalEntry::TxnStarted {
            txn_id: format!("txn-complete-{i}"),
            session_id: "s1".into(),
            files: vec![],
            started_at: now,
        }).expect("append");
        txn_journal::append_entry(&journal_path, &TxnJournalEntry::TxnCommitted {
            txn_id: format!("txn-complete-{i}"),
            files: vec![(PathBuf::from("/tmp/c.ts"), 1)],
            ts: now,
        }).expect("append");
    }
    txn_journal::append_entry(&journal_path, &TxnJournalEntry::TxnStarted {
        txn_id: "txn-incomplete-1".into(),
        session_id: "s2".into(),
        files: vec![(PathBuf::from("/tmp/d.ts"), 0)],
        started_at: now,
    }).expect("append");

    let replay = txn_journal::replay_journal(&journal_path).expect("replay");
    assert_eq!(replay.completed_txns.len(), 2);
    assert_eq!(replay.incomplete_txns.len(), 1);
    assert!(replay.completed_txns.contains("txn-complete-1"));
    assert!(replay.completed_txns.contains("txn-complete-2"));
    assert!(replay.incomplete_txns.contains_key("txn-incomplete-1"));
}
