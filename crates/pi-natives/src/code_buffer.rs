use std::path::{Path, PathBuf};

use napi::{Error, bindgen_prelude::*};
use napi_derive::napi;
use pi_code_engine::{
	CodeEngineError,
	buffer::CodeBuffer,
	edit::{
		DragDirection, Occurrence, Patch, ReplacePolicy, SpliceMode, TextEdit, apply_patches,
		clone_node, drag_node, insert_after, insert_before, kill_node, rename_symbol, replace_body,
		replace_body_safe, splice_node, transpose_nodes, wrap_node,
	},
	file_lock::lock_status,
	language::{LanguageId, LanguageProfile},
	navigate::{NavigateAction, NavigateItem, NavigateResult, navigate as navigate_buffer},
	outline::{OutlineEntry, outline as outline_buffer, read as read_buffer},
	procedure::ProcedureProof,
	resolve::{ResolvedSymbol, resolve_symbol},
	run_procedure,
};
use pi_code_graph::{
	BuildGraphOptions, CacheStore, CodeGraphBuilder, LanguageRegistry as GraphLanguageRegistry,
};
use serde_json::{Value, json};

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
		CodeEngineError::LineOutOfTargetScope { line, target_start, target_end } => json!({
			"code": "LINE_OUT_OF_TARGET_SCOPE",
			"message": error.to_string(),
			"line": line,
			"targetSpan": { "start": target_start, "end": target_end },
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
		_ => json!({ "message": error.to_string() }),
	};
	Error::from_reason(payload.to_string())
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
fn get_profile(path: &Path, buffer_lang: &LanguageId) -> Result<LanguageProfile> {
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

fn required_str<'a>(options: &'a Value, field: &str) -> Result<&'a str> {
	options
		.get(field)
		.and_then(Value::as_str)
		.ok_or_else(|| json_err(format!("Missing required field: {field}")))
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

fn parse_target_id(target_id: &str) -> Result<(String, Option<String>)> {
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

#[derive(Debug)]
struct PreparedEditOperation {
	edits:  Vec<TextEdit>,
	proof:  Option<ProcedureProof>,
	action: String,
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

fn resolve_edit_path(options: &Value) -> Result<PathBuf> {
	let operations = validate_edit_request(options)?;
	let mut targets = Vec::new();
	for operation in operations {
		collect_operation_file_targets(operation, &mut targets)?;
	}
	targets.sort();
	targets.dedup();
	if targets.len() != 1 {
		return Err(json_err(format!(
			"command 'edit' currently supports one file per request. Found file roots: {}",
			targets.join(", "),
		)));
	}
	Ok(path_for_file_target(&targets[0], options))
}

fn structured_refusal(action: &str, target_id: &str, error: CodeEngineError) -> Result<Value> {
	let CodeEngineError::Refusal { message, reason, confidence, basis, matches } = error else {
		return Err(engine_err(error));
	};
	Ok(json_response(
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
		}),
		true,
	))
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

fn prove_dead_style(
	path: &Path,
	resolved: &ResolvedSymbol,
) -> std::result::Result<ProcedureProof, CodeEngineError> {
	let root = workspace_root_for(path);
	let cache = CacheStore::new(root.join(".spell/graph"));
	let target_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
	let registry = GraphLanguageRegistry::new()
		.with_defaults()
		.map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	let builder = CodeGraphBuilder::new(registry, cache);
	let outcome = builder
		.build(&BuildGraphOptions::new(&root))
		.map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	let Some(item) = outcome
		.graph
		.graph_dead_code_with_limit(0)
		.into_iter()
		.find(|item| {
			let item_path = if item.symbol.path.is_absolute() {
				item.symbol.path.clone()
			} else {
				root.join(&item.symbol.path)
			};
			item_path == target_path
				&& item.symbol.kind == "cssrule"
				&& item.symbol.label.ends_with(&format!("::{}", resolved.name))
		})
	else {
		return Err(CodeEngineError::Refusal {
			message:    "Dead-style removal refused: static graph still sees possible consumers or \
			             lacks proof of zero consumers"
				.into(),
			reason:     "graph_dead_code did not prove this CSS rule unused at the requested location"
				.into(),
			confidence: "low".into(),
			basis:      "graph_dead_code".into(),
			matches:    None,
		});
	};
	Ok(ProcedureProof {
		basis:      "graph_dead_code".into(),
		reason:     item.reason,
		confidence: item.confidence,
		matches:    Some(1),
	})
}

/// Dispatch a single edit operation (symbol-targeted or line-targeted).
/// Dispatch a single edit operation (symbol-targeted or line-targeted).
fn action_content(action: &Value) -> std::result::Result<&str, CodeEngineError> {
	required_str(action, "content").map_err(|error| CodeEngineError::Edit(error.to_string()))
}

fn action_find(action: &Value) -> std::result::Result<&str, CodeEngineError> {
	required_str(action, "find").map_err(|error| CodeEngineError::Edit(error.to_string()))
}

fn action_line(action: &Value, resolved: Option<&ResolvedSymbol>) -> usize {
	action
		.get("line")
		.and_then(Value::as_u64)
		.and_then(|line| usize::try_from(line).ok())
		.filter(|line| *line > 0)
		.or_else(|| resolved.map(|symbol| symbol.line as usize))
		.unwrap_or(0)
}

fn action_allow_sibling_delete(action: &Value) -> bool {
	action
		.get("allowSiblingDelete")
		.and_then(Value::as_bool)
		.unwrap_or(false)
}

fn action_occurrence(action: &Value) -> std::result::Result<Occurrence, CodeEngineError> {
	match action.get("occurrence") {
		None | Some(Value::Null) => Ok(Occurrence::Unique),
		Some(Value::String(value)) => match value.as_str() {
			"first" => Ok(Occurrence::First),
			"last" => Ok(Occurrence::Last),
			"all" => Ok(Occurrence::All),
			_ => Err(CodeEngineError::Edit("invalid occurrence value".into())),
		},
		Some(Value::Number(value)) => value
			.as_u64()
			.and_then(|index| usize::try_from(index).ok())
			.filter(|index| *index > 0)
			.map(Occurrence::Index)
			.ok_or_else(|| CodeEngineError::Edit("invalid occurrence value".into())),
		Some(_) => Err(CodeEngineError::Edit("invalid occurrence value".into())),
	}
}

fn action_within(resolved: Option<&ResolvedSymbol>) -> Option<(usize, usize)> {
	resolved.map(|symbol| (symbol.start_byte, symbol.end_byte))
}

fn action_column(action: &Value) -> usize {
	value_to_usize(action.get("column"), 0)
}

fn action_node_type(action: &Value) -> &str {
	action.get("nodeType").and_then(Value::as_str).unwrap_or("")
}

fn action_mode(action: &Value) -> SpliceMode {
	match action.get("mode").and_then(Value::as_str).unwrap_or("self") {
		"up" => SpliceMode::Up,
		"down" => SpliceMode::Down,
		_ => SpliceMode::Self_,
	}
}

fn resolve_target_id(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	_path: &Path,
	target_id: &str,
) -> std::result::Result<Option<ResolvedSymbol>, CodeEngineError> {
	let (_, symbol_target_id) =
		parse_target_id(target_id).map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	match symbol_target_id {
		Some(symbol_target_id) => resolve_symbol(buffer, profile, &symbol_target_id).map(Some),
		None => Ok(None),
	}
}

fn file_target_id_for_path(path: &Path, options: &Value) -> String {
	let root = root_hint(options).unwrap_or_else(|| workspace_root_for(path));
	relativize_path(path, &root)
}

fn symbol_target_id(file_target_id: &str, symbol_path: &str) -> String {
	format!("{file_target_id}::{symbol_path}")
}

fn target_range(buffer: &CodeBuffer, resolved: Option<&ResolvedSymbol>) -> (usize, usize) {
	match resolved {
		Some(symbol) => (symbol.start_byte, symbol.end_byte),
		None => (0, buffer.source().len()),
	}
}

fn single_action(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	path: &Path,
	target_id: &str,
	action: &Value,
) -> std::result::Result<PreparedEditOperation, CodeEngineError> {
	let action_kind = action
		.get("kind")
		.and_then(Value::as_str)
		.ok_or_else(|| CodeEngineError::Edit("Each action requires 'kind'".into()))?;
	let resolved = resolve_target_id(buffer, profile, path, target_id)?;
	let conservative_web_refactor = matches!(buffer.language().as_str(), "html" | "css");
	let within = action_within(resolved.as_ref());

	let prepared = match action_kind {
		"write" => {
			let content = action_content(action)?;
			match (resolved.as_ref(), action.get("scope").and_then(Value::as_str)) {
				(Some(symbol), Some("body")) => PreparedEditOperation {
					edits:  if action_allow_sibling_delete(action) {
						replace_body(buffer, symbol, content, ReplacePolicy {
							allow_sibling_delete: true,
						})?
					} else {
						replace_body_safe(buffer, symbol, content)?
					},
					proof:  None,
					action: action_kind.to_string(),
				},
				(Some(symbol), _) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   symbol.start_byte,
						old_end_byte: symbol.end_byte,
						new_text:     content.to_string(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
				(None, Some("body")) => {
					return Err(CodeEngineError::Edit(
						"write scope 'body' requires a declaration targetId, not a file targetId".into(),
					));
				},
				(None, _) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   0,
						old_end_byte: buffer.source().len(),
						new_text:     content.to_string(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"findAndReplace" => {
			let (start_byte, end_byte) = target_range(buffer, resolved.as_ref());
			PreparedEditOperation {
				edits:  apply_patches(buffer, start_byte, end_byte, &[Patch {
					find:       action_find(action)?.to_string(),
					replace:    action_content(action)?.to_string(),
					occurrence: action_occurrence(action)?,
				}])?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"wrap" => {
			let symbol = resolved
				.as_ref()
				.ok_or_else(|| CodeEngineError::Edit("wrap requires a declaration targetId".into()))?;
			PreparedEditOperation {
				edits:  wrap_node(buffer, symbol, action_content(action)?)?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"rename" => {
			if conservative_web_refactor {
				return Err(CodeEngineError::Refusal {
					message:    "HTML/CSS rename is not yet supported safely. Use renameIdToken, \
					             renameClassToken, or renameCustomProperty only when the target is a \
					             provable literal token."
						.into(),
					reason:     "generic rename does not preserve proof for HTML/CSS token semantics"
						.into(),
					confidence: "low".into(),
					basis:      "operation_scope".into(),
					matches:    None,
				});
			}
			let symbol = resolved.as_ref().ok_or_else(|| {
				CodeEngineError::Edit("rename requires a declaration targetId".into())
			})?;
			PreparedEditOperation {
				edits:  rename_symbol(buffer, symbol, action_content(action)?)?,
				proof:  None,
				action: action_kind.to_string(),
			}
		},
		"delete" => {
			if conservative_web_refactor {
				return Err(CodeEngineError::Refusal {
					message:    "HTML/CSS delete is not yet supported safely. Use removeDeadStyle only \
					             after the static graph proves a CSS rule has no consumers."
						.into(),
					reason:     "generic delete does not preserve proof for HTML/CSS style or markup \
					             reachability"
						.into(),
					confidence: "low".into(),
					basis:      "operation_scope".into(),
					matches:    None,
				});
			}
			match (resolved.as_ref(), has_meaningful_index_field(action.get("line"))) {
				(Some(symbol), false) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   symbol.start_byte,
						old_end_byte: symbol.end_byte,
						new_text:     String::new(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
				_ => PreparedEditOperation {
					edits:  kill_node(
						buffer,
						action_line(action, resolved.as_ref()),
						action_node_type(action),
						within,
					)?,
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"insertBefore" => {
			let content = action_content(action)?;
			match (resolved.as_ref(), has_meaningful_index_field(action.get("line"))) {
				(Some(symbol), false) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   symbol.start_byte,
						old_end_byte: symbol.start_byte,
						new_text:     content.to_string(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
				_ => PreparedEditOperation {
					edits:  insert_before(
						buffer,
						action_line(action, resolved.as_ref()),
						action_node_type(action),
						content,
						within,
					)?,
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"insertAfter" => {
			let content = action_content(action)?;
			match (resolved.as_ref(), has_meaningful_index_field(action.get("line"))) {
				(Some(symbol), false) => PreparedEditOperation {
					edits:  vec![TextEdit {
						start_byte:   symbol.end_byte,
						old_end_byte: symbol.end_byte,
						new_text:     content.to_string(),
					}],
					proof:  None,
					action: action_kind.to_string(),
				},
				_ => PreparedEditOperation {
					edits:  insert_after(
						buffer,
						action_line(action, resolved.as_ref()),
						action_node_type(action),
						content,
						within,
					)?,
					proof:  None,
					action: action_kind.to_string(),
				},
			}
		},
		"splice" => PreparedEditOperation {
			edits:  splice_node(
				buffer,
				action_line(action, resolved.as_ref()),
				action_mode(action),
				within,
			)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		"move" => PreparedEditOperation {
			edits:  drag_node(
				buffer,
				action_line(action, resolved.as_ref()),
				match action
					.get("direction")
					.and_then(Value::as_str)
					.unwrap_or("down")
				{
					"up" => DragDirection::Up,
					_ => DragDirection::Down,
				},
				within,
			)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		"clone" => PreparedEditOperation {
			edits:  clone_node(buffer, action_line(action, resolved.as_ref()), within)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		"transpose" => PreparedEditOperation {
			edits:  transpose_nodes(
				buffer,
				action_line(action, resolved.as_ref()),
				action_column(action),
				within,
			)?,
			proof:  None,
			action: action_kind.to_string(),
		},
		other => {
			let procedure_name = match other {
				"renameClassToken" => "rename-class-token",
				"renameIdToken" => "rename-id-token",
				"renameCustomProperty" => "rename-custom-property",
				"removeDeadStyle" => "remove-dead-style",
				_ => other,
			};
			let procedure = profile
				.procedures
				.get(procedure_name)
				.ok_or_else(|| CodeEngineError::Edit(format!("Unknown action kind: {other}")))?;
			let symbol = resolved.as_ref().ok_or_else(|| {
				CodeEngineError::Edit(format!("{other} requires a declaration targetId"))
			})?;
			let mut procedure_options = action.as_object().cloned().unwrap_or_default();
			procedure_options.insert("file".into(), Value::String(path.display().to_string()));
			let mut result =
				run_procedure(procedure, buffer, symbol, profile, &Value::Object(procedure_options))?;
			if procedure_name == "remove-dead-style" {
				result.proof = Some(prove_dead_style(path, symbol)?);
			}
			PreparedEditOperation {
				edits:  result.edits,
				proof:  result.proof,
				action: other.to_string(),
			}
		},
	};

	Ok(prepared)
}

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

fn apply_operations_transactionally(
	buffer: &mut CodeBuffer,
	profile: &LanguageProfile,
	path: &Path,
	options: &Value,
) -> std::result::Result<(Vec<TargetSummary>, usize, Option<ProcedureProof>), CodeEngineError> {
	let operations =
		validate_edit_request(options).map_err(|error| CodeEngineError::Edit(error.to_string()))?;
	let before = buffer.source();
	let mut staged = CodeBuffer::from_str(&before, buffer.language().clone(), language_registry())?;
	let mut summaries = Vec::new();
	let mut edit_count = 0_usize;
	let mut last_proof = None;
	for operation in operations {
		let (summary, node_count, node_proof) =
			execute_operation_node(&mut staged, profile, path, operation)?;
		summaries.push(summary);
		edit_count += node_count;
		if node_proof.is_some() {
			last_proof = node_proof;
		}
	}
	buffer.edit_batch(vec![TextEdit {
		start_byte:   0,
		old_end_byte: before.len(),
		new_text:     staged.source(),
	}])?;
	Ok((summaries, edit_count, last_proof))
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
	let outline = outline_buffer(buffer, profile);
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
fn render_outline_entry(
	entry: &OutlineEntry,
	file_target_id: &str,
	parent_path: Option<&str>,
) -> Value {
	let symbol_path =
		parent_path.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
	json!({
		"name": entry.name,
		"kind": entry.kind,
		"line": entry.line,
		"endLine": entry.end_line,
		"column": entry.column,
		"exported": entry.exported,
		"signature": entry.signature,
		"targetId": symbol_target_id(file_target_id, &symbol_path),
		"children": entry
			.children
			.iter()
			.map(|child| render_outline_entry(child, file_target_id, Some(&symbol_path)))
			.collect::<Vec<_>>()
	})
}

fn render_outline_result(entries: &[OutlineEntry], file_target_id: &str) -> Value {
	Value::Array(
		entries
			.iter()
			.map(|entry| render_outline_entry(entry, file_target_id, None))
			.collect(),
	)
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

fn execute_code_buffer_inner(options: &Value) -> Result<Value> {
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
		"outline" | "navigate" | "read" | "edit" | "undo" | "redo" | "diff" | "replace_content"
		| "save" => {
			let path = if command == "edit" {
				resolve_edit_path(options)?
			} else {
				required_path(options)?
			};
			let allow_missing = command == "edit" || command == "replace_content";
			let created = command == "edit" && !path.exists();
			let buffer = if allow_missing {
				buffer_registry()
					.open_or_create(&path)
					.map_err(engine_err)?
			} else {
				buffer_registry().open(&path).map_err(engine_err)?
			};
			let mut buffer = buffer.lock();
			let profile = get_profile(&path, buffer.language())?;
			let text_fallback = buffer.language().as_str() == "text";

			match command {
				"outline" => {
					if text_fallback {
						return Err(json_err(
							"Semantic structure is unavailable for fallback text buffers. Use \
							 read/diff/replace_content/save/undo/redo instead.",
						));
					}
					let file_target_id = file_target_id_for_path(&path, options);
					let outline = outline_buffer(&buffer, &profile);
					Ok(json_response(render_outline_result(&outline, &file_target_id), false))
				},
				"navigate" => {
					if text_fallback {
						return Err(json_err(
							"Semantic navigation is unavailable for fallback text buffers. Use \
							 read/diff/replace_content/save/undo/redo instead.",
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
					let outline = outline_buffer(&buffer, &profile);
					Ok(json_response(render_navigate_result(result, &file_target_id, &outline), false))
				},
				"read" => {
					if text_fallback {
						Ok(json_response(Value::String(buffer.source()), false))
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
				"edit" => {
					let before = buffer.source();
					if text_fallback {
						return Err(json_err(
							"Fallback text buffers do not support structured code edit operations. Use \
							 replace_content for whole-buffer writes.",
						));
					}
					match apply_operations_transactionally(&mut buffer, &profile, &path, options) {
						Ok((targets, edit_count, proof)) => {
							let diff = render_annotated_diff(&buffer, &before, &profile);
							Ok(json_response(
								json!({
									"version": buffer.version(),
									"diff": diff,
									"editCount": edit_count,
									"created": created,
									"targets": targets,
									"proof": proof,
								}),
								false,
							))
						},
						Err(error @ CodeEngineError::Refusal { .. }) => {
							let target_id = options
								.get("operations")
								.and_then(Value::as_array)
								.and_then(|operations| operations.first())
								.and_then(|operation| operation.get("targetId"))
								.and_then(Value::as_str)
								.unwrap_or("unknown");
							structured_refusal("edit", target_id, error)
						},
						Err(error) => Err(engine_err(error)),
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
				"replace_content" => {
					let before = buffer.source();
					let content = options
						.get("content")
						.and_then(Value::as_str)
						.ok_or_else(|| json_err("Missing required field: content"))?;
					buffer
						.edit_batch(vec![TextEdit {
							start_byte:   0,
							old_end_byte: before.len(),
							new_text:     content.to_string(),
						}])
						.map_err(engine_err)?;
					let diff = render_annotated_diff(&buffer, &before, &profile);
					Ok(json_response(
						json!({ "version": buffer.version(), "diff": diff, "editCount": 1 }),
						false,
					))
				},
				"save" => {
					buffer
						.save_with_watcher(buffer_registry().watcher())
						.map_err(engine_err)?;
					Ok(json_response(json!({ "success": true, "version": buffer.version() }), false))
				},
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
		sync::Arc,
		time::{SystemTime, UNIX_EPOCH},
	};

	use pi_code_engine::language::LanguageRegistry;
	use serde_json::json;

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

	#[test]
	fn execute_code_buffer_inner_creates_missing_file_buffers() {
		let path = temp_path("create-buffer.ts");
		let target_id = path.display().to_string();
		let edit = execute_code_buffer_inner(&json!({
			"command": "edit",
			"operations": [{
				"targetId": target_id,
				"actions": [{ "kind": "write", "content": "export const created = 1;\n" }]
			}]
		}))
		.expect("create edit");
		assert_eq!(edit["error"], json!(false));
		assert_eq!(edit["output"]["created"], json!(true));
		let save = execute_code_buffer_inner(&json!({
			"command": "save",
			"file": path.display().to_string(),
		}))
		.expect("save");
		assert_eq!(save["error"], json!(false));
		assert_eq!(fs::read_to_string(&path).expect("saved file"), "export const created = 1;\n");
	}

	#[test]
	fn execute_code_buffer_inner_accepts_create_with_empty_transport_defaults() {
		let path = temp_path("create-buffer-transport.ts");
		let edit = execute_code_buffer_inner(&json!({
			"command": "edit",
			"operations": [{
				"targetId": path.display().to_string(),
				"actions": [{ "kind": "write", "content": "export const created = 1;\n" }]
			}],
			"symbol": "",
			"patches": [],
			"edits": [],
			"mode": "",
			"action": "",
			"line": 0,
			"column": 0,
			"resolution": 0,
			"offset": 0,
			"limit": 0,
			"depth": 0
		}))
		.expect("create edit with defaults");
		assert_eq!(edit["error"], json!(false));
		assert_eq!(edit["output"]["created"], json!(true));
	}

	#[test]
	fn execute_code_buffer_inner_ignores_empty_edits_for_top_level_operations() {
		let path = temp_path("empty-edits-shadow.ts");
		fs::write(&path, "export const original = 1;\n").expect("seed file");
		let edit = execute_code_buffer_inner(&json!({
			"command": "edit",
			"operations": [{
				"targetId": path.display().to_string(),
				"actions": [{ "kind": "write", "content": "export const replaced = 2;\n" }]
			}],
			"edits": []
		}))
		.expect("replace edit");
		assert_eq!(edit["error"], json!(false));
		assert_eq!(edit["output"]["editCount"], json!(1));
		assert_ne!(edit["output"]["diff"], json!("(no changes)"));
		let save = execute_code_buffer_inner(&json!({
			"command": "save",
			"file": path.display().to_string(),
		}))
		.expect("save");
		assert_eq!(save["error"], json!(false));
		assert_eq!(fs::read_to_string(&path).expect("saved file"), "export const replaced = 2;\n");
	}

	#[test]
	fn execute_code_buffer_inner_clears_failed_multi_edit_state() {
		let path = temp_path("failed-multi-edit.ts");
		fs::write(&path, "export function main() {\n  return oldCall();\n}\n").expect("seed file");

		let failed = execute_code_buffer_inner(&json!({
			"command": "edit",
			"operations": [{
				"targetId": format!("{}::main", path.display()),
				"actions": [{
					"kind": "findAndReplace",
					"find": "return oldCall();",
					"content": "return newCall();"
				}],
				"children": [{
					"targetId": format!("{}::missing", path.display()),
					"actions": [{
						"kind": "findAndReplace",
						"find": "return oldCall();",
						"content": "return shouldNotApply();"
					}]
				}]
			}]
		}))
		.expect_err("failed multi edit");
		assert!(failed.to_string().contains("Symbol 'missing' not found"));

		let listed =
			execute_code_buffer_inner(&json!({ "command": "list" })).expect("list after fail");
		let retained = listed["output"]
			.as_array()
			.expect("buffer list")
			.iter()
			.find(|buffer| buffer["path"] == json!(path.display().to_string()));
		assert!(
			retained.is_none()
				|| retained.is_some_and(
					|buffer| buffer["dirty"] == json!(false) && buffer["version"] == json!(0)
				),
			"failed multi-edit should not leave a dirty staged buffer behind: {listed}",
		);

		let follow_up = execute_code_buffer_inner(&json!({
			"command": "edit",
			"operations": [{
				"targetId": format!("{}::main", path.display()),
				"actions": [{
					"kind": "findAndReplace",
					"find": "return oldCall();",
					"content": "return finalCall();"
				}]
			}]
		}))
		.expect("follow-up edit");
		assert_eq!(follow_up["error"], json!(false));
		let save = execute_code_buffer_inner(&json!({
			"command": "save",
			"file": path.display().to_string(),
		}))
		.expect("save follow-up");
		assert_eq!(save["error"], json!(false));
		assert!(
			fs::read_to_string(&path)
				.expect("saved file")
				.contains("return finalCall();")
		);
	}

	#[test]
	fn execute_code_buffer_inner_rejects_create_for_existing_file() {
		let path = temp_path("existing-create.ts");
		fs::write(&path, "export const existing = true;\n").expect("seed file");
		let result = execute_code_buffer_inner(&json!({
			"command": "edit",
			"file": path.display().to_string(),
			"operation": "create",
			"content": "export const created = 1;\n"
		}))
		.expect_err("create rejection");
		assert_eq!(
			result.to_string(),
			"GenericFailure, Legacy code edit fields are not accepted for command 'edit': file, \
			 operation, content. Use only 'operations' with targetId/action nodes.",
		);
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
		let entries = vec![OutlineEntry {
			name:        "Foo".into(),
			kind:        "class".into(),
			line:        1,
			end_line:    10,
			column:      0,
			exported:    false,
			signature:   "class Foo".into(),
			children:    vec![OutlineEntry {
				name:        "bar".into(),
				kind:        "method".into(),
				line:        3,
				end_line:    5,
				column:      2,
				exported:    false,
				signature:   "bar()".into(),
				children:    vec![],
				deduplicate: false,
			}],
			deduplicate: false,
		}];
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

		assert_eq!(
			rendered,
			json!({
				"nodeType": "let",
				"text": "let teal-primary = rgb(\"#008080\")",
				"line": 7,
				"endLine": 7,
				"column": 1,
				"parentType": "code",
				"editableScopeNodeType": "code",
				"editableScopeLine": 7,
				"editableScopeEndLine": 7,
				"editableScopeColumn": 0,
				"name": null,
				"kind": null,
				"items": [],
				"references": [],
			}),
		);
	}
	#[test]
	fn unsupported_language_returns_error_envelope() {
		let dir = tempfile::tempdir().expect("tempdir");
		let unknown_file = dir.path().join("readme.xyz");
		fs::write(&unknown_file, "hello\n").expect("write");

		let result = execute_code_buffer(json!({
			"command": "read",
			"file": unknown_file.to_str().expect("utf8 path")
		}))
		.expect("should not throw");

		assert_eq!(result["error"], true);
		let output = result["output"].as_str().expect("string error output");
		assert!(
			output.contains("language not found"),
			"expected language not found error, got: {output}"
		);
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
}
