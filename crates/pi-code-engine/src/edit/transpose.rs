use super::{TextEdit, node_text};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	line_target::resolve_line_target,
};

fn node_at_point(tree: &tree_sitter::Tree, byte: usize) -> Option<tree_sitter::Node<'_>> {
	tree
		.root_node()
		.named_descendant_for_byte_range(byte, byte)
		.or_else(|| tree.root_node().descendant_for_byte_range(byte, byte))
}

fn within_span(node: tree_sitter::Node<'_>, within: Option<(usize, usize)>) -> bool {
	within.is_none_or(|(start, end)| node.start_byte() >= start && node.end_byte() <= end)
}

pub fn transpose_nodes(
	buffer: &CodeBuffer,
	line: usize,
	column: usize,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let target = resolve_line_target(buffer, line as u32, Some(column as u32), within)?;
	let left = target.raw;
	let right = node_at_point(buffer.tree(), left.end_byte())
		.ok_or_else(|| CodeEngineError::Edit("No adjacent node to transpose with".into()))?;
	if !within_span(right, within) {
		return Err(CodeEngineError::Edit(
			"No adjacent node to transpose within target declaration span".into(),
		));
	}

	if left.id() == right.id() {
		return Err(CodeEngineError::Edit("Cannot transpose a node with itself".into()));
	}
	if left.end_byte() > right.start_byte() {
		return Err(CodeEngineError::Edit("Cannot transpose overlapping nodes".into()));
	}

	let left_text = node_text(buffer, left);
	let right_text = node_text(buffer, right);

	if left.end_byte() == right.start_byte() {
		Ok(vec![TextEdit {
			start_byte:   left.start_byte(),
			old_end_byte: right.end_byte(),
			new_text:     format!("{right_text}{left_text}"),
		}])
	} else {
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
