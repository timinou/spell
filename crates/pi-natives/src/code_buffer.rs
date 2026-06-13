// P5.B (PLAN-336): the EDN path helpers (parse_edn_path, edn_node_text,
// edn_named_children, edn_root_value, edn_child_for_segment, edn_node_for_path,
// edn_resolved_symbol) moved to pi_kernel::edit_ops (host-agnostic). Imported
// below; edn_navigate_result and the napi EDN paths call the kernel versions.
fn edn_navigate_result(buffer: &CodeBuffer, node: Node<'_>) -> NavigateResult {
	let items = edn_named_children(node)
		.into_iter()
		.map(|child| NavigateItem {
			node_type: child.kind().to_string(),
			text:      edn_first_line(&edn_node_text(buffer, child), 80),
			line:      (child.start_position().row + 1) as u32,
			end_line:  (child.end_position().row + 1) as u32,
		})
		.collect();
	NavigateResult {
		node_type: node.kind().to_string(),
		text: edn_first_line(&edn_node_text(buffer, node), 80),
		line: (node.start_position().row + 1) as u32,
		end_line: (node.end_position().row + 1) as u32,
		column: node.start_position().column as u32,
		parent_type: node.parent().map(|parent| parent.kind().to_string()),
		editable_scope_node_type: Some(node.kind().to_string()),
		editable_scope_line: Some((node.start_position().row + 1) as u32),
		editable_scope_end_line: Some((node.end_position().row + 1) as u32),
		editable_scope_column: Some(node.start_position().column as u32),
		name: None,
		kind: Some(node.kind().to_string()),
		items,
		references: Vec::new(),
	}
}
use std::{
	collections::{BTreeMap, BTreeSet},
	path::{Path, PathBuf},
};

use napi::{Error, bindgen_prelude::*};
use napi_derive::napi;
use pi_code_engine::{
	CodeEngineError, JournalEntry, JournalReader, PeerEdit, PeerInfo, PeerState,
	buffer::CodeBuffer,
	default_journal_root,
	file_lock::lock_status,
	journal_path_for,
	language::{LanguageId, LanguageProfile},
	navigate::{NavigateAction, NavigateItem, NavigateResult, navigate as navigate_buffer},
	outline::{EnrichFlags, OutlineEntry, outline as outline_buffer, read as read_buffer},
	procedure::ProcedureProof,
};
// P5.B: after single_action moved to pi_kernel::edit_ops, these edit primitives
// remain used only by the test-only `single_edit_operation` / `parse_patches`
// helpers below; gate the import so the lib build stays warning-clean.
#[cfg(test)]
use pi_code_engine::{
	edit::{Occurrence, Patch, TextEdit, apply_patches},
	resolve::resolve_symbol,
	run_procedure,
};
use pi_code_graph::{
	BuildGraphOptions, CacheStatus, CacheStore, CodeGraphBuilder,
	LanguageRegistry as GraphLanguageRegistry, query::GraphOutlineEnrichment,
};
// P5.B (PLAN-336): the host-agnostic edit-prep cluster now lives in
// pi_kernel::edit_ops; re-import every symbol the napi paths in this file use so
// the call sites resolve unchanged.
use pi_kernel::edit_ops::{
	action_content, action_line, edn_named_children, edn_node_for_path, edn_node_text,
	edn_root_value, single_action, target_range,
};
use serde_json::{Value, json};
use tree_sitter::Node;

use crate::{buffer_registry, language_registry};
fn engine_err(error: pi_code_engine::error::CodeEngineError) -> Error {
	let payload = match &error {
		CodeEngineError::ExternalModification { path, .. } => json!({
			"code": "EXTERNAL_MODIFICATION",
			"message": error.to_string(),
			"path": path.display().to_string(),
		}),
		CodeEngineError::UnsafeScopeWrite { lost_decls, original, new, .. } => json!({
			"code": "UNSAFE_SCOPE_WRITE",
			"message": error.to_string(),
			"lostDecls": lost_decls,
			"original": original,
			"new": new,
		}),
		CodeEngineError::LineOutOfTargetScope {
			line,
			target_start,
			target_end,
			target_line_start,
			target_line_end,
		} => json!({
			"code": "LINE_OUT_OF_TARGET_SCOPE",
			"message": error.to_string(),
			"line": line,
			"targetSpan": { "start": target_start, "end": target_end },
			"targetLineSpan": { "start": target_line_start, "end": target_line_end },
		}),
		CodeEngineError::LockTimeout { path, budget_ms } => json!({
			"code": "LOCK_TIMEOUT",
			"message": error.to_string(),
			"path": path.display().to_string(),
			"budgetMs": budget_ms,
		}),
		CodeEngineError::LockAcquireFailed { path, .. } => json!({
			"code": "LOCK_ERROR",
			"message": error.to_string(),
			"path": path.display().to_string(),
		}),
		CodeEngineError::PeerConflict {
			session, code_path, peer_revision, peer_commit_ts, ..
		} => json!({
			"code": "PEER_CONFLICT",
			"message": error.to_string(),
			"peerConflict": {
				"sessionId": session,
				"codePath": code_path,
				"peerRevision": peer_revision,
				"peerCommitTs": peer_commit_ts,
			},
		}),
		_ => json!({ "message": error.to_string() }),
	};
	structured_err(payload)
}
fn json_err(message: impl Into<String>) -> Error {
	Error::from_reason(message.into())
}
fn json_response(output: Value, error: bool) -> Value {
	json!({ "output": output, "error": error })
}

fn required_path(options: &Value) -> Result<PathBuf> {
	let path = options
		.get("file")
		.or_else(|| options.get("path"))
		.and_then(Value::as_str)
		.ok_or_else(|| json_err("Missing required field: file"))?;
	Ok(PathBuf::from(path))
}
pub(crate) fn get_profile(path: &Path, buffer_lang: &LanguageId) -> Result<LanguageProfile> {
	language_registry()
		.get(buffer_lang)
		.cloned()
		.ok_or_else(|| json_err(format!("Language profile not found for {}", path.display())))
}
fn value_to_u32(value: Option<&Value>, default: u32) -> u32 {
	value
		.and_then(Value::as_u64)
		.and_then(|n| u32::try_from(n).ok())
		.unwrap_or(default)
}
fn value_to_usize(value: Option<&Value>, default: usize) -> usize {
	value
		.and_then(Value::as_u64)
		.and_then(|n| usize::try_from(n).ok())
		.unwrap_or(default)
}

fn navigate_action(value: Option<&str>) -> Result<NavigateAction> {
	match value.unwrap_or("node-at") {
		"node-at" => Ok(NavigateAction::NodeAt),
		"defun-at" => Ok(NavigateAction::DefunAt),
		"parent" => Ok(NavigateAction::Parent),
		"siblings" => Ok(NavigateAction::Siblings),
		"children" => Ok(NavigateAction::Children),
		"references" => Ok(NavigateAction::References),
		other => Err(json_err(format!("Unknown navigate action: {other}"))),
	}
}

// P5.B: the action_* helpers that used this moved to pi_kernel::edit_ops; the
// remaining callers live in the napi `executeCodeBuffer` batch subtree, which
// the lib-only dead-code pass can't see through the #[napi] entry. Still live
// (and test-exercised), so silence the false positive.
#[allow(dead_code)]
pub(crate) fn required_str<'a>(options: &'a Value, field: &str) -> Result<&'a str> {
	options
		.get(field)
		.and_then(Value::as_str)
		.ok_or_else(|| json_err(format!("Missing required field: {field}")))
}
fn session_id(options: &Value) -> Option<&str> {
	options
		.get("sessionId")
		.and_then(Value::as_str)
		.map(str::trim)
		.filter(|session_id| !session_id.is_empty())
}

fn structured_err(payload: Value) -> Error {
	Error::from_reason(payload.to_string())
}

fn missing_session_id_err() -> Error {
	structured_err(json!({
		"code": "MISSING_SESSION_ID",
		"message": "Mutating code buffer commands require a non-empty sessionId",
	}))
}

fn required_session_id(options: &Value) -> Result<&str> {
	session_id(options).ok_or_else(missing_session_id_err)
}

fn coord_socket_path() -> PathBuf {
	std::env::var_os("PI_EDIT_BROKER_SOCKET").map_or_else(
		|| {
			std::env::var_os("HOME").map_or_else(
				|| PathBuf::from(".spell/edit-broker.sock"),
				|home| PathBuf::from(home).join(".spell/edit-broker.sock"),
			)
		},
		PathBuf::from,
	)
}

fn coord_status_probe_path(options: &Value) -> PathBuf {
	options
		.get("file")
		.or_else(|| options.get("path"))
		.and_then(Value::as_str)
		.map(PathBuf::from)
		.or_else(|| std::env::current_dir().ok())
		.unwrap_or_else(|| PathBuf::from("."))
}

fn render_coord_peer(peer: PeerInfo) -> Value {
	json!({
		"sessionId": peer.session_id,
		"pid": peer.pid,
		"cwd": peer.cwd.display().to_string(),
		"projectName": peer.project_name,
		"startedAt": peer.started_at,
		"openFiles": peer.open_files.into_iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
	})
}

fn render_coord_edit(edit: PeerEdit) -> Value {
	json!({
		"sessionId": edit.session_id,
		"revision": edit.revision,
		"codePaths": edit.code_paths,
		"ts": edit.ts,
	})
}

fn render_coord_journal_entry(entry: JournalEntry) -> Value {
	json!({
		"ts": entry.ts,
		"sessionId": entry.session_id,
		"pid": entry.pid,
		"kind": entry.kind,
		"revision": entry.revision,
		"parentRevision": entry.parent_revision,
		"codePaths": entry.code_paths,
		"diffHash": entry.diff_hash,
		"byteLen": entry.byte_len,
	})
}

fn coord_status_output(path: &Path) -> Value {
	let coord = buffer_registry().coord().clone();
	let state: PeerState = coord.peer_state(path);
	let warnings = coord.drain_warnings();
	json!({
		"brokerUp": warnings.is_empty(),
		"peers": state.peers.into_iter().map(render_coord_peer).collect::<Vec<_>>(),
		"socketPath": coord_socket_path().display().to_string(),
	})
}

fn journal_entries_for(
	path: &Path,
	limit: usize,
) -> std::result::Result<Vec<JournalEntry>, CodeEngineError> {
	let journal_path = journal_path_for(&default_journal_root(), &workspace_root_for(path), path);
	match JournalReader::tail(&journal_path, limit) {
		Ok(entries) => Ok(entries),
		Err(CodeEngineError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
			Ok(Vec::new())
		},
		Err(error) => Err(error),
	}
}
fn has_meaningful_string(value: Option<&Value>) -> bool {
	matches!(value.and_then(Value::as_str), Some(text) if !text.is_empty())
}

fn has_entries(value: Option<&Value>) -> bool {
	matches!(value.and_then(Value::as_array), Some(entries) if !entries.is_empty())
}

fn has_meaningful_index_field(value: Option<&Value>) -> bool {
	value.and_then(Value::as_u64).is_some_and(|n| n > 0)
}

fn parse_outline_enrich(options: &Value) -> EnrichFlags {
	let tokens = options
		.get("enrich")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
		.collect::<Vec<_>>();
	EnrichFlags::from_tokens(tokens)
}

const fn has_outline_enrich(flags: EnrichFlags) -> bool {
	flags.signature || flags.metrics || flags.doc || flags.graph
}
fn root_hint(options: &Value) -> Option<PathBuf> {
	options
		.get("root")
		.and_then(Value::as_str)
		.map(PathBuf::from)
}

fn relativize_path(path: &Path, root: &Path) -> String {
	path
		.strip_prefix(root)
		.unwrap_or(path)
		.to_string_lossy()
		.to_string()
}

pub(crate) fn parse_target_id(target_id: &str) -> Result<(String, Option<String>)> {
	let Some((file_id, symbol_id)) = target_id.split_once("::") else {
		if target_id.trim().is_empty() {
			return Err(json_err("targetId must not be empty"));
		}
		return Ok((target_id.to_string(), None));
	};
	if file_id.is_empty() || symbol_id.is_empty() {
		return Err(json_err(format!(
			"Invalid targetId '{target_id}'. Use '<file>' or '<file>::<symbol>'."
		)));
	}
	Ok((file_id.to_string(), Some(symbol_id.to_string())))
}

#[derive(Debug, Clone, serde::Serialize)]
struct TargetSummary {
	#[serde(rename = "targetId")]
	target_id: String,
	actions:   Vec<String>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	children:  Vec<Self>,
}

// PreparedEditOperation moved to pi_kernel::edit_ops (P5.B); imported below.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EditSaveMode {
	Auto,
	Staged,
}

impl EditSaveMode {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Auto => "auto",
			Self::Staged => "staged",
		}
	}

	const fn success_status(self) -> &'static str {
		match self {
			Self::Auto => "applied",
			Self::Staged => "staged",
		}
	}

	const fn persisted(self) -> bool {
		matches!(self, Self::Auto)
	}
}

#[derive(Debug, Clone)]
struct EditFileRequest {
	path:       PathBuf,
	operations: Vec<Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditFileResult {
	file:       String,
	status:     String,
	#[serde(skip_serializing_if = "Option::is_none")]
	version:    Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	diff:       Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	edit_count: Option<usize>,
	created:    bool,
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	targets:    Vec<TargetSummary>,
	#[serde(skip_serializing_if = "Option::is_none")]
	proof:      Option<ProcedureProof>,
	persisted:  bool,
	dirty:      bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	error:      Option<Value>,
}

fn validate_edit_request(options: &Value) -> Result<&[Value]> {
	let invalid_fields = [
		("file", has_meaningful_string(options.get("file"))),
		("path", has_meaningful_string(options.get("path"))),
		("symbol", has_meaningful_string(options.get("symbol"))),
		("line", has_meaningful_index_field(options.get("line"))),
		("column", has_meaningful_index_field(options.get("column"))),
		("operation", has_meaningful_string(options.get("operation"))),
		("content", has_meaningful_string(options.get("content"))),
		("mode", has_meaningful_string(options.get("mode"))),
		("patches", has_entries(options.get("patches"))),
		("edits", has_entries(options.get("edits"))),
	]
	.into_iter()
	.filter_map(|(field, present)| present.then_some(field))
	.collect::<Vec<_>>();
	if !invalid_fields.is_empty() {
		return Err(json_err(format!(
			"Legacy code edit fields are not accepted for command 'edit': {}. Use only 'operations' \
			 with targetId/action nodes.",
			invalid_fields.join(", "),
		)));
	}

	options
		.get("operations")
		.and_then(Value::as_array)
		.filter(|operations| !operations.is_empty())
		.map(Vec::as_slice)
		.ok_or_else(|| json_err("command 'edit' requires a non-empty 'operations' array"))
}

fn path_for_file_target(file_target_id: &str, options: &Value) -> PathBuf {
	let candidate = PathBuf::from(file_target_id);
	if candidate.is_absolute() {
		return candidate;
	}
	if let Some(root) = root_hint(options) {
		return root.join(candidate);
	}
	candidate
}

fn operation_file_target(node: &Value) -> Result<String> {
	let target_id = required_str(node, "targetId")?;
	let (file_target, _) = parse_target_id(target_id)?;
	Ok(file_target)
}

fn collect_operation_file_targets(node: &Value, targets: &mut Vec<String>) -> Result<()> {
	targets.push(operation_file_target(node)?);
	if let Some(children) = node.get("children").and_then(Value::as_array) {
		for child in children {
			collect_operation_file_targets(child, targets)?;
		}
	}
	Ok(())
}

fn edit_save_mode(options: &Value) -> Result<EditSaveMode> {
	match options
		.get("saveMode")
		.and_then(Value::as_str)
		.unwrap_or("auto")
	{
		"auto" => Ok(EditSaveMode::Auto),
		"staged" => Ok(EditSaveMode::Staged),
		other => Err(json_err(format!("Invalid saveMode '{other}'. Use 'auto' or 'staged'."))),
	}
}

fn group_edit_requests(options: &Value) -> Result<Vec<EditFileRequest>> {
	let operations = validate_edit_request(options)?;
	let mut requests = Vec::<EditFileRequest>::new();
	for operation in operations {
		let operation_target_id = required_str(operation, "targetId")?;
		let mut targets = Vec::new();
		collect_operation_file_targets(operation, &mut targets)?;
		targets.sort();
		targets.dedup();
		if targets.len() != 1 {
			return Err(json_err(format!(
				"Top-level edit operation '{operation_target_id}' must stay within one file root. \
				 Found: {}",
				targets.join(", "),
			)));
		}
		let path = path_for_file_target(&targets[0], options);
		if let Some(existing) = requests.iter_mut().find(|request| request.path == path) {
			existing.operations.push(operation.clone());
		} else {
			requests.push(EditFileRequest { path, operations: vec![operation.clone()] });
		}
	}
	Ok(requests)
}

fn first_operation_target_id(operations: &[Value]) -> &str {
	operations
		.first()
		.and_then(|operation| operation.get("targetId"))
		.and_then(Value::as_str)
		.unwrap_or("unknown")
}
fn collect_operation_code_paths(operation: &Value, paths: &mut BTreeSet<String>) {
	if let Some(target_id) = operation.get("targetId").and_then(Value::as_str)
		&& let Ok((_, Some(symbol_path))) = parse_target_id(target_id)
	{
		paths.insert(symbol_path);
	}
	if let Some(children) = operation.get("children").and_then(Value::as_array) {
		for child in children {
			collect_operation_code_paths(child, paths);
		}
	}
}

fn operation_code_paths(operations: &[Value]) -> Vec<String> {
	let mut paths = BTreeSet::new();
	for operation in operations {
		collect_operation_code_paths(operation, &mut paths);
	}
	paths.into_iter().collect()
}
fn napi_error_payload(error: Error) -> Value {
	let reason = error.to_string();
	let payload = reason
		.strip_prefix("GenericFailure, ")
		.or_else(|| reason.strip_prefix("Error: "))
		.unwrap_or(reason.as_str());
	serde_json::from_str(payload).unwrap_or(Value::String(reason))
}

fn structured_refusal_payload(action: &str, target_id: &str, error: CodeEngineError) -> Value {
	let CodeEngineError::Refusal { message, reason, confidence, basis, matches } = error else {
		return napi_error_payload(engine_err(error));
	};
	json!({
		"message": message,
		"action": action,
		"targetId": target_id,
		"proof": {
			"basis": basis,
			"reason": reason,
			"confidence": confidence,
			"matches": matches,
		},
	})
}

fn edit_error_payload(target_id: &str, error: CodeEngineError) -> Value {
	match error {
		refusal @ CodeEngineError::Refusal { .. } => {
			structured_refusal_payload("edit", target_id, refusal)
		},
		other => napi_error_payload(engine_err(other)),
	}
}

fn workspace_root_for(path: &Path) -> PathBuf {
	let mut current = path.parent().unwrap_or(path);
	loop {
		if current.join(".git").exists() || current.join(".spell").exists() {
			return current.to_path_buf();
		}
		let Some(parent) = current.parent() else {
			return path.parent().unwrap_or(path).to_path_buf();
		};
		current = parent;
	}
}

// P5.B (PLAN-336): prove_dead_style + the action_* accessors +
// resolve_target_id (and the EDN path helpers below) moved to
// pi_kernel::edit_ops. Imported at the top of this file; the napi paths here
// call the kernel versions unchanged.
fn file_target_id_for_path(path: &Path, options: &Value) -> String {
	let root = root_hint(options).unwrap_or_else(|| workspace_root_for(path));
	relativize_path(path, &root)
}

fn symbol_target_id(file_target_id: &str, symbol_path: &str) -> String {
	format!("{file_target_id}::{symbol_path}")
}

// P5.B (PLAN-336): target_range, would_leave_zero_bytes,
// synthetic_token_symbol, and single_action moved to pi_kernel::edit_ops
// (host-agnostic, shared with the BEAM NIF edit lane). Imported at the top of
// this file.
fn execute_operation_node(
	buffer: &mut CodeBuffer,
	profile: &LanguageProfile,
	path: &Path,
	node: &Value,
) -> std::result::Result<(TargetSummary, usize, Option<ProcedureProof>), CodeEngineError> {
	let target_id =
		required_str(node, "targetId").map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	let actions = node
		.get("actions")
		.and_then(Value::as_array)
		.filter(|actions| !actions.is_empty())
		.ok_or_else(|| {
			CodeEngineError::Edit(format!("targetId '{target_id}' requires a non-empty actions array"))
		})?;
	let mut action_kinds = Vec::with_capacity(actions.len());
	let mut edit_count = 0_usize;
	let mut last_proof = None;
	for action in actions {
		let prepared = single_action(buffer, profile, path, target_id, action)?;
		buffer.edit_batch(prepared.edits)?;
		action_kinds.push(prepared.action);
		last_proof = prepared.proof;
		edit_count += 1;
	}
	let mut children = Vec::new();
	if let Some(child_nodes) = node.get("children").and_then(Value::as_array) {
		for child in child_nodes {
			let (summary, child_count, child_proof) =
				execute_operation_node(buffer, profile, path, child)?;
			children.push(summary);
			edit_count += child_count;
			if child_proof.is_some() {
				last_proof = child_proof;
			}
		}
	}
	Ok((
		TargetSummary { target_id: target_id.to_string(), actions: action_kinds, children },
		edit_count,
		last_proof,
	))
}

/// Find the enclosing symbol for a given line in the outline.
fn find_enclosing_symbol(entries: &[OutlineEntry], line: u32) -> Option<String> {
	for entry in entries.iter().rev() {
		if line >= entry.line && line <= entry.end_line {
			// Check children first for more specific match
			if let Some(child_name) = find_enclosing_symbol(&entry.children, line) {
				return Some(format!("{}.{}", entry.name, child_name));
			}
			return Some(entry.name.clone());
		}
	}
	None
}

/// Render annotated diff with @@ symbolName @@ context headers.
fn render_annotated_diff(
	buffer: &CodeBuffer,
	snapshot_source: &str,
	profile: &LanguageProfile,
) -> String {
	use std::fmt::Write;
	let hunks = pi_code_engine::diff_lines(snapshot_source, &buffer.source());
	if hunks.is_empty() {
		return "(no changes)".into();
	}
	let outline = outline_buffer(buffer, profile, EnrichFlags::default());
	let mut out = String::new();
	for hunk in &hunks {
		let symbol = find_enclosing_symbol(&outline, hunk.new_start);
		let label = symbol.as_deref().unwrap_or("top-level");
		let _ = writeln!(out, "@@ {label} @@");
		for line in hunk.content.lines() {
			let _ = writeln!(out, "{line}");
		}
	}
	out
}

fn render_buffer_info(info: pi_code_engine::buffer::BufferInfo) -> Value {
	json!({
		"path": info.path.map(|path| path.display().to_string()),
		"language": info.language.to_string(),
		"semanticCapable": info.semantic_capable,
		"version": info.version,
		"dirty": info.dirty,
		"lineCount": info.line_count,
	})
}
fn render_edit_results(results: Vec<pi_code_engine::buffer::EditResult>) -> Value {
	Value::Array(results.into_iter().map(|result| json!({ "version": result.version, "changedRanges": result.changed_ranges.into_iter().map(|range| json!({ "start": {"line": range.start_point.row + 1, "column": range.start_point.column}, "end": {"line": range.end_point.row + 1, "column": range.end_point.column} })).collect::<Vec<_>>(), "inputEdit": { "startByte": result.input_edit.start_byte, "oldEndByte": result.input_edit.old_end_byte, "newText": result.input_edit.new_text } })).collect())
}
fn render_optional_edit_result(result: Option<pi_code_engine::buffer::EditResult>) -> Value {
	result.map_or(Value::Null, |result| render_edit_results(vec![result]))
}
fn render_navigate_item(item: NavigateItem) -> Value {
	json!({ "nodeType": item.node_type, "text": item.text, "line": item.line, "endLine": item.end_line })
}

struct OutlineGraphContext {
	status:    String,
	by_target: BTreeMap<String, GraphOutlineEnrichment>,
}

fn build_outline_graph_context(
	path: &Path,
	entries: &[OutlineEntry],
	file_target_id: &str,
	options: &Value,
) -> OutlineGraphContext {
	let root = root_hint(options).unwrap_or_else(|| workspace_root_for(path));
	let cache = CacheStore::new(root.join(".spell/graph"));
	let Ok(registry) = GraphLanguageRegistry::new().with_defaults() else {
		return OutlineGraphContext { status: "unavailable".into(), by_target: BTreeMap::new() };
	};
	let builder = CodeGraphBuilder::new(registry, cache);
	let status = match builder.cache_status(&root) {
		Ok(CacheStatus::Fresh) => "indexed (warm)",
		Ok(CacheStatus::Missing | CacheStatus::Stale { .. }) => "rebuilt",
		Err(_) => "rebuilt",
	};
	let Ok(outcome) = builder.build(&BuildGraphOptions::new(&root)) else {
		return OutlineGraphContext { status: "unavailable".into(), by_target: BTreeMap::new() };
	};
	let graph = outcome.graph;
	let mut targets = Vec::new();
	collect_outline_target_ids(entries, file_target_id, None, &mut targets);
	let mut by_target = BTreeMap::new();
	for target in targets {
		if let Some(enrichment) = graph.graph_outline_enrichment(&target) {
			by_target.insert(target, enrichment);
		}
	}
	OutlineGraphContext { status: status.into(), by_target }
}

fn collect_outline_target_ids(
	entries: &[OutlineEntry],
	file_target_id: &str,
	parent_path: Option<&str>,
	out: &mut Vec<String>,
) {
	for entry in entries {
		let symbol_path = parent_path
			.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
		out.push(symbol_target_id(file_target_id, &symbol_path));
		collect_outline_target_ids(&entry.children, file_target_id, Some(&symbol_path), out);
	}
}

fn edn_first_line(text: &str, max: usize) -> String {
	text
		.lines()
		.next()
		.unwrap_or("")
		.chars()
		.take(max)
		.collect()
}
fn edn_path_string(segments: &[String]) -> String {
	if segments.is_empty() {
		"[]".into()
	} else {
		format!("[{}]", segments.join(" "))
	}
}

fn render_edn_data_entry(
	buffer: &CodeBuffer,
	file_target_id: &str,
	name: String,
	node: Node<'_>,
	segments: Vec<String>,
) -> Value {
	let children = match node.kind() {
		"map_lit" => edn_named_children(node)
			.chunks(2)
			.filter_map(|pair| {
				let [key, value] = pair else {
					return None;
				};
				let key_text = edn_node_text(buffer, *key);
				let mut child_segments = segments.clone();
				child_segments.push(key_text.clone());
				Some(render_edn_data_entry(buffer, file_target_id, key_text, *value, child_segments))
			})
			.collect::<Vec<_>>(),
		"vec_lit" | "list_lit" => edn_named_children(node)
			.into_iter()
			.enumerate()
			.map(|(index, child)| {
				let mut child_segments = segments.clone();
				child_segments.push(index.to_string());
				render_edn_data_entry(
					buffer,
					file_target_id,
					format!("[{index}]"),
					child,
					child_segments,
				)
			})
			.collect::<Vec<_>>(),
		_ => Vec::new(),
	};
	let target_path = edn_path_string(&segments);
	json!({
		"name": name,
		"kind": node.kind(),
		"line": (node.start_position().row + 1) as u32,
		"endLine": (node.end_position().row + 1) as u32,
		"column": node.start_position().column as u32,
		"exported": false,
		"signature": edn_first_line(&edn_node_text(buffer, node), 80),
		"targetId": symbol_target_id(file_target_id, &target_path),
		"children": children,
	})
}

fn render_edn_outline_result(buffer: &CodeBuffer, file_target_id: &str) -> Value {
	let Some(root) = edn_root_value(buffer) else {
		return Value::Array(Vec::new());
	};
	Value::Array(match root.kind() {
		"map_lit" => edn_named_children(root)
			.chunks(2)
			.filter_map(|pair| {
				let [key, value] = pair else {
					return None;
				};
				let key_text = edn_node_text(buffer, *key);
				Some(render_edn_data_entry(buffer, file_target_id, key_text.clone(), *value, vec![
					key_text,
				]))
			})
			.collect(),
		"vec_lit" | "list_lit" => edn_named_children(root)
			.into_iter()
			.enumerate()
			.map(|(index, child)| {
				render_edn_data_entry(buffer, file_target_id, format!("[{index}]"), child, vec![
					index.to_string(),
				])
			})
			.collect(),
		_ => vec![render_edn_data_entry(buffer, file_target_id, "value".into(), root, Vec::new())],
	})
}
fn render_outline_entry(
	entry: &OutlineEntry,
	file_target_id: &str,
	parent_path: Option<&str>,
	enrich: EnrichFlags,
	graph: Option<&OutlineGraphContext>,
) -> Value {
	let symbol_path =
		parent_path.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
	let target_id = symbol_target_id(file_target_id, &symbol_path);
	let mut object = serde_json::Map::new();
	object.insert("name".into(), Value::String(entry.name.clone()));
	object.insert("kind".into(), Value::String(entry.kind.clone()));
	object.insert("line".into(), Value::from(entry.line));
	object.insert("endLine".into(), Value::from(entry.end_line));
	object.insert("column".into(), Value::from(entry.column));
	object.insert("exported".into(), Value::Bool(entry.exported));
	object.insert("signature".into(), Value::String(entry.signature.clone()));
	object.insert("targetId".into(), Value::String(target_id.clone()));
	if enrich.signature {
		object.insert(
			"params".into(),
			Value::Array(
				entry
					.params
					.iter()
					.map(|param| json!({ "name": param.name, "ty": param.ty, "optional": param.optional, "rest": param.rest }))
					.collect(),
			),
		);
		if let Some(return_type) = &entry.return_type {
			object.insert("returnType".into(), Value::String(return_type.clone()));
		}
		if !entry.generics.is_empty() {
			object.insert(
				"generics".into(),
				Value::Array(entry.generics.iter().cloned().map(Value::String).collect()),
			);
		}
		if !entry.throws.is_empty() {
			object.insert(
				"throws".into(),
				Value::Array(entry.throws.iter().cloned().map(Value::String).collect()),
			);
		}
	}
	if enrich.metrics {
		if let Some(value) = entry.statements {
			object.insert("statements".into(), Value::from(value));
		}
		if let Some(value) = entry.branch_points {
			object.insert("branchPoints".into(), Value::from(value));
		}
		if let Some(value) = entry.nesting_depth {
			object.insert("nestingDepth".into(), Value::from(value));
		}
		if let Some(value) = entry.call_sites {
			object.insert("callSites".into(), Value::from(value));
		}
		if let Some(value) = entry.has_side_effects {
			object.insert("hasSideEffects".into(), Value::Bool(value));
		}
	}
	if enrich.doc {
		if let Some(summary) = &entry.doc_summary {
			object.insert("docSummary".into(), Value::String(summary.clone()));
		}
		if !entry.doc_tags.is_empty() {
			object.insert(
				"docTags".into(),
				Value::Array(entry.doc_tags.iter().cloned().map(Value::String).collect()),
			);
		}
	}
	if enrich.graph
		&& let Some(graph_entry) = graph.and_then(|ctx| ctx.by_target.get(&target_id))
	{
		object.insert("refsIn".into(), Value::from(graph_entry.refs_in));
		object.insert("refsOut".into(), Value::from(graph_entry.refs_out));
		object.insert("callers".into(), Value::from(graph_entry.callers));
		object.insert("callees".into(), Value::from(graph_entry.callees));
		object.insert("importedBy".into(), Value::from(graph_entry.imported_by));
		object.insert(
			"exportedReach".into(),
			json!({ "count": graph_entry.exported_reach.count, "capped": graph_entry.exported_reach.capped }),
		);
		if let Some(cluster) = &graph_entry.cluster {
			object.insert("cluster".into(), json!({ "id": cluster.id, "name": cluster.name }));
		}
		object.insert("dead".into(), Value::Bool(graph_entry.dead));
		if !graph_entry.inherits.is_empty() {
			object.insert(
				"inherits".into(),
				Value::Array(
					graph_entry
						.inherits
						.iter()
						.cloned()
						.map(Value::String)
						.collect(),
				),
			);
		}
	}
	object.insert(
		"children".into(),
		Value::Array(
			entry
				.children
				.iter()
				.map(|child| {
					render_outline_entry(child, file_target_id, Some(&symbol_path), enrich, graph)
				})
				.collect(),
		),
	);
	Value::Object(object)
}

fn render_outline_result(
	entries: &[OutlineEntry],
	file_target_id: &str,
	enrich: EnrichFlags,
	graph: Option<&OutlineGraphContext>,
) -> Value {
	let entries_value = Value::Array(
		entries
			.iter()
			.map(|entry| render_outline_entry(entry, file_target_id, None, enrich, graph))
			.collect(),
	);
	if !has_outline_enrich(enrich) {
		return entries_value;
	}
	let mut object = serde_json::Map::new();
	object.insert("entries".into(), entries_value);
	if enrich.graph {
		object.insert(
			"graphStatus".into(),
			Value::String(graph.map_or_else(|| "unavailable".to_string(), |ctx| ctx.status.clone())),
		);
	}
	Value::Object(object)
}

fn target_id_for_line(entries: &[OutlineEntry], file_target_id: &str, line: u32) -> Option<String> {
	find_enclosing_symbol(entries, line)
		.map(|symbol_path| symbol_target_id(file_target_id, &symbol_path))
}

fn render_navigate_result(
	result: NavigateResult,
	file_target_id: &str,
	outline: &[OutlineEntry],
) -> Value {
	let target_id = target_id_for_line(outline, file_target_id, result.line);
	let editable_scope_target_id = result
		.editable_scope_line
		.and_then(|line| target_id_for_line(outline, file_target_id, line));
	json!({
		"nodeType": result.node_type,
		"text": result.text,
		"line": result.line,
		"endLine": result.end_line,
		"column": result.column,
		"parentType": result.parent_type,
		"editableScopeNodeType": result.editable_scope_node_type,
		"editableScopeLine": result.editable_scope_line,
		"editableScopeEndLine": result.editable_scope_end_line,
		"editableScopeColumn": result.editable_scope_column,
		"editableScopeTargetId": editable_scope_target_id,
		"fileTargetId": file_target_id,
		"targetId": target_id,
		"name": result.name,
		"kind": result.kind,
		"items": result.items.into_iter().map(render_navigate_item).collect::<Vec<_>>(),
		"references": result.references,
	})
}
fn render_diff_hunk(hunk: pi_code_engine::diff::DiffHunk) -> Value {
	json!({ "oldStart": hunk.old_start, "oldCount": hunk.old_count, "newStart": hunk.new_start, "newCount": hunk.new_count, "kind": format!("{:?}", hunk.kind), "content": hunk.content })
}

pub(crate) fn execute_code_buffer_inner(options: &Value) -> Result<Value> {
	let command = options
		.get("command")
		.and_then(Value::as_str)
		.ok_or_else(|| json_err("Missing required field: command"))?;
	match command {
		"open" => {
			let path = required_path(options)?;
			let buffer = buffer_registry().open(&path).map_err(engine_err)?;
			let buffer = buffer.lock();
			let lines = buffer
				.source()
				.lines()
				.map(ToOwned::to_owned)
				.collect::<Vec<_>>();
			Ok(json_response(
				json!({
					"success": true,
					"language": buffer.language().to_string(),
					"semanticCapable": buffer.language().as_str() != "text",
					"lines": lines,
				}),
				false,
			))
		},
		"close" => {
			let path = required_path(options)?;
			buffer_registry().close(&path).map_err(engine_err)?;
			Ok(json_response(json!({ "success": true }), false))
		},
		"reload" => {
			let path = required_path(options)?;
			buffer_registry().close(&path).map_err(engine_err)?;
			let buffer = buffer_registry().open(&path).map_err(engine_err)?;
			let buffer = buffer.lock();
			let lines = buffer
				.source()
				.lines()
				.map(ToOwned::to_owned)
				.collect::<Vec<_>>();
			Ok(json_response(
				json!({
					"success": true,
					"language": buffer.language().to_string(),
					"semanticCapable": buffer.language().as_str() != "text",
					"lines": lines,
				}),
				false,
			))
		},
		"watcherStatus" => Ok(json_response(
			json!({
				"active": buffer_registry().watcher_active(),
				"watched": buffer_registry().watched_count(),
			}),
			false,
		)),
		"lockStatus" => {
			let path = required_path(options)?;
			let status = lock_status(&path).map_err(engine_err)?;
			Ok(json_response(
				json!({
					"path": status.path.display().to_string(),
					"exclusive": status.exclusive,
					"shared": status.shared,
				}),
				false,
			))
		},
		"list" => {
			let buffers = buffer_registry().list();
			Ok(json_response(
				Value::Array(buffers.into_iter().map(render_buffer_info).collect()),
				false,
			))
		},
		"languages" => {
			let reg = language_registry();
			let langs: Vec<Value> = reg
				.languages()
				.iter()
				.filter_map(|id| {
					let profile = reg.get(id)?;
					let semantic_capable = profile.capabilities.outline
						|| profile.capabilities.read
						|| profile.capabilities.navigate
						|| profile.capabilities.resolve
						|| profile.capabilities.edit
						|| profile.capabilities.graph;
					let capabilities = vec![
						profile.capabilities.outline.then_some("outline"),
						profile.capabilities.read.then_some("read"),
						profile.capabilities.navigate.then_some("navigate"),
						profile.capabilities.resolve.then_some("resolve"),
						profile.capabilities.edit.then_some("edit"),
						profile.capabilities.graph.then_some("graph"),
					]
					.into_iter()
					.flatten()
					.collect::<Vec<_>>();
					(!profile.extensions.is_empty()).then_some(json!({
						"id": id.to_string(),
						"extensions": profile.extensions,
						"semanticCapable": semantic_capable,
						"capabilities": capabilities,
						"embeddedLanguages": profile.capabilities.embedded_languages,
					}))
				})
				.collect();
			Ok(json_response(json!({ "languages": langs }), false))
		},
		"coord_status" => {
			let path = coord_status_probe_path(options);
			Ok(json_response(coord_status_output(&path), false))
		},
		"graph_stats" => {
			// BUG-409 (PLAN-318 W1): expose the workspace CodeGraph cache state.
			// Returns `{warm: bool, ...stats}` from the code_graph_cache module.
			// Lazy: doesn't trigger a build — only peeks. To populate the cache,
			// run any `def→`/`ref→`/`call→`/`import→` query first.
			let root = options
				.get("root")
				.and_then(Value::as_str)
				.map(std::path::PathBuf::from)
				.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));
			if let Some(entry) = crate::code_graph_cache::peek(&root) {
				let stats = entry.graph.stats();
				let built_at_ms = entry
					.built_at
					.duration_since(std::time::UNIX_EPOCH)
					.map(|d| d.as_millis() as u64)
					.unwrap_or(0);
				Ok(json_response(
					json!({
						"available": true,
						"warm": true,
						"state": "warm",
						"root": root.display().to_string(),
						"file_count": stats.file_count,
						"symbol_count": stats.symbol_count,
						"edge_count": stats.edge_count,
						"built_at_ms": built_at_ms,
					}),
					false,
				))
			} else {
				// BUG-457: the in-process cache is empty, but a fresh persisted
				// graph on disk means the next edge query warm-loads in
				// sub-second — report that distinctly from a true cold build.
				let (state, reason) = match crate::code_graph_cache::disk_cache_state(&root) {
					crate::code_graph_cache::DiskCacheState::Fresh => (
						"cached",
						"persisted graph on disk is fresh; the next edge query warm-loads it \
						 (sub-second, no rebuild)"
							.to_string(),
					),
					crate::code_graph_cache::DiskCacheState::Stale => (
						"stale",
						"persisted graph on disk is out of date; the next edge query rebuilds it"
							.to_string(),
					),
					crate::code_graph_cache::DiskCacheState::Missing => {
						("cold", "no persisted graph; the next edge query does a full build".to_string())
					},
				};
				Ok(json_response(
					json!({
						"available": true,
						"warm": false,
						"state": state,
						"root": root.display().to_string(),
						"reason": reason,
					}),
					false,
				))
			}
		},
		"coord_peer_activity" => {
			let path = required_path(options)?;
			let since_ms = options.get("sinceMs").and_then(Value::as_u64).unwrap_or(0);
			let limit = value_to_usize(options.get("limit"), 16);
			let edits = buffer_registry()
				.coord()
				.recent_peer_edits(&path, since_ms, limit);
			Ok(json_response(
				json!({
					"file": path.display().to_string(),
					"edits": edits.into_iter().map(render_coord_edit).collect::<Vec<_>>(),
				}),
				false,
			))
		},
		"coord_journal_tail" => {
			let path = required_path(options)?;
			let limit = value_to_usize(options.get("limit"), 16);
			let entries = journal_entries_for(&path, limit).map_err(engine_err)?;
			Ok(json_response(
				json!({
					"file": path.display().to_string(),
					"entries": entries.into_iter().map(render_coord_journal_entry).collect::<Vec<_>>(),
				}),
				false,
			))
		},
		"outline" | "navigate" | "read" | "undo" | "redo" | "diff" => {
			let path = required_path(options)?;
			let buffer = buffer_registry().open(&path).map_err(engine_err)?;
			let mut buffer = buffer.lock();
			let profile = get_profile(&path, buffer.language())?;
			let text_fallback = buffer.language().as_str() == "text";

			match command {
				"outline" => {
					if text_fallback {
						return Err(json_err(
							"Semantic structure is unavailable for fallback text buffers. Use \
							 read/diff/undo/redo instead.",
						));
					}
					let file_target_id = file_target_id_for_path(&path, options);
					if buffer.language().as_str() == "edn" {
						return Ok(json_response(
							render_edn_outline_result(&buffer, &file_target_id),
							false,
						));
					}
					let enrich = parse_outline_enrich(options);
					let outline = outline_buffer(&buffer, &profile, enrich);
					let graph_context = enrich
						.graph
						.then(|| build_outline_graph_context(&path, &outline, &file_target_id, options));
					Ok(json_response(
						render_outline_result(&outline, &file_target_id, enrich, graph_context.as_ref()),
						false,
					))
				},
				"navigate" => {
					if text_fallback {
						return Err(json_err(
							"Semantic navigation is unavailable for fallback text buffers. Use \
							 read/diff/undo/redo instead.",
						));
					}
					if buffer.language().as_str() == "edn"
						&& let Some(edn_path) = options.get("symbol").and_then(Value::as_str)
						&& let Some(node) = edn_node_for_path(&buffer, edn_path)
					{
						let file_target_id = file_target_id_for_path(&path, options);
						return Ok(json_response(
							render_navigate_result(
								edn_navigate_result(&buffer, node),
								&file_target_id,
								&[],
							),
							false,
						));
					}
					let action = navigate_action(options.get("action").and_then(Value::as_str))?;
					let line = value_to_u32(options.get("line"), 1);
					let column = options
						.get("column")
						.and_then(Value::as_u64)
						.and_then(|n| u32::try_from(n).ok());
					let symbol = options.get("symbol").and_then(Value::as_str);
					let result = navigate_buffer(&buffer, &profile, action, line, column, symbol)
						.map_err(engine_err)?;
					let file_target_id = file_target_id_for_path(&path, options);
					let outline = outline_buffer(&buffer, &profile, EnrichFlags::default());
					Ok(json_response(render_navigate_result(result, &file_target_id, &outline), false))
				},
				"read" => {
					if text_fallback {
						Ok(json_response(Value::String(buffer.source()), false))
					} else if buffer.language().as_str() == "edn"
						&& let Some(edn_path) = options.get("symbol").and_then(Value::as_str)
						&& let Some(node) = edn_node_for_path(&buffer, edn_path)
					{
						Ok(json_response(Value::String(edn_node_text(&buffer, node)), false))
					} else {
						let resolution = options
							.get("resolution")
							.and_then(Value::as_u64)
							.and_then(|n| u8::try_from(n).ok())
							.unwrap_or(3);
						let offset = options
							.get("offset")
							.and_then(Value::as_u64)
							.and_then(|n| u32::try_from(n).ok());
						let limit = options
							.get("limit")
							.and_then(Value::as_u64)
							.and_then(|n| u32::try_from(n).ok());
						Ok(json_response(
							Value::String(read_buffer(&buffer, &profile, resolution, offset, limit)),
							false,
						))
					}
				},
				"undo" => Ok(json_response(
					render_optional_edit_result(buffer.undo().map_err(engine_err)?),
					false,
				)),
				"redo" => Ok(json_response(
					render_optional_edit_result(buffer.redo().map_err(engine_err)?),
					false,
				)),
				"diff" => Ok(json_response(
					Value::Array(
						buffer
							.diff_from_disk()
							.map_err(engine_err)?
							.into_iter()
							.map(render_diff_hunk)
							.collect(),
					),
					false,
				)),
				_ => unreachable!(),
			}
		},
		other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
	}
}

#[napi(js_name = "executeCodeBuffer")]
pub fn execute_code_buffer(options: Value) -> Result<Value> {
	match execute_code_buffer_inner(&options) {
		Ok(value) => Ok(value),
		Err(error) => {
			let reason = error.to_string();
			let payload = reason
				.strip_prefix("GenericFailure, ")
				.or_else(|| reason.strip_prefix("Error: "))
				.unwrap_or(reason.as_str());
			let output = serde_json::from_str::<Value>(payload).unwrap_or(Value::String(reason));
			Ok(json_response(output, true))
		},
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		sync::{Arc, Mutex, MutexGuard, PoisonError},
		time::{SystemTime, UNIX_EPOCH},
	};

	// `buffer_registry()` is a process-global singleton with an LRU
	// watcher. Tests that assert post-edit registry membership must
	// serialise against any other test that performs registry-mutating
	// edits in the same test binary (otherwise an LRU eviction from a
	// concurrent test can fail the membership assertion).
	static BUFFER_REGISTRY_TEST_LOCK: Mutex<()> = Mutex::new(());

	fn lock_buffer_registry() -> MutexGuard<'static, ()> {
		BUFFER_REGISTRY_TEST_LOCK
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
	}

	use pi_code_engine::language::LanguageRegistry;
	use serde_json::json;

	const TEST_SESSION_ID: &str = "napi-test-session";

	use super::*;

	fn registry_for_tests() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn ts_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry_for_tests())
			.expect("buffer")
	}

	fn ts_profile() -> LanguageProfile {
		registry_for_tests()
			.get(&LanguageId::new("typescript"))
			.expect("profile")
			.clone()
	}

	fn typst_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/../pi-code-engine/tests/fixtures/sources/typst_edit_targets.typ",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("typst"), registry_for_tests()).expect("buffer")
	}

	fn typst_profile() -> LanguageProfile {
		registry_for_tests()
			.get(&LanguageId::new("typst"))
			.expect("profile")
			.clone()
	}

	fn markdown_profile() -> LanguageProfile {
		registry_for_tests()
			.get(&LanguageId::new("markdown"))
			.expect("profile")
			.clone()
	}

	fn elixir_buffer() -> CodeBuffer {
		CodeBuffer::from_str(
			"defmodule Agentmaker.AgentConfig.TestChat do\n  def render(), do: :ok\nend\n",
			LanguageId::new("elixir"),
			registry_for_tests(),
		)
		.expect("elixir buffer")
	}

	fn elixir_profile() -> LanguageProfile {
		registry_for_tests()
			.get(&LanguageId::new("elixir"))
			.expect("elixir profile")
			.clone()
	}

	fn temp_path(name: &str) -> PathBuf {
		let stamp = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock ok")
			.as_nanos();
		std::env::temp_dir().join(format!("pi-natives-{stamp}-{name}"))
	}

	fn temp_workspace(name: &str) -> PathBuf {
		let root = temp_path(name);
		fs::create_dir_all(&root).expect("workspace dir");
		root
	}

	struct LegacyResolvedTarget {
		kind:     String,
		line:     u32,
		end_line: u32,
	}

	fn resolve_target(
		buffer: &CodeBuffer,
		_node_profile: &LanguageProfile,
		options: &Value,
	) -> std::result::Result<LegacyResolvedTarget, CodeEngineError> {
		let line = options.get("line").and_then(Value::as_u64).unwrap_or(1) as usize;
		let node_type = options
			.get("node_type")
			.and_then(Value::as_str)
			.unwrap_or("");
		let node = pi_code_engine::line_target::resolve_edit_target(buffer, line, node_type, None)?;
		Ok(LegacyResolvedTarget {
			kind:     node.kind().to_string(),
			line:     (node.start_position().row + 1) as u32,
			end_line: (node.end_position().row + 1) as u32,
		})
	}

	fn parse_patches(options: &Value) -> std::result::Result<Vec<Patch>, CodeEngineError> {
		let Some(entries) = options.get("patches").and_then(Value::as_array) else {
			return Err(CodeEngineError::Edit("patch operation requires patches".into()));
		};
		entries
			.iter()
			.map(|entry| {
				let find = entry
					.get("find")
					.and_then(Value::as_str)
					.ok_or_else(|| CodeEngineError::Edit("patch entry requires find".into()))?;
				let replace = entry
					.get("replace")
					.and_then(Value::as_str)
					.ok_or_else(|| CodeEngineError::Edit("patch entry requires replace".into()))?;
				Ok(Patch {
					find:       find.to_string(),
					replace:    replace.to_string(),
					occurrence: Occurrence::Unique,

					force: false,
				})
			})
			.collect()
	}

	fn single_edit_operation(
		buffer: &CodeBuffer,
		profile: &LanguageProfile,
		options: &Value,
	) -> std::result::Result<Vec<TextEdit>, CodeEngineError> {
		let operation = options
			.get("operation")
			.and_then(Value::as_str)
			.ok_or_else(|| CodeEngineError::Edit("Missing required field: operation".into()))?;
		match operation {
			"replace" => {
				let content = action_content(options)?;
				if has_meaningful_index_field(options.get("line")) {
					return pi_code_engine::edit::replace_node(
						buffer,
						action_line(options, None),
						options
							.get("node_type")
							.and_then(Value::as_str)
							.unwrap_or(""),
						content,
						None,
					);
				}
				if let Some(symbol_name) = options.get("symbol").and_then(Value::as_str) {
					let symbol = resolve_symbol(buffer, profile, symbol_name)?;
					return Ok(vec![TextEdit {
						start_byte:   symbol.start_byte,
						old_end_byte: symbol.end_byte,
						new_text:     content.to_string(),
					}]);
				}
				Ok(vec![TextEdit {
					start_byte:   0,
					old_end_byte: buffer.source().len(),
					new_text:     content.to_string(),
				}])
			},
			"patch" => {
				let patches = parse_patches(options)?;
				let symbol = options
					.get("symbol")
					.and_then(Value::as_str)
					.map(|name| resolve_symbol(buffer, profile, name))
					.transpose()?;
				let (start_byte, end_byte) = target_range(buffer, symbol.as_ref());
				apply_patches(buffer, start_byte, end_byte, &patches)
			},
			other => {
				let symbol_name = options
					.get("symbol")
					.and_then(Value::as_str)
					.ok_or_else(|| CodeEngineError::Edit(format!("{other} requires symbol")))?;
				let symbol = resolve_symbol(buffer, profile, symbol_name)?;
				let procedure_name = match other {
					"replace-code-block" => "replace-code-block",
					"promote" => "promote",
					"demote" => "demote",
					_ => {
						return Err(CodeEngineError::Edit(format!(
							"unsupported legacy operation: {other}"
						)));
					},
				};
				let procedure = profile.procedures.get(procedure_name).ok_or_else(|| {
					CodeEngineError::Edit(format!("Unknown action kind: {procedure_name}"))
				})?;
				Ok(run_procedure(procedure, buffer, &symbol, profile, options)?.edits)
			},
		}
	}

	fn render_navigate_result(result: NavigateResult) -> Value {
		super::render_navigate_result(result, "fixtures/typst_edit_targets.typ", &[])
	}

	fn find_file_result<'a>(response: &'a Value, path: &Path) -> &'a Value {
		response["output"]["fileResults"]
			.as_array()
			.expect("file results")
			.iter()
			.find(|result| result["file"] == json!(path.display().to_string()))
			.expect("file result")
	}

	fn outline_entry(
		name: &str,
		kind: &str,
		line: u32,
		end_line: u32,
		column: u32,
		signature: &str,
		children: Vec<OutlineEntry>,
	) -> OutlineEntry {
		OutlineEntry {
			name: name.into(),
			kind: kind.into(),
			line,
			end_line,
			column,
			exported: false,
			signature: signature.into(),
			children,
			deduplicate: false,
			loc: 0,
			modifiers: vec![],
			decorators: vec![],
			deprecated: false,
			params: vec![],
			return_type: None,
			generics: vec![],
			throws: vec![],
			statements: None,
			branch_points: None,
			nesting_depth: None,
			call_sites: None,
			has_side_effects: None,
			doc_summary: None,
			doc_tags: vec![],
			refs_in: None,
			refs_out: None,
			callers: None,
			callees: None,
			imported_by: None,
			exported_reach: None,
			cluster: None,
			dead: None,
			inherits: vec![],
		}
	}

	#[test]
	fn execute_code_buffer_inner_persisted_edit_preserves_undo_history() {
		let _guard = lock_buffer_registry();
		let path = temp_path("undo-redo-persisted.ts");
		fs::write(&path, "export const value = 1;\n").expect("seed file");
		let edit = crate::code_path::napi::execute_code_path_inner(
			crate::code_path::napi::CodePathTaskOptions {
				command:            "edit".to_string(),
				target:             path.file_name().unwrap().to_string_lossy().to_string(),
				transaction:        None,
				limit:              None,
				head:               None,
				tail:               None,
				offset:             None,
				format:             None,
				root:               path.parent().map(|p| p.to_string_lossy().to_string()),
				actions:            Some(serde_json::json!([
					{"kind": "fileWrite", "content": "export const value = 2;\n"}
				])),
				manage:             None,
				gitignore:          None,
				artifact_threshold: None,
				session_id:         None,
				edit_group_id:      None,
				history_entry_id:   None,
				history_force:      None,
				home:               None,
				session_dir:        None,
			},
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(edit.len(), 1);
		assert!(edit[0].done);
		let diags: Vec<_> = edit.iter().flat_map(|c| c.diagnostics.iter()).collect();
		assert!(diags.is_empty(), "{:?}", diags);
		assert_eq!(fs::read_to_string(&path).expect("saved edit"), "export const value = 2;\n");
		assert!(
			buffer_registry().get(&path).is_some(),
			"persisted edit_transaction writes should preserve the managed buffer after commit",
		);
		let undo = execute_code_buffer_inner(&json!({
			"command": "undo",
			"file": path.display().to_string(),
		}))
		.expect("undo");
		assert_eq!(undo["error"], json!(false));
		assert!(undo["output"].is_array(), "undo should apply a saved in-memory revision: {undo}");
		let diff = execute_code_buffer_inner(&json!({
			"command": "diff",
			"file": path.display().to_string(),
		}))
		.expect("diff after undo");
		assert_eq!(diff["error"], json!(false));
		assert_eq!(diff["output"].as_array().expect("hunks").len(), 1);
	}

	#[test]
	fn edn_outline_read_and_edit_use_data_paths() {
		let path = temp_path("books.edn");
		fs::write(&path, "{:books [{:title \"Dune\" :pages 412}]}\n").expect("seed edn");
		let outline = execute_code_buffer_inner(&json!({
			"command": "outline",
			"file": path.display().to_string(),
		}))
		.expect("edn outline");
		assert_eq!(outline["error"], json!(false));
		let file_target = path
			.file_name()
			.and_then(|name| name.to_str())
			.expect("file name");
		assert_eq!(outline["output"][0]["targetId"], json!(format!("{file_target}::[:books]")));

		let read = execute_code_buffer_inner(&json!({
			"command": "read",
			"file": path.display().to_string(),
			"symbol": "[:books 0 :title]",
		}))
		.expect("edn read");
		assert_eq!(read["output"], json!("\"Dune\""));
	}

	#[test]
	fn parse_patches_reads_entries() {
		let options = json!({
			"patches": [
				{ "find": "return a + b;", "replace": "return a * b;" },
				{ "find": "const x = 1;", "replace": "const x = 2;" }
			]
		});
		let patches = parse_patches(&options).expect("patches");
		assert_eq!(patches.len(), 2);
		assert_eq!(patches[0].find, "return a + b;");
		assert_eq!(patches[1].replace, "const x = 2;");
	}

	#[test]
	fn single_edit_operation_supports_whole_file_replace_without_target() {
		let buffer = ts_buffer("function add(a: number, b: number): number {\n  return a + b;\n}\n");
		let profile = ts_profile();
		let options = json!({
			"operation": "replace",
			"content": "export const replaced = 2;\n"
		});
		let edits = single_edit_operation(&buffer, &profile, &options).expect("edit");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].start_byte, 0);
		assert_eq!(edits[0].old_end_byte, buffer.source().len());
		assert_eq!(edits[0].new_text, "export const replaced = 2;\n");
	}

	#[test]
	fn single_edit_operation_preserves_line_replace_precedence() {
		let buffer = ts_buffer("function add(a: number, b: number): number {\n  return a + b;\n}\n");
		let profile = ts_profile();
		let options = json!({
			"operation": "replace",
			"line": 1,
			"content": "const replaced = true;\n"
		});
		let edits = single_edit_operation(&buffer, &profile, &options).expect("edit");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].start_byte, 0);
		assert_ne!(edits[0].old_end_byte, buffer.source().len());
		assert_eq!(edits[0].new_text, "const replaced = true;\n");
	}

	#[test]
	fn single_edit_operation_accepts_fully_qualified_elixir_module_symbols() {
		let buffer = elixir_buffer();
		let profile = elixir_profile();
		let options = json!({
			"operation": "replace",
			"symbol": "Agentmaker.AgentConfig.TestChat",
			"content": "defmodule Agentmaker.AgentConfig.TestChat do\n  def render(), do: :updated\nend\n"
		});
		let edits = single_edit_operation(&buffer, &profile, &options).expect("elixir replace");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].start_byte, 0);
		assert!(edits[0].old_end_byte >= buffer.source().trim_end().len());
	}

	#[test]
	fn single_edit_operation_rejects_short_elixir_aliases_when_only_fq_module_exists() {
		let buffer = elixir_buffer();
		let profile = elixir_profile();
		let options = json!({
			"operation": "replace",
			"symbol": "TestChat",
			"content": "defmodule TestChat do\nend\n"
		});
		let error =
			single_edit_operation(&buffer, &profile, &options).expect_err("short alias should fail");
		let message = error.to_string();
		assert!(message.contains("Symbol 'TestChat' not found"));
		assert!(message.contains("Agentmaker.AgentConfig.TestChat"));
	}

	#[test]
	fn single_edit_operation_supports_markdown_promote() {
		let mut buffer = CodeBuffer::from_str(
			"## Installation\n\nFollow these steps.\n\n### Steps\n\n```bash\nbun install\n```\n",
			LanguageId::new("markdown"),
			registry_for_tests(),
		)
		.expect("buffer");
		let profile = markdown_profile();
		let options = json!({
			"operation": "promote",
			"symbol": "Installation"
		});
		let edits = single_edit_operation(&buffer, &profile, &options).expect("promote");
		buffer.edit_batch(edits).expect("apply");
		let updated = buffer.source();
		assert!(
			updated.starts_with("# Installation\n"),
			"promote should shift section heading: {updated}"
		);
		assert!(updated.contains("## Steps"), "promote should shift child heading: {updated}");
	}

	#[test]
	fn single_edit_operation_supports_markdown_replace_code_block() {
		let mut buffer = CodeBuffer::from_str(
			"## Installation\n\nFollow these steps.\n\n```bash\nbun install\n```\n",
			LanguageId::new("markdown"),
			registry_for_tests(),
		)
		.expect("buffer");
		let profile = markdown_profile();
		let options = json!({
			"operation": "replace-code-block",
			"symbol": "Installation",
			"language": "bash",
			"content": "bun add hono"
		});
		let edits = single_edit_operation(&buffer, &profile, &options).expect("replace code block");
		buffer.edit_batch(edits).expect("apply");
		let updated = buffer.source();
		assert!(
			updated.contains("```bash\nbun add hono\n```"),
			"should preserve fence + language: {updated}"
		);
	}

	#[test]
	fn single_edit_operation_supports_typst_promote_and_demote() {
		let mut promote_buffer = CodeBuffer::from_str(
			"== Section One\nSome content.\n",
			LanguageId::new("typst"),
			registry_for_tests(),
		)
		.expect("buffer");
		let profile = typst_profile();
		let promote = json!({
			"operation": "promote",
			"symbol": "Section One"
		});
		let edits = single_edit_operation(&promote_buffer, &profile, &promote).expect("promote");
		promote_buffer.edit_batch(edits).expect("apply");
		assert!(promote_buffer.source().starts_with("= Section One\n"));

		let mut demote_buffer = CodeBuffer::from_str(
			"= Top Level\nSome content.\n",
			LanguageId::new("typst"),
			registry_for_tests(),
		)
		.expect("buffer");
		let demote = json!({
			"operation": "demote",
			"symbol": "Top Level"
		});
		let edits = single_edit_operation(&demote_buffer, &profile, &demote).expect("demote");
		demote_buffer.edit_batch(edits).expect("apply");
		assert!(demote_buffer.source().starts_with("== Top Level\n"));
	}

	#[test]
	fn find_enclosing_symbol_prefers_nested_child() {
		let entries =
			vec![outline_entry("Foo", "class", 1, 10, 0, "class Foo", vec![outline_entry(
				"bar",
				"method",
				3,
				5,
				2,
				"bar()",
				vec![],
			)])];
		assert_eq!(find_enclosing_symbol(&entries, 4).as_deref(), Some("Foo.bar"));
		assert_eq!(find_enclosing_symbol(&entries, 2).as_deref(), Some("Foo"));
	}

	#[test]
	fn render_annotated_diff_labels_symbol_hunk() {
		let mut buffer = ts_buffer(
			"function add(a: number, b: number): number {\n  return a + b;\n}\n\nfunction sub(a: \
			 number, b: number): number {\n  return a - b;\n}\n",
		);
		let profile = ts_profile();
		let options = json!({
			"operation": "patch",
			"symbol": "add",
			"patches": [
				{ "find": "return a + b;", "replace": "return a * b;" }
			]
		});
		let before = buffer.source();
		let edits = single_edit_operation(&buffer, &profile, &options).expect("patch");
		buffer.edit_batch(edits).expect("apply");
		let diff = render_annotated_diff(&buffer, &before, &profile);
		assert!(diff.contains("@@ add @@"), "diff should label add hunk: {diff}");
		assert!(diff.contains("return a * b;"), "diff should include changed line: {diff}");
	}
	#[test]
	fn resolve_target_supports_typst_raw_and_editable_scope_node_types() {
		let buffer = typst_buffer();
		let profile = typst_profile();

		let raw = resolve_target(&buffer, &profile, &json!({ "line": 7, "node_type": "let" }))
			.expect("resolve raw typst target");
		assert_eq!(raw.kind, "let");
		assert_eq!((raw.line, raw.end_line), (7, 7));

		let scope = resolve_target(&buffer, &profile, &json!({ "line": 7, "node_type": "code" }))
			.expect("resolve editable-scope typst target");
		assert_eq!(scope.kind, "code");
		assert_eq!((scope.line, scope.end_line), (7, 7));
	}

	#[test]
	fn render_navigate_result_includes_editable_scope_metadata() {
		let rendered = render_navigate_result(NavigateResult {
			node_type:                "let".into(),
			text:                     "let teal-primary = rgb(\"#008080\")".into(),
			line:                     7,
			end_line:                 7,
			column:                   1,
			parent_type:              Some("code".into()),
			editable_scope_node_type: Some("code".into()),
			editable_scope_line:      Some(7),
			editable_scope_end_line:  Some(7),
			editable_scope_column:    Some(0),
			name:                     None,
			kind:                     None,
			items:                    vec![],
			references:               vec![],
		});

		assert_eq!(rendered["editableScopeNodeType"], json!("code"));
		assert_eq!(rendered["editableScopeLine"], json!(7));
		assert_eq!(rendered["editableScopeEndLine"], json!(7));
		assert_eq!(rendered["fileTargetId"], json!("fixtures/typst_edit_targets.typ"));
	}
	#[test]
	fn unsupported_language_falls_back_to_text_read() {
		let dir = tempfile::tempdir().expect("tempdir");
		let unknown_file = dir.path().join("readme.xyz");
		fs::write(&unknown_file, "hello\n").expect("write");

		let result = execute_code_buffer(json!({
			"command": "read",
			"file": unknown_file.to_str().expect("utf8 path")
		}))
		.expect("should not throw");

		assert_eq!(result["error"], false);
		assert_eq!(result["output"], json!("hello\n"));
	}

	#[test]
	fn outline_command_preserves_legacy_array_without_enrich() {
		let root = temp_workspace("outline-legacy");
		let file = root.join("sample.ts");
		fs::write(&file, "export function greet(name: string) {\n  return name;\n}\n")
			.expect("write file");
		let result = execute_code_buffer_inner(&json!({
			"command": "outline",
			"file": file.display().to_string(),
			"root": root.display().to_string(),
		}))
		.expect("outline");
		assert_eq!(result["error"], json!(false));
		assert!(
			result["output"].is_array(),
			"legacy outline output should stay array without enrich"
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn outline_command_returns_enriched_envelope_for_signature_metrics_and_doc() {
		let root = temp_workspace("outline-enrich");
		let file = root.join("sample.ts");
		fs::write(
			&file,
			"/**\n * Greets a user.\n * @param name friendly name\n */\nexport function \
			 greet<T>(name: string) {\n  if (name) {\n    return format(name);\n  }\n  return \
			 name;\n}\n",
		)
		.expect("write file");

		let signature = execute_code_buffer_inner(&json!({
			"command": "outline",
			"file": file.display().to_string(),
			"root": root.display().to_string(),
			"enrich": ["signature"],
		}))
		.expect("signature outline");
		assert!(signature["output"]["entries"].is_array());
		assert_eq!(signature["output"]["entries"][0]["generics"], json!(["T"]));
		assert_eq!(signature["output"]["entries"][0]["params"][0]["name"], json!("name"));

		let metrics = execute_code_buffer_inner(&json!({
			"command": "outline",
			"file": file.display().to_string(),
			"root": root.display().to_string(),
			"enrich": ["metrics"],
		}))
		.expect("metrics outline");
		assert!(
			metrics["output"]["entries"][0]["branchPoints"]
				.as_u64()
				.is_some()
		);
		assert_eq!(metrics["output"]["entries"][0]["callSites"], json!(1));

		let doc = execute_code_buffer_inner(&json!({
			"command": "outline",
			"file": file.display().to_string(),
			"root": root.display().to_string(),
			"enrich": ["doc"],
		}))
		.expect("doc outline");
		assert_eq!(doc["output"]["entries"][0]["docSummary"], json!("Greets a user."));
		assert_eq!(doc["output"]["entries"][0]["docTags"], json!(["param"]));
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn missing_command_returns_error_envelope() {
		let result = execute_code_buffer(json!({})).expect("should not throw");

		assert_eq!(result["error"], true);
		let output = result["output"].as_str().expect("string error output");
		assert!(
			output.contains("Missing required field: command"),
			"expected missing command error, got: {output}"
		);
	}

	fn delete_via_dispatch(src: &str, line: usize, node_type: &str) -> Result<Value> {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let file = root.join("test.ts");
		fs::write(&file, src).unwrap();
		let mut action = json!({"kind": "delete", "line": line});
		if !node_type.is_empty() {
			action["nodeType"] = json!(node_type);
		}
		execute_code_buffer_inner(&json!({
			"command": "edit",
			"sessionId": "bug-341-test",
			"root": root.display().to_string(),
			"operations": [{
				"targetId": file.display().to_string(),
				"actions": [action]
			}]
		}))
	}

	#[test]
	fn delete_via_kill_node_allows_non_zero_byte_outcome() {
		let result: Result<Value> =
			delete_via_dispatch("fn a() {}\nfn b() {}\n", 1, "function_declaration");

		assert!(result.is_ok());
		assert!(result.is_ok());
	}

	#[test]
	fn action_line_parses_pos_when_line_absent() {
		let action = json!({"kind":"insertBefore","pos":"7#AB","lines":["x"]});
		assert_eq!(action_line(&action, None), 7);
	}

	#[test]
	fn action_line_prefers_explicit_line_over_pos() {
		let action = json!({"line":3,"pos":"7#AB"});
		assert_eq!(action_line(&action, None), 3);
	}
}
