use crate::{
	TextEdit,
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	resolve::{ResolvedSymbol, collect_top_level_decls_in_range},
};

#[derive(Debug, Clone, Copy, Default)]
pub struct ReplacePolicy {
	pub allow_sibling_delete: bool,
}

/// Replace only the body of a declaration, keeping its signature.
///
/// The `content` is the new body text **including braces**: `{ ... }`.
/// Indentation is adjusted to match the original body's indent level.
pub fn replace_body(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	content: &str,
	policy: ReplacePolicy,
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

	guard_sibling_deletion(buffer, body_start, body_end, &adjusted, policy)?;

	Ok(vec![TextEdit { start_byte: body_start, old_end_byte: body_end, new_text: adjusted }])
}

pub fn replace_body_safe(
	buffer: &CodeBuffer,
	resolved: &ResolvedSymbol,
	content: &str,
) -> Result<Vec<TextEdit>> {
	replace_body(buffer, resolved, content, ReplacePolicy::default())
}

fn guard_sibling_deletion(
	buffer: &CodeBuffer,
	body_start: usize,
	body_end: usize,
	replacement: &str,
	policy: ReplacePolicy,
) -> Result<()> {
	let original_decls = collect_top_level_decls_in_range(buffer, body_start, body_end);
	if original_decls.len() < 2 {
		return Ok(());
	}

	let retained: Vec<String> = original_decls
		.iter()
		.filter(|name| replacement.contains(name.as_str()))
		.cloned()
		.collect();
	if retained.len() == original_decls.len() || policy.allow_sibling_delete {
		return Ok(());
	}

	let lost_decls = original_decls
		.iter()
		.filter(|name| !retained.iter().any(|retained_name| retained_name == *name))
		.cloned()
		.collect();
	Err(CodeEngineError::UnsafeScopeWrite {
		action: "write{scope:'body'}".into(),
		lost_decls,
		original: original_decls.len(),
		new: retained.len(),
	})
}

fn adjust_indent(text: &str, original_col: usize, target_col: usize) -> String {
	let mut out = String::with_capacity(text.len());
	for (idx, line) in text.lines().enumerate() {
		if idx > 0 {
			out.push('\n');
		}
		if idx == 0 || line.trim().is_empty() {
			out.push_str(line);
			continue;
		}
		if target_col >= original_col {
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

	fn elixir_buffer() -> CodeBuffer {
		let source = r#"defmodule BigModule do
  @moduledoc false

  def alpha(assigns) do
    assigns
    |> Map.put(:title, "Alpha")
    |> Map.update(:items, [], fn items ->
      Enum.map(items, fn item -> %{id: item.id, status: :ready} end)
    end)
  end

  def beta(assigns) do
    [assigns.locale, assigns.region]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(":")
  end

  def gamma(rows) do
    rows
    |> Enum.chunk_every(2)
    |> Enum.map(fn chunk -> Enum.map(chunk, & &1.id) end)
  end

  def delta(data) do
    %{total: length(data), active: Enum.count(data, & &1.active?)}
  end
end
"#;
		CodeBuffer::from_str(source, LanguageId::new("elixir"), registry()).expect("buffer")
	}

	fn profile(language: &str) -> crate::language::LanguageProfile {
		registry().get(&LanguageId::new(language)).unwrap().clone()
	}

	#[test]
	fn replace_body_simple() {
		let source = "function add(a: number, b: number): number {\n  return a + b;\n}";
		let buffer = ts_buffer(source);
		let resolved = resolve_symbol(&buffer, &profile("typescript"), "add").unwrap();
		let edits = replace_body_safe(&buffer, &resolved, "{\n  return a * b;\n}").unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("return a * b"));
		assert!(edits[0].start_byte > 0);
	}

	#[test]
	fn replace_body_class_method() {
		let source = "class Foo {\n  bar() { return 1; }\n}";
		let buffer = ts_buffer(source);
		let resolved = resolve_symbol(&buffer, &profile("typescript"), "Foo.bar").unwrap();
		let edits = replace_body_safe(&buffer, &resolved, "{ return 42; }").unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("42"));
	}

	#[test]
	fn replace_body_no_body_errors() {
		let source = "type X = string;";
		let buffer = ts_buffer(source);
		let resolved = resolve_symbol(&buffer, &profile("typescript"), "X").unwrap();
		let err = replace_body_safe(&buffer, &resolved, "{ ... }").unwrap_err();
		assert!(err.to_string().contains("no body"));
	}

	#[test]
	fn replace_body_multiline_indent() {
		let source = "function greet(name: string) {\n  const greeting = \"Hello\";\n  return \
		              greeting + \" \" + name;\n}";
		let buffer = ts_buffer(source);
		let resolved = resolve_symbol(&buffer, &profile("typescript"), "greet").unwrap();
		let edits = replace_body_safe(&buffer, &resolved, "{\n  return `Hello ${name}`;\n}").unwrap();
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("Hello ${name}"));
	}

	#[test]
	fn replace_body_refuses_large_sibling_deletion_without_opt_in() {
		let buffer = elixir_buffer();
		let resolved = resolve_symbol(&buffer, &profile("elixir"), "BigModule").unwrap();
		let err = replace_body_safe(&buffer, &resolved, "do\n  def alpha, do: :updated\nend")
			.expect_err("should refuse dropping sibling defs");
		match err {
			CodeEngineError::UnsafeScopeWrite { lost_decls, original, new, .. } => {
				assert_eq!(original, 4);
				assert_eq!(new, 1);
				assert_eq!(lost_decls, vec!["beta", "gamma", "delta"]);
			},
			other => panic!("expected UnsafeScopeWrite, got {other:?}"),
		}
	}

	#[test]
	fn replace_body_allows_large_delete_with_force() {
		let buffer = elixir_buffer();
		let resolved = resolve_symbol(&buffer, &profile("elixir"), "BigModule").unwrap();
		let edits =
			replace_body(&buffer, &resolved, "do\n  def alpha, do: :updated\nend", ReplacePolicy {
				allow_sibling_delete: true,
			})
			.expect("force allow sibling deletion");
		assert_eq!(edits.len(), 1);
		assert!(edits[0].new_text.contains("updated"));
	}

	#[test]
	fn replace_body_allows_proportional_shrink() {
		let source = "function add(a: number, b: number) {\n  const sum = a + b;\n  return sum;\n}";
		let buffer = ts_buffer(source);
		let resolved = resolve_symbol(&buffer, &profile("typescript"), "add").unwrap();
		let edits =
			replace_body_safe(&buffer, &resolved, "{\n  return a + b;\n}").expect("shrink body");
		assert_eq!(edits.len(), 1);
	}
}
