//! Go NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/04-go.md`. Names use `.` separator
//! with `(*Type).Method` and `(Type).Method` receiver-method form.

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
pub struct GoName {
	pub segments: Vec<GoSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GoSegment {
	Ident(String),
	Receiver { ptr: bool, ty: String, method: String },
}

pub struct GoNameLexer;

impl NameLexer for GoNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		// Receiver method: `(*Type).Method` or `(Type).Method`
		if input.starts_with('(') {
			return parse_receiver(input).map(|seg| NamePayload::Raw(render_segment(&seg)));
		}
		let mut segments = Vec::new();
		let first = parse_ident(input)?;
		segments.push(GoSegment::Ident(first));
		while input.starts_with('.') {
			let snapshot = *input;
			*input = &input[1..];
			match parse_ident(input) {
				Ok(s) => segments.push(GoSegment::Ident(s)),
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

fn parse_receiver(input: &mut &str) -> winnow::Result<GoSegment> {
	let snapshot = *input;
	*input = &input[1..]; // consume '('
	let ptr = input.starts_with('*');
	if ptr {
		*input = &input[1..];
	}
	let ty: String = match parse_ident(input) {
		Ok(s) => s,
		Err(e) => {
			*input = snapshot;
			return Err(e);
		},
	};
	if !input.starts_with(')') {
		*input = snapshot;
		return Err(winnow::error::ContextError::default());
	}
	*input = &input[1..];
	if !input.starts_with('.') {
		*input = snapshot;
		return Err(winnow::error::ContextError::default());
	}
	*input = &input[1..];
	let method = match parse_ident(input) {
		Ok(s) => s,
		Err(e) => {
			*input = snapshot;
			return Err(e);
		},
	};
	Ok(GoSegment::Receiver { ptr, ty, method })
}

fn parse_ident(input: &mut &str) -> winnow::Result<String> {
	let s: &str =
		take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
	Ok(s.to_string())
}

fn render_segment(seg: &GoSegment) -> String {
	match seg {
		GoSegment::Ident(s) => s.clone(),
		GoSegment::Receiver { ptr, ty, method } => {
			format!("({}{}).{}", if *ptr { "*" } else { "" }, ty, method)
		},
	}
}

fn render_segments(segs: &[GoSegment]) -> String {
	segs.iter().map(render_segment).collect::<Vec<_>>().join(".")
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

pub fn go_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(GoNameLexer),
		anchors: vec![
			AnchorPattern { name: "interface", matcher: |n, _s| match_kind(n, &["interface_type"]) },
			AnchorPattern {
				name:    "struct-tag",
				matcher: |n, _s| match_kind(n, &["raw_string_literal"]),
			},
			AnchorPattern {
				name:    "goroutine",
				matcher: |n, _s| match_kind(n, &["go_statement"]),
			},
			AnchorPattern { name: "defer", matcher: |n, _s| match_kind(n, &["defer_statement"]) },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function_declaration".into(), "method_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["function_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["function_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "receiver",
				applies_to: vec!["method_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "tags",
				applies_to: vec!["field_declaration".into()],
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
	fn parse_simple_ident() {
		let mut input = "Foo";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
	}

	#[test]
	fn parse_pkg_func() {
		let mut input = "pkg.Func";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "pkg.Func"));
	}

	#[test]
	fn parse_pointer_receiver() {
		let mut input = "(*Server).HandleRequest";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "(*Server).HandleRequest"));
	}

	#[test]
	fn parse_value_receiver() {
		let mut input = "(Server).foo";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "(Server).foo"));
	}

	#[test]
	fn stops_at_kernel_slash() {
		let mut input = "Foo/bar";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
		assert_eq!(input, "/bar");
	}

	#[test]
	fn stops_at_predicate() {
		let mut input = "Foo[0]";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
	}

	#[test]
	fn stops_at_qualifier() {
		let mut input = "Foo#body";
		let payload = GoNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
	}

	#[test]
	fn unbalanced_receiver_rejected() {
		let mut input = "(*).foo";
		let result = GoNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = go_dialect();
		assert_eq!(d.anchors.len(), 4);
		assert_eq!(d.qualifiers.len(), 6);
	}
}
