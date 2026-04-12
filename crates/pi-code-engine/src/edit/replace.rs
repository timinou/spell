use super::TextEdit;
use crate::{buffer::CodeBuffer, error::Result, line_target::resolve_edit_target};

fn make_result(start: usize, end: usize, content: String) -> Vec<TextEdit> {
	vec![TextEdit { start_byte: start, old_end_byte: end, new_text: content }]
}

pub fn replace_node(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.start_byte(), target.end_byte(), content.to_string()))
}

pub fn insert_before(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.start_byte(), target.start_byte(), content.to_string()))
}

pub fn insert_after(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.end_byte(), target.end_byte(), content.to_string()))
}

pub fn kill_node(buffer: &CodeBuffer, line: usize, node_type: &str) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.start_byte(), target.end_byte(), String::new()))
}
