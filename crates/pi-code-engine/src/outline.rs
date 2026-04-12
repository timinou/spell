use std::fmt::Write;

use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	language::{
		BodyExtractor, ClassBodyExtractor, DeclarationPattern, LanguageProfile, NameExtractor,
	},
	resolve::resolve_symbol,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutlineEntry {
	pub name:      String,
	pub kind:      String,
	pub line:      u32,
	pub end_line:  u32,
	pub column:    u32,
	pub exported:  bool,
	pub signature: String,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub children:  Vec<Self>,
}

pub fn outline(buffer: &CodeBuffer, profile: &LanguageProfile) -> Vec<OutlineEntry> {
	let source = buffer.source();
	let root = buffer.tree().root_node();
	let mut cursor = root.walk();
	root
		.named_children(&mut cursor)
		.filter_map(|node| entry_for_node(&source, profile, node))
		.collect()
}

fn entry_for_node(source: &str, profile: &LanguageProfile, node: Node<'_>) -> Option<OutlineEntry> {
	if node.kind() == "export_statement" {
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			if let Some(entry) = entry_for_node(source, profile, child) {
				return Some(OutlineEntry { exported: true, ..entry });
			}
		}
		return None;
	}

	let Some(decl) = declaration_for(profile, node, source) else {
		return sole_named_child(node).and_then(|child| entry_for_node(source, profile, child));
	};
	let name = declaration_name(source, node, decl)?;
	let signature = signature_text(source, node, decl);
	let start = node.start_position();
	let end = node.end_position();
	let children = class_children(source, profile, node);
	Some(OutlineEntry {
		name,
		kind: decl.kind.clone(),
		line: (start.row + 1) as u32,
		end_line: (end.row + 1) as u32,
		column: start.column as u32,
		exported: is_exported(node, decl),
		signature,
		children,
	})
}

fn sole_named_child(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	let mut children = node.named_children(&mut cursor);
	let child = children.next()?;
	(children.next().is_none()).then_some(child)
}

fn class_children(source: &str, profile: &LanguageProfile, node: Node<'_>) -> Vec<OutlineEntry> {
	class_member_nodes(profile, node, source)
		.into_iter()
		.filter_map(|child| entry_for_node(source, profile, child))
		.collect()
}

pub(crate) fn declaration_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
	source: &str,
) -> Option<&'a DeclarationPattern> {
	profile.declarations.iter().find(|decl| {
		if !decl.node_types.iter().any(|kind| kind == node.kind()) {
			return false;
		}
		if let Some(filter_names) = &decl.filter_names {
			let name_text = match &decl.name {
				NameExtractor::Field { name } => node
					.child_by_field_name(name)
					.and_then(|n| source.get(n.start_byte()..n.end_byte())),
				_ => None,
			};
			return name_text.is_some_and(|t| filter_names.iter().any(|f| f == t));
		}
		true
	})
}

pub(crate) fn declaration_name(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<String> {
	// When name_from_arg is set, extract the display name from the first
	// argument child.  This handles Elixir patterns where the keyword (def,
	// defmodule) sits in `target` but the real name is the first argument.
	if decl.name_from_arg {
		let args = child_by_field_or_kind(node, "arguments")?;
		let mut cursor = args.walk();
		let first = args.named_children(&mut cursor).next()?;
		// If the first arg is itself a call (e.g. `def start_link(opts)`) use its
		// target.
		if let Some(target) = first.child_by_field_name("target") {
			return text(source, target).map(|v| v.trim().to_string());
		}
		// Otherwise use the full text (e.g. `defmodule MyApp.Server`).
		return text(source, first).map(|v| v.trim().to_string());
	}

	match &decl.name {
		NameExtractor::Field { name } => {
			if let Some(name_node) = node.child_by_field_name(name) {
				if let Some(inner_name) = name_node.child_by_field_name("name") {
					return text(source, inner_name).map(|value| value.trim().to_string());
				}
				return text(source, name_node).map(|value| value.trim().to_string());
			}

			find_named_descendant(node, "variable_declarator")
				.and_then(|declarator| declarator.child_by_field_name("name"))
				.and_then(|name_node| text(source, name_node))
				.map(|value| value.trim().to_string())
		},
		NameExtractor::ChildField { child_type, field } => find_named_child(node, child_type)
			.and_then(|child| child.child_by_field_name(field))
			.and_then(|name_node| text(source, name_node))
			.map(|value| value.trim().to_string()),
		NameExtractor::ChildText { child_type } => find_named_child(node, child_type)
			.or_else(|| find_named_descendant(node, child_type))
			.and_then(|child| text(source, child))
			.map(|value| value.trim().to_string()),
		NameExtractor::Literal { name } => Some(name.clone()),
	}
}

/// Try `child_by_field_name(name)` first; fall back to first named child
/// with `kind() == name`.  Needed for tree-sitter grammars that use
/// positional (unnamed) children (e.g. `do_block` and `arguments` in Elixir).
pub(crate) fn child_by_field_or_kind<'a>(node: Node<'a>, name: &str) -> Option<Node<'a>> {
	if let Some(child) = node.child_by_field_name(name) {
		return Some(child);
	}
	find_named_child(node, name)
}
fn find_named_child<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	node
		.named_children(&mut cursor)
		.find(|child| child.kind() == kind)
}

pub(crate) fn declaration_body_range(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<(usize, usize)> {
	match &decl.body {
		BodyExtractor::None => None,
		BodyExtractor::Field { name } => {
			child_by_field_or_kind(node, name).map(|body| (body.start_byte(), body.end_byte()))
		},
		BodyExtractor::AfterChild { child_type } => find_named_child(node, child_type).map(|child| {
			let mut start = child.end_byte();
			if let Some(rest) = source.get(start..) {
				if rest.starts_with("\r\n") {
					start += 2;
				} else if rest.starts_with('\n') {
					start += 1;
				}
			}
			(start, node.end_byte())
		}),
	}
}

pub(crate) fn class_member_nodes<'a>(
	profile: &LanguageProfile,
	node: Node<'a>,
	source: &str,
) -> Vec<Node<'a>> {
	let Some(class_like) = profile.class_like.iter().find(|cl| {
		if cl.node_type != node.kind() {
			return false;
		}
		// Apply filter_field / filter_names when set (e.g. Elixir defmodule).
		if let (Some(filter_field), Some(filter_names)) = (&cl.filter_field, &cl.filter_names) {
			let field_text = node
				.child_by_field_name(filter_field)
				.and_then(|n| source.get(n.start_byte()..n.end_byte()));
			return field_text.is_some_and(|t| filter_names.iter().any(|f| f == t));
		}
		true
	}) else {
		return Vec::new();
	};

	match &class_like.body {
		ClassBodyExtractor::Field { name } => {
			let Some(body) = child_by_field_or_kind(node, name) else {
				return Vec::new();
			};
			let mut cursor = body.walk();
			body
				.named_children(&mut cursor)
				.filter(|child| {
					class_like
						.member_types
						.iter()
						.any(|kind| kind == child.kind())
				})
				.collect()
		},
		ClassBodyExtractor::Direct => {
			let mut cursor = node.walk();
			node
				.named_children(&mut cursor)
				.filter(|child| {
					class_like
						.member_types
						.iter()
						.any(|kind| kind == child.kind())
				})
				.collect()
		},
	}
}

fn find_named_descendant<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if child.kind() == kind {
			return Some(child);
		}
		if let Some(found) = find_named_descendant(child, kind) {
			return Some(found);
		}
	}
	None
}

fn signature_text(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> String {
	let end_byte = declaration_body_range(source, node, decl)
		.map_or_else(|| node.end_byte(), |(start_byte, _)| start_byte);
	let header = source
		.get(node.start_byte()..end_byte)
		.unwrap_or("")
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join(" ");
	truncate(&header, 200)
}

fn truncate(text: &str, max_chars: usize) -> String {
	text.chars().take(max_chars).collect()
}

fn text<'a>(source: &'a str, node: Node<'a>) -> Option<&'a str> {
	source.get(node.start_byte()..node.end_byte())
}

fn is_exported(node: Node<'_>, decl: &DeclarationPattern) -> bool {
	node
		.parent()
		.is_some_and(|parent| parent.kind() == "export_statement")
		|| decl
			.visibility
			.as_ref()
			.and_then(|field| node.child_by_field_name(field))
			.is_some()
}

pub fn read(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	resolution: u8,
	offset: Option<u32>,
	limit: Option<u32>,
) -> String {
	let source = buffer.source();
	if profile.id.as_str() == "markdown" && resolution <= 2 {
		return read_markdown(buffer, profile, resolution);
	}
	match resolution {
		0 => outline(buffer, profile)
			.into_iter()
			.map(|entry| format!("{} ({})", entry.name, entry.kind))
			.collect::<Vec<_>>()
			.join("\n"),
		1 => render_outline(&outline(buffer, profile), false, 0),
		2 => render_outline(&outline(buffer, profile), true, 0),
		_ => slice_source(&source, offset, limit),
	}
}

fn exact_node_for_range(buffer: &CodeBuffer, start: usize, end: usize) -> Option<Node<'_>> {
	let mut node = buffer
		.tree()
		.root_node()
		.named_descendant_for_byte_range(start, end)
		.or_else(|| {
			buffer
				.tree()
				.root_node()
				.descendant_for_byte_range(start, end)
		})?;
	loop {
		if node.start_byte() == start && node.end_byte() == end {
			return Some(node);
		}
		node = node.parent()?;
	}
}

fn markdown_code_language(source: &str, node: Node<'_>) -> Option<String> {
	let info = find_named_child(node, "info_string")?;
	if let Some(language) = find_named_child(info, "language") {
		return text(source, language).map(str::to_string);
	}
	text(source, info)
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
}

fn markdown_annotation(source: &str, node: Node<'_>, has_children: bool) -> String {
	let mut paragraphs = 0usize;
	let mut code_blocks = 0usize;
	let mut code_languages = Vec::new();
	let mut lists = 0usize;
	let mut tables = 0usize;
	let mut block_quotes = 0usize;
	let mut html_blocks = 0usize;
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		match child.kind() {
			"atx_heading" | "section" | "setext_heading" | "block_continuation" => {},
			"paragraph" => paragraphs += 1,
			"fenced_code_block" => {
				code_blocks += 1;
				if let Some(language) = markdown_code_language(source, child)
					&& !code_languages.iter().any(|existing| existing == &language)
				{
					code_languages.push(language);
				}
			},
			"indented_code_block" => code_blocks += 1,
			"list" => lists += 1,
			"pipe_table" => tables += 1,
			"block_quote" => block_quotes += 1,
			"html_block" => html_blocks += 1,
			_ => {},
		}
	}
	let mut parts = Vec::new();
	if paragraphs > 0 {
		parts.push(format!(
			"{} {}",
			paragraphs,
			if paragraphs == 1 {
				"paragraph"
			} else {
				"paragraphs"
			}
		));
	}
	if code_blocks > 0 {
		let mut label = format!(
			"{} {}",
			code_blocks,
			if code_blocks == 1 {
				"code block"
			} else {
				"code blocks"
			}
		);
		if !code_languages.is_empty() {
			let _ = write!(label, " ({})", code_languages.join(", "));
		}
		parts.push(label);
	}
	if lists > 0 {
		parts.push(format!("{} {}", lists, if lists == 1 { "list" } else { "lists" }));
	}
	if tables > 0 {
		parts.push(format!("{} {}", tables, if tables == 1 { "table" } else { "tables" }));
	}
	if block_quotes > 0 {
		parts.push(format!(
			"{} {}",
			block_quotes,
			if block_quotes == 1 {
				"block quote"
			} else {
				"block quotes"
			}
		));
	}
	if html_blocks > 0 {
		parts.push(format!(
			"{} {}",
			html_blocks,
			if html_blocks == 1 {
				"HTML block"
			} else {
				"HTML blocks"
			}
		));
	}
	if parts.is_empty() {
		return if has_children {
			"(subsections only)".into()
		} else {
			"(empty)".into()
		};
	}
	truncate(&parts.join(", "), 120)
}

fn read_markdown(buffer: &CodeBuffer, profile: &LanguageProfile, resolution: u8) -> String {
	let entries = outline(buffer, profile);
	match resolution {
		0 => entries
			.into_iter()
			.map(|entry| format!("{} ({})", entry.name, entry.kind))
			.collect::<Vec<_>>()
			.join("\n"),
		1 => render_outline(&entries, true, 0),
		2 => render_markdown_entries(buffer, profile, &entries, 0, None),
		_ => unreachable!(),
	}
}

fn render_markdown_entries(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	entries: &[OutlineEntry],
	indent: usize,
	parent_path: Option<&str>,
) -> String {
	let mut lines = Vec::new();
	for entry in entries {
		let indent_str = "  ".repeat(indent);
		if entry.kind == "frontmatter" {
			let label = match resolve_symbol(buffer, profile, "frontmatter")
				.ok()
				.and_then(|resolved| {
					exact_node_for_range(buffer, resolved.start_byte, resolved.end_byte)
				})
				.map(|node| node.kind().to_string())
				.as_deref()
			{
				Some("minus_metadata") => "frontmatter (yaml)",
				Some("plus_metadata") => "frontmatter (toml)",
				_ => "frontmatter",
			};
			lines.push(format!("{indent_str}{label}"));
			continue;
		}
		let symbol_path = parent_path
			.map_or_else(|| entry.name.clone(), |parent| format!("{parent}.{}", entry.name));
		lines.push(format!(
			"{indent_str}{} (lines {}-{})",
			entry.signature, entry.line, entry.end_line
		));
		if let Ok(resolved) = resolve_symbol(buffer, profile, &symbol_path)
			&& let Some(node) = exact_node_for_range(buffer, resolved.start_byte, resolved.end_byte)
		{
			lines.push(format!(
				"{indent_str}  {}",
				markdown_annotation(&buffer.source(), node, !entry.children.is_empty())
			));
		}
		let hint = if symbol_path.split('.').count() > 2 {
			format!(
				"> code read {{ symbol: \"{symbol_path}\", resolution: 3 }} (use line offset instead)"
			)
		} else {
			format!("> code read {{ symbol: \"{symbol_path}\", resolution: 3 }}")
		};
		lines.push(format!("{indent_str}  {hint}"));
		if !entry.children.is_empty() {
			lines.push(render_markdown_entries(
				buffer,
				profile,
				&entry.children,
				indent + 1,
				Some(&symbol_path),
			));
		}
	}
	lines.join("\n")
}

fn render_outline(entries: &[OutlineEntry], show_children: bool, indent: usize) -> String {
	let mut lines = Vec::new();
	for entry in entries {
		lines.push(format!("{}{}", "  ".repeat(indent), entry.signature));
		if show_children && !entry.children.is_empty() {
			lines.push(render_outline(&entry.children, true, indent + 1));
		}
	}
	lines
		.into_iter()
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join("\n")
}

fn slice_source(source: &str, offset: Option<u32>, limit: Option<u32>) -> String {
	let start = offset.unwrap_or(1).saturating_sub(1) as usize;
	let len = limit.map_or(usize::MAX, |l| l as usize);
	source
		.lines()
		.skip(start)
		.take(len)
		.collect::<Vec<_>>()
		.join("\n")
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

	use super::*;
	use crate::{
		CodeBuffer,
		language::{LanguageId, LanguageRegistry},
	};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn fixture_path(name: &str) -> String {
		format!("{}/tests/fixtures/sources/{name}", env!("CARGO_MANIFEST_DIR"))
	}

	fn profile(language: &str) -> LanguageProfile {
		registry()
			.get(&LanguageId::new(language))
			.expect("profile")
			.clone()
	}

	fn buffer(name: &str, language: &str) -> CodeBuffer {
		CodeBuffer::from_str(
			&fs::read_to_string(fixture_path(name)).expect("fixture"),
			LanguageId::new(language),
			registry(),
		)
		.expect("buffer")
	}

	#[test]
	fn test_outline_typescript() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let entries = outline(&buffer, &profile);
		assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec![
			"greet", "Greeter"
		]);
		assert_eq!(entries[0].kind, "function");
		assert_eq!(entries[1].kind, "class");
	}

	#[test]
	fn test_outline_typst_code_wrappers() {
		let buffer = buffer("hello.typ", "typst");
		let profile = profile("typst");
		let entries = outline(&buffer, &profile);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["\"theme.typ\"", "title", "heading.where(level: 1)"]
		);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.kind.as_str())
				.collect::<Vec<_>>(),
			vec!["import", "let", "show"]
		);
	}

	#[test]
	fn test_outline_children() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let entries = outline(&buffer, &profile);
		assert_eq!(
			entries[1]
				.children
				.iter()
				.map(|e| e.name.as_str())
				.collect::<Vec<_>>(),
			vec!["constructor", "greet"]
		);
	}

	#[test]
	fn test_read_resolution_0() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains("greet (function)"));
		assert!(out.contains("Greeter (class)"));
	}

	#[test]
	fn test_read_resolution_0_typst() {
		let buffer = buffer("hello.typ", "typst");
		let profile = profile("typst");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains("\"theme.typ\" (import)"));
		assert!(out.contains("title (let)"));
		assert!(out.contains("heading.where(level: 1) (show)"));
	}

	#[test]
	fn test_outline_markdown_sections() {
		let buffer = buffer("hello.md", "markdown");
		let profile = profile("markdown");
		let entries = outline(&buffer, &profile);
		assert_eq!(
			entries
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["frontmatter", "Introduction", "Installation", "API Reference"]
		);
		assert_eq!(
			entries[2]
				.children
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["Prerequisites", "Steps"]
		);
		assert_eq!(
			entries[3]
				.children
				.iter()
				.map(|entry| entry.name.as_str())
				.collect::<Vec<_>>(),
			vec!["Authentication"]
		);
	}

	#[test]
	fn test_read_resolution_2_markdown() {
		let buffer = buffer("hello.md", "markdown");
		let profile = profile("markdown");
		let out = read(&buffer, &profile, 2, None, None);
		assert!(out.contains("frontmatter (yaml)"), "should render frontmatter label: {out}");
		assert!(
			out.contains("# Installation (lines"),
			"should include section signature + lines: {out}"
		);
		assert!(out.contains("1 paragraph"), "should annotate direct section content: {out}");
		assert!(
			out.contains("1 code block (bash), 1 list"),
			"should include nested code/list annotation: {out}"
		);
		assert!(
			out.contains("Installation.Prerequisites"),
			"should include nested symbol hint: {out}"
		);
		assert!(out.contains("## Steps (lines"), "should render nested headings: {out}");
	}

	#[test]
	fn test_outline_elixir() {
		let buffer = buffer("hello.ex", "elixir");
		let profile = profile("elixir");
		let entries = outline(&buffer, &profile);
		// Only defmodule should appear as top-level
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].name, "MyApp.Greeter");
		assert_eq!(entries[0].kind, "module");
	}

	#[test]
	fn test_outline_elixir_children() {
		let buffer = buffer("hello.ex", "elixir");
		let profile = profile("elixir");
		let entries = outline(&buffer, &profile);
		let children = &entries[0].children;
		assert_eq!(children.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec![
			"start_link",
			"greet",
			"internal_helper",
			"my_macro"
		]);
		assert_eq!(children.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec![
			"def", "def", "defp", "macro"
		]);
	}

	#[test]
	fn test_read_resolution_0_elixir() {
		let buffer = buffer("hello.ex", "elixir");
		let profile = profile("elixir");
		let out = read(&buffer, &profile, 0, None, None);
		assert!(out.contains("MyApp.Greeter (module)"), "got: {out}");
	}

	#[test]
	fn test_read_resolution_3_range() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let out = read(&buffer, &profile, 3, Some(1), Some(1));
		assert!(out.contains("export function greet"));
		assert!(!out.contains("class Greeter"));
	}
}
