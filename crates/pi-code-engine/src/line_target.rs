use ropey::LineType;
use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

#[derive(Debug, Clone, Copy)]
pub struct LineTarget<'a> {
	pub raw:            Node<'a>,
	pub editable_scope: Node<'a>,
}

pub fn resolve_line_target(
	buffer: &CodeBuffer,
	line: u32,
	column: Option<u32>,
) -> Result<LineTarget<'_>> {
	let rope = buffer.rope();
	let total_lines = visible_line_count(buffer) as u32;
	if line == 0 || line > total_lines {
		return Err(CodeEngineError::Buffer("line out of range".into()));
	}

	let line_idx = (line - 1) as usize;
	let line_start = rope.line_to_byte_idx(line_idx, LineType::LF_CR);
	let byte = line_start + target_column_offset(buffer, line_idx, column);
	let raw = raw_node_at_byte(buffer, byte)?;
	Ok(LineTarget { raw, editable_scope: editable_scope_for_node(raw) })
}

pub fn resolve_edit_target<'a>(
	buffer: &'a CodeBuffer,
	line: usize,
	node_type: &str,
) -> Result<Node<'a>> {
	let target = resolve_line_target(buffer, line as u32, None)?;
	find_requested_node(target, node_type)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))
}

pub fn editable_scope_for_node(node: Node<'_>) -> Node<'_> {
	if node.kind() == "comment" {
		return node;
	}
	if let Some(parent) = node.parent()
		&& parent.kind() == "code"
	{
		return parent;
	}
	node
}

fn find_requested_node<'a>(target: LineTarget<'a>, node_type: &str) -> Option<Node<'a>> {
	if node_type.is_empty() {
		return Some(target.editable_scope);
	}
	if target.raw.kind() == node_type {
		return Some(target.raw);
	}
	if target.editable_scope.kind() == node_type {
		return Some(target.editable_scope);
	}
	find_in_ancestors(target.raw, node_type)
		.or_else(|| find_in_ancestors(target.editable_scope, node_type))
		.or_else(|| unwrap_to(target.raw, node_type))
		.or_else(|| unwrap_to(target.editable_scope, node_type))
}

fn find_in_ancestors<'a>(mut node: Node<'a>, node_type: &str) -> Option<Node<'a>> {
	loop {
		if node.kind() == node_type {
			return Some(node);
		}
		node = node.parent()?;
	}
}

fn unwrap_to<'a>(node: Node<'a>, node_type: &str) -> Option<Node<'a>> {
	let mut current = node;
	loop {
		let mut cursor = current.walk();
		let mut children = current.named_children(&mut cursor);
		let child = children.next()?;
		if children.next().is_some() {
			return None;
		}
		if child.kind() == node_type {
			return Some(child);
		}
		current = child;
	}
}

fn raw_node_at_byte(buffer: &CodeBuffer, byte: usize) -> Result<Node<'_>> {
	let mut node = buffer
		.tree()
		.root_node()
		.descendant_for_byte_range(byte, byte)
		.ok_or_else(|| CodeEngineError::Buffer("node not found".into()))?;
	while !node.is_named() {
		if let Some(parent) = node.parent() {
			node = parent;
		} else {
			break;
		}
	}
	Ok(node)
}

fn target_column_offset(buffer: &CodeBuffer, line_idx: usize, column: Option<u32>) -> usize {
	if let Some(column) = column {
		return column as usize;
	}

	let text = buffer.rope().line(line_idx, LineType::LF_CR).to_string();
	let mut offset = 0;
	for ch in text.chars() {
		if ch == '\n' || ch == '\r' || !ch.is_whitespace() {
			break;
		}
		offset += ch.len_utf8();
	}

	if buffer.language().as_str() == "typst" && text[offset..].starts_with('#') {
		offset += 1;
	}

	offset
}

fn visible_line_count(buffer: &CodeBuffer) -> usize {
	let rope = buffer.rope();
	let raw_lines = rope.len_lines(LineType::LF_CR);
	if raw_lines > 0
		&& rope
			.line(raw_lines - 1, LineType::LF_CR)
			.chars()
			.next()
			.is_none()
	{
		raw_lines.saturating_sub(1)
	} else {
		raw_lines
	}
}
