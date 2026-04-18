use super::{TextEdit, node_text, replace::standalone_sibling_boundary};
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
	let source = buffer.source();
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

	let left_boundary = standalone_sibling_boundary(
		&source,
		left.start_byte(),
		left.end_byte(),
		left.start_position().row as usize + 1,
		"transpose",
	)?;
	let right_boundary = standalone_sibling_boundary(
		&source,
		right.start_byte(),
		right.end_byte(),
		right.start_position().row as usize + 1,
		"transpose",
	)?;
	if left_boundary.indent_col != right_boundary.indent_col {
		return Err(CodeEngineError::Edit(format!(
			"Unsafe transpose at line {line}: adjacent nodes use different indentation levels. \
			 Re-anchor to a whole block replace.",
		)));
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

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::{
		buffer::CodeBuffer,
		language::{LanguageId, LanguageRegistry},
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn ts_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	#[test]
	fn transpose_nodes_rejects_shared_boundary_siblings() {
		let source = "function alpha() {} function beta() {}\n";
		let buffer = ts_buffer(source);
		let err = transpose_nodes(&buffer, 1, 0, None).expect_err("shared boundary should refuse");
		assert!(
			err.to_string().contains("transpose")
				|| err.to_string().contains("overlapping")
				|| err.to_string().contains("adjacent node")
		);
	}
}
