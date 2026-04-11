//! Org buffer: parse org files and extract items using tree-sitter.
//!
//! The tree-sitter grammar gives us document structure (headings, drawers,
//! body). We extract semantic information (TODO states, properties, CLOCK
//! lines, timestamps) by walking the AST and interpreting text content.

use std::collections::HashMap;

use tree_sitter::{Node, Parser};

use crate::{
	clock::{self, ClockEntry},
	item::OrgItem,
};

/// A parsed org-mode buffer.
pub struct OrgBuffer {
	source: String,
	tree:   tree_sitter::Tree,
}

impl OrgBuffer {
	/// Parse an org-mode source string.
	pub fn parse(source: &str) -> Result<Self, &'static str> {
		let mut parser = Parser::new();
		parser
			.set_language(&tree_sitter_org::LANGUAGE.into())
			.map_err(|_| "Failed to load org grammar")?;
		let tree = parser
			.parse(source, None)
			.ok_or("Failed to parse org source")?;
		Ok(Self { source: source.to_string(), tree })
	}

	/// Get the raw source text.
	pub fn source(&self) -> &str {
		&self.source
	}

	/// Extract all items from the buffer.
	///
	/// `todo_keywords`: set of recognized TODO keywords.
	/// `category`, `dir`: metadata to attach to each item.
	/// `file_path`: absolute path to the source file.
	/// `include_body`: whether to include body text.
	pub fn extract_items(
		&self,
		todo_keywords: &[&str],
		category: &str,
		dir: &str,
		file_path: &str,
		include_body: bool,
	) -> Vec<OrgItem> {
		let root = self.tree.root_node();
		let mut items = Vec::new();

		// Try file-level item from frontmatter
		if let Some(file_item) =
			self.extract_file_level_item(todo_keywords, category, dir, file_path, include_body)
		{
			items.push(file_item);
		}

		// Extract heading-level items
		self.extract_headings(
			root,
			todo_keywords,
			category,
			dir,
			file_path,
			include_body,
			&mut items,
		);

		items
	}

	/// Extract a file-level item from `#+KEY: value` frontmatter.
	fn extract_file_level_item(
		&self,
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

		for line in self.source.lines() {
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
				frontmatter_end += line.len() + 1; // +1 for newline
			} else {
				break;
			}
		}

		let custom_id = properties.get("CUSTOM_ID")?.clone();

		let body = if include_body {
			let body_start = self.source[frontmatter_end..]
				.find(|c: char| !c.is_whitespace())
				.map(|pos| frontmatter_end + pos)
				.unwrap_or(self.source.len());
			let body_text = self.source[body_start..].trim_end();
			if body_text.is_empty() {
				None
			} else {
				Some(body_text.to_string())
			}
		} else {
			None
		};

		// Parse CLOCK entries from body
		let clocks = self.parse_clocks_from_range(frontmatter_end, self.source.len());

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
			byte_range: (0, self.source.len()),
			children: Vec::new(),
		})
	}

	/// Walk the AST and extract heading-level items.
	fn extract_headings(
		&self,
		node: Node,
		todo_keywords: &[&str],
		category: &str,
		dir: &str,
		file_path: &str,
		include_body: bool,
		items: &mut Vec<OrgItem>,
	) {
		let mut cursor = node.walk();
		if !cursor.goto_first_child() {
			return;
		}

		loop {
			let child = cursor.node();
			if child.kind() == "section" {
				if let Some(item) = self.extract_section_item(
					child,
					todo_keywords,
					category,
					dir,
					file_path,
					include_body,
				) {
					items.push(item);
				}
			}
			if !cursor.goto_next_sibling() {
				break;
			}
		}
	}

	/// Extract an item from a section node (contains headline + body +
	/// sub-sections).
	fn extract_section_item(
		&self,
		section: Node,
		todo_keywords: &[&str],
		category: &str,
		dir: &str,
		file_path: &str,
		include_body: bool,
	) -> Option<OrgItem> {
		let mut cursor = section.walk();
		if !cursor.goto_first_child() {
			return None;
		}

		// First child should be headline
		let headline = cursor.node();
		if headline.kind() != "headline" {
			return None;
		}

		let (level, state, title) = self.parse_headline(headline, todo_keywords);

		// Gather properties, body, clock entries, and children
		let mut properties = HashMap::new();
		let mut body_parts = Vec::new();
		let mut clocks = Vec::new();
		let mut children = Vec::new();

		while cursor.goto_next_sibling() {
			let child = cursor.node();
			match child.kind() {
				"property_drawer" => {
					self.extract_properties(child, &mut properties);
				},
				"body" => {
					if include_body {
						let text = self.node_text(child).trim().to_string();
						if !text.is_empty() {
							body_parts.push(text);
						}
					}
					// Parse CLOCK entries from body
					let body_text = self.node_text(child);
					for line in body_text.lines() {
						if let Some(entry) = clock::parse_clock_line(line) {
							clocks.push(entry);
						}
					}
				},
				"section" => {
					// Sub-section = potential child item
					if let Some(child_item) = self.extract_section_item(
						child,
						todo_keywords,
						category,
						dir,
						file_path,
						include_body,
					) {
						children.push(child_item);
					}
				},
				_ => {
					// Other content nodes (paragraphs, lists, etc.) — part of body
					if include_body {
						let text = self.node_text(child).trim().to_string();
						if !text.is_empty() {
							body_parts.push(text);
						}
					}
					// Check for CLOCK entries in any content
					let text = self.node_text(child);
					for line in text.lines() {
						if let Some(entry) = clock::parse_clock_line(line) {
							clocks.push(entry);
						}
					}
				},
			}
		}

		let custom_id = properties.get("CUSTOM_ID").cloned();

		// Only include items that have a TODO state or CUSTOM_ID
		if state.is_empty() && custom_id.is_none() {
			return None;
		}

		let id = custom_id.unwrap_or_default();
		let body = if include_body && !body_parts.is_empty() {
			Some(body_parts.join("\n"))
		} else {
			None
		};

		Some(OrgItem {
			id,
			title,
			state,
			category: category.to_string(),
			dir: dir.to_string(),
			file: file_path.to_string(),
			line: headline.start_position().row + 1, // 1-indexed
			level,
			properties,
			body,
			clocks,
			byte_range: (section.start_byte(), section.end_byte()),
			children,
		})
	}

	/// Parse a headline node to extract level, state, and title.
	fn parse_headline(&self, headline: Node, todo_keywords: &[&str]) -> (usize, String, String) {
		let mut level = 0usize;
		let mut state = String::new();
		let mut title_parts = Vec::new();

		let mut cursor = headline.walk();
		if cursor.goto_first_child() {
			loop {
				let child = cursor.node();
				match child.kind() {
					"stars" => {
						level = self.node_text(child).len();
					},
					"item" => {
						let text = self.node_text(child).trim().to_string();
						// First word might be a TODO keyword
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
					"tag_list" => {
						// Tags are not part of the title
					},
					_ => {},
				}
				if !cursor.goto_next_sibling() {
					break;
				}
			}
		}

		let title = title_parts.join(" ");
		(level, state, title)
	}

	/// Extract properties from a property_drawer node.
	fn extract_properties(&self, drawer: Node, properties: &mut HashMap<String, String>) {
		let mut cursor = drawer.walk();
		if !cursor.goto_first_child() {
			return;
		}
		loop {
			let child = cursor.node();
			if child.kind() == "property" {
				self.extract_single_property(child, properties);
			}
			if !cursor.goto_next_sibling() {
				break;
			}
		}
	}

	/// Extract a single property from a property node.
	fn extract_single_property(&self, prop: Node, properties: &mut HashMap<String, String>) {
		let text = self.node_text(prop).trim().to_string();
		// Property format: `:KEY: value`
		if let Some(rest) = text.strip_prefix(':') {
			if let Some((key, value)) = rest.split_once(':') {
				let key = key.trim().to_string();
				let value = value.trim().to_string();
				if !key.is_empty() {
					properties.insert(key, value);
				}
			}
		}
	}

	/// Parse CLOCK entries from a byte range.
	fn parse_clocks_from_range(&self, start: usize, end: usize) -> Vec<ClockEntry> {
		let text = &self.source[start..end.min(self.source.len())];
		text.lines().filter_map(clock::parse_clock_line).collect()
	}

	/// Get the text content of a node.
	fn node_text(&self, node: Node) -> &str {
		&self.source[node.byte_range()]
	}
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
}
