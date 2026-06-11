use tree_sitter::Node;

use super::{TextEdit, node_at_line, replace::standalone_sibling_boundary};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

#[derive(Debug, Clone, Copy)]
pub enum DragDirection {
	Up,
	Down,
}

/// A prefix node that decorates the following declaration and must travel with
/// it during a move (Rust `attribute_item`, TS/JS `decorator`, Python
/// `decorator`). These are modelled by tree-sitter as *siblings* of the
/// declaration, not children, so a naive sibling swap would strand them.
fn is_decoration_sibling(node: Node<'_>) -> bool {
	matches!(node.kind(), "attribute_item" | "decorator")
}

/// Find the adjacent *declaration* sibling in `dir`, skipping decoration
/// siblings (which belong to the declaration that follows them).
fn sibling_pair<'a>(parent: Node<'a>, current: Node<'a>, dir: DragDirection) -> Result<Node<'a>> {
	let mut cursor = parent.walk();
	let children: Vec<_> = parent.named_children(&mut cursor).collect();
	let index = children
		.iter()
		.position(|child| child.id() == current.id())
		.ok_or_else(|| CodeEngineError::Edit("No sibling to swap with".to_string()))?;
	let no_sibling = || CodeEngineError::Edit("No sibling to swap with".to_string());
	match dir {
		DragDirection::Up => {
			let mut i = index;
			while i > 0 {
				i -= 1;
				if !is_decoration_sibling(children[i]) {
					return Ok(children[i]);
				}
			}
			Err(no_sibling())
		},
		DragDirection::Down => {
			let mut i = index + 1;
			while i < children.len() {
				if !is_decoration_sibling(children[i]) {
					return Ok(children[i]);
				}
				i += 1;
			}
			Err(no_sibling())
		},
	}
}

/// Byte span of a declaration's full *statement unit*: the declaration plus any
/// immediately-preceding decoration siblings (attributes / decorators). This is
/// the unit a `move` must relocate so decorations travel with their target.
fn statement_unit_span(node: Node<'_>) -> (usize, usize) {
	let mut start = node.start_byte();
	let mut current = node;
	while let Some(prev) = current.prev_sibling() {
		if is_decoration_sibling(prev) {
			start = prev.start_byte();
			current = prev;
		} else {
			break;
		}
	}
	(start, node.end_byte())
}

/// Resolve the node a `move` should reorder.
///
/// For a *symbol* target (`within = Some(statement_range)`), the node to move
/// is the one spanning that range — the class member / top-level statement —
/// NOT the leaf at the line. This distinction is the crux of BUG-441: a
/// method's first on-line token is its name `property_identifier`, whose
/// parent is the method itself, so a line-leaf resolution would walk the
/// method's *own* children (name/params/body) instead of the class members.
/// A top-level fn only worked by accident (its first token is the anonymous
/// `function` keyword, which climbs to the declaration).
///
/// Resolving from the span makes methods and top-level declarations one path:
/// the member node's parent is always the real sibling container (`class_body`
/// / `program`). For a *line* target (`within = None`) we keep the legacy
/// line-leaf resolution.
fn member_node_for_drag(
	buffer: &CodeBuffer,
	line: usize,
	within: Option<(usize, usize)>,
) -> Result<Node<'_>> {
	let Some((start, end)) = within else {
		return node_at_line(buffer, line, None);
	};
	let root = buffer.tree().root_node();
	// Anchor at the span's LAST byte, not its start. `statement_range` may
	// extend `start` backward over sibling prefix nodes (Rust `attribute_item`s
	// precede the `function_item` as siblings, not children). Anchoring at
	// `start` would make `named_descendant_for_byte_range` straddle the
	// attribute and the item and return their common ancestor (the container),
	// breaking the move. The last byte is always inside the declaration proper
	// (after any prefix), so the climb re-expands to the right member — and,
	// for Python `decorated_definition` (decorator is a CHILD), still reaches
	// the whole decorated node.
	let anchor = end.saturating_sub(1).max(start);
	let mut node = root
		.named_descendant_for_byte_range(anchor, anchor)
		.ok_or_else(|| CodeEngineError::Edit("No node found for symbol span".to_string()))?;
	// Climb to the outermost named node still contained in the symbol span —
	// the member/statement node whose parent is the sibling container.
	while let Some(parent) = node.parent() {
		if parent.start_byte() >= start && parent.end_byte() <= end {
			node = parent;
		} else {
			break;
		}
	}
	Ok(node)
}

pub fn drag_node(
	buffer: &CodeBuffer,
	line: usize,
	direction: DragDirection,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let node = member_node_for_drag(buffer, line, within)?;
	let parent = node
		.parent()
		.ok_or_else(|| CodeEngineError::Edit(format!("No node found at line {line}")))?;
	let sibling = sibling_pair(parent, node, direction)?;
	// Swap whole statement UNITS (declaration + any leading attributes/
	// decorators), so decorations travel with their target instead of being
	// stranded. The boundary guard runs on the unit span too.
	let (node_start, node_end) = statement_unit_span(node);
	let (sib_start, sib_end) = statement_unit_span(sibling);
	let current_boundary = standalone_sibling_boundary(
		&source,
		node_start,
		node_end,
		source[..node_start]
			.chars()
			.rev()
			.take_while(|&c| c != '\n')
			.count()
			+ 1,
		"move",
	)?;
	let sibling_boundary = standalone_sibling_boundary(
		&source,
		sib_start,
		sib_end,
		source[..sib_start]
			.chars()
			.rev()
			.take_while(|&c| c != '\n')
			.count()
			+ 1,
		"move",
	)?;
	if current_boundary.indent_col != sibling_boundary.indent_col {
		return Err(CodeEngineError::Edit(format!(
			"Unsafe move at line {line}: sibling declarations use different indentation levels. \
			 Re-anchor to a whole block replace.",
		)));
	}
	let a = (node_start, node_end, source[node_start..node_end].to_string());
	let b = (sib_start, sib_end, source[sib_start..sib_end].to_string());
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

	// BUG-441: class-method moves resolve via the symbol's statement span, not
	// the line leaf. `within` is the member's byte range (as code_buffer passes
	// from ResolvedSymbol.statement_range). Both directions must reorder the
	// class members — previously move-up reported "No sibling" and move-down
	// hit a spurious "shared boundary".
	fn member_span(source: &str, member_src: &str) -> (usize, usize) {
		let start = source.find(member_src).expect("member present");
		(start, start + member_src.len())
	}

	fn three_method_class() -> &'static str {
		"export class Box {\n  first(): number {\n    return 1;\n  }\n  second(): number {\n    \
		 return 2;\n  }\n  third(): number {\n    return 3;\n  }\n}\n"
	}

	#[test]
	fn drag_method_up_swaps_with_previous_member() {
		let source = three_method_class();
		let mut buffer = ts_buffer(source);
		let within = member_span(source, "second(): number {\n    return 2;\n  }");
		let edits = drag_node(&buffer, 5, DragDirection::Up, Some(within)).expect("move method up");
		buffer.edit_batch(edits).expect("apply");
		let out = buffer.source();
		let second = out.find("second").expect("second");
		let first = out.find("first").expect("first");
		assert!(second < first, "second should now precede first:\n{out}");
	}

	#[test]
	fn drag_method_down_swaps_with_next_member() {
		let source = three_method_class();
		let mut buffer = ts_buffer(source);
		let within = member_span(source, "second(): number {\n    return 2;\n  }");
		let edits =
			drag_node(&buffer, 5, DragDirection::Down, Some(within)).expect("move method down");
		buffer.edit_batch(edits).expect("apply");
		let out = buffer.source();
		let second = out.find("second").expect("second");
		let third = out.find("third").expect("third");
		assert!(third < second, "third should now precede second:\n{out}");
	}

	// BUG-441 review P1: Rust items carry `attribute_item` siblings that
	// `statement_range` swallows into `start`. Anchoring the span lookup at the
	// span START would straddle the attribute + item and return their container
	// (hard error at top level / corrupt edit in an impl). Anchoring at the
	// span END keeps resolution inside the item. Two attributed top-level fns
	// must still swap.
	fn rs_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("rust"), registry()).expect("buffer")
	}

	#[test]
	fn drag_rust_attributed_item_down_does_not_error() {
		let source =
			"#[inline]\nfn alpha() -> i32 {\n    1\n}\n\n#[inline]\nfn beta() -> i32 {\n    2\n}\n";
		let mut buffer = rs_buffer(source);
		// statement_range for `alpha` includes the preceding `#[inline]`.
		let attr_start = source.find("#[inline]").expect("attr");
		let alpha_end = source.find("}\n\n").expect("alpha end") + 1;
		let edits = drag_node(&buffer, 2, DragDirection::Down, Some((attr_start, alpha_end)))
			.expect("attributed item move must not error");
		buffer.edit_batch(edits).expect("apply");
		let out = buffer.source();
		let alpha = out.find("alpha").expect("alpha");
		let beta = out.find("beta").expect("beta");
		assert!(beta < alpha, "beta should now precede alpha:\n{out}");
	}

	#[test]
	fn drag_first_method_up_errors() {
		let source = three_method_class();
		let buffer = ts_buffer(source);
		let within = member_span(source, "first(): number {\n    return 1;\n  }");
		let err = drag_node(&buffer, 2, DragDirection::Up, Some(within))
			.expect_err("first member has no previous sibling");
		assert!(err.to_string().contains("No sibling"), "got: {err}");
	}

	// BUG-445 follow-up: TS decorators travel with the class they decorate (the
	// `decorator` node is a sibling, handled by `is_decoration_sibling`).
	#[test]
	fn drag_ts_decorated_class_carries_decorator() {
		let source = "@sealed\nclass A {}\n\n@frozen\nclass B {}\n";
		let mut buffer = ts_buffer(source);
		let a_start = source.find("@sealed").expect("a start");
		let a_end = source.find("class A {}").expect("a body") + "class A {}".len();
		let edits = drag_node(&buffer, 2, DragDirection::Down, Some((a_start, a_end)))
			.expect("decorated class move");
		buffer.edit_batch(edits).expect("apply");
		let out = buffer.source();
		let a = out.find("class A").expect("A");
		let b = out.find("class B").expect("B");
		assert!(b < a, "B should precede A after move:\n{out}");
		// The decorator stayed attached to A (not stranded above B).
		let sealed = out.find("@sealed").expect("sealed");
		assert!(sealed < a && sealed > b, "@sealed must sit with class A:\n{out}");
	}

	// BUG-445 follow-up: Python decorators (also `decorator` siblings) travel
	// with their function.
	#[test]
	fn drag_python_decorated_fn_carries_decorator() {
		let source = "@cache\ndef alpha():\n    return 1\n\n@cache\ndef beta():\n    return 2\n";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("python"), registry()).expect("buf");
		let a_start = source.find("@cache").expect("a start");
		let a_end = source.find("    return 1").expect("a body") + "    return 1".len();
		let edits = drag_node(&buffer, 2, DragDirection::Down, Some((a_start, a_end)))
			.expect("decorated fn move");
		let mut b2 =
			CodeBuffer::from_str(source, LanguageId::new("python"), registry()).expect("buf");
		b2.edit_batch(edits).expect("apply");
		let out = b2.source();
		let a = out.find("def alpha").expect("alpha");
		let b = out.find("def beta").expect("beta");
		assert!(b < a, "beta should precede alpha after move:\n{out}");
	}
}
