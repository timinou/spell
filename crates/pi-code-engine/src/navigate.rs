use std::collections::BTreeSet;

use tree_sitter::Node;

use crate::{buffer::CodeBuffer, error::{CodeEngineError, Result}, language::{DeclarationPattern, LanguageProfile, ReferencePattern}};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigateAction { NodeAt, DefunAt, Parent, Siblings, Children, References }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NavigateItem { pub node_type: String, pub text: String, pub line: u32, pub end_line: u32 }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NavigateResult { pub node_type: String, pub text: String, pub line: u32, pub end_line: u32, pub column: u32, pub parent_type: Option<String>, pub name: Option<String>, pub kind: Option<String>, pub items: Vec<NavigateItem>, pub references: Vec<u32> }

pub fn navigate(buffer: &CodeBuffer, profile: &LanguageProfile, action: NavigateAction, line: u32, column: Option<u32>, symbol: Option<&str>) -> Result<NavigateResult> {
	let node = node_at(buffer, line, column)?;
	match action { NavigateAction::NodeAt => Ok(node_result(buffer, node)), NavigateAction::DefunAt => defun_at(buffer, profile, node), NavigateAction::Parent => parent_result(buffer, node), NavigateAction::Siblings => Ok(siblings_result(buffer, node)), NavigateAction::Children => Ok(children_result(buffer, profile, node)), NavigateAction::References => Ok(references_result(buffer, profile, symbol.unwrap_or(&node_text(buffer, node)))) }
}

fn node_at(buffer: &CodeBuffer, line: u32, column: Option<u32>) -> Result<Node<'_>> {
	let source = buffer.source();
	let total_lines = source.lines().count() as u32;
	if line == 0 || line > total_lines { return Err(CodeEngineError::Buffer("line out of range".into())); }
	let byte = buffer.rope().line_to_byte_idx((line - 1) as usize, ropey::LineType::LF_CR) + column.unwrap_or(0) as usize;
	let mut node = buffer.tree().root_node().descendant_for_byte_range(byte, byte).ok_or_else(|| CodeEngineError::Buffer("node not found".into()))?;
	while !node.is_named() || node.is_extra() { if let Some(parent) = node.parent() { node = parent; } else { break; } }
	Ok(node)
}

fn node_result(buffer: &CodeBuffer, node: Node<'_>) -> NavigateResult { NavigateResult { node_type: node.kind().to_string(), text: first_line(&node_text(buffer, node), 80), line: (node.start_position().row + 1) as u32, end_line: (node.end_position().row + 1) as u32, column: node.start_position().column as u32, parent_type: node.parent().map(|p| p.kind().to_string()), name: None, kind: None, items: vec![], references: vec![] } }

fn defun_at(buffer: &CodeBuffer, profile: &LanguageProfile, mut node: Node<'_>) -> Result<NavigateResult> {
	loop {
		if node.kind() == "export_statement" && let Some(child) = unwrap_export(profile, node) { return Ok(declaration_result(buffer, child, declaration_for(profile, child).expect("decl"))); }
		if let Some(parent) = node.parent() { if let Some(decl) = declaration_for(profile, parent) { return Ok(declaration_result(buffer, parent, decl)); } node = parent; } else { return Err(CodeEngineError::Buffer("no enclosing function".into())); }
	}
}

fn unwrap_export<'a>(profile: &'a LanguageProfile, node: Node<'a>) -> Option<Node<'a>> { let mut cursor = node.walk(); node.named_children(&mut cursor).find(|child| declaration_for(profile, *child).is_some()) }
fn declaration_result(buffer: &CodeBuffer, node: Node<'_>, decl: &DeclarationPattern) -> NavigateResult { NavigateResult { node_type: node.kind().to_string(), text: first_line(&node_text(buffer, node), 80), line: (node.start_position().row + 1) as u32, end_line: (node.end_position().row + 1) as u32, column: node.start_position().column as u32, parent_type: node.parent().map(|p| p.kind().to_string()), name: name_text(buffer, node, decl), kind: Some(decl.kind.clone()), items: vec![], references: vec![] } }
fn parent_result(buffer: &CodeBuffer, node: Node<'_>) -> Result<NavigateResult> { Ok(node_result(buffer, node.parent().ok_or_else(|| CodeEngineError::Buffer("no parent node".into()))?)) }
fn siblings_result(buffer: &CodeBuffer, node: Node<'_>) -> NavigateResult { let items = node.parent().map(|parent| { let mut cursor = parent.walk(); parent.named_children(&mut cursor).map(|child| NavigateItem { node_type: child.kind().to_string(), text: first_line(&node_text(buffer, child), 80), line: (child.start_position().row + 1) as u32, end_line: (child.end_position().row + 1) as u32 }).collect() }).unwrap_or_default(); node_result(buffer, node).with_items(items) }
fn children_result(buffer: &CodeBuffer, profile: &LanguageProfile, node: Node<'_>) -> NavigateResult { let items = profile.class_like.iter().find(|c| c.node_type == node.kind()).and_then(|class_like| node.child_by_field_name(&class_like.body_field)).map(|body| { let mut cursor = body.walk(); body.named_children(&mut cursor).map(|child| NavigateItem { node_type: child.kind().to_string(), text: first_line(&node_text(buffer, child), 80), line: (child.start_position().row + 1) as u32, end_line: (child.end_position().row + 1) as u32 }).collect() }).unwrap_or_default(); node_result(buffer, node).with_items(items) }
fn references_result(buffer: &CodeBuffer, profile: &LanguageProfile, symbol: &str) -> NavigateResult { let mut refs = BTreeSet::new(); collect_references(buffer, profile, buffer.tree().root_node(), symbol, &mut refs); NavigateResult { node_type: "references".into(), text: symbol.to_string(), line: 1, end_line: 1, column: 0, parent_type: None, name: None, kind: None, items: vec![], references: refs.into_iter().collect() } }
fn collect_references(buffer: &CodeBuffer, profile: &LanguageProfile, node: Node<'_>, symbol: &str, out: &mut BTreeSet<u32>) { if node.kind() == "identifier" && node_text(buffer, node) == symbol && !excluded(node, profile.references.first()) { out.insert((node.start_position().row + 1) as u32); } let mut cursor = node.walk(); for child in node.named_children(&mut cursor) { collect_references(buffer, profile, child, symbol, out); } }
fn excluded(node: Node<'_>, pattern: Option<&ReferencePattern>) -> bool { let Some(pattern) = pattern else { return false; }; let mut current = Some(node); while let Some(node) = current { if pattern.exclude_parent_types.iter().any(|kind| kind == node.kind()) { return true; } current = node.parent(); } false }
fn declaration_for<'a>(profile: &'a LanguageProfile, node: Node<'_>) -> Option<&'a DeclarationPattern> { profile.declarations.iter().find(|decl| decl.node_types.iter().any(|kind| kind == node.kind())) }
fn name_text(buffer: &CodeBuffer, node: Node<'_>, decl: &DeclarationPattern) -> Option<String> { node.child_by_field_name(&decl.name_field).and_then(|n| slice(buffer, n)).map(|s| s.trim().to_string()) }
fn slice(buffer: &CodeBuffer, node: Node<'_>) -> Option<String> { buffer.source().get(node.start_byte()..node.end_byte()).map(ToString::to_string) }
fn node_text(buffer: &CodeBuffer, node: Node<'_>) -> String { slice(buffer, node).unwrap_or_default() }
fn first_line(text: &str, max: usize) -> String { text.lines().next().unwrap_or("").chars().take(max).collect() }
trait WithItems { fn with_items(self, items: Vec<NavigateItem>) -> Self; }
impl WithItems for NavigateResult { fn with_items(mut self, items: Vec<NavigateItem>) -> Self { self.items = items; self } }

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{language::{LanguageId, LanguageRegistry}, CodeBuffer};
	use std::{fs, sync::Arc};

	fn fixture_path() -> String { format!("{}/tests/fixtures/sources/hello.ts", env!("CARGO_MANIFEST_DIR")) }
	fn registry() -> Arc<LanguageRegistry> { Arc::new(LanguageRegistry::with_builtins().expect("registry")) }
	fn profile() -> LanguageProfile { registry().get(&LanguageId::new("typescript")).expect("profile").clone() }
	fn buffer() -> CodeBuffer { CodeBuffer::from_str(&fs::read_to_string(fixture_path()).expect("fixture"), LanguageId::new("typescript"), registry()).expect("buffer") }

	#[test]
	fn test_navigate_node_at() { let buf = buffer(); let p = profile(); let r = navigate(&buf, &p, NavigateAction::NodeAt, 1, Some(1), None).expect("nav"); assert_eq!(r.node_type, "export_statement"); }
	#[test]
	fn test_navigate_node_at_whitespace() { let buf = buffer(); let p = profile(); assert!(navigate(&buf, &p, NavigateAction::NodeAt, 2, Some(0), None).is_ok()); }
	#[test]
	fn test_navigate_defun_at() { let buf = buffer(); let p = profile(); let r = navigate(&buf, &p, NavigateAction::DefunAt, 1, Some(1), None).expect("nav"); assert_eq!(r.name.as_deref(), Some("greet")); }
	#[test]
	fn test_navigate_siblings() { let buf = buffer(); let p = profile(); let r = navigate(&buf, &p, NavigateAction::Siblings, 3, Some(1), None).expect("nav"); assert!(r.items.len() >= 2); }
	#[test]
	fn test_navigate_references() { let buf = buffer(); let p = profile(); let r = navigate(&buf, &p, NavigateAction::References, 1, Some(1), Some("greet")).expect("nav"); assert!(r.references.contains(&1)); assert!(r.references.contains(&3)); }
}
