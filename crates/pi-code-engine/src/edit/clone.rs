use super::{
	TextEdit, node_at_line, node_text,
	replace::{normalize_sibling_content, standalone_sibling_boundary},
};
use crate::{buffer::CodeBuffer, error::Result};

fn outermost_node_on_line(
	mut node: tree_sitter::Node<'_>,
	within: Option<(usize, usize)>,
) -> tree_sitter::Node<'_> {
	let start_row = node.start_position().row;
	while let Some(parent) = node.parent() {
		if within.is_some_and(|(start, end)| parent.start_byte() < start || parent.end_byte() > end) {
			break;
		}
		if parent.start_position().row == start_row {
			node = parent;
		} else {
			break;
		}
	}
	node
}

pub fn clone_node(
	buffer: &CodeBuffer,
	line: usize,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line, within)?;
	let node = outermost_node_on_line(node, within);
	let source = buffer.source();
	let boundary = standalone_sibling_boundary(
		&source,
		node.start_byte(),
		node.end_byte(),
		node.start_position().row as usize + 1,
		"clone",
	)?;
	let text = normalize_sibling_content(&node_text(buffer, node), boundary.indent_col)?;
	let pos = node.end_byte();
	Ok(vec![TextEdit {
		start_byte:   pos,
		old_end_byte: boundary.after_end,
		new_text:     format!("\n{}{}\n{}", boundary.indent_str, text, boundary.after_suffix),
	}])
}
