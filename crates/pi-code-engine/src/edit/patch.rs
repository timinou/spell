use crate::{
	TextEdit,
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Occurrence {
	#[default]
	Unique,
	First,
	Last,
	Index(usize),
	All,
}

/// A find/replace patch to apply within a scoped byte range.
#[derive(Debug, Clone)]
pub struct Patch {
	pub find:       String,
	pub replace:    String,
	pub occurrence: Occurrence,
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
	apply_patches_with_matcher(buffer, scope_start, scope_end, patches, MatchMode::IndentInsensitive)
}

pub fn apply_raw_text_patches(
	buffer: &CodeBuffer,
	scope_start: usize,
	scope_end: usize,
	patches: &[Patch],
) -> Result<Vec<TextEdit>> {
	apply_patches_with_matcher(buffer, scope_start, scope_end, patches, MatchMode::RawText)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchMode {
	IndentInsensitive,
	RawText,
}

fn apply_patches_with_matcher(
	buffer: &CodeBuffer,
	scope_start: usize,
	scope_end: usize,
	patches: &[Patch],
	mode: MatchMode,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let scope_text = source
		.get(scope_start..scope_end)
		.ok_or_else(|| CodeEngineError::Edit("scope range out of bounds".into()))?;

	let mut edits: Vec<TextEdit> = Vec::new();

	for (idx, patch) in patches.iter().enumerate() {
		let matches = match mode {
			MatchMode::IndentInsensitive => find_indent_insensitive(scope_text, &patch.find),
			MatchMode::RawText => find_raw_text(scope_text, &patch.find),
		};
		if matches.is_empty() {
			// BUG-402: an empty scope means the buffer itself is empty —
			// almost always a missing-file / wrong-path issue. Name the
			// actual cause instead of the misleading "text not found" line
			// followed by an empty preview.
			if scope_text.is_empty() {
				let path_hint = buffer
					.path()
					.map(|p| p.display().to_string())
					.unwrap_or_else(|| "<no path>".to_string());
				return Err(CodeEngineError::Edit(format!(
					"Patch {}: scope is empty — buffer at {path_hint} is 0 bytes \
					 (file may be missing, freshly created, or resolved to the wrong path). \
					 Verify the file exists before retrying.",
					idx + 1,
				)));
			}
			let preview = scope_preview(scope_text, 20);
			return Err(CodeEngineError::Edit(format!(
				"Patch {}: find text not found in scope. Scope preview:\n{}",
				idx + 1,
				preview,
			)));
		}

		let selected = select_matches(idx + 1, &matches, patch.occurrence, scope_start, &source)?;
		for matched in selected {
			let abs_start = scope_start + matched.offset;
			let abs_end = scope_start + matched.offset + matched.length;
			let replacement = match mode {
				MatchMode::IndentInsensitive => {
					let matched_indent = first_line_indent(&source[abs_start..abs_end]);
					let find_indent = first_line_indent(&patch.find);
					adjust_all_lines(&patch.replace, find_indent, matched_indent)
				},
				MatchMode::RawText => patch.replace.clone(),
			};
			edits.push(TextEdit {
				start_byte:   abs_start,
				old_end_byte: abs_end,
				new_text:     replacement,
			});
		}
	}

	let mut sorted: Vec<&TextEdit> = edits.iter().collect();
	sorted.sort_by_key(|edit| edit.start_byte);
	for pair in sorted.windows(2) {
		if pair[0].old_end_byte > pair[1].start_byte {
			return Err(CodeEngineError::Edit("Patches produce overlapping edits".into()));
		}
	}

	Ok(edits)
}

fn find_raw_text(haystack: &str, needle: &str) -> Vec<Match> {
	if needle.is_empty() {
		return Vec::new();
	}
	haystack
		.match_indices(needle)
		.map(|(offset, text)| Match { offset, length: text.len() })
		.collect()
}
fn select_matches<'a>(
	patch_index: usize,
	matches: &'a [Match],
	occurrence: Occurrence,
	scope_start: usize,
	source: &str,
) -> Result<Vec<&'a Match>> {
	match occurrence {
		Occurrence::Unique => {
			if matches.len() > 1 {
				let lines: Vec<String> = matches
					.iter()
					.map(|matched| line_for_offset(scope_start + matched.offset, source).to_string())
					.collect();
				return Err(CodeEngineError::Edit(format!(
					"Patch {patch_index}: find text is ambiguous, found at {} locations (lines {}). \
					 multiple matches; pass occurrence: 'first' | 'last' | 'all' | <n>",
					matches.len(),
					lines.join(", "),
				)));
			}
			Ok(vec![&matches[0]])
		},
		Occurrence::First => Ok(vec![&matches[0]]),
		Occurrence::Last => Ok(vec![matches.last().expect("non-empty matches")]),
		Occurrence::Index(index) => matches
			.get(index.saturating_sub(1))
			.map(|matched| vec![matched])
			.ok_or_else(|| {
				CodeEngineError::Edit(format!(
					"Patch {patch_index}: occurrence {index} out of range 1..={}",
					matches.len(),
				))
			}),
		Occurrence::All => Ok(matches.iter().collect()),
	}
}

fn line_for_offset(offset: usize, source: &str) -> usize {
	source[..offset].matches('\n').count() + 1
}

/// A match result: byte offset within scope text + length of matched region.
#[derive(Debug)]
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

	let mut line_starts: Vec<usize> = Vec::with_capacity(haystack_lines.len());
	let mut pos = 0usize;
	for (index, line) in haystack_lines.iter().enumerate() {
		line_starts.push(pos);
		pos += line.len();
		if index < haystack_lines.len() - 1 {
			let after = pos;
			if after < haystack.len() {
				if haystack.as_bytes()[after] == b'\r' {
					pos += 2;
				} else {
					pos += 1;
				}
			}
		}
	}

	'outer: for start in 0..=(haystack_lines.len() - needle_lines.len()) {
		for (line_index, needle_stripped_line) in needle_stripped.iter().enumerate() {
			let hay_line = haystack_lines[start + line_index].trim_start();
			if hay_line != *needle_stripped_line {
				continue 'outer;
			}
		}
		let match_start = line_starts[start];
		let last_line_idx = start + needle_lines.len() - 1;
		let match_end = line_starts[last_line_idx] + haystack_lines[last_line_idx].len();
		results.push(Match { offset: match_start, length: match_end - match_start });
	}

	if results.is_empty() && needle_lines.len() == 1 {
		return find_raw_text(haystack, needle);
	}

	results
}

/// Adjust indentation for ALL lines (including the first).
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
	fn apply_patches_unique_default() {
		let source = "value = 1\nvalue = 1\n";
		let buffer = ts_buffer(source);
		let err = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "value = 1".into(),
			replace:    "value = 2".into(),
			occurrence: Occurrence::Unique,
		}])
		.expect_err("unique default should reject ambiguity");
		assert!(
			err.to_string()
				.contains("multiple matches; pass occurrence")
		);
	}

	#[test]
	fn apply_patches_occurrence_first() {
		let source = "value = 1\nvalue = 1\n";
		let buffer = ts_buffer(source);
		let edits = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "value = 1".into(),
			replace:    "value = 2".into(),
			occurrence: Occurrence::First,
		}])
		.expect("first occurrence");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].start_byte, 0);
	}

	#[test]
	fn apply_patches_occurrence_last() {
		let source = "value = 1\nvalue = 1\n";
		let buffer = ts_buffer(source);
		let edits = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "value = 1".into(),
			replace:    "value = 2".into(),
			occurrence: Occurrence::Last,
		}])
		.expect("last occurrence");
		assert_eq!(edits.len(), 1);
		assert!(edits[0].start_byte > 0);
	}

	#[test]
	fn apply_patches_occurrence_index_2() {
		let source = "value = 1\nvalue = 1\nvalue = 1\n";
		let buffer = ts_buffer(source);
		let edits = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "value = 1".into(),
			replace:    "value = 2".into(),
			occurrence: Occurrence::Index(2),
		}])
		.expect("second occurrence");
		assert_eq!(edits.len(), 1);
		assert_eq!(line_for_offset(edits[0].start_byte, source), 2);
	}

	#[test]
	fn apply_patches_occurrence_all() {
		let source = "value = 1\nvalue = 1\nvalue = 1\n";
		let buffer = ts_buffer(source);
		let edits = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "value = 1".into(),
			replace:    "value = 2".into(),
			occurrence: Occurrence::All,
		}])
		.expect("all occurrences");
		assert_eq!(edits.len(), 3);
	}

	#[test]
	fn apply_patches_occurrence_index_out_of_range() {
		let source = "value = 1\nvalue = 1\nvalue = 1\n";
		let buffer = ts_buffer(source);
		let err = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "value = 1".into(),
			replace:    "value = 2".into(),
			occurrence: Occurrence::Index(5),
		}])
		.expect_err("out of range occurrence");
		assert!(err.to_string().contains("occurrence 5 out of range 1..=3"));
	}

	#[test]
	fn apply_patches_falls_back_to_single_line_substring() {
		let source = "(reject candidate \"live effects are prohibited\")\n";
		let buffer = ts_buffer(source);
		let edits = apply_patches(&buffer, 0, source.len(), &[Patch {
			find:       "live effects are prohibited".into(),
			replace:    "side effects are prohibited".into(),
			occurrence: Occurrence::Unique,
		}])
		.expect("substring patch");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].new_text, "side effects are prohibited");
	}
	/// BUG-402 / PLAN-317 W0 — red test.
	///
	/// When the scope is empty (e.g. an empty buffer, or a wrong path
	/// that the kernel created as a fresh empty file), the diagnostic
	/// must name the actual cause and the path, not the misleading
	/// "find text not found in scope. Scope preview:\n" with an empty
	/// preview that wastes the agent's next turn.
	#[test]
	fn find_in_empty_buffer_returns_clear_diagnostic() {
		let buffer = ts_buffer("");
		let err = apply_patches(&buffer, 0, 0, &[Patch {
			find:       "anything".into(),
			replace:    "X".into(),
			occurrence: Occurrence::Unique,
		}])
		.expect_err("empty scope must error");
		let msg = err.to_string();
		assert!(
			msg.contains("scope is empty") || msg.contains("empty buffer"),
			"expected explicit empty-scope diagnostic, got: {msg}"
		);
		assert!(
			!msg.ends_with("Scope preview:\n") && !msg.ends_with("Scope preview:"),
			"must not degrade into the empty Scope preview message: {msg}"
		);
	}


	#[test]
	fn apply_raw_text_patches_preserves_replacement_bytes() {
		let source = "  alpha beta\n";
		let buffer = ts_buffer(source);
		let edits = apply_raw_text_patches(&buffer, 0, source.len(), &[Patch {
			find:       "alpha".into(),
			replace:    "x\ny".into(),
			occurrence: Occurrence::Unique,
		}])
		.expect("raw patch");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].new_text, "x\ny");
	}
}
