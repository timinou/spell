//! Markdown / Org NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/08-markdown-org.md`. Names are
//! heading text (possibly quoted with `"…"` to embed spaces) or list-item
//! positions (`item.3.subitem.5`).

use std::ops::Range;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tree_sitter::Node;
use winnow::Parser;
use winnow::token::take_while;

use crate::ast::NamePayload;
use crate::dialect::{
	AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierResolver, QualifierSpec,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MdName {
	pub segments: Vec<MdSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MdSegment {
	Heading(String),
	QuotedHeading(String),
	ListItem(usize),
}

pub struct MdNameLexer;

impl NameLexer for MdNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		let mut segments = Vec::new();
		let first = parse_segment(input)?;
		segments.push(first);
		while input.starts_with('.') {
			let snapshot = *input;
			*input = &input[1..];
			match parse_segment(input) {
				Ok(seg) => segments.push(seg),
				Err(_) => {
					*input = snapshot;
					break;
				},
			}
		}
		Ok(NamePayload::Raw(render_segments(&segments)))
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

fn parse_segment(input: &mut &str) -> winnow::Result<MdSegment> {
	if input.starts_with('"') {
		return parse_quoted(input);
	}
	let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '-')
		.parse_next(input)?;
	if let Ok(n) = s.parse::<usize>() {
		Ok(MdSegment::ListItem(n))
	} else {
		Ok(MdSegment::Heading(s.to_string()))
	}
}

fn parse_quoted(input: &mut &str) -> winnow::Result<MdSegment> {
	let snapshot = *input;
	*input = &input[1..]; // consume opening "
	let mut buf = String::new();
	let mut chars = input.char_indices();
	let mut consumed = 0;
	let mut closed = false;
	while let Some((idx, c)) = chars.next() {
		match c {
			'"' => {
				closed = true;
				consumed = idx + 1;
				break;
			},
			'\\' => {
				if let Some((idx2, esc)) = chars.next() {
					buf.push(match esc {
						'"' => '"',
						'\\' => '\\',
						'n' => '\n',
						't' => '\t',
						other => other,
					});
					consumed = idx2 + esc.len_utf8();
				}
			},
			ch => {
				buf.push(ch);
				consumed = idx + ch.len_utf8();
			},
		}
	}
	if !closed || buf.is_empty() {
		*input = snapshot;
		return Err(winnow::error::ContextError::default());
	}
	*input = &input[consumed..];
	Ok(MdSegment::QuotedHeading(buf))
}

fn render_segments(segs: &[MdSegment]) -> String {
	segs.iter()
		.map(|s| match s {
			MdSegment::Heading(h) => h.clone(),
			MdSegment::QuotedHeading(q) => format!("\"{}\"", q.replace('\\', "\\\\").replace('"', "\\\"")),
			MdSegment::ListItem(n) => n.to_string(),
		})
		.collect::<Vec<_>>()
		.join(".")
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

pub fn markdown_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(MdNameLexer),
		anchors: vec![
			AnchorPattern { name: "code-block", matcher: |n, _s| match_kind(n, &["code_fence_content", "fenced_code_block"]) },
			AnchorPattern { name: "quote", matcher: |n, _s| match_kind(n, &["block_quote"]) },
			AnchorPattern { name: "task-item", matcher: |n, _s| match_kind(n, &["task_list_item"]) },
			AnchorPattern { name: "link", matcher: |n, _s| match_kind(n, &["link"]) },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["section".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "heading-level",
				applies_to: vec!["atx_heading".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "code-block-content",
				applies_to: vec!["fenced_code_block".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "section",
				applies_to: vec!["section".into()],
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
	fn parse_simple_heading() {
		let mut input = "Installation";
		let payload = MdNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Installation"));
	}

	#[test]
	fn parse_quoted_heading() {
		let mut input = "\"Quick start\"";
		let payload = MdNameLexer.parse(&mut input).unwrap();
		// Re-rendered with escapes; should round-trip via NamePayload::Raw.
		match payload {
			NamePayload::Raw(s) => assert_eq!(s, "\"Quick start\""),
		}
	}

	#[test]
	fn parse_nested_heading() {
		let mut input = "Foo.Bar";
		let payload = MdNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo.Bar"));
	}

	#[test]
	fn parse_list_position() {
		let mut input = "item.3.subitem.5";
		let payload = MdNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "item.3.subitem.5"));
	}

	#[test]
	fn parse_quoted_with_escape() {
		let mut input = "\"He said \\\"hi\\\"\"";
		let payload = MdNameLexer.parse(&mut input).unwrap();
		// Round-trip: the rendered form should preserve the escapes.
		match payload {
			NamePayload::Raw(s) => assert_eq!(s, "\"He said \\\"hi\\\"\""),
		}
	}

	#[test]
	fn unterminated_quote_rejected() {
		let mut input = "\"unterminated";
		let result = MdNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn stops_at_kernel_slash() {
		let mut input = "Heading/sub";
		let payload = MdNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Heading"));
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = markdown_dialect();
		assert_eq!(d.anchors.len(), 4);
		assert_eq!(d.qualifiers.len(), 4);
	}
}
