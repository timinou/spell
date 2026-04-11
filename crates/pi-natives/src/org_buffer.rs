//! NAPI bridge for the org engine.
//!
//! Single entry point `executeOrg` with command dispatch,
//! following the `executeCodeBuffer` pattern.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_org_engine::{
	buffer::OrgBuffer,
	graph, markdown,
	query::{self, QueryFilter},
	section,
};
use serde_json::{Value, json};

fn org_err(message: impl Into<String>) -> napi::Error {
	napi::Error::from_reason(message.into())
}

fn json_response(output: Value, error: bool) -> Value {
	json!({ "output": output, "error": error })
}

/// Parse items from an org file source.
fn cmd_parse_items(options: &Value) -> Result<Value> {
	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source"))?;
	let todo_keywords: Vec<&str> = options
		.get("todoKeywords")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default();
	let category = options
		.get("category")
		.and_then(Value::as_str)
		.unwrap_or("default");
	let dir = options
		.get("dir")
		.and_then(Value::as_str)
		.unwrap_or("tasks");
	let file_path = options.get("file").and_then(Value::as_str).unwrap_or("");
	let include_body = options
		.get("includeBody")
		.and_then(Value::as_bool)
		.unwrap_or(false);

	let buffer = OrgBuffer::parse(source).map_err(|e| org_err(e))?;
	let items = buffer.extract_items(&todo_keywords, category, dir, file_path, include_body);

	let items_json: Vec<Value> = items
		.iter()
		.map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
		.collect();

	Ok(json_response(json!({ "items": items_json }), false))
}

/// Execute a query against parsed items.
fn cmd_query(options: &Value) -> Result<Value> {
	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source"))?;
	let todo_keywords: Vec<&str> = options
		.get("todoKeywords")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default();
	let category = options
		.get("category")
		.and_then(Value::as_str)
		.unwrap_or("default");
	let dir = options
		.get("dir")
		.and_then(Value::as_str)
		.unwrap_or("tasks");
	let file_path = options.get("file").and_then(Value::as_str).unwrap_or("");
	let include_body = options
		.get("includeBody")
		.and_then(Value::as_bool)
		.unwrap_or(false);

	let buffer = OrgBuffer::parse(source).map_err(|e| org_err(e))?;
	let items = buffer.extract_items(&todo_keywords, category, dir, file_path, include_body);

	// Parse filter from options
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
		// Parent ID derivation: for sub-outline IDs (parent::slug), extract parent
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
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_else(|| vec!["DONE"]);
	let result = graph::next_wave(&items, &done_states);
	Ok(json_response(serde_json::to_value(&result).unwrap_or(Value::Null), false))
}

/// Find connected components.
fn cmd_connected_components(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let components = graph::connected_components(&items);
	Ok(json_response(json!({ "components": components }), false))
}

/// Edit a section within an org file.
fn cmd_edit_section(options: &Value) -> Result<Value> {
	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source"))?;
	let section_name = options
		.get("section")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: section"))?;
	let body = options.get("body").and_then(Value::as_str).unwrap_or("");
	let mode = options
		.get("mode")
		.and_then(Value::as_str)
		.unwrap_or("replace");
	let item_start = options
		.get("itemStart")
		.and_then(Value::as_u64)
		.map(|n| n as usize)
		.unwrap_or(0);
	let item_end = options
		.get("itemEnd")
		.and_then(Value::as_u64)
		.map(|n| n as usize)
		.unwrap_or(source.len());

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
		None => Ok(json_response(
			json!({
				"error": true,
				"code": "SECTION_NOT_FOUND",
				"message": format!("Section '{}' not found", section_name)
			}),
			true,
		)),
	}
}

/// Convert org to markdown.
fn cmd_to_markdown(options: &Value) -> Result<Value> {
	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source"))?;
	let md = markdown::org_to_markdown(source);
	Ok(json_response(json!({ "markdown": md }), false))
}

/// Convert org to plain text.
fn cmd_to_plain_text(options: &Value) -> Result<Value> {
	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source"))?;
	let text = markdown::org_to_plain_text(source);
	Ok(json_response(json!({ "text": text }), false))
}

/// Parse items from `source` + `todoKeywords` in options.
/// Used by graph/wave commands that take pre-parsed content.
fn parse_items_from_options(options: &Value) -> Result<Vec<pi_org_engine::OrgItem>> {
	// Try pre-serialized items first
	if let Some(items_arr) = options.get("items").and_then(Value::as_array) {
		let items: Vec<pi_org_engine::OrgItem> = items_arr
			.iter()
			.filter_map(|v| serde_json::from_value(v.clone()).ok())
			.collect();
		if !items.is_empty() {
			return Ok(items);
		}
	}

	// Fall back to parsing from source
	let source = options
		.get("source")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: source or items"))?;
	let todo_keywords: Vec<&str> = options
		.get("todoKeywords")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default();
	let category = options
		.get("category")
		.and_then(Value::as_str)
		.unwrap_or("default");
	let dir = options
		.get("dir")
		.and_then(Value::as_str)
		.unwrap_or("tasks");
	let file_path = options.get("file").and_then(Value::as_str).unwrap_or("");

	let buffer = OrgBuffer::parse(source).map_err(|e| org_err(e))?;
	Ok(buffer.extract_items(&todo_keywords, category, dir, file_path, false))
}

#[napi(js_name = "executeOrg")]
pub fn execute_org(options: Value) -> Result<Value> {
	let command = options
		.get("command")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: command"))?;

	match command {
		"parse" => cmd_parse_items(&options),
		"query" => cmd_query(&options),
		"graph" => cmd_graph(&options),
		"computeWaves" => cmd_compute_waves(&options),
		"nextWave" => cmd_next_wave(&options),
		"connectedComponents" => cmd_connected_components(&options),
		"editSection" => cmd_edit_section(&options),
		"toMarkdown" => cmd_to_markdown(&options),
		"toPlainText" => cmd_to_plain_text(&options),
		other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
	}
}
