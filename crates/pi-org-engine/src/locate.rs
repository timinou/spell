use pi_code_engine::buffer::{CodeBuffer, TextEdit};

use crate::{buffer::extract_items_from_buffer, item::OrgItem};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
	File,
	Heading,
}

#[derive(Debug, Clone)]
pub struct ItemLocation {
	pub item:                 OrgItem,
	pub kind:                 ItemKind,
	pub source:               String,
	pub lines:                Vec<String>,
	pub title_line_idx:       Option<usize>,
	pub state_line_idx:       Option<usize>,
	pub last_frontmatter_idx: Option<usize>,
	pub heading_line_idx:     Option<usize>,
	pub drawer_start_idx:     Option<usize>,
	pub drawer_end_idx:       Option<usize>,
	pub body_start_idx:       usize,
	pub body_end_idx:         usize,
}

impl ItemLocation {
	pub fn to_text_edit(&self, new_text: String) -> Vec<TextEdit> {
		vec![TextEdit {
			start_byte: self.item.byte_range.0,
			old_end_byte: self.item.byte_range.1,
			new_text,
		}]
	}
}

pub fn locate_item_by_id(
	buffer: &CodeBuffer,
	custom_id: &str,
	todo_keywords: &[&str],
) -> Option<ItemLocation> {
	let items = extract_items_from_buffer(buffer, todo_keywords, "", "", "", true);
	let item = find_item(&items, custom_id)?;
	Some(build_location(buffer, item))
}

fn find_item(items: &[OrgItem], custom_id: &str) -> Option<OrgItem> {
	for item in items {
		if item.id == custom_id {
			return Some(item.clone());
		}
		if let Some(found) = find_item(&item.children, custom_id) {
			return Some(found);
		}
	}
	None
}

fn build_location(buffer: &CodeBuffer, item: OrgItem) -> ItemLocation {
	let source = buffer.source();
	let snippet = source[item.byte_range.0..item.byte_range.1].to_string();
	let lines = split_lines(&snippet);
	if item.level == 0 {
		build_file_location(item, snippet, lines)
	} else {
		build_heading_location(item, snippet, lines)
	}
}

fn build_file_location(item: OrgItem, source: String, lines: Vec<String>) -> ItemLocation {
	let mut title_line_idx = None;
	let mut state_line_idx = None;
	let mut last_frontmatter_idx = None;
	let mut idx = 0;
	while idx < lines.len() && lines[idx].starts_with("#+") {
		let line = &lines[idx];
		if line.starts_with("#+TITLE:") {
			title_line_idx = Some(idx);
		}
		if line.starts_with("#+STATE:") {
			state_line_idx = Some(idx);
		}
		last_frontmatter_idx = Some(idx);
		idx += 1;
	}
	let body_end_idx = lines.len();

	ItemLocation {
		item,
		kind: ItemKind::File,
		source,
		lines,
		title_line_idx,
		state_line_idx,
		last_frontmatter_idx,
		heading_line_idx: None,
		drawer_start_idx: None,
		drawer_end_idx: None,
		body_start_idx: idx,
		body_end_idx,
	}
}

fn build_heading_location(item: OrgItem, source: String, lines: Vec<String>) -> ItemLocation {
	let heading_line_idx = lines
		.iter()
		.position(|line| line.starts_with('*'))
		.unwrap_or(0);
	let drawer_start_idx = lines
		.iter()
		.enumerate()
		.skip(heading_line_idx + 1)
		.find_map(|(idx, line)| (line.trim() == ":PROPERTIES:").then_some(idx));
	let drawer_end_idx = drawer_start_idx.and_then(|start| {
		lines
			.iter()
			.enumerate()
			.skip(start + 1)
			.find_map(|(idx, line)| (line.trim() == ":END:").then_some(idx))
	});
	let body_start_idx = drawer_end_idx.map_or(heading_line_idx + 1, |idx| idx + 1);
	let body_end_idx = lines
		.iter()
		.enumerate()
		.skip(body_start_idx)
		.find_map(|(idx, line)| line.starts_with('*').then_some(idx))
		.unwrap_or(lines.len());

	ItemLocation {
		item,
		kind: ItemKind::Heading,
		source,
		lines,
		title_line_idx: None,
		state_line_idx: None,
		last_frontmatter_idx: None,
		heading_line_idx: Some(heading_line_idx),
		drawer_start_idx,
		drawer_end_idx,
		body_start_idx,
		body_end_idx,
	}
}

fn split_lines(source: &str) -> Vec<String> {
	source.split('\n').map(str::to_string).collect()
}
