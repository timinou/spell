mod body;
mod clone;
mod drag;
pub(crate) mod indent;
mod patch;
mod rename;
mod replace;
mod splice;
mod transpose;
mod web_refactor;
mod wrap;

pub use body::{ReplacePolicy, replace_body, replace_body_safe};
pub use clone::clone_node;
pub use drag::{DragDirection, drag_node};
pub use patch::{Occurrence, Patch, apply_patches};
pub use rename::rename_symbol;
pub use replace::{insert_after, insert_before, kill_node, replace_node};
pub use splice::{SpliceMode, splice_node};
pub use transpose::transpose_nodes;
pub use web_refactor::{
	delete_resolved_symbol, rename_class_token, rename_custom_property, rename_id_token,
};
pub use wrap::wrap_node;

pub use crate::buffer::TextEdit;
use crate::{buffer::CodeBuffer, error::Result, line_target::resolve_line_target};

pub fn node_at_line(
	buffer: &CodeBuffer,
	line: usize,
	within: Option<(usize, usize)>,
) -> Result<tree_sitter::Node<'_>> {
	Ok(resolve_line_target(buffer, line as u32, None, within)?.raw)
}

pub(crate) fn node_text(buffer: &CodeBuffer, node: tree_sitter::Node<'_>) -> String {
	buffer.source()[node.start_byte()..node.end_byte()].to_string()
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

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

	fn typst_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/hello.typ",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("typst"), registry()).expect("buffer")
	}

	fn typst_target_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/typst_edit_targets.typ",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("typst"), registry()).expect("buffer")
	}

	fn apply_and_get(buffer: &mut CodeBuffer, edits: Vec<TextEdit>) -> String {
		buffer.edit_batch(edits).expect("edit");
		buffer.source()
	}

	#[test]
	fn test_drag_down_top_level() {
		let mut buffer = edit_buffer();
		let edits = drag_node(&buffer, 9, DragDirection::Down, None).expect("drag down");
		let out = apply_and_get(&mut buffer, edits);
		let items_pos = out.find("const items").expect("items");
		let add_pos = out.find("function add").expect("add");
		assert!(add_pos < items_pos, "add should appear before items after drag down");
	}

	#[test]
	fn test_drag_up_first_is_error() {
		let buffer = edit_buffer();
		let result = drag_node(&buffer, 1, DragDirection::Up, None);
		assert!(result.is_err(), "dragging first top-level decl up should error");
	}

	#[test]
	fn test_clone_function() {
		let mut buffer = edit_buffer();
		let edits = clone_node(&buffer, 11, None).expect("clone");
		let out = apply_and_get(&mut buffer, edits);
		let first = out.find("function add").expect("first");
		let second = out[first + 1..].find("function add");
		assert!(second.is_some(), "should have two copies of add");
		let between = &out[first + "function add".len()..first + 1 + second.unwrap()];
		assert!(between.contains('\n'), "cloned function should be separated by newline");
	}

	#[test]
	fn test_clone_preserves_indentation() {
		let mut buffer = edit_buffer();
		let edits = clone_node(&buffer, 16, None).expect("clone bar");
		let out = apply_and_get(&mut buffer, edits);
		for line in out.lines() {
			if line.contains("bar()") {
				assert!(line.starts_with("  "), "cloned bar should preserve 2-space indent");
			}
		}
		let count = out.lines().filter(|line| line.contains("bar()")).count();
		assert_eq!(count, 2, "should have two bar methods");
	}

	#[test]
	fn test_kill_function() {
		let mut buffer = edit_buffer();
		let edits = kill_node(&buffer, 11, "function_declaration", None).expect("kill");
		let out = apply_and_get(&mut buffer, edits);
		assert!(!out.contains("function add"), "add should be removed");
		assert!(out.contains("function outer"), "outer should remain");
		assert!(out.contains("class Foo"), "Foo should remain");
	}

	#[test]
	fn test_kill_typst_rejects_partial_wrapper_splice() {
		let mut buffer = typst_buffer();
		let edits = kill_node(&buffer, 2, "let", None).expect("resolve typst let target");
		let err = buffer
			.edit_batch(edits)
			.expect_err("reject partial wrapper splice");
		assert!(err.to_string().contains("structurally invalid"));
		assert!(buffer.source().contains("#let title = [Spell]"));
	}

	#[test]
	fn test_replace_node() {
		let mut buffer = edit_buffer();
		let edits = replace_node(&buffer, 11, "function_declaration", "function add() {}", None)
			.expect("replace");
		let out = apply_and_get(&mut buffer, edits);
		assert!(out.contains("function add() {}"), "replacement should be present");
		assert!(!out.contains("return a + b"), "old body should be gone");
	}

	#[test]
	fn test_replace_typst() {
		let mut buffer = typst_buffer();
		let edits =
			replace_node(&buffer, 2, "let", "let title = [Pi]", None).expect("replace typst let");
		let out = apply_and_get(&mut buffer, edits);
		assert!(out.contains("#let title = [Pi]"), "replacement should preserve valid Typst syntax");
		assert!(!out.contains("#let title = [Spell]"), "old binding should be gone");
		assert!(out.contains("= #title"), "body content should remain");
	}

	#[test]
	fn test_replace_typst_set_accepts_raw_and_editable_scope_targets() {
		let mut raw_buffer = typst_target_buffer();
		let raw_edits = replace_node(
			&raw_buffer,
			1,
			"set",
			"set document(\n  title: \"Raw set\",\n  author: \"Spell\",\n)",
			None,
		)
		.expect("replace typst set raw");
		let raw_out = apply_and_get(&mut raw_buffer, raw_edits);
		assert!(raw_out.contains("title: \"Raw set\""), "raw set target should update title");
		assert!(
			!raw_out.contains("Editable scope fixture"),
			"raw set target should remove old title"
		);

		let mut scope_buffer = typst_target_buffer();
		let scope_edits = replace_node(
			&scope_buffer,
			1,
			"code",
			"#set document(\n  title: \"Scope set\",\n  author: \"Spell\",\n)",
			None,
		)
		.expect("replace typst set scope");
		let scope_out = apply_and_get(&mut scope_buffer, scope_edits);
		assert!(
			scope_out.contains("title: \"Scope set\""),
			"editable scope target should update title"
		);
		assert!(
			!scope_out.contains("Editable scope fixture"),
			"editable scope target should remove old title"
		);
	}
}
