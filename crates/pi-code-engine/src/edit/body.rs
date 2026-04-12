use crate::{
	TextEdit,
	buffer::CodeBuffer,
	edit::indent::adjust_indent,
	error::{CodeEngineError, Result},
	resolve::ResolvedSymbol,
};

/// Replace only the body of a declaration, keeping its signature.
///
/// The `content` is the new body text **including braces**: `{ ... }`.
/// Indentation is adjusted to match the original body's indent level.
pub fn replace_body(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let body_start = resolved.body_start_byte.ok_or_else(|| {
		CodeEngineError::Edit(format!(
			"Symbol '{}' (kind: {}) has no body to replace",
			resolved.name, resolved.kind
		))
	})?;
	let body_end = resolved.body_end_byte.ok_or_else(|| {
		CodeEngineError::Edit(format!(
			"Symbol '{}' (kind: {}) has no body to replace",
			resolved.name, resolved.kind
		))
	})?;

	let source = buffer.source();
	let original_indent = first_line_indent(&source[body_start..body_end]);
	let content_indent = first_line_indent(content);
	let adjusted = adjust_indent(content, content_indent, original_indent);

	Ok(vec![TextEdit { start_byte: body_start, old_end_byte: body_end, new_text: adjusted }])
}

fn first_line_indent(text: &str) -> usize {
	text
		.chars()
		.take_while(|ch| *ch == ' ' || *ch == '\t')
		.map(char::len_utf8)
		.sum()
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
	fn replace_body_simple() {
		let source = "function add(a: number, b: number): number {\n  return a + b;\n}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "add").unwrap();
		let edits = replace_body(&buffer, &resolved, "{\n  return a * b;\n}").unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("return a * b"));
		// Signature should be preserved (start_byte is after signature)
		assert!(edits[0].start_byte > 0);
	}

	#[test]
	fn replace_body_class_method() {
		let source = "class Foo {\n  bar() { return 1; }\n}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "Foo.bar").unwrap();
		let edits = replace_body(&buffer, &resolved, "{ return 42; }").unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("42"));
	}

	#[test]
	fn replace_body_no_body_errors() {
		let source = "type X = string;";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "X").unwrap();
		let err = replace_body(&buffer, &resolved, "{ ... }").unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("no body"), "should say no body: {msg}");
	}

	#[test]
	fn replace_body_multiline_indent() {
		let source = "function greet(name: string) {\n  const greeting = \"Hello\";\n  return \
		              greeting + \" \" + name;\n}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "greet").unwrap();
		let edits = replace_body(&buffer, &resolved, "{\n  return `Hello ${name}`;\n}").unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("Hello ${name}"));
	}
}
