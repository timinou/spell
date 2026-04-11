use tree_sitter::Node;

use super::{TextEdit, node_at_line, node_text};
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
) -> Result<Vec<TextEdit>> {
	let node = node_at_line(buffer, line)?;
	let parent = node
		.parent()
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	let sibling = sibling_pair(parent, node, direction)?;
	let a = (node.start_byte(), node.end_byte(), node_text(buffer, node));
	let b = (sibling.start_byte(), sibling.end_byte(), node_text(buffer, sibling));
	let (first, second) = if a.0 > b.0 { (a, b) } else { (b, a) };
	Ok(vec![TextEdit { start_byte: first.0, old_end_byte: first.1, new_text: second.2 }, TextEdit {
		start_byte:   second.0,
		old_end_byte: second.1,
		new_text:     first.2,
	}])
}
