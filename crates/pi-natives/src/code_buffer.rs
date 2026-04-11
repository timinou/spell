use std::{path::{Path, PathBuf}, sync::{Arc, OnceLock}};

use napi::{bindgen_prelude::*, Error};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_code_engine::{
	buffer::{BufferRegistry, CodeBuffer},
	edit::{drag_node, insert_after, insert_before, kill_node, replace_node, splice_node, transpose_nodes, DragDirection, SpliceMode, TextEdit},
	language::{LanguageId, LanguageProfile, LanguageRegistry},
	navigate::{navigate as navigate_buffer, NavigateAction, NavigateItem, NavigateResult},
	outline::{outline as outline_buffer, read as read_buffer},
};
use serde_json::{json, Value};

static LANGUAGE_REGISTRY: OnceLock<Arc<LanguageRegistry>> = OnceLock::new();
static BUFFER_REGISTRY: OnceLock<Mutex<BufferRegistry>> = OnceLock::new();

fn language_registry() -> Arc<LanguageRegistry> { LANGUAGE_REGISTRY.get_or_init(|| Arc::new(LanguageRegistry::with_builtins().expect("failed to load language profiles"))).clone() }
fn registry() -> &'static Mutex<BufferRegistry> { BUFFER_REGISTRY.get_or_init(|| Mutex::new(BufferRegistry::new(language_registry()))) }
fn engine_err(e: pi_code_engine::error::CodeEngineError) -> Error { Error::from_reason(e.to_string()) }
fn json_err(message: impl Into<String>) -> Error { Error::from_reason(message.into()) }
fn json_response(output: Value, error: bool) -> Value { json!({ "output": output, "error": error }) }
fn to_json<T: serde::Serialize>(value: T) -> Result<Value> { serde_json::to_value(value).map_err(|error| json_err(error.to_string())) }

fn required_path(options: &Value) -> Result<PathBuf> { let path = options.get("file").or_else(|| options.get("path")).and_then(Value::as_str).ok_or_else(|| json_err("Missing required field: file"))?; Ok(PathBuf::from(path)) }
fn get_profile(path: &Path, buffer_lang: &LanguageId) -> Result<LanguageProfile> { language_registry().get(buffer_lang).cloned().ok_or_else(|| json_err(format!("Language profile not found for {}", path.display()))) }
fn value_to_u32(value: Option<&Value>, default: u32) -> u32 { value.and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(default) }
fn value_to_usize(value: Option<&Value>, default: usize) -> usize { value.and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).unwrap_or(default) }

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

fn node_at_line(buffer: &CodeBuffer, line: usize) -> Result<tree_sitter::Node<'_>> {
	let rope = buffer.rope();
	let byte = rope.line_to_byte_idx(line.saturating_sub(1), ropey::LineType::LF_CR);
	buffer.tree().root_node().named_descendant_for_byte_range(byte, byte).or_else(|| buffer.tree().root_node().descendant_for_byte_range(byte, byte)).ok_or_else(|| json_err(format!("No node found at line {line}")))
}
fn clone_edit(buffer: &CodeBuffer, line: usize) -> Result<Vec<TextEdit>> { let node = node_at_line(buffer, line)?; let text = buffer.source()[node.start_byte()..node.end_byte()].to_string(); let insertion = if text.contains('\n') { format!("{text}\n") } else { format!("{text} ") }; let pos = node.end_byte(); Ok(vec![TextEdit { start_byte: pos, old_end_byte: pos, new_text: insertion }]) }

fn edit_operation(buffer: &CodeBuffer, options: &Value) -> Result<Vec<TextEdit>> {
	let line = value_to_usize(options.get("line"), 0);
	let column = value_to_usize(options.get("column"), 0);
	let content = options.get("content").and_then(Value::as_str).unwrap_or("");
	let node_type = options.get("node_type").and_then(Value::as_str).unwrap_or("");
	let operation = options.get("operation").and_then(Value::as_str).ok_or_else(|| json_err("Missing required field: operation"))?;
	match operation {
		"replace" => replace_node(buffer, line, node_type, content).map_err(engine_err),
		"insert-before" => insert_before(buffer, line, node_type, content).map_err(engine_err),
		"insert-after" => insert_after(buffer, line, node_type, content).map_err(engine_err),
		"kill" => kill_node(buffer, line, node_type).map_err(engine_err),
		"splice" => { let mode = match options.get("mode").and_then(Value::as_str).unwrap_or("self") { "up" => SpliceMode::Up, "down" => SpliceMode::Down, _ => SpliceMode::Self_, }; splice_node(buffer, line, mode).map_err(engine_err) },
		"drag-up" => drag_node(buffer, line, DragDirection::Up).map_err(engine_err),
		"drag-down" => drag_node(buffer, line, DragDirection::Down).map_err(engine_err),
		"clone" => clone_edit(buffer, line),
		"transpose" => transpose_nodes(buffer, line, column).map_err(engine_err),
		other => Err(json_err(format!("Unknown edit operation: {other}"))),
	}
}

fn render_buffer_info(info: pi_code_engine::buffer::BufferInfo) -> Value { json!({ "path": info.path.map(|path| path.display().to_string()), "language": info.language.to_string(), "version": info.version, "dirty": info.dirty, "lineCount": info.line_count }) }
fn render_edit_results(results: Vec<pi_code_engine::buffer::EditResult>) -> Value { Value::Array(results.into_iter().map(|result| json!({ "version": result.version, "changedRanges": result.changed_ranges.into_iter().map(|range| json!({ "start": {"line": range.start_point.row + 1, "column": range.start_point.column}, "end": {"line": range.end_point.row + 1, "column": range.end_point.column} })).collect::<Vec<_>>(), "inputEdit": { "startByte": result.input_edit.start_byte, "oldEndByte": result.input_edit.old_end_byte, "newText": result.input_edit.new_text } })).collect()) }
fn render_optional_edit_result(result: Option<pi_code_engine::buffer::EditResult>) -> Value { result.map_or(Value::Null, |result| render_edit_results(vec![result])) }
fn render_navigate_item(item: NavigateItem) -> Value { json!({ "nodeType": item.node_type, "text": item.text, "line": item.line, "endLine": item.end_line }) }
fn render_navigate_result(result: NavigateResult) -> Value { json!({ "nodeType": result.node_type, "text": result.text, "line": result.line, "endLine": result.end_line, "column": result.column, "parentType": result.parent_type, "name": result.name, "kind": result.kind, "items": result.items.into_iter().map(render_navigate_item).collect::<Vec<_>>(), "references": result.references }) }
fn render_diff_hunk(hunk: pi_code_engine::diff::DiffHunk) -> Value { json!({ "oldStart": hunk.old_start, "oldCount": hunk.old_count, "newStart": hunk.new_start, "newCount": hunk.new_count, "kind": format!("{:?}", hunk.kind), "content": hunk.content }) }

#[napi(js_name = "executeCodeBuffer")]
pub fn execute_code_buffer(options: Value) -> Result<Value> {
	let command = options.get("command").and_then(Value::as_str).ok_or_else(|| json_err("Missing required field: command"))?;
	match command {
		"open" => { let path = required_path(&options)?; let mut guard = registry().lock(); let buffer = guard.open(&path).map_err(engine_err)?; let lines = buffer.source().lines().map(ToOwned::to_owned).collect::<Vec<_>>(); Ok(json_response(json!({ "success": true, "language": buffer.language().to_string(), "lines": lines }), false)) },
		"close" => { let path = required_path(&options)?; registry().lock().close(&path).map_err(engine_err)?; Ok(json_response(json!({ "success": true }), false)) },
		"list" => { let buffers = registry().lock().list(); Ok(json_response(Value::Array(buffers.into_iter().map(render_buffer_info).collect()), false)) },
		"outline" | "read" | "navigate" | "edit" | "undo" | "redo" | "diff" | "save" => {
			let path = required_path(&options)?;
			let mut guard = registry().lock();
			let buffer = guard.get_mut(&path).ok_or_else(|| json_err(format!("Buffer not open for {}", path.display())))?;
			let profile = get_profile(&path, buffer.language())?;
			match command {
				"outline" => Ok(json_response(to_json(outline_buffer(buffer, &profile))?, false)),
				"read" => { let resolution = options.get("resolution").and_then(Value::as_u64).and_then(|n| u8::try_from(n).ok()).unwrap_or(3); let offset = options.get("offset").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()); let limit = options.get("limit").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()); Ok(json_response(Value::String(read_buffer(buffer, &profile, resolution, offset, limit)), false)) },
				"navigate" => { let action = navigate_action(options.get("action").and_then(Value::as_str))?; let line = value_to_u32(options.get("line"), 1); let column = options.get("column").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()); let symbol = options.get("symbol").and_then(Value::as_str); let result = navigate_buffer(buffer, &profile, action, line, column, symbol).map_err(engine_err)?; Ok(json_response(render_navigate_result(result), false)) },
				"edit" => { let results = buffer.edit_batch(edit_operation(buffer, &options)?).map_err(engine_err)?; Ok(json_response(render_edit_results(results), false)) },
				"undo" => Ok(json_response(render_optional_edit_result(buffer.undo().map_err(engine_err)?), false)),
				"redo" => Ok(json_response(render_optional_edit_result(buffer.redo().map_err(engine_err)?), false)),
				"diff" => Ok(json_response(Value::Array(buffer.diff_from_disk().map_err(engine_err)?.into_iter().map(render_diff_hunk).collect()), false)),
				"save" => { buffer.save().map_err(engine_err)?; Ok(json_response(json!({ "success": true, "version": buffer.version() }), false)) },
				_ => unreachable!(),
			}
		},
		other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
	}
}
