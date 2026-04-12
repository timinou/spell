use std::collections::HashMap;

use chrono::Utc;
use pi_code_engine::buffer::{CodeBuffer, TextEdit};
use regex::Regex;

use crate::{
	locate::{ItemKind, ItemLocation, locate_item_by_id},
	section,
};

#[derive(Debug, Clone, Default)]
pub struct CreateItemParams {
	pub id:              String,
	pub title:           String,
	pub state:           String,
	pub properties:      HashMap<String, String>,
	pub body:            Option<String>,
	pub session_id:      Option<String>,
	pub transcript_path: Option<String>,
	pub initial_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionEditMode {
	Replace,
	Append,
}

pub fn create_item(buffer: &CodeBuffer, params: &CreateItemParams) -> Vec<TextEdit> {
	let source = buffer.source();
	if source.trim().is_empty() || !source.lines().any(|line| line.starts_with('*')) {
		return vec![TextEdit {
			start_byte:   0,
			old_end_byte: source.len(),
			new_text:     serialize_file_item(params),
		}];
	}

	let separator = if source.ends_with('\n') { "" } else { "\n" };
	vec![TextEdit {
		start_byte:   source.len(),
		old_end_byte: source.len(),
		new_text:     format!("{separator}{}", serialize_heading(1, params)),
	}]
}

pub fn update_state(
	buffer: &CodeBuffer,
	custom_id: &str,
	new_state: &str,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let mut location = locate_item_by_id(buffer, custom_id, todo_keywords)?;
	match location.kind {
		ItemKind::File => {
			let line = format!("#+STATE: {new_state}");
			if let Some(idx) = location.state_line_idx {
				location.lines[idx] = line;
			} else {
				let insert_idx = location
					.title_line_idx
					.map_or(0, |idx| idx + 1)
					.min(location.lines.len());
				location.lines.insert(insert_idx, line);
			}
		},
		ItemKind::Heading => {
			let idx = location.heading_line_idx?;
			let (stars, _state, title, tags) =
				parse_heading_line(&location.lines[idx], todo_keywords)?;
			location.lines[idx] = compose_heading(&stars, Some(new_state), &title, &tags);
		},
	}
	Some(location.to_text_edit(render_lines(&location.lines)))
}

pub fn update_title(
	buffer: &CodeBuffer,
	custom_id: &str,
	new_title: &str,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let mut location = locate_item_by_id(buffer, custom_id, todo_keywords)?;
	match location.kind {
		ItemKind::File => {
			let line = format!("#+TITLE: {new_title}");
			if let Some(idx) = location.title_line_idx {
				location.lines[idx] = line;
			} else {
				location.lines.insert(0, line);
			}
		},
		ItemKind::Heading => {
			let idx = location.heading_line_idx?;
			let (stars, state, _title, tags) =
				parse_heading_line(&location.lines[idx], todo_keywords)?;
			location.lines[idx] = compose_heading(&stars, state.as_deref(), new_title, &tags);
		},
	}
	Some(location.to_text_edit(render_lines(&location.lines)))
}

pub fn replace_body(
	buffer: &CodeBuffer,
	custom_id: &str,
	new_body: Option<&str>,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let mut location = locate_item_by_id(buffer, custom_id, todo_keywords)?;
	replace_body_lines(&mut location, new_body);
	Some(location.to_text_edit(render_lines(&location.lines)))
}

pub fn append_body(
	buffer: &CodeBuffer,
	custom_id: &str,
	text: &str,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let mut location = locate_item_by_id(buffer, custom_id, todo_keywords)?;
	let existing = body_text(&location).trim().to_string();
	let addition = text.trim();
	if addition.is_empty() {
		return Some(location.to_text_edit(render_lines(&location.lines)));
	}
	let combined = if existing.is_empty() {
		addition.to_string()
	} else {
		format!("{}\n\n{}", existing.trim_end(), addition)
	};
	replace_body_lines(&mut location, Some(&combined));
	Some(location.to_text_edit(render_lines(&location.lines)))
}

pub fn set_property(
	buffer: &CodeBuffer,
	custom_id: &str,
	key: &str,
	value: &str,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let mut location = locate_item_by_id(buffer, custom_id, todo_keywords)?;
	match location.kind {
		ItemKind::File => set_file_property(&mut location, key, value),
		ItemKind::Heading => set_heading_property(&mut location, key, value),
	}
	Some(location.to_text_edit(render_lines(&location.lines)))
}

pub fn append_note(
	buffer: &CodeBuffer,
	custom_id: &str,
	note_text: &str,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let today = Utc::now().format("%Y-%m-%d").to_string();
	let note_line = format!("NOTE [{today}]: {}", note_text.trim());
	append_body(buffer, custom_id, &note_line, todo_keywords)
}

pub fn edit_section(
	buffer: &CodeBuffer,
	custom_id: &str,
	section_name: &str,
	body: &str,
	mode: SectionEditMode,
	todo_keywords: &[&str],
) -> Option<Vec<TextEdit>> {
	let location = locate_item_by_id(buffer, custom_id, todo_keywords)?;
	let edit = match mode {
		SectionEditMode::Replace => section::edit_section_replace(
			&location.source,
			0,
			location.source.len(),
			section_name,
			body,
		),
		SectionEditMode::Append => section::edit_section_append(
			&location.source,
			0,
			location.source.len(),
			section_name,
			body,
		),
	}?;
	Some(location.to_text_edit(section::apply_edit(&location.source, &edit)))
}

fn replace_body_lines(location: &mut ItemLocation, new_body: Option<&str>) {
	let replacement = normalized_body_lines(new_body);
	let end = match location.kind {
		ItemKind::File => location.lines.len(),
		ItemKind::Heading => location.body_end_idx,
	};
	location
		.lines
		.splice(location.body_start_idx..end, replacement);
}

fn body_text(location: &ItemLocation) -> String {
	let end = match location.kind {
		ItemKind::File => location.lines.len(),
		ItemKind::Heading => location.body_end_idx,
	};
	location.lines[location.body_start_idx..end].join("\n")
}

fn set_file_property(location: &mut ItemLocation, key: &str, value: &str) {
	let needle = format!("#+{key}:");
	if let Some(idx) = location
		.lines
		.iter()
		.position(|line| line.starts_with(&needle))
	{
		location.lines[idx] = format!("#+{key}: {value}");
		return;
	}
	let insert_idx = location
		.last_frontmatter_idx
		.map_or(0, |idx| idx + 1)
		.min(location.lines.len());
	location
		.lines
		.insert(insert_idx, format!("#+{key}: {value}"));
}

fn set_heading_property(location: &mut ItemLocation, key: &str, value: &str) {
	let property_line = format!(":{key}: {value}");
	if let (Some(drawer_start), Some(drawer_end)) =
		(location.drawer_start_idx, location.drawer_end_idx)
	{
		if let Some(idx) = location.lines[drawer_start + 1..drawer_end]
			.iter()
			.position(|line| line.starts_with(&format!(":{key}:")))
		{
			location.lines[drawer_start + 1 + idx] = property_line;
		} else {
			location.lines.insert(drawer_end, property_line);
		}
		return;
	}

	let heading_idx = location.heading_line_idx.unwrap_or(0);
	let insert_idx = heading_idx + 1;
	location.lines.splice(insert_idx..insert_idx, vec![
		":PROPERTIES:".into(),
		property_line,
		":END:".into(),
	]);
}

fn serialize_file_item(params: &CreateItemParams) -> String {
	let mut lines = vec![
		format!("#+TITLE: {}", params.title.trim()),
		format!("#+STATE: {}", params.state.trim()),
	];
	if let Some(session_id) = &params.session_id {
		lines.push(format!("#+SESSION_ID: {session_id}"));
	}
	if let Some(transcript_path) = &params.transcript_path {
		lines.push(format!("#+TRANSCRIPT_PATH: [[file:{transcript_path}]]"));
	}
	for (key, value) in sorted_properties(with_custom_id(params)) {
		lines.push(format!("#+{key}: {value}"));
	}
	if let Some(initial_message) = &params.initial_message {
		lines.push(String::new());
		lines.push("* Initial Message".into());
		lines.push(String::new());
		lines.extend(initial_message.trim_end().split('\n').map(str::to_string));
	}
	if let Some(body) = &params.body
		&& !body.trim().is_empty()
	{
		lines.push(String::new());
		lines.extend(body.trim_end().split('\n').map(str::to_string));
	}
	lines.push(String::new());
	render_lines(&lines)
}

fn serialize_heading(level: usize, params: &CreateItemParams) -> String {
	let mut lines = vec![compose_heading(
		&"*".repeat(level.max(1)),
		Some(params.state.trim()),
		params.title.trim(),
		"",
	)];
	lines.push(":PROPERTIES:".into());
	for (key, value) in sorted_properties(with_custom_id(params)) {
		lines.push(format!(":{key}: {value}"));
	}
	lines.push(":END:".into());
	if let Some(body) = &params.body
		&& !body.trim().is_empty()
	{
		lines.push(String::new());
		lines.extend(body.trim_end().split('\n').map(str::to_string));
	}
	lines.push(String::new());
	render_lines(&lines)
}

fn with_custom_id(params: &CreateItemParams) -> HashMap<String, String> {
	let mut props = params.properties.clone();
	props.insert("CUSTOM_ID".into(), params.id.clone());
	props
}

fn sorted_properties(properties: HashMap<String, String>) -> Vec<(String, String)> {
	let mut entries: Vec<_> = properties.into_iter().collect();
	entries.sort_by(|left, right| left.0.cmp(&right.0));
	entries
}

fn normalized_body_lines(body: Option<&str>) -> Vec<String> {
	let Some(body) = body.map(str::trim_end) else {
		return Vec::new();
	};
	if body.trim().is_empty() {
		return Vec::new();
	}
	let mut lines = vec![String::new()];
	lines.extend(body.split('\n').map(str::to_string));
	lines
}

fn render_lines(lines: &[String]) -> String {
	lines.join("\n")
}

fn parse_heading_line(
	line: &str,
	todo_keywords: &[&str],
) -> Option<(String, Option<String>, String, String)> {
	let trimmed = line.trim_end();
	if !trimmed.starts_with('*') {
		return None;
	}
	let stars_end = trimmed.find(' ')?;
	let stars = trimmed[..stars_end].to_string();
	let rest = trimmed[stars_end..].trim_start();
	let tags = heading_tags(rest);
	let title_part = if tags.is_empty() {
		rest.trim_end()
	} else {
		rest[..rest.len() - tags.len()].trim_end()
	};
	let mut pieces = title_part.splitn(2, ' ');
	let first = pieces.next().unwrap_or("");
	if todo_keywords.contains(&first) {
		Some((stars, Some(first.to_string()), pieces.next().unwrap_or("").trim().to_string(), tags))
	} else {
		Some((stars, None, title_part.trim().to_string(), tags))
	}
}

fn compose_heading(stars: &str, state: Option<&str>, title: &str, tags: &str) -> String {
	let mut line = stars.to_string();
	if let Some(state) = state.filter(|state| !state.trim().is_empty()) {
		line.push(' ');
		line.push_str(state.trim());
	}
	if !title.trim().is_empty() {
		line.push(' ');
		line.push_str(title.trim());
	}
	if !tags.is_empty() {
		line.push(' ');
		line.push_str(tags.trim());
	}
	line
}

fn heading_tags(text: &str) -> String {
	let re = Regex::new(r"(:[^\s:]+:)+$").expect("heading tag regex");
	re.find(text.trim_end())
		.map(|matched| matched.as_str().to_string())
		.unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use pi_code_engine::language::{LanguageId, LanguageRegistry};

	use super::*;

	const TODO_KEYWORDS: &[&str] = &["ITEM", "DOING", "DONE", "REVIEW"];

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("org"), registry()).expect("buffer")
	}

	fn apply_source(source: &str, edits: Vec<TextEdit>) -> String {
		let mut buffer = buffer(source);
		buffer.edit_batch(edits).expect("apply edits");
		assert!(!buffer.tree().root_node().has_error(), "org parse tree should stay valid");
		buffer.source()
	}

	#[test]
	fn test_create_item_in_empty_file() {
		let source = "";
		let buffer = buffer(source);
		let edits = create_item(&buffer, &CreateItemParams {
			id: "PLAN-1".into(),
			title: "Plan".into(),
			state: "DOING".into(),
			..Default::default()
		});
		let output = apply_source(source, edits);
		assert!(output.contains("#+CUSTOM_ID: PLAN-1"));
		assert!(output.contains("#+STATE: DOING"));
	}

	#[test]
	fn test_create_item_in_existing_file() {
		let source = "* ITEM Existing\n:PROPERTIES:\n:CUSTOM_ID: E-1\n:END:\n";
		let buffer = buffer(source);
		let edits = create_item(&buffer, &CreateItemParams {
			id: "NEW-1".into(),
			title: "New Task".into(),
			state: "ITEM".into(),
			..Default::default()
		});
		let output = apply_source(source, edits);
		assert!(output.contains("* ITEM New Task"));
	}

	#[test]
	fn test_update_state() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n";
		let output = apply_source(
			source,
			update_state(&buffer(source), "T-1", "DOING", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains("* DOING Task"));
	}

	#[test]
	fn test_update_state_file_level() {
		let source = "#+TITLE: Plan\n#+CUSTOM_ID: PLAN-1\n#+STATE: ITEM\n\nBody\n";
		let output = apply_source(
			source,
			update_state(&buffer(source), "PLAN-1", "DOING", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains("#+STATE: DOING"));
	}

	#[test]
	fn test_update_title() {
		let source = "* ITEM Old Title :tag:\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n";
		let output = apply_source(
			source,
			update_title(&buffer(source), "T-1", "New Title", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains("* ITEM New Title :tag:"));
	}

	#[test]
	fn test_replace_body() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n\nOld body\n";
		let output = apply_source(
			source,
			replace_body(&buffer(source), "T-1", Some("New body"), TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains("New body"));
		assert!(!output.contains("Old body"));
	}

	#[test]
	fn test_append_body() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n\nOld body\n";
		let output = apply_source(
			source,
			append_body(&buffer(source), "T-1", "Appended", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains("Old body"));
		assert!(output.contains("Appended"));
	}

	#[test]
	fn test_set_property_existing() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:PRIORITY: #C\n:END:\n";
		let output = apply_source(
			source,
			set_property(&buffer(source), "T-1", "PRIORITY", "#A", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains(":PRIORITY: #A"));
	}

	#[test]
	fn test_set_property_new() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n";
		let output = apply_source(
			source,
			set_property(&buffer(source), "T-1", "OWNER", "spell", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains(":OWNER: spell"));
	}

	#[test]
	fn test_append_note() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n";
		let output = apply_source(
			source,
			append_note(&buffer(source), "T-1", "Check this", TODO_KEYWORDS).unwrap(),
		);
		assert!(output.contains("NOTE ["));
		assert!(output.contains("Check this"));
	}

	#[test]
	fn test_edit_section_replace() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n\n** Context\nOld \
		              content.\n\n** Next\nMore\n";
		let output = apply_source(
			source,
			edit_section(
				&buffer(source),
				"T-1",
				"Context",
				"New content.",
				SectionEditMode::Replace,
				TODO_KEYWORDS,
			)
			.unwrap(),
		);
		assert!(output.contains("New content."));
		assert!(!output.contains("Old content."));
	}

	#[test]
	fn test_edit_section_append() {
		let source = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n\n** Context\nExisting.\n";
		let output = apply_source(
			source,
			edit_section(
				&buffer(source),
				"T-1",
				"Context",
				"Appended.",
				SectionEditMode::Append,
				TODO_KEYWORDS,
			)
			.unwrap(),
		);
		assert!(output.contains("Existing."));
		assert!(output.contains("Appended."));
	}
}
