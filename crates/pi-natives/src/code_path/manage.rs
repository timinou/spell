//! `command:"manage"` subcommand handlers (FEAT-704).
//!
//! Manage subcommands are workspace- or file-level operations that don't
//! map cleanly onto a CodePath query: `save` flushes a dirty buffer,
//! `index` triggers code-graph indexing, `languages`/`buffers`/`status`/
//! `watcherStatus`/`lockStatus` report broker state. Pre-FEAT-704 every
//! `manage` call hit `parse_code_path` with an empty target and returned
//! "parse failed at position 0".
//!
//! Each handler returns a single `NodeRefDto` with `kind: "§manage-result"`.
//! The handler delegates to the existing `executeCodeBuffer` surface (or
//! the registries directly) so we don't duplicate state-management code.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::napi::{DiagnosticDto, NodeRefDto};

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
	let is_error = result.get("error").and_then(Value::as_bool).unwrap_or(false);
	let output = result.get("output").cloned().unwrap_or(Value::Null);
	if is_error {
		let msg = output.as_str().map(String::from).unwrap_or_else(|| output.to_string());
		return Err(msg);
	}
	Ok(output)
}

const MANAGE_SESSION_ID: &str = "pi-code-path-manage";

pub fn handle_languages() -> Result<NodeRefDto, DiagnosticDto> {
	let payload = dispatch(json!({ "command": "languages" })).map_err(diag_internal)?;
	Ok(manage_result("languages", payload))
}

pub fn handle_buffers() -> Result<NodeRefDto, DiagnosticDto> {
	let payload = dispatch(json!({ "command": "list" })).map_err(diag_internal)?;
	Ok(manage_result("buffers", payload))
}

pub fn handle_save(file: &str, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	let path = absolute_path(file, root);
	let payload = dispatch(json!({
		"command": "save",
		"sessionId": MANAGE_SESSION_ID,
		"file": path.display().to_string(),
	}))
	.map_err(diag_internal)?;
	Ok(manage_result("save", payload))
}

pub fn handle_undo(file: &str, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	let path = absolute_path(file, root);
	let payload = dispatch(json!({
		"command": "undo",
		"sessionId": MANAGE_SESSION_ID,
		"file": path.display().to_string(),
	}))
	.map_err(diag_internal)?;
	Ok(manage_result("undo", payload))
}

pub fn handle_redo(file: &str, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	let path = absolute_path(file, root);
	let payload = dispatch(json!({
		"command": "redo",
		"sessionId": MANAGE_SESSION_ID,
		"file": path.display().to_string(),
	}))
	.map_err(diag_internal)?;
	Ok(manage_result("redo", payload))
}

pub fn handle_diff(file: &str, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	if file.is_empty() {
		return Err(DiagnosticDto {
			variant: "missing_target".to_string(),
			message: "manage diff requires a file target".to_string(),
			span:    None,
		});
	}
	let path = absolute_path(file, root);
	let payload = dispatch(json!({
		"command": "diff",
		"sessionId": MANAGE_SESSION_ID,
		"file": path.display().to_string(),
	}))
	.map_err(diag_internal)?;
	Ok(manage_result("diff", payload))
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
		"sessionId": MANAGE_SESSION_ID,
		"file": path.display().to_string(),
	}))
	.map_err(diag_internal)?;
	Ok(manage_result("lockStatus", payload))
}

pub fn handle_status(file: Option<&str>, root: &PathBuf) -> Result<NodeRefDto, DiagnosticDto> {
	// Workspace-level status: report watcher activity + buffer count. If a
	// file is given, also include per-file coord status (delegates to the
	// existing `coord_status` command).
	let watcher = dispatch(json!({ "command": "watcherStatus" })).map_err(diag_internal)?;
	let buffers = dispatch(json!({ "command": "list" })).map_err(diag_internal)?;
	let coord = match file {
		Some(f) if !f.is_empty() => {
			let path = absolute_path(f, root);
			dispatch(json!({
				"command": "coord_status",
				"sessionId": MANAGE_SESSION_ID,
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
	// Trigger a fresh code-graph index pass over the workspace root.
	// `executeCodeBuffer` doesn't expose this directly; we report the
	// current graph statistics so the caller knows the state. A future
	// FEAT can wire a real index trigger.
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
			"unknown manage subcommand: {name:?}. Valid: save | index | languages | buffers | undo \
			 | redo | diff | status | watcherStatus | lockStatus"
		),
		span:    None,
	}
}

pub fn handle_missing() -> DiagnosticDto {
	DiagnosticDto {
		variant: "missing_subcommand".to_string(),
		message: "command:\"manage\" requires a non-empty `manage` field. Valid: save | index | \
		          languages | buffers | undo | redo | diff | status | watcherStatus | lockStatus"
			.to_string(),
		span:    None,
	}
}

fn absolute_path(file: &str, root: &PathBuf) -> PathBuf {
	let p = std::path::Path::new(file);
	if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
}

fn diag_internal(message: String) -> DiagnosticDto {
	DiagnosticDto { variant: "manage_dispatch_failed".to_string(), message, span: None }
}
