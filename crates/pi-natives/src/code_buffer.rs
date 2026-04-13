use std::path::{Path, PathBuf};

use napi::{Error, bindgen_prelude::*};
use napi_derive::napi;
use pi_code_engine::{
	apply_procedure, apply_procedure_transform,
	buffer::CodeBuffer,
	edit::{
		DragDirection, Patch, SpliceMode, TextEdit, apply_patches, clone_node, drag_node,
		insert_after, insert_before, kill_node, rename_symbol, replace_body, replace_node,
		splice_node, transpose_nodes, wrap_node,
	},
	language::{LanguageId, LanguageProfile},
	line_target::resolve_edit_target,
	navigate::{NavigateAction, NavigateItem, NavigateResult, navigate as navigate_buffer},
	outline::{OutlineEntry, outline as outline_buffer, read as read_buffer},
	resolve::{ResolvedSymbol, resolve_symbol},
};
use serde_json::{Value, json};

use crate::{buffer_registry, language_registry};
fn engine_err(e: pi_code_engine::error::CodeEngineError) -> Error {
	Error::from_reason(e.to_string())
}
fn json_err(message: impl Into<String>) -> Error {
	Error::from_reason(message.into())
}
fn json_response(output: Value, error: bool) -> Value {
	json!({ "output": output, "error": error })
}
fn to_json<T: serde::Serialize>(value: T) -> Result<Value> {
	serde_json::to_value(value).map_err(|error| json_err(error.to_string()))
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

/// Resolve the edit target from the options — either by symbol or line.
fn resolve_target(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	options: &Value,
) -> Result<ResolvedSymbol> {
	if let Some(symbol) = options.get("symbol").and_then(Value::as_str) {
		resolve_symbol(buffer, profile, symbol).map_err(engine_err)
	} else if let Some(line) = options.get("line").and_then(Value::as_u64) {
		let line = line as usize;
		let node_type = options
			.get("node_type")
			.and_then(Value::as_str)
			.unwrap_or("");
		let target = resolve_edit_target(buffer, line, node_type).map_err(engine_err)?;
		Ok(ResolvedSymbol {
			name:            String::new(),
			kind:            target.kind().to_string(),
			start_byte:      target.start_byte(),
			end_byte:        target.end_byte(),
			line:            (target.start_position().row + 1) as u32,
			end_line:        (target.end_position().row + 1) as u32,
			body_start_byte: None,
			body_end_byte:   None,
		})
	} else {
		Err(json_err("Edit requires 'symbol' or 'line' field"))
	}
}

/// Parse patches from JSON options.
fn parse_patches(options: &Value) -> Result<Vec<Patch>> {
	let arr = options
		.get("patches")
		.and_then(Value::as_array)
		.ok_or_else(|| json_err("'patch' operation requires 'patches' array"))?;
	let mut patches = Vec::with_capacity(arr.len());
	for entry in arr {
		let find = entry
			.get("find")
			.and_then(Value::as_str)
			.ok_or_else(|| json_err("Each patch must have a 'find' string"))?;
		let replace = entry
			.get("replace")
			.and_then(Value::as_str)
			.ok_or_else(|| json_err("Each patch must have a 'replace' string"))?;
		patches.push(Patch { find: find.into(), replace: replace.into() });
	}
	Ok(patches)
}

fn required_str<'a>(options: &'a Value, field: &str) -> Result<&'a str> {
	options
		.get(field)
		.and_then(Value::as_str)
		.ok_or_else(|| json_err(format!("Missing required field: {field}")))
}

fn resolved_node<'a>(
	buffer: &'a CodeBuffer,
	resolved: &ResolvedSymbol,
) -> Option<tree_sitter::Node<'a>> {
	let mut node = buffer
		.tree()
		.root_node()
		.named_descendant_for_byte_range(resolved.start_byte, resolved.end_byte)
		.or_else(|| {
			buffer
				.tree()
				.root_node()
				.descendant_for_byte_range(resolved.start_byte, resolved.end_byte)
		})?;

	loop {
		if node.start_byte() == resolved.start_byte && node.end_byte() == resolved.end_byte {
			return Some(node);
		}
		let parent = node.parent()?;
		node = parent;
	}
}

/// Dispatch a single edit operation (symbol-targeted or line-targeted).
fn single_edit_operation(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	options: &Value,
) -> Result<Vec<TextEdit>> {
	let operation = options
		.get("operation")
		.and_then(Value::as_str)
		.ok_or_else(|| json_err("Missing required field: operation"))?;

	match operation {
		// Symbol-targeted content operations
		"patch" => {
			let resolved = resolve_target(buffer, profile, options)?;
			let patches = parse_patches(options)?;
			apply_patches(buffer, resolved.start_byte, resolved.end_byte, &patches).map_err(engine_err)
		},
		"replace-body" => {
			let resolved = resolve_target(buffer, profile, options)?;
			let content = required_str(options, "content")?;
			replace_body(buffer, &resolved, content).map_err(engine_err)
		},
		"wrap" => {
			let resolved = resolve_target(buffer, profile, options)?;
			let content = required_str(options, "content")?;
			wrap_node(buffer, &resolved, content).map_err(engine_err)
		},
		"rename" => {
			let resolved = resolve_target(buffer, profile, options)?;
			let new_name = required_str(options, "content")?;
			rename_symbol(buffer, &resolved, new_name).map_err(engine_err)
		},
		// Content operations that accept symbol OR line
		"replace" => {
			let content = required_str(options, "content")?;
			if options.get("symbol").is_some() {
				let resolved = resolve_target(buffer, profile, options)?;
				Ok(vec![TextEdit {
					start_byte:   resolved.start_byte,
					old_end_byte: resolved.end_byte,
					new_text:     content.to_string(),
				}])
			} else {
				let line = value_to_usize(options.get("line"), 0);
				let node_type = options
					.get("node_type")
					.and_then(Value::as_str)
					.unwrap_or("");
				replace_node(buffer, line, node_type, content).map_err(engine_err)
			}
		},
		"kill" => {
			if options.get("symbol").is_some() {
				let resolved = resolve_target(buffer, profile, options)?;
				Ok(vec![TextEdit {
					start_byte:   resolved.start_byte,
					old_end_byte: resolved.end_byte,
					new_text:     String::new(),
				}])
			} else {
				let line = value_to_usize(options.get("line"), 0);
				let node_type = options
					.get("node_type")
					.and_then(Value::as_str)
					.unwrap_or("");
				kill_node(buffer, line, node_type).map_err(engine_err)
			}
		},
		"insert-before" => {
			let content = required_str(options, "content")?;
			if options.get("symbol").is_some() {
				let resolved = resolve_target(buffer, profile, options)?;
				Ok(vec![TextEdit {
					start_byte:   resolved.start_byte,
					old_end_byte: resolved.start_byte,
					new_text:     content.to_string(),
				}])
			} else {
				let line = value_to_usize(options.get("line"), 0);
				let node_type = options
					.get("node_type")
					.and_then(Value::as_str)
					.unwrap_or("");
				insert_before(buffer, line, node_type, content).map_err(engine_err)
			}
		},
		"insert-after" => {
			let content = required_str(options, "content")?;
			if options.get("symbol").is_some() {
				let resolved = resolve_target(buffer, profile, options)?;
				Ok(vec![TextEdit {
					start_byte:   resolved.end_byte,
					old_end_byte: resolved.end_byte,
					new_text:     content.to_string(),
				}])
			} else {
				let line = value_to_usize(options.get("line"), 0);
				let node_type = options
					.get("node_type")
					.and_then(Value::as_str)
					.unwrap_or("");
				insert_after(buffer, line, node_type, content).map_err(engine_err)
			}
		},
		// Positional operations (line-only)
		"splice" => {
			let line = value_to_usize(options.get("line"), 0);
			let mode = match options
				.get("mode")
				.and_then(Value::as_str)
				.unwrap_or("self")
			{
				"up" => SpliceMode::Up,
				"down" => SpliceMode::Down,
				_ => SpliceMode::Self_,
			};
			splice_node(buffer, line, mode).map_err(engine_err)
		},
		"drag-up" => {
			let line = value_to_usize(options.get("line"), 0);
			drag_node(buffer, line, DragDirection::Up).map_err(engine_err)
		},
		"drag-down" => {
			let line = value_to_usize(options.get("line"), 0);
			drag_node(buffer, line, DragDirection::Down).map_err(engine_err)
		},
		"clone" => {
			let line = value_to_usize(options.get("line"), 0);
			clone_node(buffer, line).map_err(engine_err)
		},
		"transpose" => {
			let line = value_to_usize(options.get("line"), 0);
			let column = value_to_usize(options.get("column"), 0);
			transpose_nodes(buffer, line, column).map_err(engine_err)
		},
		other => {
			let procedure = profile
				.procedures
				.get(other)
				.ok_or_else(|| json_err(format!("Unknown edit operation: {other}")))?;
			let resolved = resolve_target(buffer, profile, options)?;
			let node = resolved_node(buffer, &resolved)
				.ok_or_else(|| json_err("Node not found for resolved target"))?;
			let result = apply_procedure(procedure, &node, resolved.start_byte, profile)
				.ok_or_else(|| json_err(format!("Procedure '{other}' did not match")))?;
			apply_procedure_transform(procedure, &buffer.source(), &result.matched_nodes, options)
				.map_err(engine_err)
		},
	}
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
	json!({ "path": info.path.map(|path| path.display().to_string()), "language": info.language.to_string(), "version": info.version, "dirty": info.dirty, "lineCount": info.line_count })
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
fn render_navigate_result(result: NavigateResult) -> Value {
	json!({ "nodeType": result.node_type, "text": result.text, "line": result.line, "endLine": result.end_line, "column": result.column, "parentType": result.parent_type, "editableScopeNodeType": result.editable_scope_node_type, "editableScopeLine": result.editable_scope_line, "editableScopeEndLine": result.editable_scope_end_line, "editableScopeColumn": result.editable_scope_column, "name": result.name, "kind": result.kind, "items": result.items.into_iter().map(render_navigate_item).collect::<Vec<_>>(), "references": result.references })
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
				json!({ "success": true, "language": buffer.language().to_string(), "lines": lines }),
				false,
			))
		},
		"close" => {
			let path = required_path(options)?;
			buffer_registry().close(&path).map_err(engine_err)?;
			Ok(json_response(json!({ "success": true }), false))
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
				.map(|id| {
					let profile = reg.get(id).unwrap();
					json!({ "id": id.to_string(), "extensions": profile.extensions })
				})
				.collect();
			Ok(json_response(json!({ "languages": langs }), false))
		},
		"outline" | "read" | "navigate" | "edit" | "undo" | "redo" | "diff" | "replace_content"
		| "save" => {
			let path = required_path(options)?;
			let buffer = buffer_registry().open(&path).map_err(engine_err)?;
			let mut buffer = buffer.lock();
			let profile = get_profile(&path, buffer.language())?;
			match command {
				"outline" => Ok(json_response(to_json(outline_buffer(&buffer, &profile))?, false)),
				"read" => {
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
				},
				"navigate" => {
					let action = navigate_action(options.get("action").and_then(Value::as_str))?;
					let line = value_to_u32(options.get("line"), 1);
					let column = options
						.get("column")
						.and_then(Value::as_u64)
						.and_then(|n| u32::try_from(n).ok());
					let symbol = options.get("symbol").and_then(Value::as_str);
					let result = navigate_buffer(&buffer, &profile, action, line, column, symbol)
						.map_err(engine_err)?;
					Ok(json_response(render_navigate_result(result), false))
				},
				"edit" => {
					let before = buffer.source();
					let edit_count = if let Some(edits) = options.get("edits").and_then(Value::as_array)
					{
						for edit in edits {
							let text_edits = single_edit_operation(&buffer, &profile, edit)?;
							buffer.edit_batch(text_edits).map_err(engine_err)?;
						}
						edits.len()
					} else {
						let text_edits = single_edit_operation(&buffer, &profile, options)?;
						buffer.edit_batch(text_edits).map_err(engine_err)?;
						1
					};
					let diff = render_annotated_diff(&buffer, &before, &profile);
					Ok(json_response(
						json!({ "version": buffer.version(), "diff": diff, "editCount": edit_count }),
						false,
					))
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
					buffer.save().map_err(engine_err)?;
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
		Err(error) => Ok(json_response(json!(error.to_string()), true)),
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

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
	fn single_edit_operation_supports_symbol_replace() {
		let buffer = ts_buffer("function add(a: number, b: number): number {\n  return a + b;\n}\n");
		let profile = ts_profile();
		let options = json!({
			"operation": "replace",
			"symbol": "add",
			"content": "function add(a: number, b: number): number {\n  return a * b;\n}"
		});
		let edits = single_edit_operation(&buffer, &profile, &options).expect("edit");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].start_byte, 0);
		assert!(edits[0].new_text.contains("return a * b"));
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
			name:      "Foo".into(),
			kind:      "class".into(),
			line:      1,
			end_line:  10,
			column:    0,
			exported:  false,
			signature: "class Foo".into(),
			children:  vec![OutlineEntry {
				name:      "bar".into(),
				kind:      "method".into(),
				line:      3,
				end_line:  5,
				column:    2,
				exported:  false,
				signature: "bar()".into(),
				children:  vec![],
			}],
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
