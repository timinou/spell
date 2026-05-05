//! CSS NameLexer (selector subset).
//!
//! Per `specs/code-graph/code-path-dialects/07-css.md`. Names are CSS
//! selectors: `.class`, `#id`, `tag.class`, `[attr='val']`. Pseudo-classes
//! are deferred to a future iteration (interaction with kernel `:` axis).

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
pub struct CssName {
	pub raw: String,
}

pub struct CssNameLexer;

impl NameLexer for CssNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		let mut buf = String::new();
		let mut bracket_depth: i32 = 0;
		let mut chars = input.char_indices();
		let mut consumed = 0;
		for (idx, c) in chars.by_ref() {
			if bracket_depth > 0 {
				if c == ']' {
					bracket_depth -= 1;
				}
				if c == '[' {
					bracket_depth += 1;
				}
				buf.push(c);
				consumed = idx + c.len_utf8();
				continue;
			}
			match c {
				'[' if input
					.get(idx + c.len_utf8()..)
					.map_or(false, |rest| !rest.starts_with('¶')) =>
				{
					bracket_depth += 1;
					buf.push(c);
					consumed = idx + c.len_utf8();
				},
				'[' => break,
				'/' => break,
				' ' | '\t' | '\n' | '\r' => break,
				'#' if !buf.is_empty() => break,
				ch => {
					buf.push(ch);
					consumed = idx + ch.len_utf8();
				},
			}
		}
		if buf.is_empty() {
			return Err(winnow::error::ContextError::default());
		}
		if bracket_depth != 0 {
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
		if rendered == "*" {
			return true;
		}
		if node.kind() == "rule_set" {
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "selectors" {
					if let Some(text) = src.get(child.start_byte()..child.end_byte()) {
						return text.trim() == rendered;
					}
				}
			}
		}
		false
	}
}

// ── Helpers ─────────────────────────────────────────────────────

fn find_child_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	node.children(&mut cursor).find(|c| c.kind() == kind)
}

fn declaration_block(node: Node<'_>) -> Option<Node<'_>> {
	if node.kind() == "block" {
		return Some(node);
	}
	find_child_kind(node, "block")
}

fn find_declaration_in_block<'a>(block: Node<'a>, src: &str, prop_name: &str) -> Option<Node<'a>> {
	let mut result = None;
	let mut cursor = block.walk();
	for child in block.children(&mut cursor) {
		if child.kind() == "declaration" {
			if let Some(prop) = find_child_kind(child, "property_name") {
				if let Some(text) = src.get(prop.start_byte()..prop.end_byte()) {
					if text.trim() == prop_name {
						result = Some(child);
					}
				}
			}
		}
	}
	result
}

fn extract_value(node: Node<'_>, src: &str) -> Option<Range<usize>> {
	if node.kind() != "declaration" {
		return None;
	}
	let mut colon_end = None;
	let mut end = node.end_byte();
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == ":" && colon_end.is_none() {
			colon_end = Some(child.end_byte());
		}
		if child.kind() == "important" || child.kind() == ";" {
			if colon_end.is_some() {
				end = child.start_byte();
				break;
			}
		}
	}
	let start = colon_end?;
	let value_text = src.get(start..end)?;
	let trimmed = value_text.trim_start();
	let trim_start = start + (value_text.len() - trimmed.len());
	let trimmed_end = trimmed.trim_end();
	let trim_end = trim_start + trimmed_end.len();
	if trim_start < trim_end {
		Some(trim_start..trim_end)
	} else {
		None
	}
}

// ── Anchors and qualifiers ──────────────────────────────────────

mod qualifiers {
	use std::ops::Range;

	use tree_sitter::Node;

	use crate::dialect::QualifierResolver;

	pub struct Selector;
	impl QualifierResolver for Selector {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			if node.kind() == "selectors" {
				return Some(node.start_byte()..node.end_byte());
			}
			let mut cursor = node.walk();
			node
				.children(&mut cursor)
				.find(|c| c.kind() == "selectors")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Declaration;
	impl QualifierResolver for Declaration {
		fn resolve(&self, node: Node<'_>, src: &str, args: Option<&str>) -> Option<Range<usize>> {
			let prop_name = args?;
			if node.kind() == "declaration" {
				if let Some(prop) = super::find_child_kind(node, "property_name") {
					if let Some(text) = src.get(prop.start_byte()..prop.end_byte()) {
						if text.trim() == prop_name {
							return Some(node.start_byte()..node.end_byte());
						}
					}
				}
				return None;
			}
			let block = super::declaration_block(node)?;
			super::find_declaration_in_block(block, src, prop_name)
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Value;
	impl QualifierResolver for Value {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			if node.kind() == "declaration" {
				return super::extract_value(node, src);
			}
			let block = super::declaration_block(node)?;
			let mut cursor = block.walk();
			for child in block.children(&mut cursor) {
				if child.kind() == "declaration" {
					return super::extract_value(child, src);
				}
			}
			None
		}
	}

	pub struct Specificity;
	impl QualifierResolver for Specificity {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			// Return selectors range; computed specificity triple deferred.
			// TODO: emit Diagnostic noting Content::Text computed values not yet supported.
			if node.kind() == "selectors" {
				return Some(node.start_byte()..node.end_byte());
			}
			let mut cursor = node.walk();
			node
				.children(&mut cursor)
				.find(|c| c.kind() == "selectors")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Important;
	impl QualifierResolver for Important {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			if node.kind() != "declaration" {
				return None;
			}
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "important" {
					return Some(child.start_byte()..child.end_byte());
				}
			}
			None
		}
	}

	pub struct Prelude;
	impl QualifierResolver for Prelude {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if matches!(child.kind(), "block" | "keyframe_block_list") {
					return Some(node.start_byte()..child.start_byte());
				}
			}
			None
		}
	}
}

pub fn css_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(CssNameLexer),
		anchors:    vec![
			AnchorPattern {
				name:    "custom-prop",
				matcher: |n, src| {
					if n.kind() != "declaration" {
						return false;
					}
					let mut cursor = n.walk();
					for child in n.children(&mut cursor) {
						if child.kind() == "property_name" {
							if let Some(text) = src.get(child.start_byte()..child.end_byte()) {
								return text.trim_start().starts_with("--");
							}
							break;
						}
					}
					false
				},
			},
			AnchorPattern {
				name:    "important",
				matcher: |n, _src| {
					if n.kind() != "declaration" {
						return false;
					}
					let mut cursor = n.walk();
					n.children(&mut cursor).any(|c| c.kind() == "important")
				},
			},
			AnchorPattern {
				name:    "vendor-prefix",
				matcher: |n, src| {
					if n.kind() != "declaration" {
						return false;
					}
					let mut cursor = n.walk();
					for child in n.children(&mut cursor) {
						if child.kind() == "property_name" {
							if let Some(text) = src.get(child.start_byte()..child.end_byte()) {
								let t = text.trim();
								return t.starts_with("-webkit-")
									|| t.starts_with("-moz-")
									|| t.starts_with("-ms-")
									|| t.starts_with("-o-");
							}
							break;
						}
					}
					false
				},
			},
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "selector",
				applies_to: vec!["rule_set".into(), "selectors".into()],
				resolve:    Arc::new(qualifiers::Selector),
			},
			QualifierSpec {
				name:       "declaration",
				applies_to: vec!["rule_set".into(), "block".into(), "declaration".into()],
				resolve:    Arc::new(qualifiers::Declaration),
			},
			QualifierSpec {
				name:       "value",
				applies_to: vec!["rule_set".into(), "block".into(), "declaration".into()],
				resolve:    Arc::new(qualifiers::Value),
			},
			QualifierSpec {
				name:       "specificity",
				applies_to: vec!["rule_set".into(), "selectors".into()],
				resolve:    Arc::new(qualifiers::Specificity),
			},
			QualifierSpec {
				name:       "important",
				applies_to: vec!["declaration".into()],
				resolve:    Arc::new(qualifiers::Important),
			},
			QualifierSpec {
				name:       "prelude",
				applies_to: vec![
					"media_statement".into(),
					"supports_statement".into(),
					"keyframes_statement".into(),
					"at_rule".into(),
					"import_statement".into(),
				],
				resolve:    Arc::new(qualifiers::Prelude),
			},
		],
		edge_kinds: {
			let set = EdgeKindSet::default();
			// TODO: css-var→/extends→/imports→/mixin→/applies-to→ deferred until EdgeKind
			// extension
			set
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_class() {
		let mut input = ".save";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == ".save"));
	}

	#[test]
	fn parse_id() {
		let mut input = "#app";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "#app"));
	}

	#[test]
	fn parse_tag_class() {
		let mut input = "button.save";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "button.save"));
	}

	#[test]
	fn parse_tag_id_via_predicate() {
		let mut input = "div[id=\"main\"]";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "div[id=\"main\"]"));
	}

	#[test]
	fn parse_attribute() {
		let mut input = "input[type='text']";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "input[type='text']"));
	}

	#[test]
	fn parse_data_state() {
		let mut input = "[data-state=\"active\"]";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "[data-state=\"active\"]"));
	}

	#[test]
	fn stops_at_kernel_slash() {
		let mut input = ".save/foo";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == ".save"));
	}

	#[test]
	fn stops_at_qualifier() {
		let mut input = "button#block";
		let payload = CssNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "button"));
	}

	#[test]
	fn unbalanced_attr_rejected() {
		let mut input = "input[type='text'";
		let result = CssNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = css_dialect();
		assert_eq!(d.anchors.len(), 3);
		assert_eq!(d.qualifiers.len(), 6);
	}
}
