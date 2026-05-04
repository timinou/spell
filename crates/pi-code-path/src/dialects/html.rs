//! HTML NameLexer (XPath-subset payload).
//!
//! Per `specs/code-graph/code-path-dialects/06-html.md`. Names are XPath
//! expressions: `button`, `[@class='foo']`, `#app`, `.save`, `//descendant`.
//!
//! The parsed payload is preserved verbatim (`HtmlName.raw`); semantic
//! interpretation is deferred to the resolver layer (PROJ-066).

use std::ops::Range;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::ast::NamePayload;
use crate::dialect::{
	AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierResolver, QualifierSpec,
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

pub fn html_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(HtmlNameLexer),
		anchors: vec![
			AnchorPattern { name: "hook-deps", matcher: |n, _s| match_kind(n, &["element"]) },
			AnchorPattern { name: "interactive", matcher: |n, _s| match_kind(n, &["element"]) },
			AnchorPattern { name: "aria-live", matcher: |n, _s| match_kind(n, &["element"]) },
			AnchorPattern { name: "landmark", matcher: |n, _s| match_kind(n, &["element"]) },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "innerHTML",
				applies_to: vec!["element".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "outerHTML",
				applies_to: vec!["element".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "text",
				applies_to: vec!["element".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "attr",
				applies_to: vec!["element".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "tag-name",
				applies_to: vec!["element".into()],
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
		assert_eq!(d.anchors.len(), 4);
		assert_eq!(d.qualifiers.len(), 5);
	}
}
