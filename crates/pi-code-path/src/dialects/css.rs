//! CSS NameLexer (selector subset).
//!
//! Per `specs/code-graph/code-path-dialects/07-css.md`. Names are CSS
//! selectors: `.class`, `#id`, `tag.class`, `[attr='val']`. Pseudo-classes
//! are deferred to a future iteration (interaction with kernel `:` axis).

use std::ops::Range;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::ast::NamePayload;
use crate::dialect::{
	AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierResolver, QualifierSpec,
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
				'[' => {
					bracket_depth += 1;
					buf.push(c);
					consumed = idx + c.len_utf8();
				},
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
		}
	}

	fn matches(&self, _n: &NamePayload, _node: Node<'_>, _src: &str) -> bool {
		false
	}
}

struct StubResolver;
impl QualifierResolver for StubResolver {
	fn resolve(
		&self,
		_node: Node<'_>,
		_src: &str,
		_args: Option<&str>,
	) -> Option<Range<usize>> {
		Some(0..0)
	}
}

fn match_kind(node: &Node<'_>, kinds: &[&str]) -> bool {
	kinds.contains(&node.kind())
}

pub fn css_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(CssNameLexer),
		anchors: vec![
			AnchorPattern { name: "at-rule", matcher: |n, _s| match_kind(n, &["at_rule"]) },
			AnchorPattern { name: "media-query", matcher: |n, _s| match_kind(n, &["media_query"]) },
			AnchorPattern {
				name:    "custom-property",
				matcher: |n, _s| match_kind(n, &["declaration"]),
			},
			AnchorPattern {
				name:    "keyframe",
				matcher: |n, _s| match_kind(n, &["keyframe_block"]),
			},
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "block",
				applies_to: vec!["rule_set".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "declarations",
				applies_to: vec!["rule_set".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "selector-text",
				applies_to: vec!["rule_set".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "property",
				applies_to: vec!["declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
		],
		edge_kinds: EdgeKindSet::default(),
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
		// `div#main` would conflict with kernel qualifier `#main`; use predicate form.
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
		assert_eq!(d.anchors.len(), 4);
		assert_eq!(d.qualifiers.len(), 4);
	}
}
