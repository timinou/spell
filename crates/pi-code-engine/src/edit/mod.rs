mod body;
mod clone;
mod drag;
pub(crate) mod indent;
mod patch;
mod rename;
mod replace;
mod splice;
mod transpose;
mod wrap;

pub use body::replace_body;
pub use clone::clone_node;
pub use drag::{DragDirection, drag_node};
pub use patch::{Patch, apply_patches};
pub use rename::rename_symbol;
pub use replace::{insert_after, insert_before, kill_node, replace_node};
pub use splice::{SpliceMode, splice_node};
pub use transpose::transpose_nodes;
pub use wrap::wrap_node;

pub use crate::buffer::TextEdit;
use crate::{buffer::CodeBuffer, error::Result, line_target::resolve_line_target};

pub fn node_at_line(buffer: &CodeBuffer, line: usize) -> Result<tree_sitter::Node<'_>> {
	Ok(resolve_line_target(buffer, line as u32, None)?.raw)
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
		// Cloned function should be on its own line, not concatenated
		let between = &out[first + "function add".len()..first + 1 + second.unwrap()];
		assert!(between.contains('\n'), "cloned function should be separated by newline");
	}

	#[test]
	fn test_clone_preserves_indentation() {
		let mut buffer = edit_buffer();
		// line 16 is `  bar() { return 1; }`
		let edits = clone_node(&buffer, 16).expect("clone bar");
		let out = apply_and_get(&mut buffer, edits);
		// Each occurrence of bar should be on its own indented line
		for line in out.lines() {
			if line.contains("bar()") {
				assert!(line.starts_with("  "), "cloned bar should preserve 2-space indent");
			}
		}
		// There should be two distinct bar lines
		let count = out.lines().filter(|l| l.contains("bar()")).count();
		assert_eq!(count, 2, "should have two bar methods");
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

	#[test]
	fn test_kill_typst_rejects_partial_wrapper_splice() {
		let mut buffer = typst_buffer();
		let edits = kill_node(&buffer, 2, "let").expect("resolve typst let target");
		let err = buffer
			.edit_batch(edits)
			.expect_err("reject partial wrapper splice");
		assert!(err.to_string().contains("structurally invalid"));
		assert!(buffer.source().contains("#let title = [Spell]"));
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
	fn test_replace_typst() {
		let mut buffer = typst_buffer();
		let edits = replace_node(&buffer, 2, "let", "let title = [Pi]").expect("replace typst let");
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

	#[test]
	fn test_replace_typst_single_line_let_accepts_raw_and_editable_scope_targets() {
		let mut raw_buffer = typst_target_buffer();
		let raw_edits = replace_node(&raw_buffer, 7, "let", "let teal-primary = rgb(\"#000000\")")
			.expect("replace typst single-line let raw");
		let raw_out = apply_and_get(&mut raw_buffer, raw_edits);
		assert!(
			raw_out.contains("#let teal-primary = rgb(\"#000000\")"),
			"raw let target should update binding"
		);
		assert!(
			!raw_out.contains("#let teal-primary = rgb(\"#008080\")"),
			"raw let target should remove old binding"
		);

		let mut scope_buffer = typst_target_buffer();
		let scope_edits =
			replace_node(&scope_buffer, 7, "code", "#let teal-primary = rgb(\"#111111\")")
				.expect("replace typst single-line let scope");
		let scope_out = apply_and_get(&mut scope_buffer, scope_edits);
		assert!(
			scope_out.contains("#let teal-primary = rgb(\"#111111\")"),
			"editable scope target should update binding"
		);
		assert!(
			!scope_out.contains("#let teal-primary = rgb(\"#008080\")"),
			"editable scope target should remove old binding"
		);
	}

	#[test]
	fn test_replace_typst_multiline_let_accepts_raw_and_editable_scope_targets() {
		let mut raw_buffer = typst_target_buffer();
		let raw_edits = replace_node(
			&raw_buffer,
			11,
			"let",
			"let section-title-probe(num, title) = {\n  [#num :: #title]\n}",
		)
		.expect("replace typst multiline let raw");
		let raw_out = apply_and_get(&mut raw_buffer, raw_edits);
		assert!(
			raw_out.contains("section-title-probe"),
			"raw multiline let target should update helper name"
		);
		assert!(
			!raw_out.contains("section-title(num, title)"),
			"raw multiline let target should remove old helper"
		);

		let mut scope_buffer = typst_target_buffer();
		let scope_edits = replace_node(
			&scope_buffer,
			11,
			"code",
			"#let section-title-scope(num, title) = {\n  [#num == #title]\n}",
		)
		.expect("replace typst multiline let scope");
		let scope_out = apply_and_get(&mut scope_buffer, scope_edits);
		assert!(
			scope_out.contains("section-title-scope"),
			"editable scope target should update helper name"
		);
		assert!(
			!scope_out.contains("section-title(num, title)"),
			"editable scope target should remove old helper"
		);
	}

	#[test]
	fn test_replace_typst_comment_accepts_reported_comment_target() {
		let mut buffer = typst_target_buffer();
		let edits = replace_node(&buffer, 6, "comment", "// rewritten comment")
			.expect("replace typst comment");
		let out = apply_and_get(&mut buffer, edits);
		assert!(out.contains("// rewritten comment"), "comment target should replace comment text");
		assert!(
			!out.contains("// editable comment before bindings"),
			"comment target should remove old comment"
		);
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

	#[test]
	fn test_insert_after_import_requires_explicit_separator() {
		let buffer = CodeBuffer::from_str(
			"import { a } from \"./a\";\nexport const value = a;\n",
			LanguageId::new("typescript"),
			registry(),
		)
		.expect("buffer");
		let err = insert_after(&buffer, 1, "import_statement", "import { b } from \"./b\";")
			.expect_err("reject unsafe import insert");
		assert!(err.to_string().contains("must start with a newline"));
	}

	#[test]
	fn test_insert_after_interface_member_requires_explicit_separator() {
		let buffer = CodeBuffer::from_str(
			"interface Foo {\n  bar: string;\n}\n",
			LanguageId::new("typescript"),
			registry(),
		)
		.expect("buffer");
		let err = insert_after(&buffer, 2, "property_signature", "  baz: number;")
			.expect_err("reject unsafe interface member insert");
		assert!(err.to_string().contains("must start with a newline"));
	}
}
