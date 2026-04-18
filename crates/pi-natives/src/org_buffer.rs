//! NAPI bridge for the org engine.
//!
//! Single entry point `executeOrg` with command dispatch,
//! following the `executeCodeBuffer` pattern.

use std::{
	collections::HashMap,
	fs,
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_org_engine::{
	buffer::extract_items_from_source,
	edit::{self as org_edit, CreateItemParams, SectionEditMode},
	graph, markdown,
	query::{self, QueryFilter},
	section,
};
use serde_json::{Value, json};

use crate::buffer_registry;

fn org_err(message: impl Into<String>) -> napi::Error {
	napi::Error::from_reason(message.into())
}

fn engine_err(error: pi_code_engine::error::CodeEngineError) -> napi::Error {
	match &error {
		pi_code_engine::error::CodeEngineError::ExternalModification { path, .. } => org_err(
			json!({
				"code": "EXTERNAL_MODIFICATION",
				"message": error.to_string(),
				"path": path.display().to_string(),
			})
			.to_string(),
		),
		_ => org_err(error.to_string()),
	}
}

fn json_response(output: Value, error: bool) -> Value {
	json!({ "output": output, "error": error })
}

fn required_path(options: &Value) -> Result<PathBuf> {
	let path = options
		.get("file")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: file"))?;
	Ok(PathBuf::from(path))
}

fn required_str<'a>(options: &'a Value, field: &str) -> Result<&'a str> {
	options
		.get(field)
		.and_then(Value::as_str)
		.ok_or_else(|| org_err(format!("Missing required field: {field}")))
}

fn todo_keywords(options: &Value) -> Vec<&str> {
	options
		.get("todoKeywords")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default()
}

fn category(options: &Value) -> &str {
	options
		.get("category")
		.and_then(Value::as_str)
		.unwrap_or("default")
}

fn dir(options: &Value) -> &str {
	options
		.get("dir")
		.and_then(Value::as_str)
		.unwrap_or("tasks")
}

fn read_org_source(options: &Value) -> Result<String> {
	if let Some(source) = options.get("source").and_then(Value::as_str) {
		return Ok(source.to_string());
	}
	let path = required_path(options)?;
	let buffer = buffer_registry().open(&path).map_err(engine_err)?;
	Ok(buffer.lock().source())
}

fn ensure_org_file(path: &Path) -> Result<()> {
	if path.exists() {
		return Ok(());
	}
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).map_err(|error| org_err(error.to_string()))?;
	}
	fs::write(path, "").map_err(|error| org_err(error.to_string()))?;
	Ok(())
}

fn not_found(code: &str, message: impl Into<String>) -> Value {
	json_response(json!({ "code": code, "message": message.into() }), true)
}

fn create_params(options: &Value) -> Result<CreateItemParams> {
	let id = required_str(options, "id")?.to_string();
	let title = required_str(options, "title")?.to_string();
	let state = required_str(options, "state")?.to_string();
	let properties = options
		.get("properties")
		.and_then(Value::as_object)
		.map(|map| {
			map.iter()
				.filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
				.collect::<HashMap<_, _>>()
		})
		.unwrap_or_default();
	Ok(CreateItemParams {
		id,
		title,
		state,
		properties,
		body: options
			.get("body")
			.and_then(Value::as_str)
			.map(ToString::to_string),
		session_id: options
			.get("sessionId")
			.and_then(Value::as_str)
			.map(ToString::to_string),
		transcript_path: options
			.get("transcriptPath")
			.and_then(Value::as_str)
			.map(ToString::to_string),
		initial_message: options
			.get("initialMessage")
			.and_then(Value::as_str)
			.map(ToString::to_string),
	})
}

/// Parse items from an org file source or file path.
fn cmd_parse_items(options: &Value) -> Result<Value> {
	let source = read_org_source(options)?;
	let keywords = todo_keywords(options);
	let include_body = options
		.get("includeBody")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let file_path = options.get("file").and_then(Value::as_str).unwrap_or("");
	let items = extract_items_from_source(
		&source,
		&keywords,
		category(options),
		dir(options),
		file_path,
		include_body,
	)
	.map_err(org_err)?;
	let items_json: Vec<Value> = items
		.iter()
		.map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
		.collect();
	Ok(json_response(json!({ "items": items_json }), false))
}

/// Execute a query against parsed items.
fn cmd_query(options: &Value) -> Result<Value> {
	let source = read_org_source(options)?;
	let keywords = todo_keywords(options);
	let include_body = options
		.get("includeBody")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let file_path = options.get("file").and_then(Value::as_str).unwrap_or("");
	let items = extract_items_from_source(
		&source,
		&keywords,
		category(options),
		dir(options),
		file_path,
		include_body,
	)
	.map_err(org_err)?;
	let filter: QueryFilter = if let Some(query_str) = options.get("query").and_then(Value::as_str) {
		query::parse_keyword_query(query_str)
	} else if let Some(filter_obj) = options.get("filter") {
		serde_json::from_value(filter_obj.clone()).unwrap_or_default()
	} else {
		QueryFilter::default()
	};

	let mut filtered = query::apply_filter(&items, &filter);
	query::sort_items(&mut filtered, filter.sort.as_deref());
	let total = filtered.len();
	let paginated = query::paginate(filtered, filter.offset, filter.limit);
	let items_json: Vec<Value> = paginated
		.iter()
		.map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
		.collect();
	Ok(json_response(json!({ "items": items_json, "total": total }), false))
}

/// Build dependency graph from items.
fn cmd_graph(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let result = graph::build_graph(&items);
	Ok(json_response(serde_json::to_value(&result).unwrap_or(Value::Null), false))
}

/// Compute waves using Kahn's algorithm.
fn cmd_compute_waves(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let result = graph::compute_waves(&items, |id| {
		if let Some(pos) = id.find("::") {
			id[..pos].to_string()
		} else {
			String::new()
		}
	});
	Ok(json_response(serde_json::to_value(&result).unwrap_or(Value::Null), false))
}

/// Get next wave of eligible items.
fn cmd_next_wave(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let done_states: Vec<&str> = options
		.get("doneStates")
		.and_then(Value::as_array)
		.map_or_else(|| vec!["DONE"], |arr| arr.iter().filter_map(Value::as_str).collect());
	let result = graph::next_wave(&items, &done_states);
	Ok(json_response(serde_json::to_value(&result).unwrap_or(Value::Null), false))
}

/// Find connected components.
fn cmd_connected_components(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let components = graph::connected_components(&items);
	Ok(json_response(json!({ "components": components }), false))
}

fn cmd_create_item(options: &Value) -> Result<Value> {
	let path = required_path(options)?;
	ensure_org_file(&path)?;
	let params = create_params(options)?;
	let buffer = if let Some(buffer) = buffer_registry().get(&path) {
		buffer
	} else {
		buffer_registry().open(&path).map_err(engine_err)?
	};
	let mut buffer = buffer.lock();
	let edits = org_edit::create_item(&buffer, &params);
	buffer.edit_batch(edits).map_err(engine_err)?;
	buffer
		.save_with_watcher(buffer_registry().watcher())
		.map_err(engine_err)?;
	Ok(json_response(
		json!({ "success": true, "file": path.display().to_string(), "id": params.id }),
		false,
	))
}

fn cmd_update_item(options: &Value) -> Result<Value> {
	let path = required_path(options)?;
	let id = required_str(options, "id")?;
	let keywords = todo_keywords(options);
	let buffer = if let Some(buffer) = buffer_registry().get(&path) {
		buffer
	} else {
		buffer_registry().open(&path).map_err(engine_err)?
	};
	let mut buffer = buffer.lock();
	let mut updated = Vec::new();

	if let Some(state) = options.get("state").and_then(Value::as_str) {
		let Some(edits) = org_edit::update_state(&buffer, id, state, &keywords) else {
			return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
		};
		buffer.edit_batch(edits).map_err(engine_err)?;
		updated.push("state");
	}
	if let Some(title) = options.get("title").and_then(Value::as_str) {
		let Some(edits) = org_edit::update_title(&buffer, id, title, &keywords) else {
			return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
		};
		buffer.edit_batch(edits).map_err(engine_err)?;
		updated.push("title");
	}
	if let Some(body_value) = options.get("body") {
		let body = if body_value.is_null() {
			None
		} else {
			Some(
				body_value
					.as_str()
					.ok_or_else(|| org_err("Field 'body' must be string or null"))?,
			)
		};
		let Some(edits) = org_edit::replace_body(&buffer, id, body, &keywords) else {
			return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
		};
		buffer.edit_batch(edits).map_err(engine_err)?;
		updated.push("body");
	}
	if let Some(append) = options.get("append").and_then(Value::as_str) {
		let Some(edits) = org_edit::append_body(&buffer, id, append, &keywords) else {
			return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
		};
		buffer.edit_batch(edits).map_err(engine_err)?;
		updated.push("append");
	}
	if let Some(note) = options.get("note").and_then(Value::as_str) {
		let Some(edits) = org_edit::append_note(&buffer, id, note, &keywords) else {
			return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
		};
		buffer.edit_batch(edits).map_err(engine_err)?;
		updated.push("note");
	}

	buffer
		.save_with_watcher(buffer_registry().watcher())
		.map_err(engine_err)?;
	Ok(json_response(
		json!({ "success": true, "file": path.display().to_string(), "updated": updated }),
		false,
	))
}

fn cmd_set_property(options: &Value) -> Result<Value> {
	let path = required_path(options)?;
	let id = required_str(options, "id")?;
	let property = required_str(options, "property")?;
	let value = required_str(options, "value")?;
	let keywords = todo_keywords(options);
	let buffer = if let Some(buffer) = buffer_registry().get(&path) {
		buffer
	} else {
		buffer_registry().open(&path).map_err(engine_err)?
	};
	let mut buffer = buffer.lock();
	let Some(edits) = org_edit::set_property(&buffer, id, property, value, &keywords) else {
		return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
	};
	buffer.edit_batch(edits).map_err(engine_err)?;
	buffer
		.save_with_watcher(buffer_registry().watcher())
		.map_err(engine_err)?;
	Ok(json_response(json!({ "success": true, "property": property }), false))
}

fn cmd_append_note(options: &Value) -> Result<Value> {
	let path = required_path(options)?;
	let id = required_str(options, "id")?;
	let note = required_str(options, "note")?;
	let keywords = todo_keywords(options);
	let buffer = if let Some(buffer) = buffer_registry().get(&path) {
		buffer
	} else {
		buffer_registry().open(&path).map_err(engine_err)?
	};
	let mut buffer = buffer.lock();
	let Some(edits) = org_edit::append_note(&buffer, id, note, &keywords) else {
		return Ok(not_found("ITEM_NOT_FOUND", format!("Item '{id}' not found")));
	};
	buffer.edit_batch(edits).map_err(engine_err)?;
	buffer
		.save_with_watcher(buffer_registry().watcher())
		.map_err(engine_err)?;
	Ok(json_response(json!({ "success": true }), false))
}

fn cmd_edit_section(options: &Value) -> Result<Value> {
	if options.get("file").is_some() && options.get("id").is_some() {
		let path = required_path(options)?;
		let id = required_str(options, "id")?;
		let section_name = required_str(options, "section")?;
		let body = options.get("body").and_then(Value::as_str).unwrap_or("");
		let mode = match options
			.get("mode")
			.and_then(Value::as_str)
			.unwrap_or("replace")
		{
			"append" => SectionEditMode::Append,
			_ => SectionEditMode::Replace,
		};
		let keywords = todo_keywords(options);
		let buffer = if let Some(buffer) = buffer_registry().get(&path) {
			buffer
		} else {
			buffer_registry().open(&path).map_err(engine_err)?
		};
		let mut buffer = buffer.lock();
		let Some(edits) = org_edit::edit_section(&buffer, id, section_name, body, mode, &keywords)
		else {
			return Ok(not_found("SECTION_NOT_FOUND", format!("Section '{section_name}' not found")));
		};
		buffer.edit_batch(edits).map_err(engine_err)?;
		buffer
			.save_with_watcher(buffer_registry().watcher())
			.map_err(engine_err)?;
		return Ok(json_response(json!({ "success": true }), false));
	}

	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source"))?;
	let section_name = required_str(options, "section")?;
	let body = options.get("body").and_then(Value::as_str).unwrap_or("");
	let mode = options
		.get("mode")
		.and_then(Value::as_str)
		.unwrap_or("replace");
	let item_start = options
		.get("itemStart")
		.and_then(Value::as_u64)
		.map_or(0, |n| n as usize);
	let item_end = options
		.get("itemEnd")
		.and_then(Value::as_u64)
		.map_or(source.len(), |n| n as usize);

	let edit = match mode {
		"append" => section::edit_section_append(source, item_start, item_end, section_name, body),
		_ => section::edit_section_replace(source, item_start, item_end, section_name, body),
	};
	match edit {
		Some(edit) => {
			let new_source = section::apply_edit(source, &edit);
			Ok(json_response(
				json!({
					"success": true,
					"source": new_source,
					"edit": { "start": edit.start, "end": edit.end }
				}),
				false,
			))
		},
		None => Ok(not_found("SECTION_NOT_FOUND", format!("Section '{section_name}' not found"))),
	}
}

/// Convert org to markdown.
fn cmd_to_markdown(options: &Value) -> Result<Value> {
	let source = read_org_source(options)?;
	let md = markdown::org_to_markdown(&source);
	Ok(json_response(json!({ "markdown": md }), false))
}

/// Convert org to plain text.
fn cmd_to_plain_text(options: &Value) -> Result<Value> {
	let source = read_org_source(options)?;
	let text = markdown::org_to_plain_text(&source);
	Ok(json_response(json!({ "text": text }), false))
}

/// Parse items from `source` + `todoKeywords` in options.
fn parse_items_from_options(options: &Value) -> Result<Vec<pi_org_engine::OrgItem>> {
	if let Some(items_arr) = options.get("items").and_then(Value::as_array) {
		let items: Vec<pi_org_engine::OrgItem> = items_arr
			.iter()
			.enumerate()
			.filter_map(|(i, value)| {
				match serde_json::from_value::<pi_org_engine::OrgItem>(value.clone()) {
					Ok(item) => Some(item),
					Err(error) => {
						eprintln!("pi-org-engine: failed to deserialize item[{i}]: {error}");
						None
					},
				}
			})
			.collect();
		if !items.is_empty() {
			return Ok(items);
		}
	}

	let source = read_org_source(options)?;
	let keywords = todo_keywords(options);
	extract_items_from_source(
		&source,
		&keywords,
		category(options),
		dir(options),
		options.get("file").and_then(Value::as_str).unwrap_or(""),
		false,
	)
	.map_err(org_err)
}

#[allow(dead_code)]
fn execute_org_inner(options: &Value) -> Result<Value> {
	let command = options
		.get("command")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: command"))?;
	match command {
		"parse" => cmd_parse_items(options),
		"query" => cmd_query(options),
		"graph" => cmd_graph(options),
		"computeWaves" => cmd_compute_waves(options),
		"nextWave" => cmd_next_wave(options),
		"connectedComponents" => cmd_connected_components(options),
		"createItem" => cmd_create_item(options),
		"updateItem" => cmd_update_item(options),
		"setProperty" => cmd_set_property(options),
		"appendNote" => cmd_append_note(options),
		"editSection" => cmd_edit_section(options),
		"toMarkdown" => cmd_to_markdown(options),
		"toPlainText" => cmd_to_plain_text(options),
		other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
	}
}

#[napi(js_name = "executeOrg")]
pub fn execute_org(options: Value) -> Result<Value> {
	match execute_org_inner(&options) {
		Ok(value) => Ok(value),
		Err(error) => {
			let reason = error.to_string();
			let payload = reason
				.split_once(", ")
				.and_then(|(_, candidate)| candidate.starts_with('{').then_some(candidate))
				.unwrap_or(reason.as_str());
			let output = serde_json::from_str::<Value>(payload).unwrap_or(Value::String(reason));
			Ok(json_response(output, true))
		},
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use filetime::{FileTime, set_file_mtime};
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn org_external_write_parse_reloads_overwrite() {
		let dir = tempdir().expect("tempdir");
		let file = dir.path().join("external-write.org");
		let file_path = file.to_str().expect("utf8 path");

		let created = execute_org(json!({
			"command": "createItem",
			"file": file_path,
			"id": "BUG-279",
			"title": "Original",
			"state": "ITEM",
			"todoKeywords": ["ITEM", "DONE"]
		}))
		.expect("create item");
		assert_eq!(created["error"], json!(false));

		fs::write(
			&file,
			"* ITEM Replaced\n:PROPERTIES:\n:CUSTOM_ID: BUG-279\n:END:\n\nExternal body.\n",
		)
		.expect("external write");
		let bumped = FileTime::from_system_time(
			std::time::SystemTime::now() + std::time::Duration::from_secs(1),
		);
		set_file_mtime(&file, bumped).expect("bump mtime");

		let parsed = execute_org(json!({
			"command": "parse",
			"file": file_path,
			"todoKeywords": ["ITEM", "DONE"],
			"includeBody": true,
			"category": "bugs",
			"dir": "bugs"
		}))
		.expect("parse item");
		assert_eq!(parsed["error"], json!(false));
		let items = parsed["output"]["items"].as_array().expect("items array");
		assert_eq!(items[0]["title"], json!("Replaced"));
		assert!(
			items[0]["body"]
				.as_str()
				.expect("body")
				.contains("External body.")
		);
	}

	#[test]
	fn org_external_write_append_note_reports_external_modification() {
		let dir = tempdir().expect("tempdir");
		let file = dir.path().join("append-note.org");
		let file_path = file.to_str().expect("utf8 path");

		let created = execute_org(json!({
			"command": "createItem",
			"file": file_path,
			"id": "BUG-280",
			"title": "Original",
			"state": "ITEM",
			"todoKeywords": ["ITEM", "DONE"]
		}))
		.expect("create item");
		assert_eq!(created["error"], json!(false));

		fs::write(
			&file,
			"* ITEM Replaced\n:PROPERTIES:\n:CUSTOM_ID: BUG-280\n:END:\n\nExternal body.\n",
		)
		.expect("external write");
		let bumped = FileTime::from_system_time(
			std::time::SystemTime::now() + std::time::Duration::from_secs(1),
		);
		set_file_mtime(&file, bumped).expect("bump mtime");

		let noted = execute_org(json!({
			"command": "appendNote",
			"file": file_path,
			"id": "BUG-280",
			"note": "should fail",
			"todoKeywords": ["ITEM", "DONE"]
		}))
		.expect("append note");
		assert_eq!(noted["error"], json!(true));
		assert_eq!(noted["output"]["code"], json!("EXTERNAL_MODIFICATION"));
		let disk = fs::read_to_string(&file).expect("read disk");
		assert!(disk.contains("External body."));
		assert!(!disk.contains("should fail"));
	}
}
