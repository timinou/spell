use super::{TextEdit, indent::adjust_indent};
use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	line_target::resolve_edit_target,
	resolve::ResolvedSymbol,
};

#[derive(Debug, Clone)]
pub(super) struct StandaloneSiblingBoundary {
	pub indent_col:   usize,
	pub indent_str:   String,
	pub after_end:    usize,
	pub after_suffix: String,
}

fn make_result(start: usize, end: usize, content: String) -> Vec<TextEdit> {
	vec![TextEdit { start_byte: start, old_end_byte: end, new_text: content }]
}

fn ensure_insert_before_separator(line: usize, content: &str) -> Result<()> {
	if content.ends_with('\n') || content.ends_with("\r\n") {
		return Ok(());
	}

	Err(CodeEngineError::Edit(format!(
		"Unsafe line-target insert-before at line {line}: inserted content must end with a newline \
		 to create a sibling-safe boundary. Re-anchor to a declaration/symbol or include an \
		 explicit separator.",
	)))
}

fn ensure_insert_after_separator(line: usize, content: &str) -> Result<()> {
	if content.starts_with('\n') || content.starts_with("\r\n") {
		return Ok(());
	}

	Err(CodeEngineError::Edit(format!(
		"Unsafe line-target insert-after at line {line}: inserted content must start with a newline \
		 to create a sibling-safe boundary. Re-anchor to a declaration/symbol or include an \
		 explicit separator.",
	)))
}

fn line_start(source: &str, byte: usize) -> usize {
	source[..byte].rfind('\n').map_or(0, |idx| idx + 1)
}

fn leading_whitespace_width(line: &str) -> usize {
	line
		.chars()
		.take_while(|ch| *ch == ' ' || *ch == '\t')
		.map(char::len_utf8)
		.sum()
}

fn strip_indent(line: &str, width: usize) -> &str {
	let mut consumed = 0;
	let mut idx = 0;
	for ch in line.chars() {
		if (ch != ' ' && ch != '\t') || consumed >= width {
			break;
		}
		consumed += ch.len_utf8();
		idx += ch.len_utf8();
	}
	&line[idx..]
}

fn dedent_common_indent(text: &str) -> String {
	let common = text
		.lines()
		.filter(|line| !line.trim().is_empty())
		.map(leading_whitespace_width)
		.min()
		.unwrap_or(0);
	text
		.lines()
		.map(|line| strip_indent(line, common))
		.collect::<Vec<_>>()
		.join("\n")
}

pub(super) fn normalize_sibling_content(content: &str, target_indent: usize) -> Result<String> {
	let trimmed = content.trim_matches(|ch| ch == '\n' || ch == '\r');
	if trimmed.is_empty() {
		return Err(CodeEngineError::Edit("Inserted content must not be empty".into()));
	}
	let dedented = dedent_common_indent(trimmed);
	Ok(adjust_indent(&dedented, 0, target_indent))
}

pub(super) fn standalone_sibling_boundary(
	source: &str,
	start_byte: usize,
	end_byte: usize,
	line: usize,
	action: &str,
) -> Result<StandaloneSiblingBoundary> {
	let start_of_line = line_start(source, start_byte);
	let indent_str = source[start_of_line..start_byte].to_string();
	if !indent_str.chars().all(|ch| ch == ' ' || ch == '\t') {
		return Err(CodeEngineError::Edit(format!(
			"Unsafe {action} at line {line}: target starts on a shared boundary line. Re-anchor to a \
			 whole sibling declaration or widen the replace span.",
		)));
	}

	let tail = &source[end_byte..];
	if tail.is_empty() {
		return Ok(StandaloneSiblingBoundary {
			indent_col: indent_str.len(),
			indent_str,
			after_end: end_byte,
			after_suffix: String::new(),
		});
	}

	let mut saw_newline = false;
	let mut after_end = source.len();
	for (offset, ch) in tail.char_indices() {
		match ch {
			' ' | '\t' => {},
			'\n' | '\r' => saw_newline = true,
			_ if !saw_newline => {
				return Err(CodeEngineError::Edit(format!(
					"Unsafe {action} at line {line}: target ends on a shared boundary line. Re-anchor \
					 to a whole sibling declaration or widen the replace span.",
				)));
			},
			_ => {
				after_end = end_byte + offset;
				break;
			},
		}
	}

	let boundary_gap = &source[end_byte..after_end];
	let after_suffix = boundary_gap
		.rsplit_once('\n')
		.map_or(String::new(), |(_, tail)| tail.to_string());

	Ok(StandaloneSiblingBoundary {
		indent_col: indent_str.len(),
		indent_str,
		after_end,
		after_suffix,
	})
}

fn expanded_symbol_boundary(
	buffer: &CodeBuffer,
	symbol: &ResolvedSymbol,
) -> Result<(usize, usize, usize)> {
	let target_end = symbol.end_byte.saturating_sub(1);
	let mut node = buffer
		.tree()
		.root_node()
		.named_descendant_for_byte_range(symbol.start_byte, target_end)
		.ok_or_else(|| {
			CodeEngineError::Edit(format!(
				"Unable to resolve declaration boundary for {}",
				symbol.name
			))
		})?;
	while node.start_byte() != symbol.start_byte || node.end_byte() != symbol.end_byte {
		node = node.parent().ok_or_else(|| {
			CodeEngineError::Edit(format!(
				"Unable to resolve declaration boundary for {}",
				symbol.name
			))
		})?;
	}
	while let Some(parent) = node.parent() {
		if parent.start_position().row != node.start_position().row
			|| parent.end_position().row != node.end_position().row
		{
			break;
		}
		let mut cursor = parent.walk();
		let mut children = parent.named_children(&mut cursor);
		let Some(first) = children.next() else {
			break;
		};
		if first.id() != node.id() || children.next().is_some() {
			break;
		}
		node = parent;
	}
	Ok((node.start_byte(), node.end_byte(), node.start_position().row + 1))
}

pub fn replace_node(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type, within)?;
	Ok(make_result(target.start_byte(), target.end_byte(), content.to_string()))
}

pub fn insert_before(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	ensure_insert_before_separator(line, content)?;
	let target = resolve_edit_target(buffer, line, node_type, within)?;
	Ok(make_result(target.start_byte(), target.start_byte(), content.to_string()))
}

pub fn insert_after(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	content: &str,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	ensure_insert_after_separator(line, content)?;
	let target = resolve_edit_target(buffer, line, node_type, within)?;
	Ok(make_result(target.end_byte(), target.end_byte(), content.to_string()))
}

pub fn insert_before_symbol(
	buffer: &CodeBuffer,
	symbol: &ResolvedSymbol,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let (start_byte, end_byte, line) = expanded_symbol_boundary(buffer, symbol)?;
	let boundary = standalone_sibling_boundary(
		&source,
		start_byte,
		end_byte,
		line,
		"symbol-target insert-before",
	)?;
	let normalized = normalize_sibling_content(content, boundary.indent_col)?;
	Ok(make_result(start_byte, start_byte, format!("{normalized}\n{}", boundary.indent_str)))
}

pub fn insert_after_symbol(
	buffer: &CodeBuffer,
	symbol: &ResolvedSymbol,
	content: &str,
) -> Result<Vec<TextEdit>> {
	let source = buffer.source();
	let (start_byte, end_byte, line) = expanded_symbol_boundary(buffer, symbol)?;
	let boundary = standalone_sibling_boundary(
		&source,
		start_byte,
		end_byte,
		line,
		"symbol-target insert-after",
	)?;
	let normalized = normalize_sibling_content(content, boundary.indent_col)?;
	Ok(make_result(
		end_byte,
		boundary.after_end,
		format!("\n{}{}\n{}", boundary.indent_str, normalized, boundary.after_suffix),
	))
}

pub fn kill_node(
	buffer: &CodeBuffer,
	line: usize,
	node_type: &str,
	within: Option<(usize, usize)>,
) -> Result<Vec<TextEdit>> {
	let target = resolve_edit_target(buffer, line, node_type, within)?;
	Ok(make_result(target.start_byte(), target.end_byte(), String::new()))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::{
		buffer::CodeBuffer,
		language::{LanguageId, LanguageRegistry},
		resolve::ByteRange,
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn ts_buffer(source: &str) -> CodeBuffer {
		CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	fn symbol(source: &str, name: &str) -> ResolvedSymbol {
		let start = source.find(name).expect("start");
		let end = source[start..]
			.find("\n}\n")
			.map_or(source.len(), |idx| start + idx + 3);
		ResolvedSymbol {
			name:               name.to_string(),
			kind:               "declaration".into(),
			start_byte:         start,
			end_byte:           end,
			line:               source[..start].matches('\n').count() as u32 + 1,
			end_line:           source[..end].matches('\n').count() as u32 + 1,
			body_start_byte:    None,
			body_end_byte:      None,
			identifier_range:   ByteRange { start, end },
			declaration_range:  ByteRange { start, end },
			statement_range:    ByteRange { start, end },
		}
	}

	#[test]
	fn insert_before_symbol_auto_normalizes_multiline_content() {
		let source = "export function beta() {\n  return \"beta\";\n}\n";
		let mut buffer = ts_buffer(source);
		let edits = insert_before_symbol(
			&buffer,
			&symbol(source, "export function beta() {"),
			"export function alpha() {\n  return \"alpha\";\n}",
		)
		.expect("insert before symbol");
		buffer.edit_batch(edits).expect("edit batch");
		assert_eq!(
			buffer.source(),
			"export function alpha() {\n  return \"alpha\";\n}\nexport function beta() {\n  return \
			 \"beta\";\n}\n",
		);
	}

	#[test]
	fn insert_after_symbol_preserves_trailing_closer_boundary() {
		let source = "class Foo {\n  bar() { return 1; }\n}\n";
		let mut buffer = ts_buffer(source);
		let start = source.find("bar() { return 1; }").expect("bar");
		let end = start + "bar() { return 1; }".len();
		let edits = insert_after_symbol(
			&buffer,
			&ResolvedSymbol {
				name:               "Foo.bar".into(),
				kind:               "method".into(),
				start_byte:         start,
				end_byte:           end,
				line:               2,
				end_line:           2,
				body_start_byte:    None,
				body_end_byte:      None,
				identifier_range:   ByteRange { start, end },
				declaration_range:  ByteRange { start, end },
				statement_range:    ByteRange { start, end },
			},
			"baz() { return 2; }",
		)
		.expect("insert after symbol");
		buffer.edit_batch(edits).expect("edit batch");
		assert_eq!(buffer.source(), "class Foo {\n  bar() { return 1; }\n  baz() { return 2; }\n}\n",);
	}

	#[test]
	fn insert_after_symbol_rejects_shared_boundary_lines() {
		let source = "class Foo { bar() { return 1; } baz() { return 2; } }\n";
		let buffer = ts_buffer(source);
		let start = source.find("bar() { return 1; }").expect("bar");
		let end = start + "bar() { return 1; }".len();
		let err = insert_after_symbol(
			&buffer,
			&ResolvedSymbol {
				name:               "Foo.bar".into(),
				kind:               "method".into(),
				start_byte:         start,
				end_byte:           end,
				line:               1,
				end_line:           1,
				body_start_byte:    None,
				body_end_byte:      None,
				identifier_range:   ByteRange { start, end },
				declaration_range:  ByteRange { start, end },
				statement_range:    ByteRange { start, end },
			},
			"qux() { return 3; }",
		)
		.expect_err("shared boundary should refuse");
		assert!(
			err.to_string()
				.contains("Unsafe symbol-target insert-after")
		);
	}
}
