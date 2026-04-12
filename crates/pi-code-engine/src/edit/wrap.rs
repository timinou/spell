use crate::{
	TextEdit,
	buffer::CodeBuffer,
	edit::indent::adjust_indent,
	error::{CodeEngineError, Result},
	resolve::ResolvedSymbol,
};

/// Wrap a node in a template. `$BODY` in the template is replaced with the
/// node's current text, indentation-adjusted to match the `$BODY` line's
/// indent level.
pub fn wrap_node(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	template: &str,
) -> Result<Vec<TextEdit>> {
	if !template.contains("$BODY") {
		return Err(CodeEngineError::Edit("Wrap template must contain $BODY placeholder".into()));
	}

	let source = buffer.source();
	let original_text = source
		.get(resolved.start_byte..resolved.end_byte)
		.ok_or_else(|| CodeEngineError::Edit("symbol range out of bounds".into()))?;

	// Find the indent level of the line containing $BODY
	let body_indent = template
		.lines()
		.find(|line| line.contains("$BODY"))
		.map(|line| {
			line
				.chars()
				.take_while(|ch| *ch == ' ' || *ch == '\t')
				.map(char::len_utf8)
				.sum::<usize>()
		})
		.unwrap_or(0);

	// Compute the indent of the original node
	let node_indent = {
		let before_node = &source[..resolved.start_byte];
		let line_start = before_node.rfind('\n').map_or(0, |idx| idx + 1);
		source[line_start..resolved.start_byte]
			.chars()
			.take_while(|ch| *ch == ' ' || *ch == '\t')
			.map(char::len_utf8)
			.sum::<usize>()
	};

	// Adjust the original text's indentation to match the $BODY indent
	let adjusted_body = adjust_indent(original_text, node_indent, body_indent);

	// Replace $BODY in the template
	let new_text = template.replace("$BODY", &adjusted_body);

	// Adjust ALL lines of the result to match the original node's indent.
	// Unlike adjust_indent (which skips line 0), wrapping must indent
	// every line — the template starts at column 0.
	let template_indent = first_line_indent(template);
	let final_text = adjust_all_lines(&new_text, template_indent, node_indent);

	Ok(vec![TextEdit {
		start_byte:   resolved.start_byte,
		old_end_byte: resolved.end_byte,
		new_text:     final_text,
	}])
}

fn first_line_indent(text: &str) -> usize {
	text
		.chars()
		.take_while(|ch| *ch == ' ' || *ch == '\t')
		.map(char::len_utf8)
		.sum()
}

/// Adjust indentation for all lines (including the first).
fn adjust_all_lines(text: &str, original_col: usize, target_col: usize) -> String {
	let mut out = String::with_capacity(text.len());
	for (idx, line) in text.lines().enumerate() {
		if idx > 0 {
			out.push('\n');
		}
		if line.trim().is_empty() {
			out.push_str(line);
		} else if target_col >= original_col {
			let pad = " ".repeat(target_col - original_col);
			out.push_str(&pad);
			out.push_str(line);
		} else {
			let strip = original_col - target_col;
			let leading = line.len() - line.trim_start().len();
			let actual_strip = strip.min(leading);
			out.push_str(&line[actual_strip..]);
		}
	}
	out
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
	fn wrap_function_with_try_catch() {
		let source = "function risky() { doThing(); }";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "risky").unwrap();
		let template = "try {\n  $BODY\n} catch (err) {\n  logger.error(err);\n}";
		let edits = wrap_node(&buffer, &resolved, template).unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("try {"));
		assert!(edits[0].new_text.contains("function risky"));
		assert!(edits[0].new_text.contains("} catch (err)"));
	}

	#[test]
	fn wrap_no_body_placeholder_errors() {
		let source = "function risky() { doThing(); }";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "risky").unwrap();
		let template = "try {\n  // missing placeholder\n} catch (err) {}";
		let err = wrap_node(&buffer, &resolved, template).unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("$BODY"), "should mention $BODY: {msg}");
	}

	#[test]
	fn wrap_preserves_indent() {
		let source = "class App {\n  start() {\n    console.log(\"hi\");\n  }\n}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "App.start").unwrap();
		let template = "try {\n  $BODY\n} catch (e) {}";
		let edits = wrap_node(&buffer, &resolved, template).unwrap();
		assert_eq!(edits.len(), 1);
		// Should be indented to match the original 2-space indent of the method
		assert!(
			edits[0].new_text.contains("  try {"),
			"should have 2-space indent: {}",
			edits[0].new_text
		);
	}
}
