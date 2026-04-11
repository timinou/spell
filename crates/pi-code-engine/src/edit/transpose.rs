use super::{TextEdit, node_text};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

fn node_at_point(tree: &tree_sitter::Tree, byte: usize) -> Option<tree_sitter::Node<'_>> {
	tree
		.root_node()
		.named_descendant_for_byte_range(byte, byte)
		.or_else(|| tree.root_node().descendant_for_byte_range(byte, byte))
}

pub fn transpose_nodes(buffer: &CodeBuffer, line: usize, column: usize) -> Result<Vec<TextEdit>> {
	let byte = buffer
		.rope()
		.line_to_byte_idx(line.saturating_sub(1), ropey::LineType::LF_CR)
		+ column;
	let tree = buffer.tree();
	let left = node_at_point(tree, byte)
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	let right = node_at_point(tree, left.end_byte())
		.ok_or_else(|| CodeEngineError::Edit("No adjacent node to transpose with".into()))?;

	// Validate non-overlap
	if left.id() == right.id() {
		return Err(CodeEngineError::Edit("Cannot transpose a node with itself".into()));
	}
	if left.end_byte() > right.start_byte() {
		return Err(CodeEngineError::Edit("Cannot transpose overlapping nodes".into()));
	}

	let left_text = node_text(buffer, left);
	let right_text = node_text(buffer, right);

	if left.end_byte() == right.start_byte() {
		// Adjacent nodes (shared boundary): single replacement to avoid offset issues
		Ok(vec![TextEdit {
			start_byte:   left.start_byte(),
			old_end_byte: right.end_byte(),
			new_text:     format!("{right_text}{left_text}"),
		}])
	} else {
		// Non-adjacent: two replacements (edit_batch sorts desc by start_byte)
		Ok(vec![
			TextEdit {
				start_byte:   right.start_byte(),
				old_end_byte: right.end_byte(),
				new_text:     left_text,
			},
			TextEdit {
				start_byte:   left.start_byte(),
				old_end_byte: left.end_byte(),
				new_text:     right_text,
			},
		])
	}
}
