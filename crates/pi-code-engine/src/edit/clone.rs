use crate::buffer::CodeBuffer;
use crate::error::Result;

use super::{node_at_line, node_text, TextEdit};

pub fn clone_node(buffer: &CodeBuffer, line: usize) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let text = node_text(buffer, node);
	let insertion = if text.contains('\n') { format!("{text}\n") } else { format!("{text} ") };
	let pos = node.end_byte();
	Ok(vec![TextEdit { start_byte: pos, old_end_byte: pos, new_text: insertion }])
}
