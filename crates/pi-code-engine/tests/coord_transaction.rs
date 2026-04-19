mod common;

use std::{
	collections::hash_map::DefaultHasher,
	hash::{Hash, Hasher},
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use common::{TestBroker, TestClient};
use pi_code_engine::{
	BrokerEndpoint, BufferRegistry, CodeBuffer, CodeEngineError, JournalEntry, JournalReader,
	LanguageRegistry, SocketCoordClient, TextEdit, default_journal_root, journal_path_for,
};
use pi_edit_broker::{ClientMessage, ServerMessage};
use tokio::time::sleep;

fn registry() -> Arc<LanguageRegistry> {
	Arc::new(LanguageRegistry::with_builtins().expect("registry"))
}

fn registry_with_socket(socket: &Path, session_id: &str) -> BufferRegistry {
	let mut endpoint = BrokerEndpoint::new(socket.to_path_buf(), session_id.to_string());
	endpoint.budget = Duration::from_secs(1);
	BufferRegistry::new_with_coord(registry(), None, Arc::new(SocketCoordClient::new(endpoint)))
}

fn write_source(root: &Path, relative: &str, source: &str) -> PathBuf {
	let path = root.join(relative);
	std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
	std::fs::write(&path, source).expect("write source");
	path
}

fn replace_once(
	buffer: &mut CodeBuffer,
	needle: &str,
	replacement: &str,
) -> pi_code_engine::Result<()> {
	let source = buffer.source();
	let start = source.find(needle).expect("needle present");
	let end = start + needle.len();
	buffer.edit(TextEdit {
		start_byte:   start,
		old_end_byte: end,
		new_text:     replacement.to_string(),
	})?;
	Ok(())
}

fn journal_tail_for(path: &Path) -> Vec<JournalEntry> {
	let repo_root = path
		.parent()
		.and_then(Path::parent)
		.unwrap_or_else(|| path.parent().expect("repo root"));
	let journal_path = journal_path_for(&default_journal_root(), repo_root, path);
	JournalReader::tail(&journal_path, 16).expect("journal tail")
}

fn advisory_lock_path(path: &Path) -> PathBuf {
	let mut hasher = DefaultHasher::new();
	path.hash(&mut hasher);
	std::env::temp_dir()
		.join("pi-code-engine-locks")
		.join(format!("{:016x}.lock", hasher.finish()))
}

const HANDLE_PATH: &str = "::Server.handle#body";
const DISPATCH_PATH: &str = "::Server.dispatch#body";
const RENDER_PATH: &str = "::Server.render#body";
const SAMPLE_SOURCE: &str = "class Server {\n  handle() {\n    return \"handle\";\n  }\n\n  \
                             dispatch() {\n    return \"dispatch\";\n  }\n\n  render() {\n    \
                             return \"render\";\n  }\n}\n";

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_reloads_when_peer_committed_between_reads() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg_a = registry_with_socket(&broker.socket_path, "s1");
	let reg_b = registry_with_socket(&broker.socket_path, "s2");

	let _ = reg_a.open(&path).expect("open stale buffer");
	reg_b
		.edit_transaction("s2", &path, &[DISPATCH_PATH.into()], |buffer| {
			replace_once(buffer, "\"dispatch\"", "\"dispatch-peer\"")?;
			Ok(())
		})
		.expect("peer commit");

	reg_a
		.edit_transaction("s1", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-local\"")?;
			Ok(())
		})
		.expect("local commit");

	let source = std::fs::read_to_string(&path).expect("read file");
	assert!(source.contains("handle-local"));
	assert!(source.contains("dispatch-peer"));
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_surfaces_peer_conflict_on_overlapping_intent() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg_b = registry_with_socket(&broker.socket_path, "s2");
	let mut holder = TestClient::connect(&broker.socket_path, "s1").await;
	let _ = holder.hello(broker.workspace_root()).await;
	holder
		.send(&ClientMessage::Intent {
			file:          path.clone(),
			code_paths:    vec![HANDLE_PATH.into()],
			base_revision: 0,
			ttl_ms:        5_000,
		})
		.await;
	let _ = holder.recv().await.expect("intent ack");

	let error = reg_b
		.edit_transaction("s2", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-b\"")?;
			Ok(())
		})
		.expect_err("peer conflict");
	match error {
		CodeEngineError::PeerConflict { session, code_path, .. } => {
			assert_eq!(session, "s1");
			assert_eq!(code_path, HANDLE_PATH);
		},
		other => panic!("expected PeerConflict, got {other:?}"),
	}
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_succeeds_when_peer_touched_different_node() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg_a = registry_with_socket(&broker.socket_path, "s1");
	let reg_b = registry_with_socket(&broker.socket_path, "s2");

	let (first, ()) = reg_a
		.edit_transaction("s1", &path, &[DISPATCH_PATH.into()], |buffer| {
			replace_once(buffer, "\"dispatch\"", "\"dispatch-a\"")?;
			Ok(())
		})
		.expect("first commit");
	let (second, ()) = reg_b
		.edit_transaction("s2", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-b\"")?;
			Ok(())
		})
		.expect("second commit");

	assert_eq!(second.parent_revision, first.revision);
	let source = std::fs::read_to_string(&path).expect("read file");
	assert!(source.contains("dispatch-a"));
	assert!(source.contains("handle-b"));
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_emits_journal_entry_on_success() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg = registry_with_socket(&broker.socket_path, "s1");

	let (outcome, ()) = reg
		.edit_transaction("s1", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-journal\"")?;
			Ok(())
		})
		.expect("commit");

	let tail = journal_tail_for(&path);
	assert_eq!(tail.len(), 1);
	assert_eq!(tail[0].session_id, "s1");
	assert_eq!(tail[0].revision, outcome.revision);
	assert_eq!(tail[0].code_paths, vec![HANDLE_PATH.to_string()]);
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_broadcasts_to_subscribers() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg = registry_with_socket(&broker.socket_path, "s2");
	let mut subscriber = TestClient::connect(&broker.socket_path, "s1").await;
	let _ = subscriber.hello(broker.workspace_root()).await;
	subscriber
		.send(&ClientMessage::Subscribe { files: vec![path.clone()] })
		.await;
	sleep(Duration::from_millis(50)).await;

	reg.edit_transaction("s2", &path, &[DISPATCH_PATH.into()], |buffer| {
		replace_once(buffer, "\"dispatch\"", "\"dispatch-peer\"")?;
		Ok(())
	})
	.expect("commit");

	let mut committed: Option<(String, u64)> = None;
	for _ in 0..4 {
		match subscriber.recv_within(Duration::from_millis(500)).await {
			Some(ServerMessage::PeerCommitted { session_id, revision, .. }) => {
				committed = Some((session_id, revision));
				break;
			},
			Some(ServerMessage::PeerJoined { .. } | ServerMessage::PeerLeft { .. }) => {},
			Some(other) => panic!("unexpected broker message {other:?}"),
			None => break,
		}
	}
	let (session_id, revision) = committed.expect("peer committed");
	assert_eq!(session_id, "s2");
	assert!(revision >= 1);
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cached_buffer_invalidated_on_peer_commit() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg_a = registry_with_socket(&broker.socket_path, "s1");
	let reg_b = registry_with_socket(&broker.socket_path, "s2");

	let before = reg_a.open(&path).expect("initial open");
	assert!(before.lock().source().contains("dispatch"));

	reg_b
		.edit_transaction("s2", &path, &[DISPATCH_PATH.into()], |buffer| {
			replace_once(buffer, "\"dispatch\"", "\"dispatch-new\"")?;
			Ok(())
		})
		.expect("peer commit");

	let after = reg_a.open(&path).expect("reload open");
	assert!(!Arc::ptr_eq(&before, &after));
	assert!(after.lock().source().contains("dispatch-new"));
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_handles_broker_down_gracefully() {
	let temp = tempfile::tempdir().expect("tempdir");
	let path = write_source(temp.path(), "src/server.ts", SAMPLE_SOURCE);
	let missing_socket = temp.path().join("missing.sock");
	let reg = registry_with_socket(&missing_socket, "s1");

	let (outcome, ()) = reg
		.edit_transaction("s1", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-offline\"")?;
			Ok(())
		})
		.expect("offline commit still succeeds");

	assert!(
		std::fs::read_to_string(&path)
			.expect("read file")
			.contains("handle-offline")
	);
	assert!(!outcome.warnings.is_empty(), "offline path should report a warning");
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_lock_timeout_returns_structured_error() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg = registry_with_socket(&broker.socket_path, "s1");

	let lock_path = advisory_lock_path(&path);
	std::fs::create_dir_all(lock_path.parent().expect("lock dir")).expect("mkdir lock dir");
	let file = std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.open(&lock_path)
		.expect("open lock file");
	let mut lock = fd_lock::RwLock::new(file);
	let _guard = lock.try_write().expect("hold exclusive lock");

	let error = reg
		.edit_transaction("s1", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-timeout\"")?;
			Ok(())
		})
		.expect_err("lock timeout");
	match error {
		CodeEngineError::LockTimeout { path: locked, .. } => assert_eq!(locked, path),
		other => panic!("expected LockTimeout, got {other:?}"),
	}
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_is_idempotent_on_retry_after_conflict() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg = registry_with_socket(&broker.socket_path, "s2");
	let mut holder = TestClient::connect(&broker.socket_path, "s1").await;
	let _ = holder.hello(broker.workspace_root()).await;
	holder
		.send(&ClientMessage::Intent {
			file:          path.clone(),
			code_paths:    vec![HANDLE_PATH.into()],
			base_revision: 0,
			ttl_ms:        5_000,
		})
		.await;
	let _ = holder.recv().await.expect("intent ack");

	let first = reg
		.edit_transaction("s2", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-retry\"")?;
			Ok(())
		})
		.expect_err("initial conflict");
	assert!(matches!(first, CodeEngineError::PeerConflict { .. }));
	holder.send(&ClientMessage::Bye).await;
	sleep(Duration::from_millis(50)).await;

	reg.edit_transaction("s2", &path, &[HANDLE_PATH.into()], |buffer| {
		replace_once(buffer, "\"handle\"", "\"handle-retry\"")?;
		Ok(())
	})
	.expect("retry succeeds");

	let source = std::fs::read_to_string(&path).expect("read file");
	assert!(source.contains("handle-retry"));
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn batch_edit_transaction_attributes_all_nodes() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg = registry_with_socket(&broker.socket_path, "s1");
	let code_paths =
		vec![HANDLE_PATH.to_string(), DISPATCH_PATH.to_string(), RENDER_PATH.to_string()];

	reg.edit_transaction("s1", &path, &code_paths, |buffer| {
		replace_once(buffer, "\"handle\"", "\"handle-1\"")?;
		replace_once(buffer, "\"dispatch\"", "\"dispatch-2\"")?;
		replace_once(buffer, "\"render\"", "\"render-3\"")?;
		Ok(())
	})
	.expect("batch commit");

	let tail = journal_tail_for(&path);
	assert_eq!(tail[0].code_paths.len(), 3);
	assert_eq!(tail[0].code_paths, code_paths);
	broker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_transaction_records_parent_revision_from_last_own_commit() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg = registry_with_socket(&broker.socket_path, "s1");

	let (first, ()) = reg
		.edit_transaction("s1", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-parent\"")?;
			Ok(())
		})
		.expect("first commit");
	let (second, ()) = reg
		.edit_transaction("s1", &path, &[DISPATCH_PATH.into()], |buffer| {
			replace_once(buffer, "\"dispatch\"", "\"dispatch-parent\"")?;
			Ok(())
		})
		.expect("second commit");

	assert_eq!(second.parent_revision, first.revision);
	let tail = journal_tail_for(&path);
	assert_eq!(tail[0].parent_revision, Some(first.revision));
	broker.shutdown().await;
}
