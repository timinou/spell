mod common;

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use common::TestBroker;
use pi_code_engine::{
	BufferRegistry, CodeBuffer, JournalEntry, JournalReader, LanguageRegistry, SocketCoordClient,
	TextEdit, default_journal_root, journal_path_for,
};

fn registry_with_socket(socket: &Path, session_id: &str) -> BufferRegistry {
	let mut endpoint =
		pi_code_engine::BrokerEndpoint::new(socket.to_path_buf(), session_id.to_string());
	endpoint.budget = Duration::from_secs(1);
	BufferRegistry::new_with_coord(
		Arc::new(LanguageRegistry::with_builtins().expect("registry")),
		None,
		Arc::new(SocketCoordClient::new(endpoint)),
	)
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

const HANDLE_PATH: &str = "::Server.handle#body";
const DISPATCH_PATH: &str = "::Server.dispatch#body";
const SAMPLE_SOURCE: &str = "class Server {\n  handle() {\n    return \"handle\";\n  }\n\n  \
                             dispatch() {\n    return \"dispatch\";\n  }\n}\n";

#[tokio::test(flavor = "multi_thread")]
async fn two_session_disjoint_edits_share_broker_and_journal() {
	let broker = TestBroker::start().await;
	let path = write_source(broker.workspace_root(), "src/server.ts", SAMPLE_SOURCE);
	let reg_a = registry_with_socket(&broker.socket_path, "s1");
	let reg_b = registry_with_socket(&broker.socket_path, "s2");

	let (first, ()) = reg_a
		.edit_transaction("s1", &path, &[HANDLE_PATH.into()], |buffer| {
			replace_once(buffer, "\"handle\"", "\"handle-a\"")?;
			Ok(())
		})
		.expect("first commit");
	let (second, ()) = reg_b
		.edit_transaction("s2", &path, &[DISPATCH_PATH.into()], |buffer| {
			replace_once(buffer, "\"dispatch\"", "\"dispatch-b\"")?;
			Ok(())
		})
		.expect("second commit");

	assert!(first.revision < second.revision);

	let tail = journal_tail_for(&path);
	assert_eq!(tail.len(), 2);
	assert_eq!(tail[0].session_id, "s2");
	assert_eq!(tail[0].revision, second.revision);
	assert_eq!(tail[1].session_id, "s1");
	assert_eq!(tail[1].revision, first.revision);
	assert!(tail[1].revision < tail[0].revision);

	let source = std::fs::read_to_string(&path).expect("read file");
	assert!(source.contains("handle-a"));
	assert!(source.contains("dispatch-b"));
	broker.shutdown().await;
}
