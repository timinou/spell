use ropey::Rope;
use tree_sitter::{Node, Tree};

use crate::{
	buffer::TextEdit,
	language::{LanguageId, LanguageRegistry},
	outline::{declaration_for, declaration_name},
};

const WHOLE_FILE_MARKER: &str = "::*";

/// Derive the `CodePath` string(s) for a structural edit site.
///
/// Returns a single entry of the form `"::Outer.Inner"` when the edit is
/// enclosed by named declarations, or the whole-file fallback `"::*"` when
/// no named ancestor exists or the rope is empty.
///
/// When the `CodePath` dialect crate ships, this function becomes a thin
/// adapter around its `NamePayload` renderer; until then the simple
/// `.`-joined walk gives us a stable, human-readable key.
pub fn derive_code_paths(
	edit: &TextEdit,
	tree: &Tree,
	rope: &Rope,
	language: &LanguageId,
	registry: &LanguageRegistry,
) -> Vec<String> {
	if edit.start_byte == 0 && edit.old_end_byte == 0 && rope.len() == 0 {
		return vec![WHOLE_FILE_MARKER.to_string()];
	}
	let Some(profile) = registry.get(language) else {
		return vec![WHOLE_FILE_MARKER.to_string()];
	};
	let source = rope.to_string();
	let root = tree.root_node();
	let target = if edit.start_byte == edit.old_end_byte {
		find_smallest_named_containing(root, edit.start_byte)
	} else {
		find_smallest_named_enclosing(root, edit.start_byte, edit.old_end_byte)
	};
	let Some(node) = target else {
		return vec![WHOLE_FILE_MARKER.to_string()];
	};
	let mut names = Vec::new();
	let mut current = Some(node);
	while let Some(n) = current {
		if let Some(decl) = declaration_for(profile, n, &source)
			&& let Some(name) = declaration_name(&source, n, decl)
		{
			names.push(name);
		}
		current = n.parent();
	}
	if names.is_empty() {
		return vec![WHOLE_FILE_MARKER.to_string()];
	}
	names.reverse();
	vec![format!("::{}", names.join("."))]
}

fn find_smallest_named_enclosing(node: Node<'_>, start: usize, end: usize) -> Option<Node<'_>> {
	let range = node.byte_range();
	if !node.is_named() || range.start > start || range.end < end {
		return None;
	}
	let mut best = Some(node);
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if let Some(found) = find_smallest_named_enclosing(child, start, end) {
			best = Some(found);
		}
	}
	best
}

fn find_smallest_named_containing(node: Node<'_>, pos: usize) -> Option<Node<'_>> {
	let range = node.byte_range();
	if !node.is_named() || pos < range.start || pos > range.end {
		return None;
	}
	let mut best = Some(node);
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if let Some(found) = find_smallest_named_containing(child, pos) {
			best = Some(found);
		}
	}
	best
}
