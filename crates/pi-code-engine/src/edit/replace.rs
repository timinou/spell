use super::TextEdit;
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	line_target::resolve_edit_target,
};

fn make_result(start: usize, end: usize, content: String) -> Vec<TextEdit> {
	vec![TextEdit { start_byte: start, old_end_byte: end, new_text: content }]
}

fn ensure_insert_before_separator(line: usize, content: &str) -> Result<()> {
	if content.ends_with('\n') || content.ends_with("\r\n") {
		return Ok(());
	}

	Err(CodeEngineError::Edit(format!(
		"Unsafe line-target insert-before at line {line}: inserted content must end with a newline \
		 to create a sibling-safe boundary. Re-anchor to a declaration/symbol or include an \
		 explicit separator.",
	)))
}

fn ensure_insert_after_separator(line: usize, content: &str) -> Result<()> {
	if content.starts_with('\n') || content.starts_with("\r\n") {
		return Ok(());
	}

	Err(CodeEngineError::Edit(format!(
		"Unsafe line-target insert-after at line {line}: inserted content must start with a newline \
		 to create a sibling-safe boundary. Re-anchor to a declaration/symbol or include an \
		 explicit separator.",
	)))
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
	ensure_insert_before_separator(line, content)?;
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.start_byte(), target.start_byte(), content.to_string()))
}

pub fn insert_after(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
) -> Result<Vec<TextEdit>> {
	ensure_insert_after_separator(line, content)?;
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.end_byte(), target.end_byte(), content.to_string()))
}

pub fn kill_node(buffer: &CodeBuffer, line: usize, node_type: &str) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type)?;
	Ok(make_result(target.start_byte(), target.end_byte(), String::new()))
}
