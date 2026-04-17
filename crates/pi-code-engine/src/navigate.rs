use std::collections::BTreeSet;

use tree_sitter::Node;

use crate::{
	buffer::CodeBuffer,
	error::{CodeEngineError, Result},
	language::{DeclarationPattern, LanguageProfile, ReferencePattern},
	line_target::{editable_scope_for_node, resolve_line_target},
	outline::{class_member_nodes, declaration_for, declaration_name},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigateAction {
	NodeAt,
	DefunAt,
	Parent,
	Siblings,
	Children,
	References,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NavigateItem {
	pub node_type: String,
	pub text:      String,
	pub line:      u32,
	pub end_line:  u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NavigateResult {
	pub node_type:                String,
	pub text:                     String,
	pub line:                     u32,
	pub end_line:                 u32,
	pub column:                   u32,
	pub parent_type:              Option<String>,
	pub editable_scope_node_type: Option<String>,
	pub editable_scope_line:      Option<u32>,
	pub editable_scope_end_line:  Option<u32>,
	pub editable_scope_column:    Option<u32>,
	pub name:                     Option<String>,
	pub kind:                     Option<String>,
	pub items:                    Vec<NavigateItem>,
	pub references:               Vec<u32>,
}

pub fn navigate(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	action: NavigateAction,
	line: u32,
	column: Option<u32>,
	symbol: Option<&str>,
) -> Result<NavigateResult> {
	let target = resolve_line_target(buffer, line, column)?;
	let node = target.raw;
	match action {
		NavigateAction::NodeAt => Ok(node_result(buffer, node)),
		NavigateAction::DefunAt => defun_at(buffer, profile, node),
		NavigateAction::Parent => parent_result(buffer, node),
		NavigateAction::Siblings => Ok(siblings_result(buffer, node)),
		NavigateAction::Children => Ok(children_result(buffer, profile, node)),
		NavigateAction::References => {
			Ok(references_result(buffer, profile, symbol.unwrap_or(&node_text(buffer, node))))
		},
	}
}

fn node_result(buffer: &CodeBuffer, node: Node<'_>) -> NavigateResult {
	result_for_node(buffer, node, None, None)
}

fn result_for_node(
	buffer: &CodeBuffer,
	node: Node<'_>,
	name: Option<String>,
	kind: Option<String>,
) -> NavigateResult {
	let editable_scope = editable_scope_for_node(node);
	NavigateResult {
		node_type: node.kind().to_string(),
		text: first_line(&node_text(buffer, node), 80),
		line: (node.start_position().row + 1) as u32,
		end_line: (node.end_position().row + 1) as u32,
		column: node.start_position().column as u32,
		parent_type: node.parent().map(|p| p.kind().to_string()),
		editable_scope_node_type: Some(editable_scope.kind().to_string()),
		editable_scope_line: Some((editable_scope.start_position().row + 1) as u32),
		editable_scope_end_line: Some((editable_scope.end_position().row + 1) as u32),
		editable_scope_column: Some(editable_scope.start_position().column as u32),
		name,
		kind,
		items: vec![],
		references: vec![],
	}
}

fn defun_at(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	mut node: Node<'_>,
) -> Result<NavigateResult> {
	let source = buffer.source();
	loop {
		if let Some(target) = declaration_node(profile, node, &source) {
			return Ok(declaration_result(
				buffer,
				target,
				declaration_for(profile, target, &source).expect("decl"),
			));
		}
		if let Some(parent) = node.parent() {
			node = parent;
		} else {
			return Err(CodeEngineError::Buffer("no enclosing function".into()));
		}
	}
}

fn declaration_node<'a>(
	profile: &'a LanguageProfile,
	node: Node<'a>,
	source: &str,
) -> Option<Node<'a>> {
	if declaration_for(profile, node, source).is_some() {
		return Some(node);
	}
	if node.kind() == "export_statement" {
		return unwrap_export(profile, node, source);
	}
	sole_named_child(node).and_then(|child| declaration_node(profile, child, source))
}

fn unwrap_export<'a>(
	profile: &'a LanguageProfile,
	node: Node<'a>,
	source: &str,
) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	node
		.named_children(&mut cursor)
		.find_map(|child| declaration_node(profile, child, source))
}

fn sole_named_child(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	let mut children = node.named_children(&mut cursor);
	let child = children.next()?;
	(children.next().is_none()).then_some(child)
}
fn declaration_result(
	buffer: &CodeBuffer,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> NavigateResult {
	result_for_node(
		buffer,
		node,
		declaration_name(&buffer.source(), node, decl),
		Some(decl.kind.clone()),
	)
}
fn parent_result(buffer: &CodeBuffer, node: Node<'_>) -> Result<NavigateResult> {
	Ok(node_result(
		buffer,
		node
			.parent()
			.ok_or_else(|| CodeEngineError::Buffer("no parent node".into()))?,
	))
}
fn siblings_result(buffer: &CodeBuffer, node: Node<'_>) -> NavigateResult {
	let items = node
		.parent()
		.map(|parent| {
			let mut cursor = parent.walk();
			parent
				.named_children(&mut cursor)
				.map(|child| NavigateItem {
					node_type: child.kind().to_string(),
					text:      first_line(&node_text(buffer, child), 80),
					line:      (child.start_position().row + 1) as u32,
					end_line:  (child.end_position().row + 1) as u32,
				})
				.collect()
		})
		.unwrap_or_default();
	node_result(buffer, node).with_items(items)
}
fn children_result(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	node: Node<'_>,
) -> NavigateResult {
	let items = class_member_nodes(profile, node, &buffer.source())
		.into_iter()
		.map(|child| NavigateItem {
			node_type: child.kind().to_string(),
			text:      first_line(&node_text(buffer, child), 80),
			line:      (child.start_position().row + 1) as u32,
			end_line:  (child.end_position().row + 1) as u32,
		})
		.collect();
	node_result(buffer, node).with_items(items)
}
fn references_result(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	symbol: &str,
) -> NavigateResult {
	let mut refs = BTreeSet::new();
	collect_references(buffer, profile, buffer.tree().root_node(), symbol, &mut refs);
	NavigateResult {
		node_type:                "references".into(),
		text:                     symbol.to_string(),
		line:                     1,
		end_line:                 1,
		column:                   0,
		parent_type:              None,
		editable_scope_node_type: None,
		editable_scope_line:      None,
		editable_scope_end_line:  None,
		editable_scope_column:    None,
		name:                     None,
		kind:                     None,
		items:                    vec![],
		references:               refs.into_iter().collect(),
	}
}
fn collect_references(
	buffer: &CodeBuffer,
	profile: &LanguageProfile,
	node: Node<'_>,
	symbol: &str,
	out: &mut BTreeSet<u32>,
) {
	if let Some(pattern) = reference_pattern_for(profile, node)
		&& node_text(buffer, node) == symbol
		&& !excluded(node, Some(pattern))
	{
		out.insert((node.start_position().row + 1) as u32);
	}
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		collect_references(buffer, profile, child, symbol, out);
	}
}
fn excluded(node: Node<'_>, pattern: Option<&ReferencePattern>) -> bool {
	let Some(pattern) = pattern else {
		return false;
	};
	let mut current = Some(node);
	while let Some(node) = current {
		if pattern
			.exclude_parent_types
			.iter()
			.any(|kind| kind == node.kind())
		{
			return true;
		}
		current = node.parent();
	}
	false
}
fn reference_pattern_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
) -> Option<&'a ReferencePattern> {
	profile
		.references
		.iter()
		.find(|pattern| pattern.node_type == node.kind())
}
fn slice(buffer: &CodeBuffer, node: Node<'_>) -> Option<String> {
	buffer
		.source()
		.get(node.start_byte()..node.end_byte())
		.map(ToString::to_string)
}
fn node_text(buffer: &CodeBuffer, node: Node<'_>) -> String {
	slice(buffer, node).unwrap_or_default()
}
fn first_line(text: &str, max: usize) -> String {
	text
		.lines()
		.next()
		.unwrap_or("")
		.chars()
		.take(max)
		.collect()
}
trait WithItems {
	fn with_items(self, items: Vec<NavigateItem>) -> Self;
}
impl WithItems for NavigateResult {
	fn with_items(mut self, items: Vec<NavigateItem>) -> Self {
		self.items = items;
		self
	}
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
	fn test_navigate_html_defun_at() {
		let buf = buffer("hello.html", "html");
		let p = profile("html");
		let defun = navigate(&buf, &p, NavigateAction::DefunAt, 6, Some(5), None).expect("nav");
		assert_eq!(defun.name.as_deref(), Some("button#save"));
		assert_eq!(defun.kind.as_deref(), Some("element"));
	}

	#[test]
	fn test_navigate_css_defun_at() {
		let buf = buffer("hello.css", "css");
		let p = profile("css");
		let defun = navigate(&buf, &p, NavigateAction::DefunAt, 3, Some(1), None).expect("nav");
		assert_eq!(defun.name.as_deref(), Some(".btn, .link"));
		assert_eq!(defun.kind.as_deref(), Some("rule"));
	}

	#[test]
	fn test_navigate_node_at() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		let r = navigate(&buf, &p, NavigateAction::NodeAt, 1, Some(1), None).expect("nav");
		assert_eq!(r.node_type, "export_statement");
	}

	#[test]
	fn test_navigate_node_at_whitespace() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		assert!(navigate(&buf, &p, NavigateAction::NodeAt, 2, Some(0), None).is_ok());
	}

	#[test]
	fn test_navigate_node_at_last_content_line_with_trailing_newline() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		assert!(navigate(&buf, &p, NavigateAction::NodeAt, 3, Some(1), None).is_ok());
		assert!(navigate(&buf, &p, NavigateAction::NodeAt, 4, Some(1), None).is_err());
	}

	#[test]
	fn test_navigate_defun_at() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		let r = navigate(&buf, &p, NavigateAction::DefunAt, 1, Some(1), None).expect("nav");
		assert_eq!(r.name.as_deref(), Some("greet"));
	}

	#[test]
	fn test_navigate_typst_defun_at_code_wrapper() {
		let buf = buffer("hello.typ", "typst");
		let p = profile("typst");
		let r = navigate(&buf, &p, NavigateAction::DefunAt, 2, Some(5), None).expect("nav");
		assert_eq!(r.name.as_deref(), Some("title"));
		assert_eq!(r.kind.as_deref(), Some("let"));
	}

	#[test]
	fn test_navigate_siblings() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		let r = navigate(&buf, &p, NavigateAction::Siblings, 3, Some(1), None).expect("nav");
		assert!(r.items.len() >= 2);
	}

	#[test]
	fn test_navigate_references() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		let r =
			navigate(&buf, &p, NavigateAction::References, 1, Some(1), Some("greet")).expect("nav");
		assert!(r.references.contains(&1));
		assert!(r.references.contains(&3));
	}

	#[test]
	fn test_navigate_typst_references() {
		let buf = buffer("hello.typ", "typst");
		let p = profile("typst");
		let r =
			navigate(&buf, &p, NavigateAction::References, 2, Some(5), Some("title")).expect("nav");
		assert_eq!(r.references, vec![2, 5]);
	}
	#[test]
	fn test_navigate_typst_node_at_reports_editable_scope_for_set() {
		let buf = buffer("typst_edit_targets.typ", "typst");
		let p = profile("typst");
		let r = navigate(&buf, &p, NavigateAction::NodeAt, 1, Some(1), None).expect("nav");
		assert_eq!(r.node_type, "set");
		assert_eq!(r.editable_scope_node_type.as_deref(), Some("code"));
		assert_eq!(r.editable_scope_line, Some(1));
		assert_eq!(r.editable_scope_end_line, Some(4));
	}

	#[test]
	fn test_navigate_typst_node_at_reports_editable_scope_for_single_line_let() {
		let buf = buffer("typst_edit_targets.typ", "typst");
		let p = profile("typst");
		let r = navigate(&buf, &p, NavigateAction::NodeAt, 7, Some(1), None).expect("nav");
		assert_eq!(r.node_type, "let");
		assert_eq!(r.editable_scope_node_type.as_deref(), Some("code"));
		assert_eq!(r.editable_scope_line, Some(7));
		assert_eq!(r.editable_scope_end_line, Some(7));
	}

	#[test]
	fn test_navigate_typst_node_at_reports_editable_scope_for_multiline_let() {
		let buf = buffer("typst_edit_targets.typ", "typst");
		let p = profile("typst");
		let r = navigate(&buf, &p, NavigateAction::NodeAt, 11, Some(1), None).expect("nav");
		assert_eq!(r.node_type, "let");
		assert_eq!(r.editable_scope_node_type.as_deref(), Some("code"));
		assert_eq!(r.editable_scope_line, Some(11));
		assert_eq!(r.editable_scope_end_line, Some(13));
	}

	#[test]
	fn test_navigate_typst_comment_stays_comment() {
		let buf = buffer("typst_edit_targets.typ", "typst");
		let p = profile("typst");
		let r = navigate(&buf, &p, NavigateAction::NodeAt, 6, Some(1), None).expect("nav");
		assert_eq!(r.node_type, "comment");
		assert_ne!(r.node_type, "source_file");
		assert_eq!(r.editable_scope_node_type.as_deref(), Some("comment"));
		assert_eq!(r.editable_scope_line, Some(6));
		assert_eq!(r.editable_scope_end_line, Some(6));
	}

	#[test]
	fn test_navigate_typescript_raw_kind_is_additive_compatible() {
		let buf = buffer("hello.ts", "typescript");
		let p = profile("typescript");
		let r = navigate(&buf, &p, NavigateAction::NodeAt, 1, Some(1), None).expect("nav");
		assert_eq!(r.node_type, "export_statement");
		assert_eq!(r.editable_scope_node_type.as_deref(), Some("export_statement"));
		assert_eq!(r.editable_scope_line, Some(1));
		assert_eq!(r.editable_scope_end_line, Some(1));
	}
}
