use super::{TextEdit, node_at_line};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

fn find_target<'a>(node: tree_sitter::Node<'a>, node_type: &str) -> Option<tree_sitter::Node<'a>> {
	let mut current = node;
	loop {
		if current.kind() == node_type {
			return Some(current);
		}
		match current.parent() {
			Some(parent) => current = parent,
			None => break,
		}
	}

	// Some grammars wrap declarations in a single named child, so the line-start
	// byte resolves to the wrapper rather than the declaration itself.
	unwrap_to(node, node_type)
}

fn unwrap_to<'a>(node: tree_sitter::Node<'a>, node_type: &str) -> Option<tree_sitter::Node<'a>> {
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

fn make_result(start: usize, end: usize, content: String) -> Vec<TextEdit> {
	vec![TextEdit { start_byte: start, old_end_byte: end, new_text: content }]
}

pub fn replace_node(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_target(node, node_type)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.start_byte(), target.end_byte(), content.to_string()))
}

pub fn insert_before(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_target(node, node_type)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.start_byte(), target.start_byte(), content.to_string()))
}

pub fn insert_after(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_target(node, node_type)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.end_byte(), target.end_byte(), content.to_string()))
}

pub fn kill_node(buffer: &CodeBuffer, line: usize, node_type: &str) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_target(node, node_type)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.start_byte(), target.end_byte(), String::new()))
}
