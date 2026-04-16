use super::{TextEdit, node_at_line, node_text};
use crate::{buffer::CodeBuffer, error::Result};

fn outermost_node_on_line(mut node: tree_sitter::Node<'_>) -> tree_sitter::Node<'_> {
	let start_row = node.start_position().row;
	while let Some(parent) = node.parent() {
		if parent.start_position().row == start_row {
			node = parent;
		} else {
			break;
		}
	}
	node
}

pub fn clone_node(buffer: &CodeBuffer, line: usize) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let node = outermost_node_on_line(node);
	let text = node_text(buffer, node);
	let indent = super::indent::node_indent(&buffer.source(), node);
	let indent_str = " ".repeat(indent);
	let text = text.trim_end_matches('\n');
	let insertion = format!("\n{indent_str}{text}\n");
	let pos = node.end_byte();
	Ok(vec![TextEdit { start_byte: pos, old_end_byte: pos, new_text: insertion }])
}
