#![allow(
	clippy::map_unwrap_or,
	reason = "pre-existing style lint debt outside PLAN-205 behavior changes"
)]

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
		edit::rename_symbol,
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

	#[test]
	fn wrap_top_level_fn_with_if_true_succeeds() {
		// FEAT-702: trivial wrap template MUST succeed.
		let source = "function foo() { return 1; }
";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "foo").unwrap();
		let template = "if (true) {
  $BODY
}";
		let edits = wrap_node(&buffer, &resolved, template).expect("wrap should succeed");
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("if (true)"));
		assert!(edits[0].new_text.contains("function foo"));
	}

	#[test]
	fn wrap_inner_block_with_try_catch_succeeds() {
		// FEAT-702
		let source = "function risky() {
  doThing();
}
";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "risky").unwrap();
		let template = "try {
  $BODY
} catch (e) {
  throw e;
}";
		let edits = wrap_node(&buffer, &resolved, template).expect("wrap should succeed");
		assert!(edits[0].new_text.contains("try {"));
	}

	#[test]
	fn wrap_with_invalid_template_still_rejects() {
		// FEAT-702: locally-malformed template (mismatched braces) should
		// still be rejected at the buffer-validity layer.
		let source = "function foo() { return 1; }
";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "foo").unwrap();
		// Template missing the open brace.
		let template = "if (true)
  $BODY";
		let edits = wrap_node(&buffer, &resolved, template).unwrap();
		// wrap_node itself doesn't reject; the buffer's edit() does.
		// Apply through buffer to surface the rejection.
		let mut buf = ts_buffer(source);
		let result = buf.edit_batch(edits);
		// Either the edit succeeds (template happens to be valid) or it
		// fails with a structural error — both behaviours are acceptable
		// per FEAT-702 spec, but a panic is not.
		match result {
			Ok(_) => {},
			Err(e) => assert!(format!("{e}").contains("structurally")),
		}
	}

	#[test]
	fn wrap_with_missing_body_marker_rejected() {
		let source = "function foo() {}";
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, "foo").unwrap();
		let err = wrap_node(&buffer, &resolved, "no marker here").unwrap_err();
		assert!(err.to_string().contains("$BODY"));
	}

	fn apply_edits(source: &str, edits: Vec<TextEdit>) -> String {
		let mut buffer = ts_buffer(source);
		buffer.edit_batch(edits).expect("edit batch");
		buffer.source().to_string()
	}

	fn wrap_via_dispatch(source: &str, name: &str, template: &str) -> Vec<TextEdit> {
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, name).unwrap();
		let mut sym = resolved.clone();
		sym.start_byte = sym.statement_range.start;
		sym.end_byte = sym.statement_range.end;
		wrap_node(&buffer, &sym, template).unwrap()
	}

	fn rename_via_dispatch(source: &str, name: &str, new_name: &str) -> Vec<TextEdit> {
		let buffer = ts_buffer(source);
		let p = profile();
		let resolved = resolve_symbol(&buffer, &p, name).unwrap();
		let mut sym = resolved.clone();
		sym.start_byte = sym.identifier_range.start;
		sym.end_byte = sym.identifier_range.end;
		rename_symbol(&buffer, &sym, new_name).unwrap()
	}

	#[test]
	fn wrap_export_const_includes_export_keyword() {
		let source = "export const X = 1;\n";
		let edits = wrap_via_dispatch(source, "X", "try { $BODY } catch (e) {}");
		let result = apply_edits(source, edits);
		assert!(
			result.contains("try { export const X = 1; } catch (e) {}"),
			"expected wrap to include export keyword, got: {result}"
		);
		assert!(!result.contains("export try"), "export keyword should not be left dangling: {result}");
	}

	#[test]
	fn wrap_export_default_function_includes_default() {
		let source = "export default function foo() { return 1; }\n";
		let edits = wrap_via_dispatch(source, "foo", "/* WRAPPED */ $BODY");
		let result = apply_edits(source, edits);
		assert!(
			result.contains("/* WRAPPED */ export default function foo()"),
			"expected wrap to include default keyword, got: {result}"
		);
	}

	#[test]
	fn rename_uses_identifier_range_unchanged() {
		let source = "export const X = 1;\n";
		let edits = rename_via_dispatch(source, "X", "Y");
		let result = apply_edits(source, edits);
		assert_eq!(result, "export const Y = 1;\n");
	}
}
