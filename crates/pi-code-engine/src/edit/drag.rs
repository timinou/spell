use tree_sitter::Node;

use super::{TextEdit, node_at_line, node_text, replace::standalone_sibling_boundary};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

#[derive(Debug, Clone, Copy)]
pub enum DragDirection {
	Up,
	Down,
}

fn sibling_pair<'a>(parent: Node<'a>, current: Node<'a>, dir: DragDirection) -> Result<Node<'a>> {
	let mut cursor = parent.walk();
	let children: Vec<_> = parent.named_children(&mut cursor).collect();
	let index = children
		.iter()
		.position(|child| child.id() == current.id())
		.ok_or_else(|| CodeEngineError::Edit("No sibling to swap with".to_string()))?;
	match dir {
		DragDirection::Up => index
			.checked_sub(1)
			.and_then(|idx| children.get(idx).copied())
			.ok_or_else(|| CodeEngineError::Edit("No sibling to swap with".to_string())),
		DragDirection::Down => children
			.get(index + 1)
			.copied()
			.ok_or_else(|| CodeEngineError::Edit("No sibling to swap with".to_string())),
	}
}

pub fn drag_node(
	buffer: &CodeBuffer,
	line: usize,
	direction: DragDirection,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let node = node_at_line(buffer, line, within)?;
	let parent = node
		.parent()
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	let sibling = sibling_pair(parent, node, direction)?;
	let current_boundary = standalone_sibling_boundary(
		&source,
		node.start_byte(),
		node.end_byte(),
		node.start_position().row as usize + 1,
		"move",
	)?;
	let sibling_boundary = standalone_sibling_boundary(
		&source,
		sibling.start_byte(),
		sibling.end_byte(),
		sibling.start_position().row as usize + 1,
		"move",
	)?;
	if current_boundary.indent_col != sibling_boundary.indent_col {
		return Err(CodeEngineError::Edit(format!(
			"Unsafe move at line {line}: sibling declarations use different indentation levels. \
			 Re-anchor to a whole block replace.",
		)));
	}
	let a = (node.start_byte(), node.end_byte(), node_text(buffer, node));
	let b = (sibling.start_byte(), sibling.end_byte(), node_text(buffer, sibling));
	let (first, second) = if a.0 > b.0 { (a, b) } else { (b, a) };
	Ok(vec![TextEdit { start_byte: first.0, old_end_byte: first.1, new_text: second.2 }, TextEdit {
		start_byte:   second.0,
		old_end_byte: second.1,
		new_text:     first.2,
	}])
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
	fn drag_node_rejects_shared_boundary_siblings() {
		let source = "const alpha = 1; const beta = 2;\n";
		let buffer = ts_buffer(source);
		let err = drag_node(&buffer, 1, DragDirection::Down, None)
			.expect_err("shared boundary should refuse");
		assert!(err.to_string().contains("Unsafe move"));
	}
}
