use crate::{
	TextEdit,
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

/// A find/replace patch to apply within a scoped byte range.
#[derive(Debug, Clone)]
pub struct Patch {
	pub find:    String,
	pub replace: String,
}

/// Apply find/replace patches within a byte range of the buffer.
///
/// `scope_start` and `scope_end` define the byte range to search within.
/// All patches are matched against the **original** buffer text (no mutation
/// between patches). Returns `TextEdit`s for each matched patch.
///
/// Matching is indent-insensitive: leading whitespace is stripped per line
/// for comparison. The replacement inherits the matched region's indentation.
pub fn apply_patches(
	buffer: &CodeBuffer,
	scope_start: usize,
	scope_end: usize,
	patches: &[Patch],
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let scope_text = source
		.get(scope_start..scope_end)
		.ok_or_else(|| CodeEngineError::Edit("scope range out of bounds".into()))?;

	let mut edits: Vec<TextEdit> = Vec::new();

	for (idx, patch) in patches.iter().enumerate() {
		let matches = find_indent_insensitive(scope_text, &patch.find);

		if matches.is_empty() {
			let preview = scope_preview(scope_text, 20);
			return Err(CodeEngineError::Edit(format!(
				"Patch {}: find text not found in scope. Scope preview:\n{}",
				idx + 1,
				preview,
			)));
		}
		if matches.len() > 1 {
			let lines: Vec<String> = matches
				.iter()
				.map(|m| {
					let abs = scope_start + m.offset;
					let line = source[..abs].matches('\n').count() + 1;
					line.to_string()
				})
				.collect();
			return Err(CodeEngineError::Edit(format!(
				"Patch {}: find text is ambiguous, found at {} locations (lines {})",
				idx + 1,
				matches.len(),
				lines.join(", "),
			)));
		}

		let m = &matches[0];
		let abs_start = scope_start + m.offset;
		let abs_end = scope_start + m.offset + m.length;

		// Compute indentation adjustment for the replacement.
		// Unlike adjust_indent (which skips the first line), patches need ALL
		// lines adjusted, including the first, since the agent's find/replace
		// text may have different indentation than the source.
		let matched_indent = first_line_indent(&source[abs_start..abs_end]);
		let find_indent = first_line_indent(&patch.find);
		let replacement = adjust_all_lines(&patch.replace, find_indent, matched_indent);

		edits.push(TextEdit {
			start_byte:   abs_start,
			old_end_byte: abs_end,
			new_text:     replacement,
		});
	}

	// Check for overlapping edits
	let mut sorted: Vec<&TextEdit> = edits.iter().collect();
	sorted.sort_by_key(|e| e.start_byte);
	for pair in sorted.windows(2) {
		if pair[0].old_end_byte > pair[1].start_byte {
			return Err(CodeEngineError::Edit("Patches produce overlapping edits".into()));
		}
	}

	Ok(edits)
}

/// A match result: byte offset within scope text + length of matched region.
struct Match {
	offset: usize,
	length: usize,
}

/// Find all indent-insensitive matches of `needle` in `haystack`.
///
/// Leading whitespace is stripped from each line of both needle and haystack
/// for comparison. The returned offset/length refer to the original haystack
/// bytes (with whitespace intact).
fn find_indent_insensitive(haystack: &str, needle: &str) -> Vec<Match> {
	let needle_lines: Vec<&str> = needle.lines().collect();
	if needle_lines.is_empty() {
		return vec![];
	}
	let needle_stripped: Vec<&str> = needle_lines.iter().map(|line| line.trim_start()).collect();

	let haystack_lines: Vec<&str> = haystack.lines().collect();
	let mut results = Vec::new();

	if haystack_lines.len() < needle_lines.len() {
		return results;
	}

	// Pre-compute byte offsets of each line start in the haystack
	let mut line_starts: Vec<usize> = Vec::with_capacity(haystack_lines.len());
	let mut pos = 0usize;
	for (i, line) in haystack_lines.iter().enumerate() {
		line_starts.push(pos);
		pos += line.len();
		// Account for the newline character (if not the last line)
		if i < haystack_lines.len() - 1 {
			// The original might have \r\n or \n
			let after = pos;
			if after < haystack.len() {
				if haystack.as_bytes()[after] == b'\r' {
					pos += 2; // \r\n
				} else {
					pos += 1; // \n
				}
			}
		}
	}

	'outer: for start in 0..=(haystack_lines.len() - needle_lines.len()) {
		for (j, needle_stripped_line) in needle_stripped.iter().enumerate() {
			let hay_line = haystack_lines[start + j].trim_start();
			if hay_line != *needle_stripped_line {
				continue 'outer;
			}
		}
		// Match found
		let match_start = line_starts[start];
		let last_line_idx = start + needle_lines.len() - 1;
		let match_end = line_starts[last_line_idx] + haystack_lines[last_line_idx].len();
		results.push(Match { offset: match_start, length: match_end - match_start });
	}

	results
}

/// Adjust indentation for ALL lines (including the first).
/// Unlike `adjust_indent` from indent.rs, which skips the first line,
/// patches need every line adjusted since the agent's text may have
/// completely different indentation.
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

/// Get the indentation (number of leading space/tab bytes) of the first line.
fn first_line_indent(text: &str) -> usize {
	text
		.chars()
		.take_while(|ch| *ch == ' ' || *ch == '\t')
		.map(char::len_utf8)
		.sum()
}

/// Generate a preview of scope text for error messages.
fn scope_preview(scope_text: &str, max_lines: usize) -> String {
	let lines: Vec<&str> = scope_text.lines().take(max_lines).collect();
	let preview = lines.join("\n");
	if scope_text.lines().count() > max_lines {
		format!("{}\n  ... ({} more lines)", preview, scope_text.lines().count() - max_lines)
	} else {
		preview
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn ts_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	#[test]
	fn patch_single_line() {
		let source = "function greet(name: string): string {\n  const prefix = \"Hello\";\n  return \
		              prefix + \" \" + name;\n}";
		let buffer = ts_buffer(source);
		let patches = vec![Patch {
			find:    "const prefix = \"Hello\";".into(),
			replace: "const prefix = \"Hi\";".into(),
		}];
		let edits = apply_patches(&buffer, 0, source.len(), &patches).expect("patch");
		assert_eq!(edits.len(), 1);
		// Replacement inherits the matched region's 2-space indent
		assert_eq!(edits[0].new_text, "  const prefix = \"Hi\";");
	}

	#[test]
	fn patch_multi_line() {
		let source = "function process(data: Input): Output {\n  if (data.error) {\n    return \
		              null;\n  }\n  return transform(data);\n}";
		let buffer = ts_buffer(source);
		let patches = vec![Patch {
			find:    "if (data.error) {\n    return null;\n  }".into(),
			replace: "if (data.error) {\n    logger.error(data.error);\n    throw data.error;\n  }"
				.into(),
		}];
		let edits = apply_patches(&buffer, 0, source.len(), &patches).expect("patch");
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("logger.error"));
		assert!(edits[0].new_text.contains("throw"));
	}

	#[test]
	fn patch_indent_insensitive() {
		let source = "function process(data: Input): Output {\n  if (data.error) {\n    return \
		              null;\n  }\n  return transform(data);\n}";
		let buffer = ts_buffer(source);
		// Agent provides find without indentation
		let patches = vec![Patch {
			find:    "if (data.error) {\nreturn null;\n}".into(),
			replace: "if (data.error) {\nlogger.error(data.error);\nthrow data.error;\n}".into(),
		}];
		let edits = apply_patches(&buffer, 0, source.len(), &patches).expect("patch");
		assert_eq!(edits.len(), 1);
		// The replacement should be re-indented to match the original 2-space indent
		assert!(
			edits[0].new_text.contains("  if (data.error)"),
			"should have 2-space indent: {}",
			edits[0].new_text
		);
	}

	#[test]
	fn patch_multiple_patches() {
		let source = "function test() {\n  const a = 1;\n  const b = 2;\n}";
		let buffer = ts_buffer(source);
		let patches =
			vec![Patch { find: "const a = 1;".into(), replace: "const a = 10;".into() }, Patch {
				find:    "const b = 2;".into(),
				replace: "const b = 20;".into(),
			}];
		let edits = apply_patches(&buffer, 0, source.len(), &patches).expect("patches");
		assert_eq!(edits.len(), 2);
		assert_eq!(edits[0].new_text, "  const a = 10;");
		assert_eq!(edits[1].new_text, "  const b = 20;");
	}

	#[test]
	fn patch_ambiguous_error() {
		let source = "function test() {\n  log(\"hello\");\n  log(\"hello\");\n}";
		let buffer = ts_buffer(source);
		let patches =
			vec![Patch { find: "log(\"hello\");".into(), replace: "log(\"world\");".into() }];
		let err = apply_patches(&buffer, 0, source.len(), &patches).unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("ambiguous"), "should say ambiguous: {msg}");
		assert!(msg.contains("2 locations"), "should say 2 locations: {msg}");
	}

	#[test]
	fn patch_not_found_error() {
		let source = "function test() {\n  return 42;\n}";
		let buffer = ts_buffer(source);
		let patches =
			vec![Patch { find: "nonexistent text".into(), replace: "replacement".into() }];
		let err = apply_patches(&buffer, 0, source.len(), &patches).unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("not found"), "should say not found: {msg}");
	}

	#[test]
	fn patch_empty_replace_deletes() {
		let source = "function test() {\n  const unused = true;\n  return 42;\n}";
		let buffer = ts_buffer(source);
		let patches = vec![Patch { find: "const unused = true;".into(), replace: String::new() }];
		let edits = apply_patches(&buffer, 0, source.len(), &patches).expect("patch");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].new_text, "");
	}

	#[test]
	fn patch_overlapping_error() {
		// Two multi-line patches whose matched regions overlap
		let source = "function test() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n}";
		let buffer = ts_buffer(source);
		let patches = vec![
			Patch { find: "const a = 1;\n  const b = 2;".into(), replace: "const x = 10;".into() },
			Patch { find: "const b = 2;\n  const c = 3;".into(), replace: "const y = 20;".into() },
		];
		let err = apply_patches(&buffer, 0, source.len(), &patches).unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("overlapping"), "should detect overlap: {msg}");
	}

	#[test]
	fn patch_scope_boundary() {
		let source = "const x = 1;\nfunction add(a: number, b: number): number {\n  return a + b;\n}";
		let buffer = ts_buffer(source);
		// Only patch within the function scope (skip const x)
		let fn_start = source.find("function").unwrap();
		let patches =
			vec![Patch { find: "return a + b;".into(), replace: "return a * b;".into() }];
		let edits = apply_patches(&buffer, fn_start, source.len(), &patches).expect("patch");
		assert_eq!(edits.len(), 1);
		assert!(edits[0].start_byte >= fn_start, "edit should be within scope");
	}
}
