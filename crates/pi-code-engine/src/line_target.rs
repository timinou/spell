use ropey::LineType;
use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

type TargetSpan = (usize, usize);

#[derive(Debug, Clone, Copy)]
pub struct LineTarget<'a> {
	pub raw:            Node<'a>,
	pub editable_scope: Node<'a>,
}

pub fn resolve_line_target(
	buffer: &CodeBuffer,
	line: u32,
	column: Option<u32>,
	within: Option<TargetSpan>,
) -> Result<LineTarget<'_>> {
	let rope = buffer.rope();
	let total_lines = visible_line_count(buffer) as u32;
	if line == 0 || line > total_lines {
		return Err(CodeEngineError::Buffer("line out of range".into()));
	}

	let line_idx = (line - 1) as usize;
	let line_start = rope.line_to_byte_idx(line_idx, LineType::LF_CR);
	let byte = line_start + target_column_offset(buffer, line_idx, column);
	ensure_within_target_scope(buffer, line as usize, byte, within)?;
	let raw = raw_node_at_byte(buffer, byte, within)?;
	Ok(LineTarget { raw, editable_scope: editable_scope_for_node(raw, within) })
}

pub fn resolve_edit_target<'a>(
	buffer: &'a CodeBuffer,
	line: usize,
	node_type: &str,
	within: Option<TargetSpan>,
) -> Result<Node<'a>> {
	let target = resolve_line_target(buffer, line as u32, None, within)?;
	if node_type.is_empty() {
		return default_edit_target(target, line);
	}
	find_requested_node(target, node_type, within)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))
}

fn ensure_within_target_scope(
	buffer: &CodeBuffer,
	line: usize,
	byte: usize,
	within: Option<TargetSpan>,
) -> Result<()> {
	let Some((target_start, target_end)) = within else {
		return Ok(());
	};
	let upper = target_end.saturating_sub(1);
	if byte < target_start || byte > upper {
		// FEAT-706: include the symbol's line range and a remediation
		// hint in the error so the agent can self-correct.
		let rope = buffer.rope();
		let total_bytes = buffer.source().len();
		let target_line_start =
			rope.byte_to_line_idx(target_start.min(total_bytes), LineType::LF_CR) + 1;
		let end_clamped = target_end
			.saturating_sub(1)
			.min(total_bytes.saturating_sub(1).max(0));
		let target_line_end = rope.byte_to_line_idx(end_clamped, LineType::LF_CR) + 1;
		return Err(CodeEngineError::LineOutOfTargetScope {
			line,
			target_start,
			target_end,
			target_line_start,
			target_line_end,
		});
	}
	Ok(())
}

fn default_edit_target(target: LineTarget<'_>, line: usize) -> Result<Node<'_>> {
	if same_target_node(target.raw, target.editable_scope) {
		return Ok(target.editable_scope);
	}

	Err(CodeEngineError::Edit(format!(
		"Ambiguous line target at line {line}: raw node '{}' expands to editable scope '{}'. \
		 Specify node_type or use symbol targeting.",
		target.raw.kind(),
		target.editable_scope.kind(),
	)))
}

fn same_target_node(left: Node<'_>, right: Node<'_>) -> bool {
	left.id() == right.id()
		|| (left.kind() == right.kind()
			&& left.start_byte() == right.start_byte()
			&& left.end_byte() == right.end_byte())
}

fn node_within(node: Node<'_>, within: Option<TargetSpan>) -> bool {
	within.is_none_or(|(start, end)| node.start_byte() >= start && node.end_byte() <= end)
}

pub fn editable_scope_for_node(mut node: Node<'_>, within: Option<TargetSpan>) -> Node<'_> {
	let original = node;
	if node.kind() == "comment" {
		return node;
	}
	if let Some(parent) = node.parent()
		&& parent.kind() == "code"
		&& node_within(parent, within)
	{
		return parent;
	}
	while let Some(parent) = node.parent() {
		if !node_within(parent, within) {
			break;
		}
		if matches!(
			parent.kind(),
			"element"
				| "self_closing_tag"
				| "style_element"
				| "script_element"
				| "rule_set"
				| "media_statement"
				| "supports_statement"
				| "keyframes_statement"
				| "declaration"
				| "code"
		) {
			return parent;
		}
		node = parent;
	}
	original
}

fn find_requested_node<'a>(
	target: LineTarget<'a>,
	node_type: &str,
	within: Option<TargetSpan>,
) -> Option<Node<'a>> {
	if target.raw.kind() == node_type {
		return Some(target.raw);
	}
	if target.editable_scope.kind() == node_type {
		return Some(target.editable_scope);
	}
	find_in_ancestors(target.raw, node_type, within)
		.or_else(|| find_in_ancestors(target.editable_scope, node_type, within))
		.or_else(|| unwrap_to(target.raw, node_type, within))
		.or_else(|| unwrap_to(target.editable_scope, node_type, within))
}

fn find_in_ancestors<'a>(
	mut node: Node<'a>,
	node_type: &str,
	within: Option<TargetSpan>,
) -> Option<Node<'a>> {
	loop {
		if !node_within(node, within) {
			return None;
		}
		if node.kind() == node_type {
			return Some(node);
		}
		node = node.parent()?;
	}
}

fn unwrap_to<'a>(node: Node<'a>, node_type: &str, within: Option<TargetSpan>) -> Option<Node<'a>> {
	let mut current = node;
	loop {
		if !node_within(current, within) {
			return None;
		}
		let mut cursor = current.walk();
		let mut children = current.named_children(&mut cursor);
		let child = children.next()?;
		if children.next().is_some() || !node_within(child, within) {
			return None;
		}
		if child.kind() == node_type {
			return Some(child);
		}
		current = child;
	}
}

fn raw_node_at_byte(
	buffer: &CodeBuffer,
	byte: usize,
	within: Option<TargetSpan>,
) -> Result<Node<'_>> {
	let mut node = buffer
		.tree()
		.root_node()
		.descendant_for_byte_range(byte, byte)
		.ok_or_else(|| CodeEngineError::Buffer("node not found".into()))?;
	while !node.is_named() {
		if let Some(parent) = node.parent() {
			if !node_within(parent, within) {
				break;
			}
			node = parent;
		} else {
			break;
		}
	}
	if !node_within(node, within) {
		return Err(CodeEngineError::Edit("No node found inside target declaration span".into()));
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

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn elixir_buffer() -> CodeBuffer {
		let source =
			"defmodule Mod do\n  def foo do\n    :ok\n  end\n\n  def bar do\n    :bar\n  end\nend\n";
		CodeBuffer::from_str(source, LanguageId::new("elixir"), registry()).expect("buffer")
	}

	#[test]
	fn resolve_edit_target_respects_ancestor_constraint() {
		let buffer = elixir_buffer();
		let source = buffer.source();
		let foo_start = source.find("def foo do").expect("foo start");
		let foo_end = source.find("\n\n  def bar").expect("foo end");
		let err = resolve_edit_target(&buffer, 1, "call", Some((foo_start, foo_end)))
			.expect_err("line should be outside foo span");
		assert!(matches!(err, CodeEngineError::LineOutOfTargetScope { line: 1, .. }));
	}

	#[test]
	fn resolve_edit_target_within_ancestor_succeeds() {
		let buffer = elixir_buffer();
		let source = buffer.source();
		let foo_start = source.find("def foo do").expect("foo start");
		let foo_end = source.find("\n\n  def bar").expect("foo end");
		let target = resolve_edit_target(&buffer, 3, "atom", Some((foo_start, foo_end)))
			.expect("resolve inside foo span");
		assert_eq!(target.kind(), "atom");
	}
}

#[cfg(test)]
mod feat_706_tests {
	use std::sync::Arc;

	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

	fn ts_buffer(source: &str) -> CodeBuffer {
		let registry = Arc::new(LanguageRegistry::with_builtins().expect("registry"));
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry).expect("buffer")
	}

	#[test]
	fn out_of_scope_error_includes_target_line_range() {
		let source = "// 1\n// 2\nfunction foo() {\n  return 1;\n}\n// 6\n";
		let buffer = ts_buffer(source);
		let span_start = source.find("function").unwrap();
		let span_end = source.find("}\n// 6").unwrap() + 1;
		let err =
			ensure_within_target_scope(&buffer, 1, 0, Some((span_start, span_end))).unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("symbol span"), "expected 'symbol span' phrase: {msg}");
		assert!(msg.contains("lines 3..5") || msg.contains("3..5"), "msg: {msg}");
	}

	#[test]
	fn out_of_scope_error_includes_suggestion() {
		let source = "// 1\nfunction bar() {\n  return 2;\n}\n";
		let buffer = ts_buffer(source);
		let span_start = source.find("function").unwrap();
		let span_end = source.find("}\n").unwrap() + 1;
		let err =
			ensure_within_target_scope(&buffer, 1, 0, Some((span_start, span_end))).unwrap_err();
		let msg = err.to_string();
		assert!(
			msg.contains("file-level target") || msg.contains("LINE#ID"),
			"expected remediation hint: {msg}"
		);
	}

	#[test]
	fn in_scope_passes() {
		let source = "function foo() {\n  return 1;\n}\n";
		let buffer = ts_buffer(source);
		let span_start = 0;
		let span_end = source.len();
		assert!(ensure_within_target_scope(&buffer, 2, 17, Some((span_start, span_end))).is_ok());
	}
}
