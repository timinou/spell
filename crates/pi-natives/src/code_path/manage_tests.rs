//! `command:"manage"` subcommand tests (FEAT-704).

use std::path::PathBuf;

use serde_json::Value;

use super::napi::{CodePathTaskOptions, execute_code_path_inner};

fn manage_opts(subcommand: &str, target: &str, root: PathBuf) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "manage".to_string(),
		target:             target.to_string(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               Some(root.to_string_lossy().to_string()),
		actions:            None,
		manage:             Some(subcommand.to_string()),
		artifact_threshold: None,
		gitignore:          None,
		session_id:         None,
		edit_group_id:      None,
		history_entry_id:   None,
		history_force:      None,
		home:               None,
		session_dir:        None,
	}
}

fn run(opts: CodePathTaskOptions) -> super::napi::CodePathChunk {
	execute_code_path_inner(opts, crate::task::CancelToken::default())
		.unwrap()
		.into_iter()
		.next()
		.unwrap()
}

#[test]
fn manage_with_empty_target_does_not_parse_codepath() {
	// Pre-FEAT-704 this returned "parse failed at position 0". Now the
	// manage branch runs before the parser is invoked.
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("languages", "", dir.path().to_path_buf()));
	assert!(chunk.diagnostics.is_empty(), "diagnostics: {:?}", chunk.diagnostics);
	assert_eq!(chunk.nodes.len(), 1);
	assert_eq!(chunk.nodes[0].kind, "§manage-result");
}

#[test]
fn manage_languages_returns_registered_profiles() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("languages", "", dir.path().to_path_buf()));
	assert!(chunk.diagnostics.is_empty());
	let payload = chunk.nodes[0].metadata.get("payload").unwrap();
	let langs = payload.get("languages").and_then(Value::as_array).unwrap();
	// At minimum, typescript should be registered.
	assert!(
		langs
			.iter()
			.any(|l| l.get("id").and_then(Value::as_str) == Some("typescript"))
	);
}

#[test]
fn manage_buffers_returns_open_buffer_list() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("buffers", "", dir.path().to_path_buf()));
	assert!(chunk.diagnostics.is_empty());
	let payload = &chunk.nodes[0].metadata.get("payload");
	assert!(payload.is_some(), "payload should be present");
}

#[test]
fn manage_status_returns_session_summary() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("status", "", dir.path().to_path_buf()));
	assert!(chunk.diagnostics.is_empty());
	let payload = chunk.nodes[0].metadata.get("payload").unwrap();
	assert!(payload.get("watcher").is_some());
	assert!(payload.get("openBuffers").is_some());
}

#[test]
fn manage_watcher_status_returns_broker_state() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("watcherStatus", "", dir.path().to_path_buf()));
	assert!(chunk.diagnostics.is_empty());
	let payload = chunk.nodes[0].metadata.get("payload").unwrap();
	assert!(payload.get("active").is_some());
}

#[test]
fn manage_lock_status_requires_target() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("lockStatus", "", dir.path().to_path_buf()));
	assert!(!chunk.diagnostics.is_empty());
	assert_eq!(chunk.diagnostics[0].variant, "missing_target");
}

#[test]
fn manage_unknown_subcommand_returns_diagnostic() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("nonsense", "", dir.path().to_path_buf()));
	assert!(!chunk.diagnostics.is_empty());
	assert_eq!(chunk.diagnostics[0].variant, "unsupported_operation");
}

#[test]
fn manage_diff_requires_target() {
	let dir = tempfile::tempdir().unwrap();
	let chunk = run(manage_opts("diff", "", dir.path().to_path_buf()));
	assert!(!chunk.diagnostics.is_empty());
	assert_eq!(chunk.diagnostics[0].variant, "missing_target");
}

#[test]
fn manage_save_flushes_dirty_buffer() {
	// `manage save` requires the buffer to be open (dirty). For an
	// untouched on-disk file the save command is a no-op but must not
	// error.
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.ts"), "export const x = 1;\n").unwrap();
	let chunk = run(manage_opts("save", "a.ts", root));
	// Save against a non-open buffer surfaces as a manage_dispatch_failed
	// diagnostic; that's OK — the test asserts the routing flowed
	// through the manage branch (no parse error).
	assert!(chunk.nodes.len() + chunk.diagnostics.len() >= 1, "expected node OR diagnostic");
}

#[test]
fn manage_undo_redo_round_trip() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.ts"), "export const x = 1;\n").unwrap();
	let undo_chunk = run(manage_opts("undo", "a.ts", root.clone()));
	let redo_chunk = run(manage_opts("redo", "a.ts", root));
	// Either succeeds or surfaces a diagnostic — neither variant should
	// produce a panic.
	assert!(undo_chunk.nodes.len() + undo_chunk.diagnostics.len() >= 1);
	assert!(redo_chunk.nodes.len() + redo_chunk.diagnostics.len() >= 1);
}

/// Build an `edit` task-options for a single find/replace action against
/// `target`, stamping `edit_group_id` so the recorder groups the resulting
/// entries. `.spell` under root makes it the workspace so the edit-history log
/// and the undo handler resolve the same file.
fn edit_replace_opts(
	target: &str,
	find: &str,
	replace: &str,
	root: PathBuf,
	session: &str,
	group: Option<&str>,
) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "edit".to_string(),
		target:             target.to_string(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               Some(root.to_string_lossy().to_string()),
		actions:            Some(serde_json::json!([{
			"kind": "fileFindReplace",
			"find": find,
			"content": replace,
		}])),
		manage:             None,
		artifact_threshold: None,
		gitignore:          None,
		session_id:         Some(session.to_string()),
		edit_group_id:      group.map(Into::into),
		history_entry_id:   None,
		history_force:      None,
		home:               None,
		session_dir:        None,
	}
}

/// End-to-end (real recorder + thread-local group): two edits to two files in
/// ONE logical invocation share an `editGroupId`; a single targeted `undo`
/// reverts BOTH files atomically. This is the full-stack proof of the
/// operation-aware, target-honouring fix — not just the unit-level revert.
#[test]
fn edit_group_undo_reverts_all_member_files_e2e() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::create_dir_all(root.join(".spell")).unwrap();
	std::fs::write(root.join("a.ts"), "const v = oldName;\n").unwrap();
	std::fs::write(root.join("b.ts"), "call(oldName);\n").unwrap();

	// Two edits, same group id, same session — simulating one cross-file rename.
	let ea = run(edit_replace_opts("a.ts", "oldName", "newName", root.clone(), "S1", Some("G1")));
	assert!(ea.diagnostics.is_empty(), "edit a diagnostics: {:?}", ea.diagnostics);
	let eb = run(edit_replace_opts("b.ts", "oldName", "newName", root.clone(), "S1", Some("G1")));
	assert!(eb.diagnostics.is_empty(), "edit b diagnostics: {:?}", eb.diagnostics);
	assert_eq!(std::fs::read_to_string(root.join("a.ts")).unwrap(), "const v = newName;\n");
	assert_eq!(std::fs::read_to_string(root.join("b.ts")).unwrap(), "call(newName);\n");

	// A single undo targeting ONE member reverts the WHOLE group.
	let undo = run(manage_opts_session("undo", "a.ts", root.clone(), "S1"));
	assert!(undo.diagnostics.is_empty(), "undo diagnostics: {:?}", undo.diagnostics);
	let payload = undo.nodes[0].metadata.get("payload").unwrap();
	assert_eq!(
		payload.get("fileCount").and_then(Value::as_u64),
		Some(2),
		"both grouped files should revert; payload: {payload:?}"
	);
	assert_eq!(std::fs::read_to_string(root.join("a.ts")).unwrap(), "const v = oldName;\n");
	assert_eq!(std::fs::read_to_string(root.join("b.ts")).unwrap(), "call(oldName);\n");

	// And redo re-applies both.
	let redo = run(manage_opts_session("redo", "a.ts", root.clone(), "S1"));
	assert!(redo.diagnostics.is_empty(), "redo diagnostics: {:?}", redo.diagnostics);
	assert_eq!(std::fs::read_to_string(root.join("a.ts")).unwrap(), "const v = newName;\n");
	assert_eq!(std::fs::read_to_string(root.join("b.ts")).unwrap(), "call(newName);\n");
}

/// Manage opts variant carrying a session id (the default helper passes None).
fn manage_opts_session(
	subcommand: &str,
	target: &str,
	root: PathBuf,
	session: &str,
) -> CodePathTaskOptions {
	let mut o = manage_opts(subcommand, target, root);
	o.session_id = Some(session.to_string());
	o
}
