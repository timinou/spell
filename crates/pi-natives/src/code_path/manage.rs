//! `command:"manage"` subcommand handlers (FEAT-704 / BUG-340).
//!
//! Manage subcommands are workspace- or file-level operations that don't
//! map cleanly onto a CodePath query.  Pre-FEAT-704 every `manage` call
//! hit `parse_code_path` with an empty target and returned "parse failed
//! at position 0".
//!
//! BUG-340 reframes save/undo/diff/context as a per-session edit-history
//! tracker: edits auto-persist, so `manage` inspects or reverts THIS
//! session's changes without affecting sibling sessions.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{
	edit_history::{EditHistory, HistoryQuery, JsonlHistory},
	napi::{DiagnosticDto, NodeRefDto},
};

/// Build a §manage-result NodeRefDto with the given subcommand and payload.
fn manage_result(subcommand: &str, payload: Value) -> NodeRefDto {
	let mut metadata = serde_json::Map::new();
	metadata.insert("subcommand".to_string(), Value::String(subcommand.to_string()));
	metadata.insert("payload".to_string(), payload);
	NodeRefDto {
		locator:     format!("manage://{subcommand}"),
		range_start: 0,
		range_end:   0,
		kind:        "§manage-result".to_string(),
		content:     None,
		metadata:    Value::Object(metadata),
		diagnostics: Vec::new(),
	}
}

fn dispatch(request: Value) -> Result<Value, String> {
	let result = crate::code_buffer::execute_code_buffer_inner(&request)
		.map_err(|e| format!("manage dispatch failed: {e}"))?;
	let is_error = result
		.get("error")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let output = result.get("output").cloned().unwrap_or(Value::Null);
	if is_error {
		let msg = output
			.as_str()
			.map(String::from)
			.unwrap_or_else(|| output.to_string());
		return Err(msg);
	}
	Ok(output)
}

fn history_for(file: &str, root: &PathBuf) -> JsonlHistory {
	// `workspace_root_for` walks upward from `path.parent()`, so it skips a
	// marker that lives in `path` itself. The file branch is naturally safe
	// (the file sits *inside* the workspace). For the empty-target branch we
	// must probe `root` itself: join a synthetic child so the parent-walk
	// starts at `root` and can see `root/.spell` (the common case where the
	// session cwd IS the workspace root). Without this, target-less undo
	// resolves a different history file than the edit that recorded it.
	let probe = if file.is_empty() {
		root.join(".spell-history-probe")
	} else {
		absolute_path(file, root)
	};
	let workspace = pi_code_engine::workspace_root_for(&probe);
	let path = workspace.join(".spell").join("edit-history.jsonl");
	JsonlHistory::new(path)
}

fn absolute_path(file: &str, root: &PathBuf) -> PathBuf {
	let p = Path::new(file);
	if p.is_absolute() {
		p.to_path_buf()
	} else {
		root.join(p)
	}
}

fn diag_internal(message: String) -> DiagnosticDto {
	DiagnosticDto { variant: "manage_dispatch_failed".to_string(), message, span: None }
}

// ── Subcommand handlers ──────────────────────────────────────────

pub fn handle_languages() -> Result<NodeRefDto, DiagnosticDto> {
	let payload = dispatch(json!({ "command": "languages" })).map_err(diag_internal)?;
	Ok(manage_result("languages", payload))
}

pub fn handle_buffers() -> Result<NodeRefDto, DiagnosticDto> {
	let payload = dispatch(json!({ "command": "list" })).map_err(diag_internal)?;
	Ok(manage_result("buffers", payload))
}

pub fn handle_save(_file: &str, _root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	Ok(manage_result(
		"save",
		json!({
			"message": "edits auto-persist; use manage diff to inspect or manage undo to revert",
		}),
	))
}

pub fn handle_undo(
	file: &str,
	root: &PathBuf,
	session_id: &str,
) -> Result<NodeRefDto, DiagnosticDto> {
	// Target is optional: with no file, undo reverts the most recent
	// uncommitted edit in this session (the `undo` verb is dispatched alone
	// and target-less by contract). A file narrows the revert to that path.
	let history = history_for(file, root);
	let mut query = HistoryQuery::default().session_id(session_id);
	if !file.is_empty() {
		let path = absolute_path(file, root);
		query = query.file_glob(path.to_string_lossy().to_string());
	}
	match history.revert(query) {
		super::edit_history::RevertOutcome::Success { entry_id } => {
			Ok(manage_result("undo", json!({ "reverted": entry_id })))
		},
		super::edit_history::RevertOutcome::NotFound => Ok(manage_result(
			"undo",
			json!({ "message": "no uncommitted edit found for this session" }),
		)),
		super::edit_history::RevertOutcome::Error(e) => {
			Err(diag_internal(format!("revert failed: {e}")))
		},
	}
}

pub fn handle_redo(
	file: &str,
	root: &PathBuf,
	session_id: &str,
) -> Result<NodeRefDto, DiagnosticDto> {
	// Symmetric with handle_undo: target optional (re-applies the most recent
	// undone edit in the session); a file narrows to that path.
	let history = history_for(file, root);
	let mut query = HistoryQuery::default().session_id(session_id);
	if !file.is_empty() {
		let path = absolute_path(file, root);
		query = query.file_glob(path.to_string_lossy().to_string());
	}
	match history.reapply(query) {
		super::edit_history::RevertOutcome::Success { entry_id } => {
			Ok(manage_result("redo", json!({ "reapplied": entry_id })))
		},
		super::edit_history::RevertOutcome::NotFound => Ok(manage_result(
			"redo",
			json!({ "message": "no undone edit to redo for this session" }),
		)),
		super::edit_history::RevertOutcome::Error(e) => {
			Err(diag_internal(format!("reapply failed: {e}")))
		},
	}
}

pub fn handle_diff(
	file: &str,
	root: &PathBuf,
	session_id: &str,
) -> Result<NodeRefDto, DiagnosticDto> {
	if file.is_empty() {
		return Err(DiagnosticDto {
			variant: "missing_target".to_string(),
			message: "manage diff requires a file target".to_string(),
			span:    None,
		});
	}
	let path = absolute_path(file, root);
	let history = history_for(file, root);
	let query = HistoryQuery::default()
		.session_id(session_id)
		.file_glob(path.to_string_lossy().to_string())
		.uncommitted_only(true);
	let entries = history.query(query);
	let diffs: Vec<String> = entries.into_iter().map(|e| e.diff).collect();
	let payload = json!({ "diffs": diffs, "count": diffs.len() });
	Ok(manage_result("diff", payload))
}

pub fn handle_context(root: &PathBuf, session_id: &str) -> Result<NodeRefDto, DiagnosticDto> {
	let history = history_for("", root);
	let query = HistoryQuery::default()
		.session_id(session_id)
		.uncommitted_only(true)
		.exclude_reverted(true);
	let entries = history.query(query);
	let payload = json!({
		"entries": entries.into_iter().map(|e| json!({
			"id": e.id,
			"sessionId": e.session_id,
			"file": e.file.display().to_string(),
			"timestamp": e.timestamp.duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs(),
			"diff": e.diff,
			"reverted": e.reverted,
		})).collect::<Vec<Value>>(),
	});
	Ok(manage_result("context", payload))
}

pub fn handle_watcher_status() -> Result<NodeRefDto, DiagnosticDto> {
	let payload = dispatch(json!({ "command": "watcherStatus" })).map_err(diag_internal)?;
	Ok(manage_result("watcherStatus", payload))
}

pub fn handle_lock_status(file: &str, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	if file.is_empty() {
		return Err(DiagnosticDto {
			variant: "missing_target".to_string(),
			message: "manage lockStatus requires a file target".to_string(),
			span:    None,
		});
	}
	let path = absolute_path(file, root);
	let payload = dispatch(json!({
		"command": "lockStatus",
		"sessionId": "pi-code-path-manage",
		"file": path.display().to_string(),
	}))
	.map_err(diag_internal)?;
	Ok(manage_result("lockStatus", payload))
}

pub fn handle_status(file: Option<&str>, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	let watcher = dispatch(json!({ "command": "watcherStatus" })).map_err(diag_internal)?;
	let buffers = dispatch(json!({ "command": "list" })).map_err(diag_internal)?;
	let coord = match file {
		Some(f) if !f.is_empty() => {
			let path = absolute_path(f, root);
			dispatch(json!({
				"command": "coord_status",
				"sessionId": "pi-code-path-manage",
				"file": path.display().to_string(),
			}))
			.ok()
		},
		_ => None,
	};
	let payload = json!({
		"watcher": watcher,
		"openBuffers": buffers,
		"coordinator": coord,
	});
	Ok(manage_result("status", payload))
}

pub fn handle_index(root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	let payload = dispatch(json!({
		"command": "graph_stats",
		"root": root.display().to_string(),
	}))
	.unwrap_or_else(|err| json!({ "available": false, "message": err }));
	Ok(manage_result("index", payload))
}

pub fn handle_unknown(name: &str) -> DiagnosticDto {
	DiagnosticDto {
		variant: "unsupported_operation".to_string(),
		message: format!(
			"unknown manage subcommand: {name:?}. Valid: save | undo | redo | diff | context | \
			 status | buffers | languages | watcherStatus | lockStatus | index"
		),
		span:    None,
	}
}

pub fn handle_missing() -> DiagnosticDto {
	DiagnosticDto {
		variant: "missing_subcommand".to_string(),
		message: "command:\"manage\" requires a non-empty `manage` field. Valid: save | undo | redo \
		          | diff | context | status | buffers | languages | watcherStatus | lockStatus | \
		          index"
			.to_string(),
		span:    None,
	}
}

#[cfg(test)]
mod undo_tests {
	use std::{path::PathBuf, time::SystemTime};

	use super::*;
	use crate::code_path::edit_history::{EditEntry, EditHistory};

	/// BUG-440: `undo` must work target-less (the verb is dispatched alone).
	/// A recorded edit is reverted on disk with `file: ""`, reverting the most
	/// recent uncommitted edit for the session regardless of path.
	#[test]
	fn handle_undo_reverts_without_target() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		// `.spell` marks this dir as the workspace root; history_for("") must
		// probe `root` itself (root-inclusive) to find it — see history_for.
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let file = root.join("f.txt");
		std::fs::write(&file, "AFTER\n").unwrap();

		// Record an edit (before="ORIG", after="AFTER") into the workspace history.
		let hist = history_for(file.to_str().unwrap(), &root);
		hist.record(EditEntry {
			id:          "e1".into(),
			session_id:  "S1".into(),
			agent_label: "".into(),
			file:        file.clone(),
			before:      "ORIG\n".into(),
			after:       "AFTER\n".into(),
			diff:        "diff".into(),
			timestamp:   SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
		});

		// Target-less undo: must succeed and revert the file to "ORIG".
		let out = handle_undo("", &root, "S1").expect("target-less undo should succeed");
		let payload = out.metadata.get("payload").unwrap();
		assert!(
			payload.get("reverted").is_some(),
			"expected a reverted entry id, got: {payload:?}"
		);
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "ORIG\n");
	}

	/// redo re-applies the most recently undone edit (round-trip): write AFTER,
	/// record before/after, undo → ORIG, redo → AFTER. Target-less, mirroring undo.
	#[test]
	fn handle_redo_reapplies_after_undo() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let file = root.join("f.txt");
		std::fs::write(&file, "AFTER\n").unwrap();
		let hist = history_for(file.to_str().unwrap(), &root);
		hist.record(EditEntry {
			id:          "e1".into(),
			session_id:  "S1".into(),
			agent_label: "".into(),
			file:        file.clone(),
			before:      "ORIG\n".into(),
			after:       "AFTER\n".into(),
			diff:        "diff".into(),
			timestamp:   SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
		});
		handle_undo("", &root, "S1").expect("undo");
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "ORIG\n");
		let out = handle_redo("", &root, "S1").expect("redo should succeed");
		let payload = out.metadata.get("payload").unwrap();
		assert!(
			payload.get("reapplied").is_some(),
			"expected reapplied entry id, got: {payload:?}"
		);
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "AFTER\n");
		// And undo again works (reverted flag was cleared).
		handle_undo("", &root, "S1").expect("undo again");
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "ORIG\n");
	}

	/// No undone edit → graceful message.
	#[test]
	fn handle_redo_nothing_to_redo_is_graceful() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let out = handle_redo("", &root, "NOPE").expect("redo no-op should not error");
		assert!(out.metadata.get("payload").unwrap().get("message").is_some());
	}

	/// Empty session with no history → graceful NotFound message, not an error.
	#[test]
	fn handle_undo_no_history_is_graceful() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let out = handle_undo("", &root, "NOPE").expect("no-history undo should not error");
		let payload = out.metadata.get("payload").unwrap();
		assert!(
			payload.get("message").is_some(),
			"expected a graceful message, got: {payload:?}"
		);
		let _ = PathBuf::new();
	}
}
