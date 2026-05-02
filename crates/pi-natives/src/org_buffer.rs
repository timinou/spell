//! NAPI bridge for the org engine.
//!
//! Single entry point `executeOrg` with command dispatch,
//! following the `executeCodeBuffer` pattern.

use std::{
	collections::HashMap,
	fs,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_org_engine::{
	buffer::extract_items_from_source,
	edge::EdgeKind,
	edit::{self as org_edit, CreateItemParams, SectionEditMode},
	graph::{self, build_typed_graph, neighborhood, timeline},
	item::OrgItem,
	locate::{MultiRootIndex, RootScope},
	markdown,
	query::{self, QueryFilter},
	section,
};
use pi_org_recall::{
	embedder::MockEmbedder,
	fts::FtsIndex,
	recall::{recall, RecallContext, RecallQuery},
	vec::VecIndex,
	Embedder,
};
use serde_json::{Value, json};

use crate::{buffer_registry, org_index};

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
fn required_root(options: &Value) -> Result<PathBuf> {
	let root = options
		.get("root")
		.and_then(Value::as_str)
		.ok_or_else(|| org_err("Missing required field: root"))?;
	Ok(PathBuf::from(root))
}

fn read_org_source(options: &Value) -> Result<String> {
	if let Some(source) = options.get("source").and_then(Value::as_str) {
		return Ok(source.to_string());
	}
	let path = required_path(options)?;
	let _ = buffer_registry().close(&path);
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
	match graph::compute_waves(&items, |id| {
		if let Some(pos) = id.find("::") {
			id[..pos].to_string()
		} else {
			String::new()
		}
	}) {
		Ok(result) => Ok(json_response(serde_json::to_value(&result).unwrap_or(Value::Null), false)),
		Err(error) => Ok(json_response(serde_json::to_value(&error).unwrap_or(Value::Null), true)),
	}
}

/// Get next wave of eligible items.
fn cmd_next_wave(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let done_states: Vec<&str> = options
		.get("doneStates")
		.and_then(Value::as_array)
		.map_or_else(|| vec!["DONE"], |arr| arr.iter().filter_map(Value::as_str).collect());
	match graph::next_wave(&items, &done_states) {
		Ok(result) => Ok(json_response(serde_json::to_value(&result).unwrap_or(Value::Null), false)),
		Err(error) => Ok(json_response(serde_json::to_value(&error).unwrap_or(Value::Null), true)),
	}
}

/// Find connected components.
fn cmd_connected_components(options: &Value) -> Result<Value> {
	let items = parse_items_from_options(options)?;
	let components = graph::connected_components(&items);
	Ok(json_response(json!({ "components": components }), false))
}

#[allow(deprecated, reason = "org buffer still persists through save_with_watcher")]
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
	refresh_org_index_after_write(options)?;
	Ok(json_response(
		json!({ "success": true, "file": path.display().to_string(), "id": params.id }),
		false,
	))
}

#[allow(deprecated, reason = "org buffer still persists through save_with_watcher")]
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
	refresh_org_index_after_write(options)?;
	Ok(json_response(
		json!({ "success": true, "file": path.display().to_string(), "updated": updated }),
		false,
	))
}

#[allow(deprecated, reason = "org buffer still persists through save_with_watcher")]
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
	refresh_org_index_after_write(options)?;
	Ok(json_response(json!({ "success": true, "property": property }), false))
}

#[allow(deprecated, reason = "org buffer still persists through save_with_watcher")]
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
	refresh_org_index_after_write(options)?;
	Ok(json_response(json!({ "success": true }), false))
}

#[allow(deprecated, reason = "org buffer still persists through save_with_watcher")]
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
		refresh_org_index_after_write(options)?;
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
fn refresh_org_index_after_write(options: &Value) -> Result<()> {
	let Some(root) = options
		.get("root")
		.and_then(Value::as_str)
		.map(PathBuf::from)
	else {
		return Ok(());
	};
	let Some(_) = options.get("categories") else {
		return Ok(());
	};
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	org_index::ensure_fresh(&root, &categories, &keywords, true).map_err(org_err)?;
	Ok(())
}

fn cmd_org_index_status(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	Ok(json_response(org_index::status_json(&root), false))
}

fn cmd_org_index_rebuild(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	let (entry, previous_status, rebuilt) =
		org_index::ensure_fresh(&root, &categories, &keywords, true).map_err(org_err)?;
	Ok(json_response(
		json!({
			"status": cache_status_json(previous_status),
			"rebuilt": rebuilt,
			"itemCount": entry.index.items.len(),
			"duplicateIds": entry.index.duplicate_ids,
			"fingerprintHash": org_index::fingerprint_hash(&entry),
		}),
		false,
	))
}

fn cmd_org_index_resolve(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	let id = required_str(options, "id")?;
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	let include_body = options
		.get("includeBody")
		.and_then(Value::as_bool)
		.unwrap_or(true);
	let (entry, status, rebuilt) =
		org_index::ensure_fresh(&root, &categories, &keywords, false).map_err(org_err)?;
	let items = org_index::resolve(&entry, id, include_body);
	Ok(json_response(
		json!({
			"items": items,
			"item": items.first(),
			"cacheStatus": cache_status_json(status),
			"rebuilt": rebuilt,
			"duplicates": entry.index.duplicate_ids.get(id),
		}),
		false,
	))
}

fn cmd_org_index_list(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	let include_body = options
		.get("includeBody")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let filter = if let Some(query_str) = options.get("query").and_then(Value::as_str) {
		query::parse_keyword_query(query_str)
	} else if let Some(filter_obj) = options.get("filter") {
		serde_json::from_value::<QueryFilter>(filter_obj.clone()).unwrap_or_default()
	} else {
		QueryFilter::default()
	};
	let (entry, status, rebuilt) =
		org_index::ensure_fresh(&root, &categories, &keywords, false).map_err(org_err)?;
	let (items, total) = org_index::list(&entry, &filter, include_body);
	Ok(json_response(
		json!({
			"items": items,
			"total": total,
			"cacheStatus": cache_status_json(status),
			"rebuilt": rebuilt,
			"duplicateIds": entry.index.duplicate_ids,
		}),
		false,
	))
}

fn cmd_org_index_dashboard(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	let (entry, ..) =
		org_index::ensure_fresh(&root, &categories, &keywords, false).map_err(org_err)?;
	Ok(json_response(org_index::dashboard(&entry, &categories, &keywords), false))
}

fn cmd_org_index_archive(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	let category = options.get("category").and_then(Value::as_str);
	let (entry, ..) =
		org_index::ensure_fresh(&root, &categories, &keywords, false).map_err(org_err)?;
	let items = org_index::archive_items(&entry, category);
	Ok(json_response(json!({ "archived": items.len(), "items": items }), false))
}

fn cmd_org_index_validate_plan(options: &Value) -> Result<Value> {
	let root = required_root(options)?;
	let id = required_str(options, "id")?;
	let categories = org_index::parse_categories(options).map_err(org_err)?;
	let keywords = todo_keywords(options);
	let (entry, ..) =
		org_index::ensure_fresh(&root, &categories, &keywords, false).map_err(org_err)?;
	Ok(json_response(org_index::validate_plan(&entry, id), false))
}

fn cache_status_json(status: pi_workspace_cache::CacheStatus) -> Value {
	match status {
		pi_workspace_cache::CacheStatus::Missing => json!({ "status": "missing" }),
		pi_workspace_cache::CacheStatus::Fresh => json!({ "status": "fresh" }),
		pi_workspace_cache::CacheStatus::Stale { reason } => {
			json!({ "status": "stale", "reason": reason })
		},
	}
}


// ---------------------------------------------------------------------------
// New commands: recall, remember, timeline, subgraph, link
// ---------------------------------------------------------------------------

fn walk_org_files(dir: &Path) -> Vec<PathBuf> {
	let mut files = Vec::new();
	let Ok(read_dir) = fs::read_dir(dir) else { return files; };
	for entry in read_dir.flatten() {
		let path = entry.path();
		if path.is_dir() {
			files.extend(walk_org_files(&path));
		} else if path.extension().is_some_and(|ext| ext == "org") {
			files.push(path);
		}
	}
	files
}

fn parse_org_files(files: &[PathBuf]) -> Vec<OrgItem> {
	let mut items = Vec::new();
	for file in files {
		let path_str = file.to_string_lossy();
		if let Ok(source) = fs::read_to_string(file) {
			if let Ok(mut parsed) = extract_items_from_source(
				&source, &[], "", "", &path_str, false,
			) {
				items.append(&mut parsed);
			}
		}
	}
	items
}

fn epoch_millis() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis() as i64)
		.unwrap_or(0)
}

/// Civil date helper: seconds since epoch → (year, month, day)
fn civil_date(secs: u64) -> (i32, u32, u32) {
	// Based on Howard Hinnant's algorithm
	let z = secs / 86400 + 719468;
	let era = z / 146097;
	let doe = z - era * 146097;
	let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
	let y = yoe as i32 + era as i32 * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if m <= 2 { y + 1 } else { y };
	(y as i32, m as u32, d as u32)
}

fn iso_date() -> String {
	let secs = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);
	let (y, m, d) = civil_date(secs);
	format!("{:04}-{:02}-{:02}", y, m, d)
}

fn iso_datetime() -> String {
	let secs = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);
	let (y, m, d) = civil_date(secs);
	let h = (secs % 86400) / 3600;
	let min = (secs % 3600) / 60;
	let s = secs % 60;
	format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, h, min, s)
}

fn make_slug(summary: &str) -> String {
	let slug: String = summary
		.to_lowercase()
		.chars()
		.map(|c| if c.is_alphanumeric() { c } else { '-' })
		.collect();
	let trimmed: String = slug.trim_matches('-').to_string();
	trimmed.chars().take(40).collect()
}

fn generate_id(prefix: &str, summary: &str) -> String {
	use std::hash::{Hash, Hasher};
	let ts = epoch_millis();
	let mut hasher = std::collections::hash_map::DefaultHasher::new();
	ts.hash(&mut hasher);
	summary.hash(&mut hasher);
	let hash = hasher.finish();
	format!("{}-{:012x}", prefix, hash)
}

/// Build RELATIONS drawer lines from optional id lists.
fn build_relations_drawer(
	involves: &[String], about: &[String], produced: &[String],
	distilled_from: &[String], supersedes: &[String],
) -> String {
	let mut lines: Vec<String> = Vec::new();
	lines.push(":RELATIONS:".to_string());
	for id in involves { lines.push(format!("INVOLVED: {}", id)); }
	for id in about { lines.push(format!("ABOUT: {}", id)); }
	for id in produced { lines.push(format!("PRODUCED: {}", id)); }
	for id in distilled_from { lines.push(format!("DISTILLED_FROM: {}", id)); }
	for id in supersedes { lines.push(format!("SUPERSEDES: {}", id)); }
	lines.push(":END:".to_string());
	lines.join("\n")
}

fn cmd_recall(options: &Value) -> Result<Value> {
	let query_text = options.get("text").and_then(Value::as_str).map(String::from);
	let scope: Vec<String> = options
		.get("scope")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
		.unwrap_or_default();
	let focus = options.get("focus").and_then(Value::as_str).map(String::from);
	let graph_hops = options.get("graphHops").and_then(Value::as_u64).unwrap_or(1) as u8;
	let limit = options.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
	let include_personal = options.get("includePersonal").and_then(Value::as_bool).unwrap_or(false);
	let weights = options.get("weights").and_then(|w| serde_json::from_value::<pi_org_recall::FusionWeights>(w.clone()).ok());

	let graph_kinds: Vec<EdgeKind> = options
		.get("graphKinds")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(EdgeKind::parse)).collect())
		.unwrap_or_default();

	let repo_root = options.get("repoRoot").and_then(Value::as_str).map(PathBuf::from)
		.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

	let mut all_items: Vec<OrgItem> = Vec::new();

	let tasks_dir = repo_root.join("!tasks");
	if tasks_dir.is_dir() {
		let files = walk_org_files(&tasks_dir);
		all_items.append(&mut parse_org_files(&files));
	}

	let memory_dir = repo_root.join(".spell").join("memory");
	if memory_dir.is_dir() {
		let files = walk_org_files(&memory_dir);
		all_items.append(&mut parse_org_files(&files));
	}

	if all_items.is_empty() {
		return Ok(json_response(json!({ "hits": [] }), false));
	}

	let fts = FtsIndex::open(&repo_root).map_err(|e| org_err(format!("fts open: {e}")))?;
	fts.index(&all_items).map_err(|e| org_err(format!("fts index: {e}")))?;

	let mut vec_idx = VecIndex::new(768);
	let embedder = MockEmbedder::new();

	// Embed each item and insert into VecIndex (uses blake3-based MockEmbedder)
	let embed_texts: Vec<String> = all_items.iter().map(|item| {
		match item.body.as_ref() {
			Some(body) => format!("{} {}", item.title, body.chars().take(512).collect::<String>()),
			None => item.title.clone(),
		}
	}).collect();
	let embed_refs: Vec<&str> = embed_texts.iter().map(String::as_str).collect();

	if let Ok(vectors) = embedder.embed_batch(&embed_refs) {
		for (i, item) in all_items.iter().enumerate() {
			if let Some(vec) = vectors.get(i) {
				let _ = vec_idx.insert(item.id.clone(), vec.clone());
			}
		}
	}

	let typed_graph = build_typed_graph(&all_items);

	let query = RecallQuery {
		text: query_text,
		scope,
		focus,
		graph_hops,
		graph_kinds,
		limit,
		weights,
		profile: options.get("profile").and_then(Value::as_str).map(String::from),
		include_personal,
	};

	let ctx = RecallContext {
		items: &all_items,
		fts: &fts,
		vec: &vec_idx,
		embedder: &embedder,
		graph: &typed_graph,
	};

	let hits = recall(query, &ctx).map_err(|e| org_err(format!("recall: {e}")))?;

	let hits_json: Vec<Value> = hits.iter().map(|hit| {
		let mut h = serde_json::to_value(hit).unwrap_or(Value::Null);
		// Truncate excerpts to 200 chars
		if let Some(excerpt) = h.get("excerpt").and_then(Value::as_str) {
			let truncated: String = excerpt.chars().take(200).collect();
			if truncated.len() < excerpt.len() {
				h["excerpt"] = json!(truncated);
			}
		}
		h
	}).collect();

	Ok(json_response(json!({ "hits": hits_json }), false))
}

fn cmd_remember(options: &Value) -> Result<Value> {
	let kind = required_str(options, "kind")?;
	let summary = required_str(options, "summary")?;
	let involves: Vec<String> = options.get("involves")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
		.unwrap_or_default();
	let about: Vec<String> = options.get("about")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
		.unwrap_or_default();
	let produced: Vec<String> = options.get("produced")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
		.unwrap_or_default();
	let distilled_from: Vec<String> = options.get("distilledFrom")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
		.unwrap_or_default();
	let supersedes: Vec<String> = options.get("supersedes")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
		.unwrap_or_default();

	let repo_root = options.get("repoRoot").and_then(Value::as_str).map(PathBuf::from)
		.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

	let (file_path, item_id, slug_str) = match kind {
		"episode" => {
			let date = iso_date();
			let slug = make_slug(summary);
			let id = generate_id("EP", summary);
			let file = repo_root.join(".spell").join("memory").join("episodes").join(format!("{}.org", date));
			(file, id, slug)
		},
		"concept" => {
			let slug = make_slug(summary);
			let id = format!("CON-{}", slug);
			let file = repo_root.join(".spell").join("memory").join("concepts").join(format!("{}.org", slug));
			(file, id, slug)
		},
		other => return Err(org_err(format!("Unknown kind: {other}"))),
	};

	// Ensure parent directory exists
	if let Some(parent) = file_path.parent() {
		fs::create_dir_all(parent).map_err(|e| org_err(format!("mkdir: {e}")))?;
	}

	// Build the org-formatted block
	let relations_drawer = build_relations_drawer(&involves, &about, &produced, &distilled_from, &supersedes);
	let created = iso_datetime();
	let confidence = "0.6";

	let block = format!(
		"** ITEM {summary}\n:PROPERTIES:\n:CUSTOM_ID: {item_id}\n:KIND: {kind}\n:CONFIDENCE: {confidence}\n:CREATED: {created}\n:END:\n{relations_drawer}\n"
	);

	let path_str = file_path.to_string_lossy().to_string();

	if file_path.exists() {
		// Append to existing file
		let mut contents = fs::read_to_string(&file_path)
			.map_err(|e| org_err(format!("read: {e}")))?;
		if !contents.ends_with('\n') {
			contents.push('\n');
		}
		contents.push_str(&block);
		fs::write(&file_path, &contents).map_err(|e| org_err(format!("write: {e}")))?;
	} else {
		// Create new file with title header
		let date = iso_date();
		let title = match kind {
			"episode" => format!("Episodes {}", date),
			_ => slug_str.clone(),
		};
		let contents = format!("#+TITLE: {title}\n\n{block}");
		fs::write(&file_path, &contents).map_err(|e| org_err(format!("write: {e}")))?;
	}

	Ok(json_response(json!({
		"id": item_id,
		"file": path_str
	}), false))
}

fn cmd_timeline(options: &Value) -> Result<Value> {
	let target = required_str(options, "target")?;

	let items = if let Some(source) = options.get("source").and_then(Value::as_str) {
		let keywords = todo_keywords(options);
		extract_items_from_source(source, &keywords, category(options), dir(options),
			options.get("file").and_then(Value::as_str).unwrap_or(""), false)
			.map_err(org_err)?
	} else if let Some(items_arr) = options.get("items").and_then(Value::as_array) {
		let parsed: Vec<OrgItem> = items_arr.iter().filter_map(|v| {
			serde_json::from_value::<OrgItem>(v.clone()).ok()
		}).collect();
		parsed
	} else {
		let repo_root = options.get("repoRoot").and_then(Value::as_str).map(PathBuf::from)
			.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
		let mut all_items = Vec::new();
		for dir_name in &["!tasks", ".spell/memory"] {
			let dir = repo_root.join(dir_name);
			if dir.is_dir() {
				let files = walk_org_files(&dir);
				all_items.append(&mut parse_org_files(&files));
			}
		}
		all_items
	};

	let entries = timeline(&items, target);

	let entries_json: Vec<Value> = entries.iter().map(|entry| {
		json!({
			"id": entry.item.id,
			"kind": entry.item.kind,
			"title": entry.item.title,
			"file": entry.item.file,
			"ts": entry.ts,
		})
	}).collect();

	Ok(json_response(json!({ "entries": entries_json }), false))
}

fn cmd_subgraph(options: &Value) -> Result<Value> {
	let root = required_str(options, "root")?;
	let hops: u8 = options.get("hops").and_then(Value::as_u64).unwrap_or(1) as u8;

	let kinds: Vec<EdgeKind> = options
		.get("kinds")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(|v| v.as_str().map(EdgeKind::parse)).collect())
		.unwrap_or_default();

	let items = if let Some(source) = options.get("source").and_then(Value::as_str) {
		let keywords = todo_keywords(options);
		extract_items_from_source(source, &keywords, category(options), dir(options),
			options.get("file").and_then(Value::as_str).unwrap_or(""), false)
			.map_err(org_err)?
	} else if let Some(items_arr) = options.get("items").and_then(Value::as_array) {
		let parsed: Vec<OrgItem> = items_arr.iter().filter_map(|v| {
			serde_json::from_value::<OrgItem>(v.clone()).ok()
		}).collect();
		parsed
	} else {
		let repo_root = options.get("repoRoot").and_then(Value::as_str).map(PathBuf::from)
			.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
		let mut all_items = Vec::new();
		for dir_name in &["!tasks", ".spell/memory"] {
			let dir = repo_root.join(dir_name);
			if dir.is_dir() {
				let files = walk_org_files(&dir);
				all_items.append(&mut parse_org_files(&files));
			}
		}
		all_items
	};

	let typed_graph = build_typed_graph(&items);
	let sub = neighborhood(&typed_graph, root, hops, &kinds);

	let nodes_json: Vec<Value> = sub.nodes.iter().map(|node| {
		json!({
			"id": node.id,
			"kind": node.kind,
			"title": node.title,
			"file": node.file,
			"dangling": node.dangling,
		})
	}).collect();

	let edges_json: Vec<Value> = sub.edges.iter().map(|edge| {
		json!({
			"from": edge.from,
			"to": edge.to,
			"kind": edge.kind.token(),
		})
	}).collect();

	Ok(json_response(json!({
		"nodes": nodes_json,
		"edges": edges_json,
	}), false))
}

fn cmd_link(options: &Value) -> Result<Value> {
	let from = required_str(options, "from")?;
	let to = required_str(options, "to")?;
	let kind_str = required_str(options, "kind")?;
	let edge_kind = EdgeKind::parse(kind_str);

	let repo_root = options.get("repoRoot").and_then(Value::as_str).map(PathBuf::from)
		.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

	let todo_keywords: Vec<&str> = options.get("todoKeywords")
		.and_then(Value::as_array)
		.map(|arr| arr.iter().filter_map(Value::as_str).collect())
		.unwrap_or_default();

	let roots = vec![(RootScope::Cwd, repo_root.as_path())];
	let index = MultiRootIndex::build(&roots, &todo_keywords);

	let (_scope, file_path) = index.resolve(from)
		.ok_or_else(|| org_err(format!("Item {from} not found")))?;
	let file_path = file_path.to_path_buf();

	let contents = fs::read_to_string(&file_path)
		.map_err(|e| org_err(format!("read {}: {e}", file_path.display())))?;

	let lines: Vec<String> = contents.lines().map(String::from).collect();
	let mut new_lines = lines.clone();
	let mut _found_at: Option<usize> = None;

	#[derive(PartialEq)]
	enum State { Seeking, InProperties, AfterProperties, FoundDrawer }
	let mut state = State::Seeking;
	let mut insert_pos: Option<usize> = None;
	let mut line_idx = 0usize;

	while line_idx < new_lines.len() {
		let line = &new_lines[line_idx];
		match state {
			State::Seeking => {
				if line.starts_with('*') {
					state = State::InProperties;
				}
			},
			State::InProperties => {
				if line.starts_with(":CUSTOM_ID:") && line.contains(from) {
					_found_at = Some(line_idx);
				}
				if line.starts_with(":END:") {
					state = State::AfterProperties;
				}
			},
			State::AfterProperties => {
				insert_pos = Some(line_idx + 1);
				if line.starts_with(":RELATIONS:") {
					state = State::FoundDrawer;
					let edge_line = format!("{}: {}", edge_kind.token(), to);
					for check_idx in (line_idx + 1)..new_lines.len() {
						let check = &new_lines[check_idx];
						if check.starts_with(":END:") {
							insert_pos = Some(check_idx);
							break;
						}
						if check.trim() == edge_line {
							let revision = epoch_millis();
							return Ok(json_response(json!({
								"revision": revision,
								"file": file_path.to_string_lossy().to_string(),
							}), false));
						}
					}
				} else if line.starts_with('*') {
					break;
				}
			},
			State::FoundDrawer => {
				if line.starts_with(":END:") {
					insert_pos = Some(line_idx);
					break;
				}
			},
		}
		line_idx += 1;
	}

	if state == State::Seeking || state == State::InProperties {
		return Err(org_err(format!("Item {from} not found in {}", file_path.display())));
	}

	let edge_line = format!("{}: {}", edge_kind.token(), to);

	if let Some(pos) = insert_pos {
		if state == State::AfterProperties {
			// Create new RELATIONS drawer
			new_lines.insert(pos, ":RELATIONS:".to_string());
			new_lines.insert(pos + 1, edge_line);
			new_lines.insert(pos + 2, ":END:".to_string());
		} else {
			// Append to existing drawer (before :END:)
			new_lines.insert(pos, edge_line);
		}
	}

	let new_contents = new_lines.join("\n");
	fs::write(&file_path, &new_contents)
		.map_err(|e| org_err(format!("write {}: {e}", file_path.display())))?;

	let revision = epoch_millis();
	Ok(json_response(json!({
		"revision": revision,
		"file": file_path.to_string_lossy().to_string(),
	}), false))
}

#[allow(dead_code, reason = "helper used through execute_org wrapper")]
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
		"orgIndexStatus" => cmd_org_index_status(options),
		"orgIndexRebuild" => cmd_org_index_rebuild(options),
		"orgIndexResolve" => cmd_org_index_resolve(options),
		"orgIndexList" => cmd_org_index_list(options),
		"orgIndexDashboard" => cmd_org_index_dashboard(options),
		"orgIndexArchive" => cmd_org_index_archive(options),
		"orgIndexValidatePlan" => cmd_org_index_validate_plan(options),
		"recall" => cmd_recall(options),
		"remember" => cmd_remember(options),
		"timeline" => cmd_timeline(options),
		"subgraph" => cmd_subgraph(options),
		"link" => cmd_link(options),
		other => Ok(json_response(Value::String(format!("Unknown command: {other}")), true)),
	}
}

fn org_error_response(error: napi::Error) -> Value {
	let reason = error.to_string();
	let payload = reason
		.split_once(", ")
		.and_then(|(_, candidate)| candidate.starts_with('{').then_some(candidate))
		.unwrap_or(reason.as_str());
	let output = serde_json::from_str::<Value>(payload).unwrap_or(Value::String(reason));
	json_response(output, true)
}

fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(message) = payload.downcast_ref::<&str>() {
		return (*message).to_string();
	}
	if let Some(message) = payload.downcast_ref::<String>() {
		return message.clone();
	}
	"unknown panic payload".to_string()
}

fn execute_org_catching<F>(options: &Value, run: F) -> Value
where
	F: FnOnce(&Value) -> Result<Value>,
{
	match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(options))) {
		Ok(Ok(value)) => value,
		Ok(Err(error)) => org_error_response(error),
		Err(payload) => json_response(
			json!({
				"code": "NATIVE_PANIC",
				"message": format!("Native org dispatch panicked: {}", panic_payload_message(&*payload)),
			}),
			true,
		),
	}
}

#[napi(js_name = "executeOrg")]
pub fn execute_org(options: Value) -> Result<Value> {
	Ok(execute_org_catching(&options, execute_org_inner))
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
			std::time::SystemTime::now() + std::time::Duration::from_secs(5),
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
			std::time::SystemTime::now() + std::time::Duration::from_secs(5),
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

	fn category_json(dir: &std::path::Path) -> Value {
		json!([{ "absPath": dir.display().to_string(), "name": "features", "dir": "tasks" }])
	}

	#[test]
	fn execute_org_catching_returns_native_panic_error_payload() {
		let result = execute_org_catching(&json!({ "command": "parse" }), |_| -> Result<Value> {
			panic!("boom")
		});

		assert_eq!(result["error"], json!(true));
		assert_eq!(result["output"]["code"], json!("NATIVE_PANIC"));
		assert_eq!(result["output"]["message"], json!("Native org dispatch panicked: boom"));
	}

	#[test]
	fn execute_org_catching_preserves_error_response_shape() {
		let result = execute_org_catching(&json!({ "command": "parse" }), |_| {
			Err(org_err(
				json!({ "code": "ORDINARY_ERROR", "message": "ordinary failure" }).to_string(),
			))
		});

		assert_eq!(result["error"], json!(true));
		assert_eq!(result["output"]["code"], json!("ORDINARY_ERROR"));
		assert_eq!(result["output"]["message"], json!("ordinary failure"));
	}

	#[test]
	fn execute_org_catching_preserves_success_response_shape() {
		let result = execute_org_catching(&json!({ "command": "parse" }), |_| {
			Ok(json_response(json!({ "ok": true }), false))
		});

		assert_eq!(result["error"], json!(false));
		assert_eq!(result["output"], json!({ "ok": true }));
	}

	#[test]
	fn org_parse_frontmatter_only_without_final_newline_includes_no_body() {
		let parsed = execute_org(json!({
			"command": "parse",
			"source": "#+TITLE: EOF Plan\n#+CUSTOM_ID: PLAN-EOF\n#+STATE: ITEM",
			"todoKeywords": ["ITEM", "DONE"],
			"includeBody": true,
			"category": "plans",
			"dir": "plans"
		}))
		.expect("parse frontmatter-only source");

		assert_eq!(parsed["error"], json!(false));
		let items = parsed["output"]["items"].as_array().expect("items array");
		assert_eq!(items.len(), 1);
		assert_eq!(items[0]["id"], json!("PLAN-EOF"));
		assert_eq!(items[0]["body"], Value::Null);
	}

	#[test]
	fn org_index_resolves_frontmatter_only_without_final_newline_includes_no_body() {
		let dir = tempdir().expect("tempdir");
		let root = dir.path();
		let category = root.join("features");
		fs::create_dir_all(&category).expect("category");
		fs::write(
			category.join("PLAN-EOF.org"),
			"#+TITLE: EOF Plan\n#+CUSTOM_ID: PLAN-EOF\n#+STATE: ITEM",
		)
		.expect("org file");

		let rebuilt = execute_org(json!({
			"command": "orgIndexRebuild",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"]
		}))
		.expect("rebuild");
		assert_eq!(rebuilt["error"], json!(false));
		assert_eq!(rebuilt["output"]["itemCount"], json!(1));

		let resolved = execute_org(json!({
			"command": "orgIndexResolve",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"],
			"id": "PLAN-EOF",
			"includeBody": true
		}))
		.expect("resolve");
		assert_eq!(resolved["error"], json!(false));
		assert_eq!(resolved["output"]["item"]["id"], json!("PLAN-EOF"));
		assert_eq!(resolved["output"]["item"]["body"], Value::Null);
	}

	#[test]
	fn org_index_rebuild_resolves_top_level_and_suboutline() {
		let dir = tempdir().expect("tempdir");
		let root = dir.path();
		let category = root.join("features");
		fs::create_dir_all(&category).expect("category");
		fs::write(
			category.join("FEAT-001.org"),
			"* ITEM Feature\n:PROPERTIES:\n:CUSTOM_ID: FEAT-001\n:LAYER: core\n:END:\n\n** ITEM \
			 Child\n:PROPERTIES:\n:CUSTOM_ID: FEAT-001::child\n:DEPENDS: FEAT-001::other\n:END:\n",
		)
		.expect("org file");
		let rebuilt = execute_org(json!({
			"command": "orgIndexRebuild",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"]
		}))
		.expect("rebuild");
		assert_eq!(rebuilt["error"], json!(false));
		assert_eq!(rebuilt["output"]["itemCount"], json!(2));
		let resolved = execute_org(json!({
			"command": "orgIndexResolve",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"],
			"id": "FEAT-001::child",
			"includeBody": true
		}))
		.expect("resolve");
		assert_eq!(resolved["error"], json!(false));
		assert_eq!(resolved["output"]["item"]["id"], json!("FEAT-001::child"));
		assert_eq!(resolved["output"]["item"]["properties"]["DEPENDS"], json!("FEAT-001::other"));
	}

	#[test]
	fn org_index_status_tracks_workspace_file_drift_and_duplicates() {
		let dir = tempdir().expect("tempdir");
		let root = dir.path();
		let category = root.join("features");
		fs::create_dir_all(&category).expect("category");
		fs::write(category.join("a.org"), "* ITEM A\n:PROPERTIES:\n:CUSTOM_ID: DUP-001\n:END:\n")
			.expect("first org file");
		fs::write(category.join("b.org"), "* ITEM B\n:PROPERTIES:\n:CUSTOM_ID: DUP-001\n:END:\n")
			.expect("second org file");
		let missing = execute_org(json!({
			"command": "orgIndexStatus",
			"root": root.display().to_string(),
		}))
		.expect("status");
		assert_eq!(missing["output"]["cache"]["status"], json!("missing"));
		let rebuilt = execute_org(json!({
			"command": "orgIndexRebuild",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"]
		}))
		.expect("rebuild");
		assert_eq!(rebuilt["error"], json!(false));
		assert!(rebuilt["output"]["duplicateIds"]["DUP-001"].is_array());
		let fresh = execute_org(json!({
			"command": "orgIndexStatus",
			"root": root.display().to_string(),
		}))
		.expect("fresh status");
		assert_eq!(fresh["output"]["cache"]["status"], json!("fresh"));
		fs::write(category.join("c.org"), "* ITEM C\n:PROPERTIES:\n:CUSTOM_ID: FEAT-003\n:END:\n")
			.expect("third org file");
		let stale = execute_org(json!({
			"command": "orgIndexStatus",
			"root": root.display().to_string(),
		}))
		.expect("stale status");
		assert_eq!(stale["output"]["cache"]["status"], json!("stale"));
	}

	#[test]
	fn org_index_write_refreshes_same_session_reads() {
		let dir = tempdir().expect("tempdir");
		let root = dir.path();
		let category = root.join("features");
		fs::create_dir_all(&category).expect("category");
		let file = category.join("created.org");
		let created = execute_org(json!({
			"command": "createItem",
			"file": file.display().to_string(),
			"id": "FEAT-010",
			"title": "Created",
			"state": "ITEM",
			"todoKeywords": ["ITEM", "DONE"],
			"root": root.display().to_string(),
			"categories": category_json(&category)
		}))
		.expect("create item");
		assert_eq!(created["error"], json!(false));
		let resolved = execute_org(json!({
			"command": "orgIndexResolve",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"],
			"id": "FEAT-010",
			"includeBody": true
		}))
		.expect("resolve");
		assert_eq!(resolved["output"]["item"]["title"], json!("Created"));
		let updated = execute_org(json!({
			"command": "setProperty",
			"file": file.display().to_string(),
			"id": "FEAT-010",
			"property": "LAYER",
			"value": "native",
			"todoKeywords": ["ITEM", "DONE"],
			"root": root.display().to_string(),
			"categories": category_json(&category)
		}))
		.expect("set property");
		assert_eq!(updated["error"], json!(false));
		let resolved = execute_org(json!({
			"command": "orgIndexResolve",
			"root": root.display().to_string(),
			"categories": category_json(&category),
			"todoKeywords": ["ITEM", "DONE"],
			"id": "FEAT-010",
			"includeBody": true
		}))
		.expect("resolve updated");
		assert_eq!(resolved["output"]["item"]["properties"]["LAYER"], json!("native"));
	}

	#[test]
	fn compute_waves_duplicate_ids_return_error_payload() {
		let source = [
			"* ITEM Alpha",
			":PROPERTIES:",
			":CUSTOM_ID: DUP-001",
			":END:",
			"* ITEM Beta",
			":PROPERTIES:",
			":CUSTOM_ID: DUP-001",
			":END:",
		]
		.join("\n");
		let result = execute_org(json!({
			"command": "computeWaves",
			"source": source,
			"todoKeywords": ["ITEM", "DONE"],
			"category": "bugs",
			"dir": "bugs"
		}))
		.expect("compute waves");
		assert_eq!(result["error"], json!(true));
		assert_eq!(result["output"]["code"], json!("DUPLICATE_CUSTOM_ID"));
		assert_eq!(result["output"]["duplicate_ids"], json!(["DUP-001"]));
		assert_eq!(result["output"]["duplicate_count"], json!(1));
		assert_eq!(
			result["output"]["message"],
			json!("duplicate CUSTOM_ID values in wave input: DUP-001"),
		);
	}

	#[test]
	fn next_wave_duplicate_ids_return_error_payload() {
		let source = [
			"* DONE Alpha",
			":PROPERTIES:",
			":CUSTOM_ID: DUP-010",
			":END:",
			"* ITEM Beta",
			":PROPERTIES:",
			":CUSTOM_ID: DUP-010",
			":END:",
		]
		.join("\n");
		let result = execute_org(json!({
			"command": "nextWave",
			"source": source,
			"todoKeywords": ["ITEM", "DONE"],
			"doneStates": ["DONE"],
			"category": "bugs",
			"dir": "bugs"
		}))
		.expect("next wave");
		assert_eq!(result["error"], json!(true));
		assert_eq!(result["output"]["code"], json!("DUPLICATE_CUSTOM_ID"));
		assert_eq!(result["output"]["duplicate_ids"], json!(["DUP-010"]));
		assert_eq!(result["output"]["duplicate_count"], json!(1));
		assert_eq!(
			result["output"]["message"],
			json!("duplicate CUSTOM_ID values in wave input: DUP-010"),
		);
	}
}
