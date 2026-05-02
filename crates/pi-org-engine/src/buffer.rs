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
	edge::EdgeKind,
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

	for raw_line in source.split_inclusive('\n') {
		let line_without_lf = raw_line.strip_suffix('\n').unwrap_or(raw_line);
		let line = line_without_lf
			.strip_suffix('\r')
			.unwrap_or(line_without_lf);
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
			frontmatter_end += raw_line.len();
		} else {
			break;
		}
	}

	let blockers_rels = synthesize_blockers_property(&properties);

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
		relations: blockers_rels,
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
		if child.kind() == "section" {
			let mut descendants = Vec::new();
			if let Some(item) = extract_section_item(source, child, options, &mut descendants) {
				items.push(item);
				items.extend(descendants);
			} else {
				items.extend(extract_descendant_items_from_section(source, child, options));
			}
		}
		if !cursor.goto_next_sibling() {
			break;
		}
	}
}

fn first_descendant_section_start(node: Node<'_>) -> Option<usize> {
	let mut cursor = node.walk();
	if !cursor.goto_first_child() {
		return None;
	}

	let mut first = None;
	loop {
		let child = cursor.node();
		let candidate = if child.kind() == "section" {
			Some(child.start_byte())
		} else {
			first_descendant_section_start(child)
		};
		if let Some(start) = candidate {
			first = Some(first.map_or(start, |current: usize| current.min(start)));
		}
		if !cursor.goto_next_sibling() {
			break;
		}
	}
	first
}

fn nested_body_text(source: &str, node: Node<'_>) -> String {
	let end = first_descendant_section_start(node).unwrap_or_else(|| node.end_byte());
	if end <= node.start_byte() {
		String::new()
	} else {
		source[node.start_byte()..end].trim().to_string()
	}
}

fn section_level(source: &str, section: Node<'_>, todo_keywords: &[&str]) -> Option<usize> {
	let mut cursor = section.walk();
	if !cursor.goto_first_child() {
		return None;
	}
	let headline = cursor.node();
	if headline.kind() != "headline" {
		return None;
	}
	Some(parse_headline(source, headline, todo_keywords).0)
}

fn push_child_section_items(
	source: &str,
	node: Node<'_>,
	options: &ExtractOptions<'_>,
	parent_level: usize,
	descendants: &mut Vec<OrgItem>,
	children: &mut Vec<OrgItem>,
) {
	let mut cursor = node.walk();
	if !cursor.goto_first_child() {
		return;
	}

	loop {
		let child = cursor.node();
		if child.kind() == "section" {
			if section_level(source, child, options.todo_keywords) == Some(parent_level + 1) {
				let mut child_descendants = Vec::new();
				if let Some(child_item) =
					extract_section_item(source, child, options, &mut child_descendants)
				{
					descendants.push(child_item.clone());
					descendants.extend(child_descendants);
					children.push(child_item);
				}
			} else {
				push_child_section_items(source, child, options, parent_level, descendants, children);
			}
		} else {
			push_child_section_items(source, child, options, parent_level, descendants, children);
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
	descendants: &mut Vec<OrgItem>,
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
	let mut relations = Vec::new();
	let mut body_parts = Vec::new();
	let mut clocks = Vec::new();
	let mut children = Vec::new();

	while cursor.goto_next_sibling() {
		let child = cursor.node();
		match child.kind() {
			"property_drawer" => extract_properties(source, child, &mut properties),
			"body" => {
				let text = nested_body_text(source, child);
				let trimmed_text = text.trim();
				if trimmed_text.starts_with(":RELATIONS:") {
					relations.extend(parse_relations_drawer_text(trimmed_text));
				} else {
					if options.include_body && !trimmed_text.is_empty() {
						body_parts.push(text.clone());
					}
					for line in text.lines() {
						if let Some(entry) = clock::parse_clock_line(line) {
							clocks.push(entry);
						}
					}
				}
				push_child_section_items(source, child, options, level, descendants, &mut children);
			},
			"section" => {
				push_child_section_items(source, child, options, level, descendants, &mut children);
			},
			_ => {
				let text = node_text(source, child);
				let trimmed_text = text.trim();
				if trimmed_text.starts_with(":RELATIONS:") {
					relations.extend(parse_relations_drawer_text(trimmed_text));
				} else {
					if options.include_body && !trimmed_text.is_empty() {
						body_parts.push(trimmed_text.to_string());
					}
					for line in text.lines() {
						if let Some(entry) = clock::parse_clock_line(line) {
							clocks.push(entry);
						}
					}
				}
			},
		}
	}

	// Synthesize legacy BLOCKERS/DEPENDS → Blocks edges
	relations.extend(synthesize_blockers_property(&properties));

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
	let (nested_children, nested_descendants) = extract_nested_items_from_text(
		source,
		section.start_byte(),
		section.end_byte(),
		headline.start_position().row + 1,
		level,
		options,
	);
	if !nested_children.is_empty() {
		children = nested_children;
		descendants.extend(nested_descendants);
	}

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
		relations,
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

#[derive(Clone)]
struct NestedItemNode {
	item:          OrgItem,
	child_indices: Vec<usize>,
}

fn parse_heading_line(line: &str, todo_keywords: &[&str]) -> Option<(usize, String, String)> {
	let stars = line.chars().take_while(|ch| *ch == '*').count();
	if stars == 0 || !line.get(stars..)?.starts_with(' ') {
		return None;
	}
	let rest = line[stars..].trim();
	let mut parts = rest.split_whitespace();
	let first = parts.next().unwrap_or("");
	if todo_keywords.contains(&first) {
		let title = rest[first.len()..].trim().to_string();
		Some((stars, first.to_string(), title))
	} else {
		Some((stars, String::new(), rest.to_string()))
	}
}

fn parse_nested_properties(line: &str, properties: &mut HashMap<String, String>) {
	if let Some(rest) = line.trim().strip_prefix(':')
		&& let Some((key, value)) = rest.split_once(':')
	{
		let key = key.trim().to_string();
		let value = value.trim().to_string();
		if !key.is_empty() {
			properties.insert(key, value);
		}
	}
}
/// Strip `[[id:…]]` wrapper from a target id string.
fn strip_id_wrapper(s: &str) -> &str {
	if let Some(rest) = s.trim().strip_prefix("[[id:")
		&& let Some(inner) = rest.strip_suffix("]]")
	{
		inner.trim()
	} else {
		s.trim()
	}
}

/// Parse a single RELATIONS drawer line (\"KIND: target\") into an EdgeKind +
/// target.
fn parse_relations_line(line: &str) -> Option<(EdgeKind, String)> {
	let trimmed = line.trim();
	if trimmed.is_empty() || !trimmed.contains(':') {
		return None;
	}
	let (kind_str, target_str) = trimmed.split_once(':')?;
	if kind_str.trim().is_empty() {
		return None;
	}
	let kind = EdgeKind::parse(kind_str);
	let target = strip_id_wrapper(target_str).to_string();
	if target.is_empty() {
		return None;
	}
	Some((kind, target))
}

/// Parse RELATIONS drawer lines from a text block (between :RELATIONS: and
/// :END:).
fn parse_relations_drawer_text(text: &str) -> Vec<(EdgeKind, String)> {
	let mut relations = Vec::new();
	for line in text.lines() {
		let trimmed = line.trim();
		if trimmed == ":RELATIONS:" || trimmed == ":END:" || trimmed.is_empty() {
			continue;
		}
		if let Some(rel) = parse_relations_line(trimmed) {
			relations.push(rel);
		}
	}
	relations
}

/// Synthesize Blocks edges from BLOCKERS or DEPENDS properties.
fn synthesize_blockers_property(properties: &HashMap<String, String>) -> Vec<(EdgeKind, String)> {
	let blockers_prop = properties
		.get("BLOCKERS")
		.or_else(|| properties.get("DEPENDS"));
	let Some(value) = blockers_prop else {
		return Vec::new();
	};
	value
		.split(|c: char| c == ',' || c.is_whitespace())
		.map(str::trim)
		.filter(|s| !s.is_empty())
		.map(|s| (EdgeKind::Blocks, strip_id_wrapper(s).to_string()))
		.collect()
}
fn extract_descendant_items_from_section(
	source: &str,
	section: Node<'_>,
	options: &ExtractOptions<'_>,
) -> Vec<OrgItem> {
	let Some(parent_level) = section_level(source, section, options.todo_keywords) else {
		return Vec::new();
	};
	let mut cursor = section.walk();
	if !cursor.goto_first_child() {
		return Vec::new();
	}
	let headline = cursor.node();
	let (_, flat) = extract_nested_items_from_text(
		source,
		section.start_byte(),
		section.end_byte(),
		headline.start_position().row + 1,
		parent_level,
		options,
	);
	flat
}

fn extract_nested_items_from_text(
	source: &str,
	section_start: usize,
	section_end: usize,
	section_line: usize,
	parent_level: usize,
	options: &ExtractOptions<'_>,
) -> (Vec<OrgItem>, Vec<OrgItem>) {
	let section_text = &source[section_start..section_end];
	let mut headings: Vec<(usize, usize, usize)> = Vec::new();
	let mut byte_offset = 0usize;
	for (line_no, segment) in (section_line..).zip(section_text.split_inclusive('\n')) {
		let line = segment.trim_end_matches('\n');
		if let Some((level, ..)) = parse_heading_line(line, options.todo_keywords)
			&& level > parent_level
		{
			headings.push((level, section_start + byte_offset, line_no));
		}
		byte_offset += segment.len();
	}
	if headings.is_empty() {
		return (Vec::new(), Vec::new());
	}

	let mut nodes = Vec::new();
	for (index, (level, start_byte, start_line)) in headings.iter().enumerate() {
		let end_byte = headings
			.iter()
			.skip(index + 1)
			.find(|(next_level, ..)| *next_level <= *level)
			.map_or(section_end, |(_, next_start, _)| *next_start);
		let item_text = &source[*start_byte..end_byte];
		let mut lines = item_text.split_inclusive('\n');
		let Some(heading_line) = lines.next().map(|line| line.trim_end_matches('\n')) else {
			continue;
		};
		let Some((item_level, state, title)) =
			parse_heading_line(heading_line, options.todo_keywords)
		else {
			continue;
		};
		let mut properties = HashMap::new();
		let mut relations = Vec::new();
		let mut body_lines = Vec::new();
		let mut clocks = Vec::new();
		let mut in_properties = false;
		let mut in_relations = false;
		for raw_line in lines {
			let line = raw_line.trim_end_matches('\n');
			if let Some((next_level, ..)) = parse_heading_line(line, options.todo_keywords)
				&& next_level > item_level
			{
				break;
			}
			if line.trim() == ":PROPERTIES:" {
				in_properties = true;
				continue;
			}
			if line.trim() == ":RELATIONS:" {
				in_relations = true;
				continue;
			}
			if line.trim() == ":END:" {
				in_properties = false;
				in_relations = false;
				continue;
			}
			if in_properties {
				parse_nested_properties(line, &mut properties);
				continue;
			}
			if in_relations {
				if let Some(rel) = parse_relations_line(line) {
					relations.push(rel);
				}
				continue;
			}
			if options.include_body {
				body_lines.push(line.to_string());
			}
			if let Some(entry) = clock::parse_clock_line(line) {
				clocks.push(entry);
			}
		}
		// Synthesize legacy BLOCKERS/DEPENDS → Blocks edges
		relations.extend(synthesize_blockers_property(&properties));

		let custom_id = properties.get("CUSTOM_ID").cloned();
		if state.is_empty() && custom_id.is_none() {
			continue;
		}
		let body = if options.include_body {
			let body = body_lines.join("\n").trim().to_string();
			if body.is_empty() { None } else { Some(body) }
		} else {
			None
		};
		nodes.push(NestedItemNode {
			item:          OrgItem {
				id: custom_id.unwrap_or_default(),
				title,
				state,
				category: options.category.to_string(),
				dir: options.dir.to_string(),
				file: options.file_path.to_string(),
				line: *start_line,
				level: item_level,
				properties,
				body,
				clocks,
				byte_range: (*start_byte, end_byte),
				children: Vec::new(),
				relations: relations.clone(),
			},
			child_indices: Vec::new(),
		});
	}
	if nodes.is_empty() {
		return (Vec::new(), Vec::new());
	}

	let mut root_indices = Vec::new();
	let mut stack: Vec<usize> = Vec::new();
	for idx in 0..nodes.len() {
		while let Some(last) = stack.last().copied() {
			if nodes[last].item.level >= nodes[idx].item.level {
				stack.pop();
			} else {
				break;
			}
		}
		if let Some(parent_idx) = stack.last().copied() {
			nodes[parent_idx].child_indices.push(idx);
		} else {
			root_indices.push(idx);
		}
		stack.push(idx);
	}

	fn build_nested_tree(
		index: usize,
		nodes: &[NestedItemNode],
		flat: &mut Vec<OrgItem>,
	) -> OrgItem {
		let flat_index = flat.len();
		flat.push(nodes[index].item.clone());
		let mut item = nodes[index].item.clone();
		item.children = nodes[index]
			.child_indices
			.iter()
			.map(|child| build_nested_tree(*child, nodes, flat))
			.collect();
		flat[flat_index] = item.clone();
		item
	}

	let mut flat = Vec::new();
	let roots = root_indices
		.iter()
		.map(|index| build_nested_tree(*index, &nodes, &mut flat))
		.collect();
	(roots, flat)
}

#[cfg(test)]
mod tests {
	use super::*;

	const TODO_KEYWORDS: &[&str] = &["ITEM", "INIT", "DOING", "REVIEW", "BLOCKED", "DONE"];

	fn extract_test_items(source: &str, include_body: bool) -> Vec<OrgItem> {
		OrgBuffer::parse(source).unwrap().extract_items(
			TODO_KEYWORDS,
			"features",
			"tasks",
			"/feature.org",
			include_body,
		)
	}

	fn source_with_two_sub_outlines() -> &'static str {
		concat!(
			"#+TITLE: Parent file\n",
			"#+CUSTOM_ID: FEAT-100\n",
			"#+STATE: ITEM\n",
			"\n",
			"* ITEM Parent task\n",
			":PROPERTIES:\n",
			":CUSTOM_ID: FEAT-100-root\n",
			":END:\n",
			"Parent body.\n",
			"** ITEM First child\n",
			":PROPERTIES:\n",
			":CUSTOM_ID: FEAT-100-root::first\n",
			":END:\n",
			"First child body.\n",
			"** ITEM Second child\n",
			":PROPERTIES:\n",
			":CUSTOM_ID: FEAT-100-root::second\n",
			":END:\n",
			"Second child body.\n",
		)
	}

	fn source_with_deep_sub_outline() -> &'static str {
		concat!(
			"#+TITLE: Parent file\n",
			"#+CUSTOM_ID: FEAT-200\n",
			"#+STATE: ITEM\n",
			"\n",
			"* ITEM Parent task\n",
			":PROPERTIES:\n",
			":CUSTOM_ID: FEAT-200-root\n",
			":END:\n",
			"Parent body.\n",
			"** ITEM Child task\n",
			":PROPERTIES:\n",
			":CUSTOM_ID: FEAT-200-root::child\n",
			":END:\n",
			"Child task body.\n",
			"*** ITEM Grand child\n",
			":PROPERTIES:\n",
			":CUSTOM_ID: FEAT-200-root::grand\n",
			":END:\n",
			"Grand child body.\n",
			"** Plain note\n",
			"No custom id here.\n",
		)
	}

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
	fn extract_file_level_frontmatter_only_no_final_newline_with_body_enabled() {
		let src = "#+TITLE: EOF Plan\n#+CUSTOM_ID: PLAN-EOF\n#+STATE: DOING";
		let items = extract_test_items(src, true);

		assert_eq!(items.len(), 1);
		assert_eq!(items[0].id, "PLAN-EOF");
		assert_eq!(items[0].title, "EOF Plan");
		assert_eq!(items[0].state, "DOING");
		assert_eq!(items[0].body, None);
	}

	#[test]
	fn extract_file_level_frontmatter_only_no_final_newline_without_body() {
		let src = "#+TITLE: EOF Plan\n#+CUSTOM_ID: PLAN-EOF\n#+STATE: DOING";
		let items = extract_test_items(src, false);

		assert_eq!(items.len(), 1);
		assert_eq!(items[0].id, "PLAN-EOF");
		assert_eq!(items[0].body, None);
	}

	#[test]
	fn extract_file_level_frontmatter_then_body_keeps_body_start() {
		let src = "#+TITLE: My Plan\n#+CUSTOM_ID: PLAN-BODY\n#+STATE: DOING\n\nPlan body.\n";
		let items = extract_test_items(src, true);

		assert_eq!(items.len(), 1);
		assert_eq!(items[0].body.as_deref(), Some("Plan body."));
	}

	#[test]
	fn extract_file_level_frontmatter_uses_byte_accurate_crlf_boundary() {
		let src = "#+TITLE: Café Plan\r\n#+CUSTOM_ID: PLAN-CRLF\r\n#+STATE: DOING\r\n\r\nBody with \
		           café.\r\n";
		let items = extract_test_items(src, true);

		assert_eq!(items.len(), 1);
		assert_eq!(items[0].id, "PLAN-CRLF");
		assert_eq!(items[0].title, "Café Plan");
		assert_eq!(items[0].body.as_deref(), Some("Body with café."));
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

	#[test]
	fn flatten_extracts_two_star_sub_outlines() {
		let items = extract_test_items(source_with_two_sub_outlines(), false);
		let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
		assert_eq!(ids, vec![
			"FEAT-100",
			"FEAT-100-root",
			"FEAT-100-root::first",
			"FEAT-100-root::second"
		]);
	}

	#[test]
	fn flatten_preserves_level_and_deep_nodes() {
		let items = extract_test_items(source_with_deep_sub_outline(), false);
		assert_eq!(
			items
				.iter()
				.find(|item| item.id == "FEAT-200-root")
				.unwrap()
				.level,
			1
		);
		assert_eq!(
			items
				.iter()
				.find(|item| item.id == "FEAT-200-root::child")
				.unwrap()
				.level,
			2
		);
		assert_eq!(
			items
				.iter()
				.find(|item| item.id == "FEAT-200-root::grand")
				.unwrap()
				.level,
			3
		);
	}

	#[test]
	fn flatten_preserves_byte_ranges_and_children() {
		let source = source_with_deep_sub_outline();
		let items = extract_test_items(source, true);
		let parent = items
			.iter()
			.find(|item| item.id == "FEAT-200-root")
			.unwrap();
		let grand_child = items
			.iter()
			.find(|item| item.id == "FEAT-200-root::grand")
			.unwrap();
		assert_eq!(parent.children.len(), 1);
		assert_eq!(parent.children[0].children.len(), 1);
		assert!(
			source[grand_child.byte_range.0..grand_child.byte_range.1]
				.starts_with("*** ITEM Grand child")
		);
	}

	#[test]
	fn flatten_skips_plain_notes_and_propagates_metadata() {
		let items = extract_test_items(source_with_deep_sub_outline(), false);
		assert!(!items.iter().any(|item| item.title == "Plain note"));
		let child = items
			.iter()
			.find(|item| item.id == "FEAT-200-root::child")
			.unwrap();
		assert_eq!(child.category, "features");
		assert_eq!(child.dir, "tasks");
		assert_eq!(child.file, "/feature.org");
	}

	#[test]
	fn flatten_body_populated_when_requested() {
		let items = extract_test_items(source_with_deep_sub_outline(), true);
		let child = items
			.iter()
			.find(|item| item.id == "FEAT-200-root::child")
			.unwrap();
		assert_eq!(child.body.as_deref(), Some("Child task body."));
	}
}
