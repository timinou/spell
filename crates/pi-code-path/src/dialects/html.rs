//! HTML NameLexer (XPath-subset payload).
//!
//! Per `specs/code-graph/code-path-dialects/06-html.md`. Names are XPath
//! expressions: `button`, `[@class='foo']`, `#app`, `.save`, `//descendant`.
//!
//! The parsed payload is preserved verbatim (`HtmlName.raw`); semantic
//! interpretation is deferred to the resolver layer (PROJ-066).

use std::{ops::Range, sync::Arc};

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::{
	ast::NamePayload,
	dialect::{
		AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierResolver, QualifierSpec,
	},
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HtmlName {
	pub raw: String,
}

pub struct HtmlNameLexer;

impl NameLexer for HtmlNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		// Collect characters allowed inside the HTML payload. Stops at:
		//   - top-level `/` that is NOT part of `//` (XPath descendant axis),
		//   - whitespace,
		//   - `#` qualifier sigil (when not inside a predicate).
		// Maintains balanced bracket depth for `[…]` predicates.
		let bytes = input.as_bytes();
		let mut buf = String::new();
		let mut bracket_depth: i32 = 0;
		let mut consumed = 0;
		let mut prev: Option<char> = None;
		let mut idx = 0;
		while idx < bytes.len() {
			let c = bytes[idx] as char;
			if bracket_depth > 0 {
				if c == ']' {
					bracket_depth -= 1;
				} else if c == '[' {
					bracket_depth += 1;
				}
				buf.push(c);
				consumed = idx + 1;
				prev = Some(c);
				idx += 1;
				continue;
			}
			match c {
				'[' => {
					bracket_depth += 1;
					buf.push(c);
					consumed = idx + 1;
					prev = Some(c);
					idx += 1;
				},
				'/' if input[idx..].starts_with("//") => {
					// XPath descendant axis: take both slashes.
					buf.push('/');
					buf.push('/');
					consumed = idx + 2;
					prev = Some('/');
					idx += 2;
				},
				'/' => break,
				' ' | '\t' | '\n' | '\r' => break,
				'#' if prev != Some(']') && !buf.is_empty() => break,
				ch => {
					buf.push(ch);
					consumed = idx + 1;
					prev = Some(ch);
					idx += 1;
				},
			}
		}
		if buf.is_empty() || bracket_depth != 0 {
			return Err(winnow::error::ContextError::default());
		}
		*input = &input[consumed..];
		Ok(NamePayload::Raw(buf))
	}

	fn render(&self, n: &NamePayload) -> String {
		match n {
			NamePayload::Raw(s) => s.clone(),
			NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(&self, n: &NamePayload, node: Node<'_>, src: &str) -> bool {
		let rendered = self.render(n);
		if rendered.contains('/') || rendered.contains('[') || rendered.starts_with('@') {
			return false;
		}
		if !matches!(node.kind(), "element" | "script_element" | "style_element") {
			return false;
		}
		if let Some(tag) = find_start_tag(node) {
			if let Some(tag_name) = find_tag_name(tag) {
				if let Some(text) = src.get(tag_name.start_byte()..tag_name.end_byte()) {
					return text == rendered;
				}
			}
		}
		false
	}
}

// ── Helpers ─────────────────────────────────────────────────────

fn find_start_tag(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == "start_tag" || child.kind() == "self_closing_tag" {
			return Some(child);
		}
	}
	None
}

fn find_end_tag(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == "end_tag" {
			return Some(child);
		}
	}
	None
}

fn find_tag_name(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == "tag_name" {
			return Some(child);
		}
	}
	None
}

fn find_attribute_name(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == "attribute_name" {
			return Some(child);
		}
	}
	None
}

// ── Anchors and qualifiers ──────────────────────────────────────

pub mod qualifiers {
	use std::ops::Range;

	use tree_sitter::Node;

	use super::{find_attribute_name, find_end_tag, find_start_tag, find_tag_name};
	use crate::dialect::QualifierResolver;

	pub struct InnerHTML;
	impl QualifierResolver for InnerHTML {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let start_tag = find_start_tag(node)?;
			let end_tag = find_end_tag(node);
			match end_tag {
				Some(et) => Some(start_tag.end_byte()..et.start_byte()),
				None => Some(start_tag.end_byte()..start_tag.end_byte()),
			}
		}
	}

	pub struct OuterHTML;
	impl QualifierResolver for OuterHTML {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			Some(node.start_byte()..node.end_byte())
		}
	}

	pub struct Text;
	impl QualifierResolver for Text {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut first: Option<usize> = None;
			let mut last: Option<usize> = None;
			let mut stack = vec![node];
			while let Some(n) = stack.pop() {
				if n.kind() == "text" || n.kind() == "raw_text" {
					if first.is_none() || n.start_byte() < first.unwrap() {
						first = Some(n.start_byte());
					}
					if last.is_none() || n.end_byte() > last.unwrap() {
						last = Some(n.end_byte());
					}
				}
				let mut cursor = n.walk();
				for child in n.children(&mut cursor) {
					stack.push(child);
				}
			}
			match (first, last) {
				(Some(f), Some(l)) => Some(f..l),
				_ => Some(node.end_byte()..node.end_byte()),
			}
		}
	}

	pub struct Attr;
	impl QualifierResolver for Attr {
		fn resolve(&self, node: Node<'_>, src: &str, args: Option<&str>) -> Option<Range<usize>> {
			let target_name = args?;
			let tag = find_start_tag(node)?;
			let mut cursor = tag.walk();
			for child in tag.children(&mut cursor) {
				if child.kind() == "attribute" {
					if let Some(attr_name_node) = find_attribute_name(child) {
						if let Some(name_text) =
							src.get(attr_name_node.start_byte()..attr_name_node.end_byte())
						{
							if name_text == target_name {
								let mut attr_cursor = child.walk();
								for attr_child in child.children(&mut attr_cursor) {
									if attr_child.kind() == "quoted_attribute_value" {
										return Some(attr_child.start_byte()..attr_child.end_byte());
									}
								}
							}
						}
					}
				}
			}
			None
		}
	}

	pub struct Tag;
	impl QualifierResolver for Tag {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let tag = find_start_tag(node)?;
			find_tag_name(tag).map(|n| n.start_byte()..n.end_byte())
		}
	}
}

fn match_kind(node: &Node<'_>, kinds: &[&str]) -> bool {
	kinds.contains(&node.kind())
}

fn has_role_attribute(node: &Node<'_>, src: &str) -> bool {
	let tag = match find_start_tag(*node) {
		Some(t) => t,
		None => return false,
	};
	let mut cursor = tag.walk();
	for child in tag.children(&mut cursor) {
		if child.kind() == "attribute" {
			if let Some(attr_name_node) = find_attribute_name(child) {
				if let Some(name_text) = src.get(attr_name_node.start_byte()..attr_name_node.end_byte())
				{
					if name_text == "role" {
						return true;
					}
				}
			}
		}
	}
	false
}

fn tag_name_text<'a>(node: &Node<'_>, src: &'a str) -> Option<&'a str> {
	let tag = find_start_tag(*node)?;
	let tag_name = find_tag_name(tag)?;
	src.get(tag_name.start_byte()..tag_name.end_byte())
}

pub fn html_dialect() -> LanguageDialect {
	let element_kinds: Vec<String> =
		vec!["element".into(), "script_element".into(), "style_element".into()];
	LanguageDialect {
		name_lexer: Arc::new(HtmlNameLexer),
		anchors:    vec![AnchorPattern {
			name:    "landmark-by-role",
			matcher: |n, src| {
				if !match_kind(n, &["element", "script_element", "style_element"]) {
					return false;
				}
				if has_role_attribute(n, src) {
					return true;
				}
				if let Some(name) = tag_name_text(n, src) {
					return matches!(
						name,
						"header" | "footer" | "main" | "nav" | "aside" | "section" | "article"
					);
				}
				false
			},
		}],
		qualifiers: vec![
			QualifierSpec {
				name:       "innerHTML",
				applies_to: element_kinds.clone(),
				resolve:    Arc::new(qualifiers::InnerHTML),
			},
			QualifierSpec {
				name:       "outerHTML",
				applies_to: element_kinds.clone(),
				resolve:    Arc::new(qualifiers::OuterHTML),
			},
			QualifierSpec {
				name:       "text",
				applies_to: element_kinds.clone(),
				resolve:    Arc::new(qualifiers::Text),
			},
			QualifierSpec {
				name:       "attr",
				applies_to: element_kinds.clone(),
				resolve:    Arc::new(qualifiers::Attr),
			},
			QualifierSpec {
				name:       "tag",
				applies_to: element_kinds.clone(),
				resolve:    Arc::new(qualifiers::Tag),
			},
		],
		edge_kinds: EdgeKindSet::default(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_simple_element() {
		let mut input = "button";
		let payload = HtmlNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "button"));
	}

	#[test]
	fn parse_attribute_predicate() {
		let mut input = "form[@method='post']";
		let payload = HtmlNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "form[@method='post']"));
	}

	#[test]
	fn parse_id_shortcut() {
		let mut input = "#app";
		let payload = HtmlNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "#app"));
	}

	#[test]
	fn parse_class_shortcut() {
		let mut input = "button.save";
		let payload = HtmlNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "button.save"));
	}

	#[test]
	fn parse_descendant_axis() {
		let mut input = "//button";
		let payload = HtmlNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "//button"));
	}

	#[test]
	fn stops_at_qualifier() {
		let mut input = "button#text";
		let payload = HtmlNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "button"));
	}

	#[test]
	fn unbalanced_predicate_rejected() {
		let mut input = "form[@class='foo'";
		let result = HtmlNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = html_dialect();
		assert_eq!(d.anchors.len(), 1);
		assert_eq!(d.qualifiers.len(), 5);
	}
}
