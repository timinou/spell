//! Org buffer: parse org files and extract items using the shared `CodeBuffer`.
//!
//! The tree-sitter grammar gives us document structure (headings, drawers,
//! body). We extract semantic information (TODO states, properties, CLOCK
//! lines, timestamps) by walking the AST and interpreting text content.

use std::{
	collections::HashMap,
	sync::{Arc, OnceLock},
};

use pi_code_engine::{
	buffer::CodeBuffer,
	language::{LanguageId, LanguageRegistry},
};
use tree_sitter::Node;

use crate::{
	clock::{self, ClockEntry},
	item::OrgItem,
};

/// A parsed org-mode buffer backed by the shared `CodeBuffer` implementation.
pub struct OrgBuffer {
	buffer: CodeBuffer,
}

struct ExtractOptions<'a> {
	todo_keywords: &'a [&'a str],
	category:      &'a str,
	dir:           &'a str,
	file_path:     &'a str,
	include_body:  bool,
}

fn language_registry() -> Arc<LanguageRegistry> {
	static REGISTRY: OnceLock<Arc<LanguageRegistry>> = OnceLock::new();
	REGISTRY
		.get_or_init(|| Arc::new(LanguageRegistry::with_builtins().expect("org language profile")))
		.clone()
}

impl OrgBuffer {
	/// Parse an org-mode source string.
	pub fn parse(source: &str) -> Result<Self, &'static str> {
		let buffer = CodeBuffer::from_str(source, LanguageId::new("org"), language_registry())
			.map_err(|_| "Failed to parse org source")?;
		Ok(Self { buffer })
	}

	/// Get the raw source text.
	pub fn source(&self) -> String {
		self.buffer.source()
	}

	/// Extract all items from the buffer.
	pub fn extract_items(
		&self,
		todo_keywords: &[&str],
		category: &str,
		dir: &str,
		file_path: &str,
		include_body: bool,
	) -> Vec<OrgItem> {
		extract_items_from_buffer(&self.buffer, todo_keywords, category, dir, file_path, include_body)
	}

	pub const fn code_buffer(&self) -> &CodeBuffer {
		&self.buffer
	}
}

pub fn extract_items_from_source(
	source: &str,
	todo_keywords: &[&str],
	category: &str,
	dir: &str,
	file_path: &str,
	include_body: bool,
) -> Result<Vec<OrgItem>, &'static str> {
	let buffer = CodeBuffer::from_str(source, LanguageId::new("org"), language_registry())
		.map_err(|_| "Failed to parse org source")?;
	Ok(extract_items_from_buffer(&buffer, todo_keywords, category, dir, file_path, include_body))
}

pub fn extract_items_from_buffer(
	buffer: &CodeBuffer,
	todo_keywords: &[&str],
	category: &str,
	dir: &str,
	file_path: &str,
	include_body: bool,
) -> Vec<OrgItem> {
	let source = buffer.source();
	let root = buffer.tree().root_node();
	let mut items = Vec::new();

	if let Some(file_item) =
		extract_file_level_item(&source, todo_keywords, category, dir, file_path, include_body)
	{
		items.push(file_item);
	}

	let options = ExtractOptions { todo_keywords, category, dir, file_path, include_body };
	extract_headings(&source, root, &options, &mut items);
	items
}

fn extract_file_level_item(
	source: &str,
	todo_keywords: &[&str],
	category: &str,
	dir: &str,
	file_path: &str,
	include_body: bool,
) -> Option<OrgItem> {
	let mut properties = HashMap::new();
	let mut title = String::new();
	let mut state = String::new();
	let mut frontmatter_end = 0usize;

	for line in source.lines() {
		if let Some(rest) = line.strip_prefix("#+") {
			if let Some((key, value)) = rest.split_once(':') {
				let key = key.trim().to_uppercase();
				let value = value.trim().to_string();
				match key.as_str() {
					"TITLE" => title = value,
					"STATE" => {
						if todo_keywords.contains(&value.as_str()) {
							state = value;
						}
					},
					_ => {
						properties.insert(key, value);
					},
				}
			}
			frontmatter_end += line.len() + 1;
		} else {
			break;
		}
	}

	let custom_id = properties.get("CUSTOM_ID")?.clone();
	let body = if include_body {
		let body_start = source[frontmatter_end..]
			.find(|c: char| !c.is_whitespace())
			.map_or(source.len(), |pos| frontmatter_end + pos);
		let body_text = source[body_start..].trim_end();
		if body_text.is_empty() {
			None
		} else {
			Some(body_text.to_string())
		}
	} else {
		None
	};
	let clocks = parse_clocks_from_range(source, frontmatter_end, source.len());

	Some(OrgItem {
		id: custom_id,
		title,
		state,
		category: category.to_string(),
		dir: dir.to_string(),
		file: file_path.to_string(),
		line: 1,
		level: 0,
		properties,
		body,
		clocks,
		byte_range: (0, source.len()),
		children: Vec::new(),
	})
}

fn extract_headings(
	source: &str,
	node: Node<'_>,
	options: &ExtractOptions<'_>,
	items: &mut Vec<OrgItem>,
) {
	let mut cursor = node.walk();
	if !cursor.goto_first_child() {
		return;
	}

	loop {
		let child = cursor.node();
		if child.kind() == "section"
			&& let Some(item) = extract_section_item(source, child, options)
		{
			items.push(item);
		}
		if !cursor.goto_next_sibling() {
			break;
		}
	}
}

fn extract_section_item(
	source: &str,
	section: Node<'_>,
	options: &ExtractOptions<'_>,
) -> Option<OrgItem> {
	let mut cursor = section.walk();
	if !cursor.goto_first_child() {
		return None;
	}

	let headline = cursor.node();
	if headline.kind() != "headline" {
		return None;
	}

	let (level, state, title) = parse_headline(source, headline, options.todo_keywords);
	let mut properties = HashMap::new();
	let mut body_parts = Vec::new();
	let mut clocks = Vec::new();
	let mut children = Vec::new();

	while cursor.goto_next_sibling() {
		let child = cursor.node();
		match child.kind() {
			"property_drawer" => extract_properties(source, child, &mut properties),
			"body" => {
				if options.include_body {
					let text = node_text(source, child).trim().to_string();
					if !text.is_empty() {
						body_parts.push(text);
					}
				}
				for line in node_text(source, child).lines() {
					if let Some(entry) = clock::parse_clock_line(line) {
						clocks.push(entry);
					}
				}
			},
			"section" => {
				if let Some(child_item) = extract_section_item(source, child, options) {
					children.push(child_item);
				}
			},
			_ => {
				if options.include_body {
					let text = node_text(source, child).trim().to_string();
					if !text.is_empty() {
						body_parts.push(text);
					}
				}
				for line in node_text(source, child).lines() {
					if let Some(entry) = clock::parse_clock_line(line) {
						clocks.push(entry);
					}
				}
			},
		}
	}

	let custom_id = properties.get("CUSTOM_ID").cloned();
	if state.is_empty() && custom_id.is_none() {
		return None;
	}

	let id = custom_id.unwrap_or_default();
	let body = if options.include_body && !body_parts.is_empty() {
		Some(body_parts.join("\n"))
	} else {
		None
	};

	Some(OrgItem {
		id,
		title,
		state,
		category: options.category.to_string(),
		dir: options.dir.to_string(),
		file: options.file_path.to_string(),
		line: headline.start_position().row + 1,
		level,
		properties,
		body,
		clocks,
		byte_range: (section.start_byte(), section.end_byte()),
		children,
	})
}

fn parse_headline(
	source: &str,
	headline: Node<'_>,
	todo_keywords: &[&str],
) -> (usize, String, String) {
	let mut level = 0usize;
	let mut state = String::new();
	let mut title_parts = Vec::new();

	let mut cursor = headline.walk();
	if cursor.goto_first_child() {
		loop {
			let child = cursor.node();
			match child.kind() {
				"stars" => level = node_text(source, child).len(),
				"item" => {
					let text = node_text(source, child).trim().to_string();
					if state.is_empty() {
						let first_word = text.split_whitespace().next().unwrap_or("");
						if todo_keywords.contains(&first_word) {
							state = first_word.to_string();
							let rest = text[first_word.len()..].trim().to_string();
							if !rest.is_empty() {
								title_parts.push(rest);
							}
						} else {
							title_parts.push(text);
						}
					} else {
						title_parts.push(text);
					}
				},
				"tag_list" => {},
				_ => {},
			}
			if !cursor.goto_next_sibling() {
				break;
			}
		}
	}

	(level, state, title_parts.join(" "))
}

fn extract_properties(source: &str, drawer: Node<'_>, properties: &mut HashMap<String, String>) {
	let mut cursor = drawer.walk();
	if !cursor.goto_first_child() {
		return;
	}
	loop {
		let child = cursor.node();
		if child.kind() == "property" {
			extract_single_property(source, child, properties);
		}
		if !cursor.goto_next_sibling() {
			break;
		}
	}
}

fn extract_single_property(source: &str, prop: Node<'_>, properties: &mut HashMap<String, String>) {
	let text = node_text(source, prop).trim().to_string();
	if let Some(rest) = text.strip_prefix(':')
		&& let Some((key, value)) = rest.split_once(':')
	{
		let key = key.trim().to_string();
		let value = value.trim().to_string();
		if !key.is_empty() {
			properties.insert(key, value);
		}
	}
}

fn parse_clocks_from_range(source: &str, start: usize, end: usize) -> Vec<ClockEntry> {
	let text = &source[start..end.min(source.len())];
	text.lines().filter_map(clock::parse_clock_line).collect()
}

fn node_text<'a>(source: &'a str, node: Node<'_>) -> &'a str {
	&source[node.byte_range()]
}

#[cfg(test)]
mod tests {
	use super::*;

	const TODO_KEYWORDS: &[&str] = &["ITEM", "INIT", "DOING", "REVIEW", "BLOCKED", "DONE"];

	#[test]
	fn extract_heading_item() {
		let src = "* DOING My task\n:PROPERTIES:\n:CUSTOM_ID: PROJ-001-my-task\n:PRIORITY: \
		           #A\n:END:\nBody text here.\n";
		let buf = OrgBuffer::parse(src).unwrap();
		let items = buf.extract_items(TODO_KEYWORDS, "projects", "tasks", "/test.org", true);
		assert_eq!(items.len(), 1);
		let item = &items[0];
		assert_eq!(item.id, "PROJ-001-my-task");
		assert_eq!(item.state, "DOING");
		assert_eq!(item.title, "My task");
		assert_eq!(item.level, 1);
		assert_eq!(item.property("PRIORITY"), Some("#A"));
		assert!(item.body.as_ref().unwrap().contains("Body text here"));
	}

	#[test]
	fn extract_file_level_item() {
		let src = "#+TITLE: My Plan\n#+CUSTOM_ID: PLAN-001-my-plan\n#+STATE: DOING\n\nPlan body.\n";
		let buf = OrgBuffer::parse(src).unwrap();
		let items = buf.extract_items(TODO_KEYWORDS, "plans", "tasks", "/plan.org", true);
		assert_eq!(items.len(), 1);
		let item = &items[0];
		assert_eq!(item.id, "PLAN-001-my-plan");
		assert_eq!(item.state, "DOING");
		assert_eq!(item.level, 0);
		assert!(item.body.as_ref().unwrap().contains("Plan body"));
	}

	#[test]
	fn extract_clock_entries() {
		let src = "* DOING Task\n:PROPERTIES:\n:CUSTOM_ID: T-001\n:END:\nSome text.\nCLOCK: \
		           [2024-01-15 Mon 09:00]--[2024-01-15 Mon 11:00] =>  2:00\nCLOCK: [2024-01-16 Tue \
		           14:00]--[2024-01-16 Tue 15:30] =>  1:30\n";
		let buf = OrgBuffer::parse(src).unwrap();
		let items = buf.extract_items(TODO_KEYWORDS, "test", "tasks", "/test.org", false);
		assert_eq!(items.len(), 1);
		assert_eq!(items[0].clocks.len(), 2);
		assert_eq!(items[0].total_clocked_minutes(), 210);
	}

	#[test]
	fn extract_multiple_items() {
		let src = "* DOING First\n:PROPERTIES:\n:CUSTOM_ID: T-001\n:END:\n\n* ITEM \
		           Second\n:PROPERTIES:\n:CUSTOM_ID: T-002\n:END:\n";
		let buf = OrgBuffer::parse(src).unwrap();
		let items = buf.extract_items(TODO_KEYWORDS, "test", "tasks", "/test.org", false);
		assert_eq!(items.len(), 2);
		assert_eq!(items[0].id, "T-001");
		assert_eq!(items[1].id, "T-002");
	}

	#[test]
	fn extract_with_blockers() {
		let src = "* ITEM Task\n:PROPERTIES:\n:CUSTOM_ID: T-002\n:BLOCKERS: T-001, T-003\n:END:\n";
		let buf = OrgBuffer::parse(src).unwrap();
		let items = buf.extract_items(TODO_KEYWORDS, "test", "tasks", "/test.org", false);
		assert_eq!(items[0].blockers(), vec!["T-001", "T-003"]);
	}

	#[test]
	fn extract_items_from_buffer_matches_wrapper() {
		let src = "* DOING Task\n:PROPERTIES:\n:CUSTOM_ID: T-001\n:END:\nBody text.\n";
		let buf = OrgBuffer::parse(src).unwrap();
		let from_wrapper = buf.extract_items(TODO_KEYWORDS, "test", "tasks", "/test.org", true);
		let from_buffer = extract_items_from_buffer(
			buf.code_buffer(),
			TODO_KEYWORDS,
			"test",
			"tasks",
			"/test.org",
			true,
		);
		assert_eq!(from_wrapper.len(), from_buffer.len());
		assert_eq!(from_wrapper[0].id, from_buffer[0].id);
		assert_eq!(from_wrapper[0].title, from_buffer[0].title);
		assert_eq!(from_wrapper[0].body, from_buffer[0].body);
	}
}
