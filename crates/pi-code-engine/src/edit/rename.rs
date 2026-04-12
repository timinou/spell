#![allow(
	clippy::collapsible_if,
	clippy::uninlined_format_args,
	reason = "pre-existing style lint debt outside PLAN-205 behavior changes"
)]

use tree_sitter::Node;

use crate::{
	TextEdit,
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	resolve::ResolvedSymbol,
};

/// Rename a declaration and all in-file references.
///
/// Scans the buffer for whole-word occurrences of the old name, filtering to
/// `identifier` or `property_identifier` nodes (not inside strings/comments).
pub fn rename_symbol(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	new_name: &str,
) -> Result<Vec<TextEdit>> {
	if new_name.is_empty() {
		return Err(CodeEngineError::Edit("new_name cannot be empty".into()));
	}
	if !new_name
		.chars()
		.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
	{
		return Err(CodeEngineError::Edit(format!("Invalid identifier: '{new_name}'")));
	}

	let source = buffer.source();
	let old_name = &resolved.name;
	let root = buffer.tree().root_node();

	let mut edits = Vec::new();
	collect_rename_edits(root, &source, old_name, new_name, &mut edits);

	if edits.is_empty() {
		return Err(CodeEngineError::Edit(format!("No references to '{}' found", old_name)));
	}

	Ok(edits)
}

fn collect_rename_edits(
	node: Node<'_>,
	source: &str,
	old_name: &str,
	new_name: &str,
	edits: &mut Vec<TextEdit>,
) {
	// Check if this node is an identifier matching the old name
	let kind = node.kind();
	if (kind == "identifier" || kind == "property_identifier" || kind == "type_identifier")
		&& !is_in_string_or_comment(node)
	{
		if let Some(text) = source.get(node.start_byte()..node.end_byte()) {
			if text == old_name {
				edits.push(TextEdit {
					start_byte:   node.start_byte(),
					old_end_byte: node.end_byte(),
					new_text:     new_name.to_string(),
				});
				return; // Leaf node, no children to check
			}
		}
	}

	// Recurse into children
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		collect_rename_edits(child, source, old_name, new_name, edits);
	}
}

/// Check if a node is inside a string or comment.
fn is_in_string_or_comment(node: Node<'_>) -> bool {
	let mut current = node;
	while let Some(parent) = current.parent() {
		let kind = parent.kind();
		if kind == "string"
			|| kind == "template_string"
			|| kind == "comment"
			|| kind == "string_fragment"
		{
			return true;
		}
		current = parent;
	}
	false
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::{
		language::{LanguageId, LanguageRegistry},
		resolve::resolve_symbol,
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn ts_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	fn profile() -> crate::language::LanguageProfile {
		registry()
			.get(&LanguageId::new("typescript"))
			.unwrap()
			.clone()
	}

	#[test]
	fn rename_function_and_calls() {
		let source =
			"function add(a: number, b: number) {\n  return a + b;\n}\nconst result = add(1, 2);";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "add").unwrap();
		let edits = rename_symbol(&buffer, &resolved, "sum").unwrap();
		// Should rename both the declaration and the call site
		assert!(edits.len() >= 2, "should have at least 2 edits: {}", edits.len());
		assert!(edits.iter().all(|e| e.new_text == "sum"));
	}

	#[test]
	fn rename_skips_strings() {
		let source =
			"function add(a: number, b: number) {\n  console.log(\"add\");\n  return a + b;\n}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "add").unwrap();
		let edits = rename_symbol(&buffer, &resolved, "sum").unwrap();
		// Should NOT rename the string "add"
		for edit in &edits {
			let original = &source[edit.start_byte..edit.old_end_byte];
			assert_eq!(original, "add");
			// Verify we're not inside a string by checking the surrounding context
			let before = &source[..edit.start_byte];
			let in_string = before.ends_with('"') || before.ends_with('\'');
			assert!(!in_string, "should not rename string content");
		}
	}

	#[test]
	fn rename_class() {
		let source = "class Foo {\n  bar() { return 1; }\n}\nconst f = new Foo();";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "Foo").unwrap();
		let edits = rename_symbol(&buffer, &resolved, "Bar").unwrap();
		assert!(edits.len() >= 2, "should rename declaration and usage");
		assert!(edits.iter().all(|e| e.new_text == "Bar"));
	}

	#[test]
	fn rename_empty_name_errors() {
		let source = "function add() {}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "add").unwrap();
		let err = rename_symbol(&buffer, &resolved, "").unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("empty"), "should say empty: {msg}");
	}

	#[test]
	fn rename_invalid_chars_errors() {
		let source = "function add() {}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "add").unwrap();
		let err = rename_symbol(&buffer, &resolved, "new name").unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("Invalid"), "should say invalid: {msg}");
	}
}
