#![allow(dead_code, reason = "edit helpers are invoked through the dispatcher and via tests")]

mod clone;
mod drag;
mod indent;
mod replace;
mod splice;
mod transpose;

pub use crate::buffer::TextEdit;
pub use drag::{drag_node, DragDirection};
pub use replace::{insert_after, insert_before, kill_node, replace_node};
pub use splice::{splice_node, SpliceMode};
pub use transpose::transpose_nodes;

use crate::{buffer::CodeBuffer, error::{CodeEngineError, Result}};
use ropey::LineType;

pub(crate) fn node_at_line(buffer: &CodeBuffer, line: usize) -> Result<tree_sitter::Node<'_>> {
    let rope = buffer.rope();
    let byte = rope.line_to_byte_idx(line.saturating_sub(1), LineType::LF_CR);
    let tree = buffer.tree();
    let node = tree
        .root_node()
        .named_descendant_for_byte_range(byte, byte)
        .or_else(|| tree.root_node().descendant_for_byte_range(byte, byte))
        .ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
    Ok(node)
}

pub(crate) fn node_text(buffer: &CodeBuffer, node: tree_sitter::Node<'_>) -> String {
    buffer.source()[node.start_byte()..node.end_byte()].to_string()
}
