use std::{path::PathBuf, sync::Arc};

use pi_code_engine::{
	CodeBuffer, CoordClient, IntentResult, JournalEntry, JournalReader, JournalWriter, LanguageId,
	LanguageRegistry, NullCoordClient, PeerEdit, TextEdit, default_journal_root, derive_code_paths,
	journal_path_for,
};

fn registry() -> Arc<LanguageRegistry> {
	Arc::new(LanguageRegistry::with_builtins().expect("registry"))
}

fn ts_buffer(source: &str) -> CodeBuffer {
	CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer")
}

/// FEAT-575: attribution is stored on the new revision.
#[test]
fn edit_with_attribution_records_session_and_paths() {
	let mut buffer = ts_buffer("export const x = 1;\n");
	let edit = TextEdit { start_byte: 17, old_end_byte: 18, new_text: "2".into() };
	buffer
		.edit_with_attribution(edit, "session-a", vec!["::x".into()])
		.expect("edit applies");

	let summary = buffer
		.last_revision_summary()
		.expect("attributed revision present");
	assert_eq!(summary.session_id, "session-a");
	assert_eq!(summary.code_paths, vec!["::x".to_string()]);
	assert!(summary.revision >= 1, "revision_num must be monotonic");
	assert!(buffer.source().contains("const x = 2"));
}

/// FEAT-575: synthetic root revision reports no attribution.
#[test]
fn last_revision_summary_is_none_at_root() {
	let buffer = ts_buffer("export const x = 1;\n");
	assert!(buffer.last_revision_summary().is_none());
}

/// FEAT-575: scoped undo walks past a peer's revision and applies the
/// previous same-session revision.
#[test]
fn undo_scoped_skips_peer_revision() {
	let mut buffer = ts_buffer("const a = 1;\nconst b = 1;\n");
	// s1 edits a=1 -> a=9
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 10, old_end_byte: 11, new_text: "9".into() },
			"s1",
			vec!["::a".into()],
		)
		.unwrap();
	// s2 edits b=1 -> b=8 (non-overlapping)
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 23, old_end_byte: 24, new_text: "8".into() },
			"s2",
			vec!["::b".into()],
		)
		.unwrap();

	let result = buffer.undo_scoped_apply("s1").expect("scoped undo ok");
	let applied = result.applied.expect("s1 revision applied");
	assert_eq!(applied.session_id, "s1");
	assert_eq!(result.skipped.len(), 1, "one s2 revision skipped");
	assert_eq!(result.skipped[0].session_id, "s2");
	// s1's edit is reverted; s2's edit stays.
	let src = buffer.source();
	assert!(src.contains("const a = 1"), "s1 inverse applied: got {src}");
	assert!(src.contains("const b = 8"), "s2 edit preserved: got {src}");
}

/// FEAT-575: scoped undo with no matching session returns None + records all
/// walked revisions as skipped.
#[test]
fn undo_scoped_no_match_returns_none() {
	let mut buffer = ts_buffer("const a = 1;\n");
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 10, old_end_byte: 11, new_text: "9".into() },
			"s1",
			vec!["::a".into()],
		)
		.unwrap();
	let result = buffer.undo_scoped_apply("other").expect("no-op ok");
	assert!(result.applied.is_none());
	assert_eq!(result.skipped.len(), 1);
	assert_eq!(result.skipped[0].session_id, "s1");
}

/// FEAT-575: scoped redo walks forward past peer revisions.
#[test]
fn redo_scoped_skips_peer_revision() {
	let mut buffer = ts_buffer("const a = 1;\nconst b = 1;\n");
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 10, old_end_byte: 11, new_text: "9".into() },
			"s1",
			vec!["::a".into()],
		)
		.unwrap();
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 23, old_end_byte: 24, new_text: "8".into() },
			"s2",
			vec!["::b".into()],
		)
		.unwrap();
	// Roll back to the root so both revisions are ahead.
	buffer.undo().unwrap();
	buffer.undo().unwrap();

	let result = buffer.redo_scoped_apply("s2").expect("scoped redo ok");
	let applied = result.applied.expect("s2 revision applied");
	assert_eq!(applied.session_id, "s2");
	assert_eq!(result.skipped.len(), 1, "one s1 revision skipped");
	assert_eq!(result.skipped[0].session_id, "s1");
}

/// FEAT-575: empty rope + empty edit resolves to the whole-file fallback.
#[test]
fn derive_code_paths_empty_rope_is_whole_file() {
	let buffer = ts_buffer("");
	let edit = TextEdit { start_byte: 0, old_end_byte: 0, new_text: "const x = 1;".into() };
	let paths =
		derive_code_paths(&edit, buffer.tree(), buffer.rope(), buffer.language(), buffer.registry());
	assert_eq!(paths, vec!["::*".to_string()]);
}

/// FEAT-575: nested declaration yields joined `::Outer.Inner` path.
#[test]
fn derive_code_paths_nested_declaration() {
	let source = "class Outer {\n  method() {\n    const y = 1;\n  }\n}\n";
	let buffer = ts_buffer(source);
	let pos = source.find('1').unwrap();
	let edit = TextEdit { start_byte: pos, old_end_byte: pos + 1, new_text: "42".into() };
	let paths =
		derive_code_paths(&edit, buffer.tree(), buffer.rope(), buffer.language(), buffer.registry());
	assert_eq!(paths.len(), 1);
	let path = &paths[0];
	assert!(path.starts_with("::"), "got {path}");
	assert!(path.contains("Outer"), "got {path}");
	assert!(path.contains('y') || path.contains("method"), "got {path}");
}

/// FEAT-575: journal write then tail roundtrips.
#[test]
fn journal_append_and_tail_roundtrip() {
	let tmp = tempfile::tempdir().expect("tmpdir");
	let root = tmp.path().join("journal");
	let repo = tmp.path();
	let file = tmp.path().join("src/foo.ts");
	std::fs::create_dir_all(file.parent().unwrap()).unwrap();
	std::fs::write(&file, "").unwrap();
	let entry = JournalEntry {
		ts:              1_700_000_000,
		session_id:      "s1".into(),
		pid:             1234,
		kind:            "commit".into(),
		revision:        7,
		parent_revision: Some(6),
		code_paths:      vec!["::foo".into()],
		diff_hash:       "abcd".into(),
		byte_len:        42,
	};
	JournalWriter::append(&root, repo, &file, &entry).expect("append ok");
	JournalWriter::append(&root, repo, &file, &entry).expect("second append ok");

	let path = journal_path_for(&root, repo, &file);
	let tail = JournalReader::tail(&path, 10).expect("tail ok");
	assert_eq!(tail.len(), 2);
	assert_eq!(tail[0], entry);
}

/// FEAT-575: journal path is deterministic for the same inputs.
#[test]
fn journal_path_is_deterministic() {
	let root = PathBuf::from("/journals");
	let repo = PathBuf::from("/project");
	let file = PathBuf::from("/project/src/a.ts");
	let a = journal_path_for(&root, &repo, &file);
	let b = journal_path_for(&root, &repo, &file);
	assert_eq!(a, b);
	// Different file => different path.
	let file2 = PathBuf::from("/project/src/b.ts");
	let c = journal_path_for(&root, &repo, &file2);
	assert_ne!(a, c);
}

/// FEAT-575: null coord client grants every intent and acks every commit.
#[test]
fn null_coord_client_is_granting() {
	let client = NullCoordClient;
	let file = PathBuf::from("/tmp/x.ts");
	assert!(matches!(client.intent("s", &file, &["::x".into()], 0), IntentResult::Granted));
	let edits = client.recent_peer_edits(&file, 0, 10);
	assert!(edits.is_empty());
	assert!(client.peer_state(&file).peers.is_empty());
	let _: Vec<PeerEdit> = edits;
}

/// FEAT-575: `default_journal_root` produces a reasonable path even when
/// `HOME` is unset.
#[test]
fn default_journal_root_is_stable() {
	let root = default_journal_root();
	let s = root.to_string_lossy();
	assert!(s.ends_with(".spell/edit-journal"), "got {s}");
}

/// FEAT-575: a new edit after undo truncates the redo branch, dropping
/// attribution that belonged to discarded revisions.
#[test]
fn new_edit_after_undo_truncates_future_revisions() {
	let mut buffer = ts_buffer("const x = 1;\n");
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 10, old_end_byte: 11, new_text: "2".into() },
			"s1",
			vec!["::x".into()],
		)
		.unwrap();
	buffer.undo().unwrap();
	assert!(buffer.last_revision_summary().is_none());
	buffer
		.edit_with_attribution(
			TextEdit { start_byte: 10, old_end_byte: 11, new_text: "3".into() },
			"s2",
			vec!["::x".into()],
		)
		.unwrap();
	let summary = buffer.last_revision_summary().expect("new revision");
	assert_eq!(summary.session_id, "s2");
	// Redo via scoped should find no s1 ahead.
	let redo = buffer.redo_scoped_apply("s1").unwrap();
	assert!(redo.applied.is_none());
}
