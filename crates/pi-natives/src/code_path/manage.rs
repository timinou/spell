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
	napi::{ContentDto, DiagnosticDto, NodeRefDto},
};

/// Build a §manage-result NodeRefDto with the given subcommand and payload.
fn manage_result(subcommand: &str, payload: Value) -> NodeRefDto {
	manage_result_inner(subcommand, payload, None)
}

/// Like [`manage_result`] but attaches a text body — used by undo/redo to carry
/// the effective diff so the TS render layer shows a diff cell rather than an
/// opaque entry id (PLAN-332 Thesis D / FEAT-809).
fn manage_result_with_content(subcommand: &str, payload: Value, content: String) -> NodeRefDto {
	manage_result_inner(subcommand, payload, Some(content))
}

/// Render a successful undo/redo
/// (`super::edit_history::RevertOutcome::Success`) into a manage result node. A
/// single logical history op may touch MULTIPLE files (a grouped cross-file
/// rename); we surface every touched file in the payload and concatenate their
/// effective diffs (each prefixed with a `<verb> · <file>` header) into the
/// text body so the TUI shows one diff cell per file. `key` is the payload
/// field name ("reverted" / "reapplied").
fn render_history_success(
	subcommand: &str,
	key: &str,
	entry_id: String,
	group_id: Option<String>,
	files: Vec<super::edit_history::RevertedFile>,
) -> NodeRefDto {
	let file_payload: Vec<Value> = files
		.iter()
		.map(|f| {
			json!({
				"entryId": f.entry_id,
				"file": f.file.to_string_lossy().to_string(),
				"diff": f.diff,
			})
		})
		.collect();
	let body = files
		.iter()
		.map(|f| {
			let header = format!("{subcommand} · {}", f.file.to_string_lossy());
			if f.diff.is_empty() {
				header
			} else {
				format!("{header}\n{}", f.diff)
			}
		})
		.collect::<Vec<_>>()
		.join("\n\n");
	// Back-compat: keep the scalar `file`/`diff` of the primary entry so existing
	// single-file consumers keep working, alongside the new `files` array.
	let primary = files.first();
	let payload = json!({
		key: entry_id,
		"groupId": group_id,
		"file": primary.map(|f| f.file.to_string_lossy().to_string()),
		"diff": primary.map(|f| f.diff.clone()),
		"files": file_payload,
		"fileCount": files.len(),
	});
	manage_result_with_content(subcommand, payload, body)
}

/// Render a DECLINED undo (PLAN-338 C): committed file(s) blocked the revert.
/// Surfaced as a manage result the agent reads as an actionable, non-fatal
/// message — NOT a hard error (it's a safe-stop). Names each committed file +
/// sha and tells the agent the two safe paths (force, or git revert).
fn render_history_declined(entries: Vec<super::edit_history::DeclinedEntry>) -> NodeRefDto {
	let files: Vec<Value> = entries
		.iter()
		.map(|e| {
			json!({
				"entryId": e.entry_id,
				"file": e.file.to_string_lossy().to_string(),
				"commit": e.commit,
			})
		})
		.collect();
	let names: Vec<String> = entries
		.iter()
		.map(|e| {
			let sha = e
				.commit
				.as_deref()
				.map(|c| &c[..c.len().min(7)])
				.unwrap_or("HEAD");
			format!("{} ({sha})", e.file.to_string_lossy())
		})
		.collect();
	let body = format!(
		"undo declined: already committed — {}\n  • re-run with force to revert anyway\n  • or use \
		 `git revert`",
		names.join(", ")
	);
	let payload = json!({
		"declined": true,
		"reason": "committed",
		"files": files,
		"fileCount": entries.len(),
		"message": body,
	});
	manage_result_with_content("undo", payload, body)
}

fn manage_result_inner(subcommand: &str, payload: Value, content: Option<String>) -> NodeRefDto {
	let mut metadata = serde_json::Map::new();
	metadata.insert("subcommand".to_string(), Value::String(subcommand.to_string()));
	metadata.insert("payload".to_string(), payload);
	NodeRefDto {
		locator:     format!("manage://{subcommand}"),
		range_start: 0,
		range_end:   0,
		kind:        "§manage-result".to_string(),
		content:     content.map(|value| ContentDto {
			kind: "text".to_string(),
			value: Some(value),
			..Default::default()
		}),
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

fn history_for(file: &str, root: &PathBuf, session_dir: Option<&str>) -> JsonlHistory {
	// PLAN-338 B: with a session dir, the read side resolves the SAME
	// session-unified log the recorder wrote to
	// (`<session_dir>/edit-history.jsonl`), so a target-less undo sees every edit
	// the session made across all workspaces — not just the session-cwd shard.
	// This is the read counterpart of the recorder's `current_session_dir()`
	// branch in lib.rs.
	if let Some(dir) = session_dir.filter(|d| !d.is_empty()) {
		let path = super::edit_history::session_log_path(Path::new(dir));
		return JsonlHistory::new(path);
	}
	// Legacy per-workspace fallback (no session dir; headless/test).
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
	session_dir: Option<&str>,
	entry_id: Option<&str>,
	force: bool,
) -> Result<NodeRefDto, DiagnosticDto> {
	// Target is optional: with no file, undo reverts the most recent
	// uncommitted edit in this session. A file NARROWS the revert to that
	// path's group (BUG: undo-atomicity — the agent's target must be honoured,
	// not discarded). An `entry_id` targets one specific entry (id-precise undo
	// from the history listing, PLAN-338 B). When the original edit was a
	// grouped operation (e.g. a cross-file rename), the whole group is reverted
	// atomically.
	let history = history_for(file, root, session_dir);
	let mut query = HistoryQuery::default().session_id(session_id);
	if let Some(id) = entry_id.filter(|s| !s.is_empty()) {
		query = query.entry_id(id);
	} else if !file.is_empty() {
		let path = absolute_path(file, root);
		query = query.file_glob(path.to_string_lossy().to_string());
	}
	// PLAN-338 C: commit guard. Decline (don't write) if a member is committed,
	// unless force. git checks live in commit_guard (fail-open).
	match history.revert_guarded(query, force, &super::commit_guard::is_committed) {
		super::edit_history::RevertOutcome::Success { entry_id, group_id, files } => {
			Ok(render_history_success("undo", "reverted", entry_id, group_id, files))
		},
		super::edit_history::RevertOutcome::Declined { entries } => {
			Ok(render_history_declined(entries))
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
	session_dir: Option<&str>,
	entry_id: Option<&str>,
) -> Result<NodeRefDto, DiagnosticDto> {
	// Symmetric with handle_undo: target optional (re-applies the most recent
	// undone edit in the session); a file or entry_id narrows to that group,
	// which is re-applied atomically. No commit guard — redo re-applies an edit
	// the user already made, never destroys committed work.
	let history = history_for(file, root, session_dir);
	let mut query = HistoryQuery::default().session_id(session_id);
	if let Some(id) = entry_id.filter(|s| !s.is_empty()) {
		query = query.entry_id(id);
	} else if !file.is_empty() {
		let path = absolute_path(file, root);
		query = query.file_glob(path.to_string_lossy().to_string());
	}
	match history.reapply(query) {
		super::edit_history::RevertOutcome::Success { entry_id, group_id, files } => {
			Ok(render_history_success("redo", "reapplied", entry_id, group_id, files))
		},
		super::edit_history::RevertOutcome::Declined { entries } => {
			Ok(render_history_declined(entries))
		},
		super::edit_history::RevertOutcome::NotFound => {
			Ok(manage_result("redo", json!({ "message": "no undone edit to redo for this session" })))
		},
		super::edit_history::RevertOutcome::Error(e) => {
			Err(diag_internal(format!("reapply failed: {e}")))
		},
	}
}

pub fn handle_diff(
	file: &str,
	root: &PathBuf,
	session_id: &str,
	session_dir: Option<&str>,
) -> Result<NodeRefDto, DiagnosticDto> {
	if file.is_empty() {
		return Err(DiagnosticDto {
			variant: "missing_target".to_string(),
			message: "manage diff requires a file target".to_string(),
			span:    None,
		});
	}
	let path = absolute_path(file, root);
	let history = history_for(file, root, session_dir);
	let query = HistoryQuery::default()
		.session_id(session_id)
		.file_glob(path.to_string_lossy().to_string())
		.uncommitted_only(true);
	let entries = history.query(query);
	let diffs: Vec<String> = entries.into_iter().map(|e| e.diff).collect();
	let payload = json!({ "diffs": diffs, "count": diffs.len() });
	Ok(manage_result("diff", payload))
}

pub fn handle_context(
	root: &PathBuf,
	session_id: &str,
	session_dir: Option<&str>,
) -> Result<NodeRefDto, DiagnosticDto> {
	let history = history_for("", root, session_dir);
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

/// PLAN-338 B: read-only edit-history listing for the session, newest-first.
///
/// Surfaced to the agent as `status { command: "history", file? }` and to the
/// human as the TUI history palette. An optional `file` target narrows to edits
/// touching that path. Each entry carries everything the inspector / id-precise
/// undo need: id, file, workspace, group, kind hint, reverted flag, committed
/// flag (+ commit sha when known), agent label, timestamp.
/// `undoable`/`redoable` counts let a caller show "N edits can be undone".
pub fn handle_history(
	file: &str,
	root: &PathBuf,
	session_id: &str,
	session_dir: Option<&str>,
) -> Result<NodeRefDto, DiagnosticDto> {
	let history = history_for(file, root, session_dir);
	let mut query = HistoryQuery::default().session_id(session_id);
	if !file.is_empty() {
		let path = absolute_path(file, root);
		query = query.file_glob(path.to_string_lossy().to_string());
	}
	let mut entries = history.query(query);
	// Newest-first: the inspector and palette read top-down as "most recent
	// edit first", matching undo's LIFO default.
	entries.reverse();

	let undoable = entries.iter().filter(|e| !e.reverted).count();
	let redoable = entries.iter().filter(|e| e.reverted).count();
	let total = entries.len();
	let rows: Vec<Value> = entries
		.iter()
		.map(|e| {
			// Live git state, not the provenance sha (e.commit).
			let committed = super::commit_guard::is_committed(&e.file);
			json!({
				"id": e.id,
				"sessionId": e.session_id,
				"agentLabel": e.agent_label,
				"file": e.file.display().to_string(),
				"workspace": e.workspace,
				"groupId": e.group_id,
				"reverted": e.reverted,
				"committed": committed,
				"commit": e.commit,
				"timestamp": e.timestamp.duration_since(std::time::SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs(),
			})
		})
		.collect();
	let payload = json!({
		"entries": rows,
		"total": total,
		"undoable": undoable,
		"redoable": redoable,
	});
	Ok(manage_result("history", payload))
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
		let hist = history_for(file.to_str().unwrap(), &root, None);
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
			group_id:    None,
			workspace:   String::new(),
		});

		// Target-less undo: must succeed and revert the file to "ORIG".
		let out =
			handle_undo("", &root, "S1", None, None, false).expect("target-less undo should succeed");
		let payload = out.metadata.get("payload").unwrap();
		assert!(payload.get("reverted").is_some(), "expected a reverted entry id, got: {payload:?}");
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "ORIG\n");
	}

	/// redo re-applies the most recently undone edit (round-trip): write AFTER,
	/// record before/after, undo → ORIG, redo → AFTER. Target-less, mirroring
	/// undo.
	#[test]
	fn handle_redo_reapplies_after_undo() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let file = root.join("f.txt");
		std::fs::write(&file, "AFTER\n").unwrap();
		let hist = history_for(file.to_str().unwrap(), &root, None);
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
			group_id:    None,
			workspace:   String::new(),
		});
		handle_undo("", &root, "S1", None, None, false).expect("undo");
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "ORIG\n");
		let out = handle_redo("", &root, "S1", None, None).expect("redo should succeed");
		let payload = out.metadata.get("payload").unwrap();
		assert!(payload.get("reapplied").is_some(), "expected reapplied entry id, got: {payload:?}");
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "AFTER\n");
		// And undo again works (reverted flag was cleared).
		handle_undo("", &root, "S1", None, None, false).expect("undo again");
		assert_eq!(std::fs::read_to_string(&file).unwrap(), "ORIG\n");
	}

	/// No undone edit → graceful message.
	#[test]
	fn handle_redo_nothing_to_redo_is_graceful() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let out = handle_redo("", &root, "NOPE", None, None).expect("redo no-op should not error");
		assert!(
			out.metadata
				.get("payload")
				.unwrap()
				.get("message")
				.is_some()
		);
	}

	/// Empty session with no history → graceful NotFound message, not an error.
	#[test]
	fn handle_undo_no_history_is_graceful() {
		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let out = handle_undo("", &root, "NOPE", None, None, false)
			.expect("no-history undo should not error");
		let payload = out.metadata.get("payload").unwrap();
		assert!(payload.get("message").is_some(), "expected a graceful message, got: {payload:?}");
		let _ = PathBuf::new();
	}

	/// A grouped (multi-file) undo through `handle_undo` surfaces every touched
	/// file in the `files` payload array, a `fileCount`, and a rendered diff
	/// body that names each file — so the TUI renders one diff cell per file
	/// rather than hiding the cross-file scope. Regression guard for the render
	/// layer.
	#[test]
	fn handle_undo_renders_grouped_multifile_payload() {
		use crate::code_path::edit_history::EditHistory;

		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let a = root.join("a.txt");
		let b = root.join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();

		let hist = history_for(a.to_str().unwrap(), &root, None);
		let mk = |id: &str, file: &PathBuf, before: &str, after: &str| EditEntry {
			id:          id.into(),
			session_id:  "S1".into(),
			agent_label: "".into(),
			file:        file.clone(),
			before:      before.into(),
			after:       after.into(),
			diff:        format!("@@ -1 +1 @@\n-{before}+{after}"),
			timestamp:   std::time::SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
			group_id:    Some("G".into()),
			workspace:   String::new(),
		};
		hist.record(mk("1", &a, "A0\n", "A1\n"));
		hist.record(mk("2", &b, "B0\n", "B1\n"));

		// Target one member; the whole group must come back.
		let out =
			handle_undo(a.to_str().unwrap(), &root, "S1", None, None, false).expect("grouped undo");
		let payload = out.metadata.get("payload").unwrap();
		assert_eq!(payload.get("fileCount").and_then(|v| v.as_u64()), Some(2));
		let files = payload.get("files").and_then(|v| v.as_array()).unwrap();
		assert_eq!(files.len(), 2, "both files surfaced");
		assert_eq!(payload.get("groupId").and_then(|v| v.as_str()), Some("G"));
		// Both files reverted on disk.
		assert_eq!(std::fs::read_to_string(&a).unwrap(), "A0\n");
		assert_eq!(std::fs::read_to_string(&b).unwrap(), "B0\n");
		// Rendered body names both files.
		let body = out
			.content
			.as_ref()
			.and_then(|c| c.value.clone())
			.unwrap_or_default();
		assert!(body.contains("a.txt") && body.contains("b.txt"), "body: {body}");
	}

	/// PLAN-338 B: `handle_history` lists the session's edits newest-first with
	/// the full per-entry shape (id, file, workspace, group, reverted, counts).
	#[test]
	fn handle_history_lists_session_edits_newest_first() {
		use crate::code_path::edit_history::EditHistory;

		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell")).unwrap();
		let a = root.join("a.txt");
		let b = root.join("b.txt");
		std::fs::write(&a, "A1\n").unwrap();
		std::fs::write(&b, "B1\n").unwrap();
		let hist = history_for("", &root, None);
		let mk = |id: &str, file: &PathBuf| EditEntry {
			id:          id.into(),
			session_id:  "S1".into(),
			agent_label: "".into(),
			file:        file.clone(),
			before:      "x".into(),
			after:       "y".into(),
			diff:        "d".into(),
			timestamp:   std::time::SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
			group_id:    None,
			workspace:   root.display().to_string(),
		};
		hist.record(mk("1", &a));
		hist.record(mk("2", &b));

		let out = handle_history("", &root, "S1", None).expect("history");
		let payload = out.metadata.get("payload").unwrap();
		assert_eq!(payload.get("total").and_then(Value::as_u64), Some(2));
		assert_eq!(payload.get("undoable").and_then(Value::as_u64), Some(2));
		assert_eq!(payload.get("redoable").and_then(Value::as_u64), Some(0));
		let entries = payload.get("entries").and_then(Value::as_array).unwrap();
		// Newest-first: entry "2" (b.txt) leads.
		assert_eq!(entries[0].get("id").and_then(Value::as_str), Some("2"));
		assert_eq!(entries[1].get("id").and_then(Value::as_str), Some("1"));
		// Shape present.
		assert!(entries[0].get("workspace").is_some());
		assert!(entries[0].get("committed").is_some());
	}

	/// PLAN-338 C end-to-end: an undo of a file that is committed in a real git
	/// repo DECLINES (writes nothing); the same undo with force reverts. Uses
	/// the `manage` napi path so the commit_guard git checks run for real.
	#[test]
	fn handle_undo_declines_committed_file_then_force_reverts() {
		use crate::code_path::edit_history::EditHistory;

		fn git(args: &[&str], dir: &std::path::Path) -> bool {
			std::process::Command::new("git")
				.args(args)
				.current_dir(dir)
				.output()
				.map(|o| o.status.success())
				.unwrap_or(false)
		}

		let ws = tempfile::tempdir().unwrap();
		let root = ws.path().to_path_buf();
		if !git(&["init", "-q"], &root) {
			return; // git unavailable → skip (guard is fail-open by design)
		}
		git(&["config", "user.email", "t@t"], &root);
		git(&["config", "user.name", "t"], &root);
		git(&["config", "commit.gpgsign", "false"], &root);
		std::fs::create_dir_all(root.join(".spell")).unwrap();

		let f = root.join("committed.txt");
		// The edit produced "v1"; that content is committed to HEAD.
		std::fs::write(&f, "v1\n").unwrap();
		git(&["add", "committed.txt"], &root);
		git(&["commit", "-q", "-m", "add"], &root);

		let hist = history_for(f.to_str().unwrap(), &root, None);
		hist.record(EditEntry {
			id:          "1".into(),
			session_id:  "S1".into(),
			agent_label: "".into(),
			file:        f.clone(),
			before:      "v0\n".into(),
			after:       "v1\n".into(),
			diff:        "@@ -1 +1 @@\n-v0\n+v1\n".into(),
			timestamp:   std::time::SystemTime::UNIX_EPOCH,
			commit:      None,
			reverted:    false,
			group_id:    None,
			workspace:   root.display().to_string(),
		});

		// Default undo (force=false) → declined; file stays at committed content.
		let out = handle_undo(f.to_str().unwrap(), &root, "S1", None, None, false).expect("undo");
		let payload = out.metadata.get("payload").unwrap();
		assert_eq!(
			payload.get("declined").and_then(Value::as_bool),
			Some(true),
			"payload: {payload:?}"
		);
		assert_eq!(std::fs::read_to_string(&f).unwrap(), "v1\n", "declined undo writes nothing");

		// Force → reverts.
		let out =
			handle_undo(f.to_str().unwrap(), &root, "S1", None, None, true).expect("forced undo");
		assert!(
			out.metadata
				.get("payload")
				.unwrap()
				.get("declined")
				.is_none()
		);
		assert_eq!(std::fs::read_to_string(&f).unwrap(), "v0\n", "force reverts past the guard");
	}
}
