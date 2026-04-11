use crate::{buffer::CodeBuffer, error::{CodeEngineError, Result}};

use super::{node_at_line, node_text, TextEdit};

#[derive(Debug, Clone, Copy)]
pub enum SpliceMode { Up, Self_, Down }

pub fn splice_node(buffer: &CodeBuffer, line: usize, mode: SpliceMode) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let parent = node.parent().ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	let mut cursor = parent.walk();
	let mut kept = String::new();
	for child in parent.named_children(&mut cursor) {
		let keep = match mode {
			SpliceMode::Up => child.start_byte() >= node.start_byte(),
			SpliceMode::Self_ => child.start_byte() >= node.start_byte() && child.end_byte() <= node.end_byte(),
			SpliceMode::Down => child.end_byte() <= node.end_byte(),
		};
		if keep { kept.push_str(&node_text(buffer, child)); }
	}
	Ok(vec![TextEdit { start_byte: parent.start_byte(), old_end_byte: parent.end_byte(), new_text: kept }])
}
