#![allow(
	clippy::collapsible_if,
	clippy::doc_markdown,
	clippy::map_unwrap_or,
	clippy::uninlined_format_args,
	reason = "pre-existing style lint debt outside PLAN-205 behavior changes"
)]

use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	language::LanguageProfile,
	outline::{class_member_nodes, declaration_body_range, declaration_for, declaration_name},
};

/// Resolved symbol with byte range and optional body range.
#[derive(Debug, Clone)]
pub struct ResolvedSymbol {
	pub name:            String,
	pub kind:            String,
	pub start_byte:      usize,
	pub end_byte:        usize,
	pub line:            u32,
	pub end_line:        u32,
	pub body_start_byte: Option<usize>,
	pub body_end_byte:   Option<usize>,
}

/// Resolve a symbol by name within a buffer.
///
/// Supports dotted names for class members: `"ClassName.methodName"`.
/// Only two-level dotting is supported (container.member).
pub fn resolve_symbol(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	symbol: &str,
) -> Result<ResolvedSymbol> {
	let parts: Vec<&str> = symbol.split('.').collect();
	if parts.is_empty() || parts.len() > 2 {
		return Err(CodeEngineError::Edit(format!(
			"Symbol '{}' must be a name or Container.member (at most 2 levels)",
			symbol
		)));
	}

	let source = buffer.source();
	let root = buffer.tree().root_node();
	let mut cursor = root.walk();
	let top_name = parts[0];

	// Collect all top-level matches (unwrapping export_statement wrappers)
	let mut matches: Vec<Node<'_>> = Vec::new();
	for child in root.named_children(&mut cursor) {
		if let Some(node) = match_declaration(child, profile, top_name, &source) {
			matches.push(node);
		}
	}

	if matches.is_empty() {
		let available = collect_top_level_names(root, profile, &source);
		return Err(CodeEngineError::Edit(format!(
			"Symbol '{}' not found. Available: [{}]",
			top_name,
			available.join(", ")
		)));
	}
	if matches.len() > 1 {
		let lines: Vec<String> = matches
			.iter()
			.map(|n| (n.start_position().row + 1).to_string())
			.collect();
		return Err(CodeEngineError::Edit(format!(
			"Ambiguous symbol '{}': found at lines {}",
			top_name,
			lines.join(", ")
		)));
	}

	let node = matches[0];

	if parts.len() == 1 {
		return Ok(build_resolved(node, profile, &source));
	}

	// Dotted: resolve member within a class-like container
	let member_name = parts[1];
	resolve_member(node, profile, &source, top_name, member_name)
}

fn match_declaration<'a>(
	node: Node<'a>,
	profile: &LanguageProfile,
	name: &str,
	source: &str,
) -> Option<Node<'a>> {
	let inner = unwrap_export(node);
	if let Some(decl) = declaration_for(profile, inner) {
		if let Some(decl_name) = declaration_name(source, inner, decl) {
			if decl_name == name {
				return Some(inner);
			}
		}
		// Even if name didn't match, don't fall through to sole_named_child
		// for recognized declarations
		return None;
	}
	// For unrecognized nodes, try sole_named_child
	let mut cursor = inner.walk();
	let mut children = inner.named_children(&mut cursor);
	let child = children.next()?;
	if children.next().is_some() {
		return None;
	}
	match_declaration(child, profile, name, source)
}

/// Unwrap export_statement to get the inner declaration node.
fn unwrap_export(node: Node<'_>) -> Node<'_> {
	if node.kind() == "export_statement" {
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			if child.kind() != "export_statement" {
				return child;
			}
		}
	}
	node
}

/// Build a ResolvedSymbol from a declaration node.
fn build_resolved(node: Node<'_>, profile: &LanguageProfile, source: &str) -> ResolvedSymbol {
	let decl = declaration_for(profile, node);
	let name = decl
		.and_then(|d| declaration_name(source, node, d))
		.unwrap_or_default();
	let kind = decl.map(|d| d.kind.clone()).unwrap_or_default();

	let (body_start, body_end) = decl
		.and_then(|d| declaration_body_range(node, d))
		.map(|(start, end)| (Some(start), Some(end)))
		.unwrap_or((None, None));

	ResolvedSymbol {
		name,
		kind,
		start_byte: node.start_byte(),
		end_byte: node.end_byte(),
		line: (node.start_position().row + 1) as u32,
		end_line: (node.end_position().row + 1) as u32,
		body_start_byte: body_start,
		body_end_byte: body_end,
	}
}

/// Resolve a member within a class-like node.
fn resolve_member(
	class_node: Node<'_>,
	profile: &LanguageProfile,
	source: &str,
	class_name: &str,
	member_name: &str,
) -> Result<ResolvedSymbol> {
	let class_like = profile
		.class_like
		.iter()
		.find(|cl| cl.node_type == class_node.kind())
		.ok_or_else(|| {
			CodeEngineError::Edit(format!(
				"'{}' is not a class-like container, cannot resolve member '{}'",
				class_name, member_name
			))
		})?;

	let members = class_member_nodes(profile, class_node);
	if members.is_empty() && !class_like.member_types.is_empty() {
		return Err(CodeEngineError::Edit(format!("'{}' has no body", class_name)));
	}

	let mut matches: Vec<Node<'_>> = Vec::new();
	for child in members {
		if let Some(decl) = declaration_for(profile, child) {
			if let Some(n) = declaration_name(source, child, decl) {
				if n == member_name {
					matches.push(child);
				}
			}
		}
	}

	if matches.is_empty() {
		let available = collect_member_names(class_node, profile, source);
		return Err(CodeEngineError::Edit(format!(
			"Member '{}' not found in '{}'. Available: [{}]",
			member_name,
			class_name,
			available.join(", ")
		)));
	}
	if matches.len() > 1 {
		let lines: Vec<String> = matches
			.iter()
			.map(|n| (n.start_position().row + 1).to_string())
			.collect();
		return Err(CodeEngineError::Edit(format!(
			"Ambiguous member '{}' in '{}': found at lines {}",
			member_name,
			class_name,
			lines.join(", ")
		)));
	}

	Ok(build_resolved(matches[0], profile, source))
}

/// Collect names of all top-level declarations for error messages.
fn collect_top_level_names(root: Node<'_>, profile: &LanguageProfile, source: &str) -> Vec<String> {
	let mut names = Vec::new();
	let mut cursor = root.walk();
	for child in root.named_children(&mut cursor) {
		let inner = unwrap_export(child);
		if let Some(decl) = declaration_for(profile, inner) {
			if let Some(n) = declaration_name(source, inner, decl) {
				names.push(n);
			}
		}
	}
	names
}

/// Collect names of members within a class-like body for error messages.
fn collect_member_names(
	class_node: Node<'_>,
	profile: &LanguageProfile,
	source: &str,
) -> Vec<String> {
	let mut names = Vec::new();
	for child in class_member_nodes(profile, class_node) {
		if let Some(decl) = declaration_for(profile, child) {
			if let Some(n) = declaration_name(source, child, decl) {
				names.push(n);
			}
		}
	}
	names
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

	use super::*;
	use crate::language::{LanguageId, LanguageRegistry};

	fn registry() -> Arc<LanguageRegistry> {
		Arc::new(LanguageRegistry::with_builtins().expect("registry"))
	}

	fn test_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/edit_target.ts",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("typescript"), registry()).expect("buffer")
	}

	#[test]
	fn resolve_top_level_function() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "outer").expect("resolve outer");
		assert_eq!(resolved.name, "outer");
		assert_eq!(resolved.kind, "function");
		assert_eq!(resolved.line, 1);
		assert_eq!(resolved.end_line, 7);
		assert!(resolved.body_start_byte.is_some());
		assert!(resolved.body_end_byte.is_some());
	}

	#[test]
	fn resolve_function_add() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "add").expect("resolve add");
		assert_eq!(resolved.name, "add");
		assert_eq!(resolved.kind, "function");
		assert_eq!(resolved.line, 11);
		assert_eq!(resolved.end_line, 13);
		assert!(resolved.body_start_byte.is_some());
	}

	#[test]
	fn resolve_const_variable() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "items").expect("resolve items");
		assert_eq!(resolved.name, "items");
		assert_eq!(resolved.kind, "variable");
		assert_eq!(resolved.line, 9);
		// lexical_declaration has no body_field in TS profile
		assert!(resolved.body_start_byte.is_none());
	}

	#[test]
	fn resolve_class() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "Foo").expect("resolve Foo");
		assert_eq!(resolved.name, "Foo");
		assert_eq!(resolved.kind, "class");
		assert_eq!(resolved.line, 15);
		assert_eq!(resolved.end_line, 18);
		assert!(resolved.body_start_byte.is_some());
	}

	#[test]
	fn resolve_class_member_bar() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "Foo.bar").expect("resolve Foo.bar");
		assert_eq!(resolved.name, "bar");
		assert_eq!(resolved.kind, "method");
		assert_eq!(resolved.line, 16);
	}

	#[test]
	fn resolve_class_member_baz() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "Foo.baz").expect("resolve Foo.baz");
		assert_eq!(resolved.name, "baz");
		assert_eq!(resolved.kind, "method");
		assert_eq!(resolved.line, 17);
	}

	#[test]
	fn resolve_not_found() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let err = resolve_symbol(&buffer, profile, "nonexistent").unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("not found"), "should say not found: {msg}");
		assert!(msg.contains("Available"), "should list available: {msg}");
	}

	#[test]
	fn resolve_member_not_found() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let err = resolve_symbol(&buffer, profile, "Foo.nonexistent").unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("not found in 'Foo'"), "should say not found in Foo: {msg}");
	}

	#[test]
	fn resolve_too_many_levels() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let err = resolve_symbol(&buffer, profile, "Foo.bar.deep").unwrap_err();
		let msg = err.to_string();
		assert!(msg.contains("at most 2 levels"), "should reject 3-level: {msg}");
	}

	#[test]
	fn resolve_exported_function() {
		// Test that export-wrapped declarations are found
		let source = "export function greet(name: string) { return name; }";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "greet").expect("resolve greet");
		assert_eq!(resolved.name, "greet");
		assert_eq!(resolved.kind, "function");
	}
}
