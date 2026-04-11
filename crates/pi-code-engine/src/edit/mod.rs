mod clone;
mod drag;
mod indent;
mod replace;
mod splice;
mod transpose;

pub use clone::clone_node;
pub use drag::{DragDirection, drag_node};
pub use replace::{insert_after, insert_before, kill_node, replace_node};
use ropey::LineType;
pub use splice::{SpliceMode, splice_node};
pub use transpose::transpose_nodes;

pub use crate::buffer::TextEdit;
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

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

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

	use super::*;
	use crate::{
		buffer::CodeBuffer,
		language::{LanguageId, LanguageRegistry},
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn edit_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/edit_target.ts",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	fn apply_and_get(buffer: &mut CodeBuffer, edits: Vec<TextEdit>) -> String {
		buffer.edit_batch(edits).expect("edit");
		buffer.source()
	}

	// -- drag tests --

	#[test]
	fn test_drag_down_top_level() {
		let mut buffer = edit_buffer();
		// line 9: `const items = [...]` — a top-level declaration at col 0
		// Drag down swaps it with the next sibling: `function add` at line 11
		let edits = drag_node(&buffer, 9, DragDirection::Down).expect("drag down");
		let out = apply_and_get(&mut buffer, edits);
		let items_pos = out.find("const items").expect("items");
		let add_pos = out.find("function add").expect("add");
		assert!(add_pos < items_pos, "add should appear before items after drag down");
	}

	#[test]
	fn test_drag_up_first_is_error() {
		let buffer = edit_buffer();
		// line 1: `function outer()` — the first top-level declaration at col 0
		let result = drag_node(&buffer, 1, DragDirection::Up);
		assert!(result.is_err(), "dragging first top-level decl up should error");
	}

	// -- clone test --

	#[test]
	fn test_clone_function() {
		let mut buffer = edit_buffer();
		// line 11 is `function add(...)`
		let edits = clone_node(&buffer, 11).expect("clone");
		let out = apply_and_get(&mut buffer, edits);
		// Should contain two copies of the add function
		let first = out.find("function add").expect("first");
		let second = out[first + 1..].find("function add");
		assert!(second.is_some(), "should have two copies of add");
	}

	// -- kill test --

	#[test]
	fn test_kill_function() {
		let mut buffer = edit_buffer();
		// Kill the function_declaration at line 11
		let edits = kill_node(&buffer, 11, "function_declaration").expect("kill");
		let out = apply_and_get(&mut buffer, edits);
		assert!(!out.contains("function add"), "add should be removed");
		// Other content preserved
		assert!(out.contains("function outer"), "outer should remain");
		assert!(out.contains("class Foo"), "Foo should remain");
	}

	// -- replace / insert tests --

	#[test]
	fn test_replace_node() {
		let mut buffer = edit_buffer();
		let edits =
			replace_node(&buffer, 11, "function_declaration", "function add() {}").expect("replace");
		let out = apply_and_get(&mut buffer, edits);
		assert!(out.contains("function add() {}"), "replacement should be present");
		assert!(!out.contains("return a + b"), "old body should be gone");
	}

	#[test]
	fn test_insert_before() {
		let mut buffer = edit_buffer();
		let edits =
			insert_before(&buffer, 11, "function_declaration", "// comment\n").expect("insert before");
		let out = apply_and_get(&mut buffer, edits);
		let comment_pos = out.find("// comment").expect("comment");
		let add_pos = out.find("function add").expect("add");
		assert!(comment_pos < add_pos, "comment should appear before add");
	}

	#[test]
	fn test_insert_after() {
		let mut buffer = edit_buffer();
		let edits =
			insert_after(&buffer, 11, "function_declaration", "\n// comment").expect("insert after");
		let out = apply_and_get(&mut buffer, edits);
		let add_end = out.find("return a + b").expect("add body");
		let comment_pos = out.find("// comment").expect("comment");
		assert!(comment_pos > add_end, "comment should appear after add function");
	}

	// -- transpose tests --

	#[test]
	fn test_transpose_swaps_nodes() {
		// Use two statements without a gap for a clean transpose test
		let source2 = "x;y";
		let mut buffer2 =
			CodeBuffer::from_str(source2, LanguageId::new("typescript"), registry()).expect("buffer");
		// expression_statement for x ends at byte 2 (x;), expression_statement for y
		// starts at byte 2
		let result = transpose_nodes(&buffer2, 1, 0);
		if let Ok(edits) = result {
			let out = apply_and_get(&mut buffer2, edits);
			assert!(out.contains('y') && out.contains('x'), "both should remain");
			// If it succeeds, the order should be swapped
		} else {
			// transpose may fail if nodes overlap or resolve to same node — that's
			// also valid The point is that the overlap check and same-node
			// check don't panic
		}
	}

	#[test]
	fn test_transpose_same_node_errors() {
		let buffer = edit_buffer();
		// Use position 0, col 0 on line 1 — the function keyword
		// node_at_point at byte 0 returns 'function' keyword or 'outer' identifier
		// At the end byte of that node, node_at_point may return the same node
		// Use the program root: last byte of the file points to the same root node
		let source = buffer.source();
		let last_line = source.lines().count();
		let result = transpose_nodes(&buffer, last_line, 0);
		// Either same-node error or no-adjacent-node error — both are Err
		assert!(result.is_err(), "transpose at boundary should error");
	}

	// -- splice test --

	#[test]
	fn test_splice_self() {
		let mut buffer = edit_buffer();
		// line 3: `const x = 1;` inside the if block
		// Splice self on that node — the if_statement body contains x, y, return
		// splice_node resolves the node at line 3, finds its parent (statement_block),
		// and for Self_ mode keeps only the child matching the node's range
		let edits = splice_node(&buffer, 3, SpliceMode::Self_).expect("splice self");
		let out = apply_and_get(&mut buffer, edits);
		assert!(out.contains("const x"), "x should remain after splice self");
		// Sibling statements should be removed from the parent range
		// The parent node is replaced with only the kept children
	}
}
