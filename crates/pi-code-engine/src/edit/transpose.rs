use crate::{buffer::CodeBuffer, error::{CodeEngineError, Result}};

use super::{node_text, TextEdit};

fn node_at_point(tree: &tree_sitter::Tree, byte: usize) -> Option<tree_sitter::Node<'_>> {
    tree.root_node().named_descendant_for_byte_range(byte, byte).or_else(|| tree.root_node().descendant_for_byte_range(byte, byte))
}

pub fn transpose_nodes(buffer: &CodeBuffer, line: usize, column: usize) -> Result<Vec<TextEdit>> {
    let byte = buffer.rope().line_to_byte_idx(line.saturating_sub(1), ropey::LineType::LF_CR) + column;
    let tree = buffer.tree();
    let left = node_at_point(tree, byte).ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
    let right = node_at_point(tree, left.end_byte()).ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
    Ok(vec![TextEdit { start_byte: left.start_byte(), old_end_byte: left.end_byte(), new_text: node_text(buffer, right) }, TextEdit { start_byte: right.start_byte(), old_end_byte: right.end_byte(), new_text: node_text(buffer, left) }])
}
