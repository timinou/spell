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
	outline::{
		class_member_nodes, declaration_body_range, declaration_for, declaration_name,
		declaration_name_resolution,
	},
};

/// Byte range within the source buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
	pub start: usize,
	pub end:   usize,
}

/// Resolved symbol with byte range and optional body range.
///
/// Three explicit ranges are provided so that action handlers can pick the
/// appropriate span without guessing:
/// - `identifier_range` — the bare name token (used by rename).
/// - `declaration_range` — the unwrapped declaration body (default for
///   find/get).
/// - `statement_range` — the smallest enclosing statement that includes leading
///   keywords such as `export`, decorators, or Rust attributes (used by wrap,
///   splice, move, clone).
#[derive(Debug, Clone)]
pub struct ResolvedSymbol {
	pub name:              String,
	pub kind:              String,
	pub start_byte:        usize,
	pub end_byte:          usize,
	pub line:              u32,
	pub end_line:          u32,
	pub body_start_byte:   Option<usize>,
	pub body_end_byte:     Option<usize>,
	pub identifier_range:  ByteRange,
	pub declaration_range: ByteRange,
	pub statement_range:   ByteRange,
}

fn declaration_name_for_node(
	node: Node<'_>,
	profile: &LanguageProfile,
	source: &str,
) -> Option<String> {
	let inner = unwrap_export(node);
	let decl = declaration_for(profile, inner, source)?;
	declaration_name(source, inner, decl)
}

fn declaration_ancestor_within(
	mut node: Node<'_>,
	profile: &LanguageProfile,
	source: &str,
	start: usize,
	end: usize,
) -> bool {
	while let Some(parent) = node.parent() {
		if parent.start_byte() < start || parent.end_byte() > end {
			return false;
		}
		if declaration_name_for_node(parent, profile, source).is_some() {
			return true;
		}
		node = parent;
	}
	false
}

pub fn collect_top_level_decls_in_range(
	buffer: &CodeBuffer,
	start: usize,
	end: usize,
) -> Vec<String> {
	let source = buffer.source();
	let Some(profile) = buffer.registry().get(buffer.language()) else {
		return Vec::new();
	};
	let root = buffer.tree().root_node();
	let Some(container) = root.named_descendant_for_byte_range(start, end.saturating_sub(1)) else {
		return Vec::new();
	};
	let mut names = Vec::new();
	let mut stack = vec![container];
	while let Some(node) = stack.pop() {
		if node.start_byte() < start || node.end_byte() > end {
			continue;
		}
		if let Some(name) = declaration_name_for_node(node, profile, &source)
			&& !declaration_ancestor_within(node, profile, &source, start, end)
		{
			names.push(name);
			continue;
		}
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			stack.push(child);
		}
	}
	names.reverse();
	names
}

/// Resolve a symbol by name within a buffer.
///
/// Supports dotted names by first matching the full string, then resolving the
/// prefix recursively as a container path and the suffix as a member name.
fn clojure_local_symbol_alias<'a>(
	root: Node<'a>,
	profile: &LanguageProfile,
	source: &str,
	symbol: &'a str,
) -> Option<&'a str> {
	let (namespace, local) = symbol.rsplit_once('/')?;
	if namespace.is_empty() || local.is_empty() {
		return None;
	}
	let namespace_matches = find_top_level_matches(root, profile, source, namespace)
		.into_iter()
		.any(|node| {
			declaration_for(profile, node, source).is_some_and(|decl| decl.kind == "namespace")
		});
	namespace_matches.then_some(local)
}
pub fn resolve_symbol(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	symbol: &str,
) -> Result<ResolvedSymbol> {
	let source = buffer.source();
	let root = buffer.tree().root_node();
	if let Some(node) = find_symbol_node(root, profile, &source, symbol)? {
		return Ok(build_resolved(node, profile, &source));
	}
	if profile.id.as_str() == "clojure"
		&& let Some(local_symbol) = clojure_local_symbol_alias(root, profile, &source, symbol)
		&& let Some(node) = find_symbol_node(root, profile, &source, local_symbol)?
	{
		return Ok(build_resolved(node, profile, &source));
	}

	let available = collect_top_level_names(root, profile, &source);
	if available.is_empty() {
		let hints = collect_top_level_hints(root, &source);
		if hints.is_empty() {
			return Err(CodeEngineError::Edit(format!(
				"Symbol '{}' not found. No recognized declarations in file.",
				symbol
			)));
		}
		return Err(CodeEngineError::Edit(format!(
			"Symbol '{}' not found. File contains top-level nodes but no recognized declarations \
			 (observed: [{}]).",
			symbol,
			hints.join(", ")
		)));
	}
	Err(CodeEngineError::Edit(format!(
		"Symbol '{}' not found. Available: [{}]",
		symbol,
		available.join(", ")
	)))
}

fn match_declaration<'a>(
	node: Node<'a>,
	profile: &LanguageProfile,
	name: &str,
	source: &str,
) -> Option<Node<'a>> {
	let inner = unwrap_export(node);
	if let Some(decl) = declaration_for(profile, inner, source) {
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
fn statement_range_for(node: Node<'_>, profile: &LanguageProfile) -> ByteRange {
	let mut statement_node = node;
	while let Some(parent) = statement_node.parent() {
		if profile
			.enclosing_statement_kinds
			.iter()
			.any(|k| k == parent.kind())
		{
			statement_node = parent;
		} else {
			break;
		}
	}
	// Rust-specific: include preceding attribute_item siblings.
	if profile.id.as_str() == "rust" {
		let mut start_byte = statement_node.start_byte();
		let mut current = statement_node;
		while let Some(prev) = current.prev_sibling() {
			if prev.kind() == "attribute_item" {
				start_byte = prev.start_byte();
				current = prev;
			} else {
				break;
			}
		}
		ByteRange { start: start_byte, end: statement_node.end_byte() }
	} else {
		ByteRange { start: statement_node.start_byte(), end: statement_node.end_byte() }
	}
}

fn build_resolved(node: Node<'_>, profile: &LanguageProfile, source: &str) -> ResolvedSymbol {
	let decl = declaration_for(profile, node, source);
	let name = decl
		.and_then(|d| declaration_name(source, node, d))
		.unwrap_or_default();
	let kind = decl.map(|d| d.kind.clone()).unwrap_or_default();

	let (body_start, body_end) = decl
		.and_then(|d| declaration_body_range(source, node, d))
		.map(|(start, end)| (Some(start), Some(end)))
		.unwrap_or((None, None));

	let (id_start, id_end) = decl
		.and_then(|d| declaration_name_resolution(source, node, d))
		.map(|res| (res.start_byte, res.end_byte))
		.unwrap_or_else(|| (node.start_byte(), node.end_byte()));

	let declaration_range = ByteRange { start: node.start_byte(), end: node.end_byte() };
	let statement_range = statement_range_for(node, profile);

	ResolvedSymbol {
		name,
		kind,
		start_byte: declaration_range.start,
		end_byte: declaration_range.end,
		line: (node.start_position().row + 1) as u32,
		end_line: (node.end_position().row + 1) as u32,
		body_start_byte: body_start,
		body_end_byte: body_end,
		identifier_range: ByteRange { start: id_start, end: id_end },
		declaration_range,
		statement_range,
	}
}

/// Resolve a member within a class-like node.
fn find_top_level_matches<'a>(
	root: Node<'a>,
	profile: &LanguageProfile,
	source: &str,
	name: &str,
) -> Vec<Node<'a>> {
	let mut cursor = root.walk();
	let mut matches: Vec<Node<'a>> = Vec::new();
	for child in root.named_children(&mut cursor) {
		if let Some(node) = match_declaration(child, profile, name, source) {
			matches.push(node);
		}
	}
	matches
}

fn ambiguous_symbol_error(name: &str, matches: &[Node<'_>]) -> CodeEngineError {
	let lines: Vec<String> = matches
		.iter()
		.map(|n| (n.start_position().row + 1).to_string())
		.collect();
	CodeEngineError::Edit(format!(
		"Ambiguous symbol '{}': found at lines {}",
		name,
		lines.join(", ")
	))
}

fn find_symbol_node<'a>(
	root: Node<'a>,
	profile: &LanguageProfile,
	source: &str,
	symbol: &str,
) -> Result<Option<Node<'a>>> {
	let (base_symbol, occurrence) = split_deduplicated_name(symbol);
	let matches = find_top_level_matches(root, profile, source, base_symbol);
	if let Some(occurrence) = occurrence {
		return if occurrence > 0 && occurrence <= matches.len() {
			Ok(Some(matches[occurrence - 1]))
		} else {
			Ok(None)
		};
	}
	if matches.len() == 1 {
		return Ok(Some(matches[0]));
	}
	if matches.len() > 1 {
		return Err(ambiguous_symbol_error(symbol, &matches));
	}

	if let Some(last_dot) = symbol.rfind('.') {
		let container_name = &symbol[..last_dot];
		let member_name = &symbol[last_dot + 1..];
		if !container_name.is_empty() && !member_name.is_empty() {
			if let Some(container_node) = find_symbol_node(root, profile, source, container_name)? {
				return resolve_member_node(
					container_node,
					profile,
					source,
					container_name,
					member_name,
				)
				.map(Some);
			}
		}
	}

	// Self-nesting containers (markdown/org/typst sections nest as sections):
	// a bare child name like `Section` is addressable without the full
	// `Parent.Section` dot-path, matching what the read-side resolver accepts.
	// Gated to self-nesting `class_like` so code languages keep top-level +
	// dot-path semantics (a nested fn is NOT bare-addressable). Ambiguity
	// across the tree is surfaced as an error, identical to the top-level rule.
	if profile_has_self_nesting_container(profile) {
		let nested = find_nested_matches(root, profile, source, base_symbol);
		if nested.len() == 1 {
			return Ok(Some(nested[0]));
		}
		if nested.len() > 1 {
			return Err(ambiguous_symbol_error(symbol, &nested));
		}
	}

	Ok(None)
}

/// True when the profile declares a `class_like` container whose own
/// `node_type` appears in its `member_types` — i.e. it nests within itself
/// (markdown/org/typst `section`). Code containers (Rust `impl_item`, TS
/// `class_declaration`) hold *different* member node types and are excluded.
fn profile_has_self_nesting_container(profile: &LanguageProfile) -> bool {
	profile
		.class_like
		.iter()
		.any(|cl| cl.member_types.iter().any(|m| m == &cl.node_type))
}

/// Recursively collect every declaration node matching `name` anywhere in the
/// tree (used only for self-nesting container languages). Mirrors
/// `match_declaration`'s name comparison; descends through all named children.
fn find_nested_matches<'a>(
	node: Node<'a>,
	profile: &LanguageProfile,
	source: &str,
	name: &str,
) -> Vec<Node<'a>> {
	let mut out = Vec::new();
	fn walk<'a>(
		node: Node<'a>,
		profile: &LanguageProfile,
		source: &str,
		name: &str,
		out: &mut Vec<Node<'a>>,
	) {
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			if let Some(found) = match_declaration(child, profile, name, source) {
				out.push(found);
			}
			walk(child, profile, source, name, out);
		}
	}
	walk(node, profile, source, name, &mut out);
	out
}

fn split_deduplicated_name(name: &str) -> (&str, Option<usize>) {
	let Some(open_bracket) = name.rfind('[') else {
		return (name, None);
	};
	if !name.ends_with(']') {
		return (name, None);
	}
	let number = &name[open_bracket + 1..name.len() - 1];
	if number.is_empty() || !number.chars().all(|ch| ch.is_ascii_digit()) {
		return (name, None);
	}
	(&name[..open_bracket], number.parse::<usize>().ok())
}

fn resolve_member_node<'a>(
	class_node: Node<'a>,
	profile: &LanguageProfile,
	source: &str,
	class_name: &str,
	member_name: &str,
) -> Result<Node<'a>> {
	let class_like = profile
		.class_like
		.iter()
		.find(|cl| {
			if cl.node_type != class_node.kind() {
				return false;
			}
			if let (Some(filter_field), Some(filter_names)) = (&cl.filter_field, &cl.filter_names) {
				let field_text = class_node
					.child_by_field_name(filter_field)
					.and_then(|n| source.get(n.start_byte()..n.end_byte()));
				return field_text.is_some_and(|t| filter_names.iter().any(|f| f == t));
			}
			true
		})
		.ok_or_else(|| {
			CodeEngineError::Edit(format!(
				"'{}' is not a class-like container, cannot resolve member '{}'",
				class_name, member_name
			))
		})?;

	let members = class_member_nodes(profile, class_node, source);
	if members.is_empty() && !class_like.member_types.is_empty() {
		return Err(CodeEngineError::Edit(format!("'{}' has no body", class_name)));
	}

	let (base_member_name, occurrence) = split_deduplicated_name(member_name);
	let mut matches: Vec<Node<'_>> = Vec::new();
	for child in members {
		if let Some(decl) = declaration_for(profile, child, source) {
			if let Some(name) = declaration_name(source, child, decl) {
				if name == base_member_name {
					matches.push(child);
				}
			}
		}
	}

	if let Some(occurrence) = occurrence {
		return matches
			.get(occurrence.saturating_sub(1))
			.copied()
			.ok_or_else(|| {
				CodeEngineError::Edit(format!(
					"Member '{}' not found in '{}'. Available: [{}]",
					member_name,
					class_name,
					collect_member_names(class_node, profile, source).join(", ")
				))
			});
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

	Ok(matches[0])
}

/// Resolve a member within a class-like node.
#[allow(dead_code, reason = "legacy helper kept for focused resolve tests")]
fn resolve_member(
	class_node: Node<'_>,
	profile: &LanguageProfile,
	source: &str,
	class_name: &str,
	member_name: &str,
) -> Result<ResolvedSymbol> {
	let node = resolve_member_node(class_node, profile, source, class_name, member_name)?;
	Ok(build_resolved(node, profile, source))
}

/// Collect names of all top-level declarations for error messages.
fn collect_top_level_names(root: Node<'_>, profile: &LanguageProfile, source: &str) -> Vec<String> {
	fn collect_names(
		node: Node<'_>,
		profile: &LanguageProfile,
		source: &str,
		names: &mut Vec<String>,
	) {
		let inner = unwrap_export(node);
		if let Some(decl) = declaration_for(profile, inner, source) {
			if let Some(name) = declaration_name(source, inner, decl) {
				names.push(name);
			}
			return;
		}
		let mut cursor = inner.walk();
		let mut children = inner.named_children(&mut cursor);
		let Some(child) = children.next() else {
			return;
		};
		if children.next().is_some() {
			return;
		}
		collect_names(child, profile, source, names);
	}

	let mut names = Vec::new();
	let mut cursor = root.walk();
	for child in root.named_children(&mut cursor) {
		collect_names(child, profile, source, &mut names);
	}
	names
}
/// Collect observed top-level node kinds / call targets for diagnostic hints
/// when a file has named children but no recognized declarations.
fn collect_top_level_hints(root: Node<'_>, source: &str) -> Vec<String> {
	let mut hints = Vec::new();
	let mut cursor = root.walk();
	for child in root.named_children(&mut cursor) {
		let kind = child.kind();
		if kind == "call" {
			if let Some(target) = child.child_by_field_name("target") {
				if let Some(text) = source.get(target.start_byte()..target.end_byte()) {
					hints.push(format!("{} (call: {})", kind, text));
					continue;
				}
			}
		}
		hints.push(kind.to_string());
	}
	hints
}
/// Collect names of members within a class-like body for error messages.
fn collect_member_names(
	class_node: Node<'_>,
	profile: &LanguageProfile,
	source: &str,
) -> Vec<String> {
	let mut names = Vec::new();
	for child in class_member_nodes(profile, class_node, source) {
		if let Some(decl) = declaration_for(profile, child, source) {
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

	fn markdown_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/hello.md",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("markdown"), registry()).expect("buffer")
	}

	fn elixir_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/hello.ex",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("elixir"), registry()).expect("buffer")
	}

	fn html_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/hello.html",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("html"), registry()).expect("buffer")
	}

	fn css_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/hello.css",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("css"), registry()).expect("buffer")
	}

	fn typst_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/typst_edit_targets.typ",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("typst"), registry()).expect("buffer")
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
	fn resolve_non_class_deep_member() {
		let buffer = test_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let err = resolve_symbol(&buffer, profile, "Foo.bar.deep").unwrap_err();
		let msg = err.to_string();
		assert!(
			msg.contains("'Foo.bar' is not a class-like container"),
			"should attempt recursive container resolution: {msg}"
		);
	}

	#[test]
	fn resolve_markdown_section() {
		let buffer = markdown_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("markdown")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "Installation").expect("resolve section");
		assert_eq!(resolved.name, "Installation");
		assert_eq!(resolved.kind, "section");
		assert!(resolved.body_start_byte.is_some());
		assert!(resolved.body_end_byte.is_some());
		let body =
			&buffer.source()[resolved.body_start_byte.unwrap()..resolved.body_end_byte.unwrap()];
		assert!(
			body.starts_with("Follow these steps"),
			"body should start after heading line: {body:?}"
		);
	}

	/// BUG-439: a nested heading is addressable by its BARE name (no
	/// `Parent.` dot-path), matching the read-side resolver. Self-nesting
	/// container languages opt into recursive descent.
	#[test]
	fn resolve_markdown_bare_nested_section() {
		let source = "# Title\n\nIntro.\n\n## Section\n\nBody.\n";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("markdown"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("markdown")).unwrap();
		let resolved = resolve_symbol(&buffer, profile, "Section").expect("bare nested section");
		assert_eq!(resolved.name, "Section");
		assert_eq!(resolved.kind, "section");
	}

	/// Bare nested resolution must still refuse ambiguity: two `## Dup`
	/// headings under different parents → ambiguous error (same rule as
	/// top-level duplicates), guiding the agent to the dot-path.
	#[test]
	fn resolve_markdown_bare_nested_ambiguous() {
		let source = "# A\n\n## Dup\n\nx\n\n# B\n\n## Dup\n\ny\n";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("markdown"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("markdown")).unwrap();
		let err = resolve_symbol(&buffer, profile, "Dup").expect_err("ambiguous");
		assert!(
			err.to_string().contains("Ambiguous"),
			"expected ambiguity error, got: {err}"
		);
		// Dot-path disambiguates.
		assert!(resolve_symbol(&buffer, profile, "A.Dup").is_ok());
		assert!(resolve_symbol(&buffer, profile, "B.Dup").is_ok());
	}

	/// A bare top-level name must NOT recurse past a unique top-level match
	/// (no behavior change for the common case).
	#[test]
	fn resolve_markdown_bare_toplevel_unaffected() {
		let source = "# Title\n\n## Section\n\nBody.\n";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("markdown"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("markdown")).unwrap();
		let resolved = resolve_symbol(&buffer, profile, "Title").expect("top-level");
		assert_eq!(resolved.name, "Title");
	}

	#[test]
	fn resolve_markdown_nested_section() {
		let buffer = markdown_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("markdown")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "Installation.Prerequisites")
			.expect("resolve nested section");
		assert_eq!(resolved.name, "Prerequisites");
		assert_eq!(resolved.kind, "section");
		assert!(resolved.line < resolved.end_line);
	}

	#[test]
	fn resolve_markdown_deep_nested_section() {
		let source = "# A

## B

### C

Deep section body.
";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("markdown"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("markdown")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "A.B.C").expect("resolve nested section");
		assert_eq!(resolved.name, "C");
		assert_eq!(resolved.kind, "section");
		assert_eq!(resolved.line, 5);
	}

	#[test]
	fn resolve_elixir_module() {
		let buffer = elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "MyApp.Greeter").expect("resolve module");
		assert_eq!(resolved.name, "MyApp.Greeter");
		assert_eq!(resolved.kind, "module");
		assert_eq!(resolved.line, 1);
	}

	#[test]
	fn resolve_elixir_member_greet() {
		let buffer = elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved =
			resolve_symbol(&buffer, profile, "MyApp.Greeter.greet").expect("resolve greet");
		assert_eq!(resolved.name, "greet");
		assert_eq!(resolved.kind, "def");
		assert_eq!(resolved.line, 8);
	}

	#[test]
	fn resolve_html_root_and_nested_button() {
		let buffer = html_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("html")).unwrap();

		let root = resolve_symbol(&buffer, profile, "html#root").expect("resolve html root");
		assert_eq!(root.name, "html#root");
		assert_eq!(root.kind, "element");

		let button = resolve_symbol(&buffer, profile, "html#root.body#main.button#save")
			.expect("resolve nested button");
		assert_eq!(button.name, "button#save");
		assert_eq!(button.kind, "element");
	}

	#[test]
	fn resolve_css_keyframes() {
		let buffer = css_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("css")).unwrap();

		let keyframes = resolve_symbol(&buffer, profile, "fade-in").expect("resolve keyframes");
		assert_eq!(keyframes.name, "fade-in");
		assert_eq!(keyframes.kind, "keyframes");
	}

	#[test]
	fn resolve_elixir_member_start_link() {
		let buffer = elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved =
			resolve_symbol(&buffer, profile, "MyApp.Greeter.start_link").expect("resolve start_link");
		assert_eq!(resolved.name, "start_link");
		assert_eq!(resolved.kind, "def");
		assert_eq!(resolved.line, 4);
	}

	#[test]
	fn resolve_elixir_private_member() {
		let buffer = elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "MyApp.Greeter.internal_helper")
			.expect("resolve internal_helper");
		assert_eq!(resolved.name, "internal_helper");
		assert_eq!(resolved.kind, "defp");
		assert_eq!(resolved.line, 12);
	}

	#[test]
	fn resolve_elixir_missing_member() {
		let buffer = elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let err = resolve_symbol(&buffer, profile, "MyApp.Greeter.nonexistent").unwrap_err();
		let msg = err.to_string();
		assert!(
			msg.contains("not found in 'MyApp.Greeter'"),
			"should say not found in MyApp.Greeter: {msg}"
		);
	}

	#[test]
	fn resolve_elixir_missing_module() {
		let buffer = elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let err = resolve_symbol(&buffer, profile, "NonExistent.Module").unwrap_err();
		let msg = err.to_string();
		assert!(
			msg.contains("Symbol 'NonExistent.Module' not found"),
			"should say module not found: {msg}"
		);
		assert!(msg.contains("MyApp.Greeter"), "should list available module names: {msg}");
	}

	#[test]
	fn resolve_audited_non_typst_symbol_paths_and_diagnostics() {
		let markdown = markdown_buffer();
		let markdown_profile = registry();
		let markdown_profile = markdown_profile.get(&LanguageId::new("markdown")).unwrap();
		assert_eq!(
			resolve_symbol(&markdown, markdown_profile, "Installation.Prerequisites")
				.expect("resolve markdown nested section")
				.name,
			"Prerequisites"
		);
		let markdown_err = resolve_symbol(&markdown, markdown_profile, "Missing").unwrap_err();
		assert!(markdown_err.to_string().contains("Installation"));

		let org_source = "* OrgTop\n** OrgChild\n";
		let org =
			CodeBuffer::from_str(org_source, LanguageId::new("org"), registry()).expect("org buffer");
		let org_profile = registry();
		let org_profile = org_profile.get(&LanguageId::new("org")).unwrap();
		assert_eq!(
			resolve_symbol(&org, org_profile, "OrgTop.OrgChild")
				.expect("resolve org nested section")
				.name,
			"OrgChild"
		);
		let org_err = resolve_symbol(&org, org_profile, "Missing").unwrap_err();
		assert!(org_err.to_string().contains("OrgTop"));

		let elixir = elixir_buffer();
		let elixir_profile = registry();
		let elixir_profile = elixir_profile.get(&LanguageId::new("elixir")).unwrap();
		assert_eq!(
			resolve_symbol(&elixir, elixir_profile, "MyApp.Greeter.greet")
				.expect("resolve elixir member")
				.name,
			"greet"
		);

		let html = html_buffer();
		let html_profile = registry();
		let html_profile = html_profile.get(&LanguageId::new("html")).unwrap();
		assert_eq!(
			resolve_symbol(&html, html_profile, "html#root.body#main.button#save")
				.expect("resolve html nested element")
				.name,
			"button#save"
		);

		let css_source = ":root { --accent: red; color: var(--accent); }\n";
		let css =
			CodeBuffer::from_str(css_source, LanguageId::new("css"), registry()).expect("css buffer");
		let css_profile = registry();
		let css_profile = css_profile.get(&LanguageId::new("css")).unwrap();
		assert_eq!(
			resolve_symbol(&css, css_profile, ":root.--accent")
				.expect("resolve css custom property")
				.name,
			"--accent"
		);
	}

	#[test]
	fn resolve_typst_callable_let_by_base_name() {
		let buffer = typst_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typst")).unwrap();

		let resolved =
			resolve_symbol(&buffer, profile, "section-title").expect("resolve section-title");
		assert_eq!(resolved.name, "section-title");
		assert_eq!(resolved.kind, "let");
		assert_eq!(resolved.line, 11);
		assert!(resolved.body_start_byte.is_some());
	}

	#[test]
	fn resolve_typst_simple_and_callable_lets_by_binding_name() {
		let source = "#let navy = rgb(\"#000080\")\n#let posterior-chart() = [ok]\n#let lbl(txt, \
		              color: navy) = [#txt]\n";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("typst"), registry()).expect("buffer");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typst")).unwrap();

		assert_eq!(
			resolve_symbol(&buffer, profile, "navy")
				.expect("resolve navy")
				.name,
			"navy"
		);
		assert_eq!(
			resolve_symbol(&buffer, profile, "posterior-chart")
				.expect("resolve posterior-chart")
				.name,
			"posterior-chart"
		);
		assert_eq!(
			resolve_symbol(&buffer, profile, "lbl")
				.expect("resolve lbl")
				.name,
			"lbl"
		);
	}

	#[test]
	fn resolve_typst_missing_symbol_reports_canonical_available_names() {
		let buffer = typst_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typst")).unwrap();

		let err = resolve_symbol(&buffer, profile, "missing").unwrap_err();
		let msg = err.to_string();
		assert_eq!(
			msg,
			"edit error: Symbol 'missing' not found. Available: [teal-primary, section-title]"
		);
	}

	#[test]
	fn resolve_elixir_deep_three_segment_module() {
		let buffer = deep_elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "MyApp.Web.Greeter").expect("resolve module");
		assert_eq!(resolved.name, "MyApp.Web.Greeter");
		assert_eq!(resolved.kind, "module");
		assert_eq!(resolved.line, 1);
	}

	#[test]
	fn resolve_elixir_deep_three_segment_member() {
		let buffer = deep_elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved =
			resolve_symbol(&buffer, profile, "MyApp.Web.Greeter.greet").expect("resolve greet");
		assert_eq!(resolved.name, "greet");
		assert_eq!(resolved.kind, "def");
	}

	#[test]
	fn resolve_elixir_four_segment_module() {
		let buffer = four_segment_elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved =
			resolve_symbol(&buffer, profile, "MyApp.Web.Api.V1.Controller").expect("resolve module");
		assert_eq!(resolved.name, "MyApp.Web.Api.V1.Controller");
		assert_eq!(resolved.kind, "module");
	}

	#[test]
	fn resolve_elixir_four_segment_member() {
		let buffer = four_segment_elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "MyApp.Web.Api.V1.Controller.index")
			.expect("resolve index");
		assert_eq!(resolved.name, "index");
		assert_eq!(resolved.kind, "def");
	}

	#[test]
	fn resolve_elixir_missing_deep_member() {
		let buffer = deep_elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let err = resolve_symbol(&buffer, profile, "MyApp.Web.Greeter.nonexistent").unwrap_err();
		let msg = err.to_string();
		assert!(
			msg.contains("not found in 'MyApp.Web.Greeter'"),
			"should say not found in MyApp.Web.Greeter: {msg}"
		);
		assert!(msg.contains("start_link"), "should list available member: {msg}");
	}

	#[test]
	fn resolve_elixir_empty_candidates_diagnostic() {
		let buffer = empty_candidates_elixir_buffer();
		let profile = registry();
		let profile = profile.get(&LanguageId::new("elixir")).unwrap();

		let err = resolve_symbol(&buffer, profile, "anything").unwrap_err();
		let msg = err.to_string();
		assert!(
			msg.contains("observed:"),
			"should report observed top-level nodes when no declarations found: {msg}"
		);
		assert!(
			msg.contains("call: use") || msg.contains("call"),
			"should mention call nodes: {msg}"
		);
	}

	fn deep_elixir_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/deep_module.ex",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("elixir"), registry()).expect("buffer")
	}

	fn four_segment_elixir_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/four_segment_module.ex",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("elixir"), registry()).expect("buffer")
	}

	fn empty_candidates_elixir_buffer() -> CodeBuffer {
		let source = fs::read_to_string(format!(
			"{}/tests/fixtures/sources/empty_candidates.ex",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("fixture");
		CodeBuffer::from_str(&source, LanguageId::new("elixir"), registry()).expect("buffer")
	}

	#[test]
	fn resolve_exported_function() {
		let source = "export function greet(name: string) { return name; }";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("typescript"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("typescript")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "greet").expect("resolve greet");
		assert_eq!(resolved.name, "greet");
		assert_eq!(resolved.kind, "function");
	}

	#[test]
	fn resolve_clojure_accepts_qualified_var_alias() {
		let source = "(ns app.core)\n(defn normalize-name [s] s)\n";
		let buffer =
			CodeBuffer::from_str(source, LanguageId::new("clojure"), registry()).expect("buf");
		let profile = registry();
		let profile = profile.get(&LanguageId::new("clojure")).unwrap();

		let resolved = resolve_symbol(&buffer, profile, "app.core/normalize-name")
			.expect("resolve qualified clojure var");
		assert_eq!(resolved.name, "normalize-name");
		assert_eq!(resolved.kind, "function");
	}
}
