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
	let workspace = if file.is_empty() {
		pi_code_engine::workspace_root_for(root)
	} else {
		pi_code_engine::workspace_root_for(&absolute_path(file, root))
	};
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
	if file.is_empty() {
		return Err(DiagnosticDto {
			variant: "missing_target".to_string(),
			message: "manage undo requires a file target".to_string(),
			span:    None,
		});
	}
	let path = absolute_path(file, root);
	let history = history_for(file, root);
	let query = HistoryQuery::default()
		.session_id(session_id)
		.file_glob(path.to_string_lossy().to_string());
	match history.revert(query) {
		super::edit_history::RevertOutcome::Success { entry_id } => {
			Ok(manage_result("undo", json!({ "reverted": entry_id })))
		},
		super::edit_history::RevertOutcome::NotFound => Ok(manage_result(
			"undo",
			json!({ "message": "no uncommitted edit found for this session and file" }),
		)),
		super::edit_history::RevertOutcome::Error(e) => {
			Err(diag_internal(format!("revert failed: {e}")))
		},
	}
}

pub fn handle_redo(
	_file: &str,
	_root: &PathBuf,
	_session_id: &str,
) -> Result<NodeRefDto, DiagnosticDto> {
	Ok(manage_result(
		"redo",
		json!({
			"message": "redo not yet implemented; re-apply the edit manually",
		}),
	))
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
