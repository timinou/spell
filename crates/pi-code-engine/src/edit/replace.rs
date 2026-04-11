use crate::{buffer::CodeBuffer, error::{CodeEngineError, Result}};

use super::{node_at_line, TextEdit};

fn find_ancestor<'a>(mut node: tree_sitter::Node<'a>, node_type: &str) -> Option<tree_sitter::Node<'a>> {
	loop {
		if node.kind() == node_type { return Some(node); }
		node = node.parent()?;
	}
}

fn make_result(start: usize, end: usize, content: String) -> Vec<TextEdit> { vec![TextEdit { start_byte: start, old_end_byte: end, new_text: content }] }

pub fn replace_node(buffer: &CodeBuffer, line: usize, node_type: &str, content: &str) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_ancestor(node, node_type).ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.start_byte(), target.end_byte(), content.to_string()))
}

pub fn insert_before(buffer: &CodeBuffer, line: usize, node_type: &str, content: &str) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_ancestor(node, node_type).ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.start_byte(), target.start_byte(), content.to_string()))
}

pub fn insert_after(buffer: &CodeBuffer, line: usize, node_type: &str, content: &str) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_ancestor(node, node_type).ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.end_byte(), target.end_byte(), content.to_string()))
}

pub fn kill_node(buffer: &CodeBuffer, line: usize, node_type: &str) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let target = find_ancestor(node, node_type).ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	Ok(make_result(target.start_byte(), target.end_byte(), String::new()))
}
