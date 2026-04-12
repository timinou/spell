use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	language::{DeclarationPattern, LanguageProfile},
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

	let Some(decl) = declaration_for(profile, node) else {
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
	let Some(class_like) = profile
		.class_like
		.iter()
		.find(|class_like| class_like.node_type == node.kind())
	else {
		return Vec::new();
	};
	let Some(body) = node.child_by_field_name(&class_like.body_field) else {
		return Vec::new();
	};
	let mut cursor = body.walk();
	body
		.named_children(&mut cursor)
		.filter_map(|child| {
			if class_like
				.member_types
				.iter()
				.any(|kind| kind == child.kind())
			{
				entry_for_node(source, profile, child)
			} else {
				None
			}
		})
		.collect()
}

pub(crate) fn declaration_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
) -> Option<&'a DeclarationPattern> {
	profile
		.declarations
		.iter()
		.find(|decl| decl.node_types.iter().any(|kind| kind == node.kind()))
}

pub(crate) fn declaration_name(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<String> {
	if let Some(name_node) = node.child_by_field_name(&decl.name_field) {
		if let Some(inner_name) = name_node.child_by_field_name("name") {
			return text(source, inner_name).map(|value| value.trim().to_string());
		}
		return text(source, name_node).map(|value| value.trim().to_string());
	}

	find_named_descendant(node, "variable_declarator")
		.and_then(|declarator| declarator.child_by_field_name("name"))
		.and_then(|name_node| text(source, name_node))
		.map(|value| value.trim().to_string())
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
	let end_byte = decl
		.body_field
		.as_ref()
		.and_then(|field| {
			node
				.child_by_field_name(field)
				.map(|body| body.start_byte())
		})
		.unwrap_or_else(|| node.end_byte());
	let header = source
		.get(node.start_byte()..end_byte)
		.unwrap_or("")
		.lines()
		.map(str::trim)
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
	fn test_read_resolution_3_range() {
		let buffer = buffer("hello.ts", "typescript");
		let profile = profile("typescript");
		let out = read(&buffer, &profile, 3, Some(1), Some(1));
		assert!(out.contains("export function greet"));
		assert!(!out.contains("class Greeter"));
	}
}
