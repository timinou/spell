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

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{buffer::extract_items_from_source, edge::ItemId};

/// Scope of a root directory for multi-root locate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootScope {
	/// The current working directory (project root).
	#[serde(rename = "cwd")]
	Cwd,
	/// The personal/global directory.
	#[serde(rename = "personal")]
	Personal,
}

/// Multi-root index mapping item IDs to their file paths across scopes.
#[derive(Debug, Clone)]
pub struct MultiRootIndex {
	roots: Vec<(RootScope, HashMap<ItemId, PathBuf>)>,
}

impl MultiRootIndex {
	/// Build an index by scanning `.org` files in each root directory.
	pub fn build(roots: &[(RootScope, &Path)], todo_keywords: &[&str]) -> Self {
		let mut root_maps = Vec::with_capacity(roots.len());
		for (scope, root_dir) in roots {
			let mut map: HashMap<ItemId, PathBuf> = HashMap::new();
			collect_org_files(root_dir, todo_keywords, &mut map);
			root_maps.push((*scope, map));
		}
		Self { roots: root_maps }
	}

	/// Create from pre-built maps (test helper).
	#[must_use]
	pub fn from_roots(roots: Vec<(RootScope, HashMap<ItemId, PathBuf>)>) -> Self {
		Self { roots }
	}

	/// Resolve an ID to its scope and path. Returns the first match (cwd-first).
	#[must_use]
	pub fn resolve(&self, id: &str) -> Option<(RootScope, &Path)> {
		for (scope, map) in &self.roots {
			if let Some(path) = map.get(id) {
				return Some((*scope, path.as_path()));
			}
		}
		None
	}

	/// Iterate over all (scope, id, path) entries.
	pub fn iter(&self) -> impl Iterator<Item = (RootScope, &ItemId, &Path)> {
		let mut entries = Vec::new();
		for (scope, map) in &self.roots {
			for (id, path) in map {
				entries.push((*scope, id, path.as_path()));
			}
		}
		entries.into_iter()
	}

	/// Number of root directories.
	#[must_use]
	pub fn root_count(&self) -> usize {
		self.roots.len()
	}
}

/// Recursively collect .org files from a directory and extract CUSTOM_IDs.
fn collect_org_files(dir: &Path, todo_keywords: &[&str], map: &mut HashMap<ItemId, PathBuf>) {
	let Ok(read_dir) = std::fs::read_dir(dir) else {
		return;
	};
	for entry in read_dir.flatten() {
		let path = entry.path();
		if path.is_dir() {
			collect_org_files(&path, todo_keywords, map);
		} else if path.extension().is_some_and(|ext| ext == "org") {
			if let Ok(source) = std::fs::read_to_string(&path) {
				let path_str = path.to_string_lossy();
				if let Ok(items) =
					extract_items_from_source(&source, todo_keywords, "", "", &path_str, false)
				{
					for item in &items {
						if !item.id.is_empty() {
							map.entry(item.id.clone()).or_insert(path.clone());
						}
					}
				}
			}
		}
	}
}
