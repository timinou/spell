//! Elixir NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/09-elixir.md`. Names use `.` as
//! separator with dotted module paths (`Foo.Bar.baz`) and arity suffixes
//! (`Foo.bar/2`).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tree_sitter::Node;
use winnow::{ModalResult, Parser, token::take_while};

use crate::{
	ast::NamePayload,
	dialect::{AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierSpec},
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ExName {
	pub segments: Vec<ExSegment>,
	pub arity:    Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ExSegment {
	Ident(String),
	Quoted(String),
}

pub struct ExNameLexer;

impl NameLexer for ExNameLexer {
	fn parse(&self, input: &mut &str) -> winnow::Result<NamePayload> {
		let segments = parse_segments(input)?;
		if segments.is_empty() {
			return Err(winnow::error::ContextError::default());
		}
		let arity = parse_arity(input)?;
		let is_quoted = segments.iter().any(|s| matches!(s, ExSegment::Quoted(_))) || arity.is_some();
		if is_quoted {
			Ok(NamePayload::Quoted(render_segments(&segments, arity)))
		} else {
			Ok(NamePayload::Raw(render_segments(&segments, arity)))
		}
	}

	fn render(&self, n: &NamePayload) -> String {
		match n {
			NamePayload::Raw(s) => s.clone(),
			NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(&self, n: &NamePayload, node: Node<'_>, src: &str) -> bool {
		match n {
			NamePayload::Raw(target) => {
				let leaf = target.rsplit('.').next().unwrap_or(target);
				let leaf = leaf.split('/').next().unwrap_or(leaf);
				if node.kind() == "call"
					&& let Some(target_child) = node.child_by_field_name("target")
					&& let Some(text) = src.get(target_child.start_byte()..target_child.end_byte())
				{
					return text == leaf;
				}
				if node.kind() == "identifier"
					&& let Some(text) = src.get(node.start_byte()..node.end_byte())
				{
					return text == leaf;
				}
				false
			},
			NamePayload::Quoted(target) => {
				let text = src.get(node.start_byte()..node.end_byte()).unwrap_or("");
				normalize_ws(text).contains(&normalize_ws(target))
			},
		}
	}
}

fn parse_segments(input: &mut &str) -> winnow::Result<Vec<ExSegment>> {
	let mut segments = Vec::new();
	let first = parse_segment(input)?;
	segments.push(first);
	while input.starts_with('.') {
		let snapshot = *input;
		*input = &input[1..];
		// Reject double-dot (`foo..bar`).
		if input.starts_with('.') {
			*input = snapshot;
			return Err(winnow::error::ContextError::default());
		}
		match parse_segment(input) {
			Ok(s) => segments.push(s),
			Err(_) => {
				*input = snapshot;
				break;
			},
		}
	}
	Ok(segments)
}

fn parse_segment(input: &mut &str) -> winnow::Result<ExSegment> {
	if input.starts_with('`') {
		*input = &input[1..];
		let mut buf = String::new();
		let mut closed = false;
		let mut chars = input.char_indices();
		let mut consumed = 0;
		for (idx, c) in chars.by_ref() {
			if c == '`' {
				closed = true;
				consumed = idx + 1;
				break;
			}
			buf.push(c);
			consumed = idx + c.len_utf8();
		}
		if !closed {
			return Err(winnow::error::ContextError::default());
		}
		*input = &input[consumed..];
		return Ok(ExSegment::Quoted(buf));
	}
	let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
	Ok(ExSegment::Ident(s.to_string()))
}

fn try_digits<'s>(input: &mut &'s str) -> ModalResult<&'s str> {
	take_while(1.., |c: char| c.is_ascii_digit()).parse_next(input)
}

fn parse_arity(input: &mut &str) -> winnow::Result<Option<u32>> {
	if !input.starts_with('/') {
		return Ok(None);
	}
	let snapshot = *input;
	*input = &input[1..];
	if input.is_empty() {
		*input = snapshot;
		return Err(winnow::error::ContextError::default());
	}
	let result = try_digits(input);
	match result {
		Ok(d) => Ok(Some(d.parse().unwrap())),
		Err(_) => {
			*input = snapshot;
			Ok(None)
		},
	}
}

fn render_segments(segs: &[ExSegment], arity: Option<u32>) -> String {
	let mut s = segs
		.iter()
		.map(|seg| match seg {
			ExSegment::Ident(i) => i.clone(),
			ExSegment::Quoted(q) => q.clone(),
		})
		.collect::<Vec<_>>()
		.join(".");
	if let Some(a) = arity {
		s.push('/');
		s.push_str(&a.to_string());
	}
	s
}

// ── Anchors and qualifiers ──────────────────────────────────────

mod qualifiers {
	use std::ops::Range;

	use tree_sitter::Node;

	use crate::dialect::QualifierResolver;

	pub struct Body;
	impl QualifierResolver for Body {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("do_block")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Sig;
	impl QualifierResolver for Sig {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let target = node.child_by_field_name("target")?;
			let arguments = node.child_by_field_name("arguments")?;
			Some(target.start_byte()..arguments.end_byte())
		}
	}

	pub struct Name;
	impl QualifierResolver for Name {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("target")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Docstring;
	impl QualifierResolver for Docstring {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut first: Option<Node> = None;
			let mut last: Option<Node> = None;
			let mut sib = node.prev_sibling();
			while let Some(n) = sib {
				if n.kind() == "call"
					&& let Some(target) = n.child_by_field_name("target")
					&& let Some(text) = src.get(target.start_byte()..target.end_byte())
					&& text == "@"
					&& let Some(args) = n.child_by_field_name("arguments")
				{
					let mut cursor = args.walk();
					if let Some(first_arg) = args.children(&mut cursor).next()
						&& let Some(arg_text) = src.get(first_arg.start_byte()..first_arg.end_byte())
						&& (arg_text == "moduledoc" || arg_text == "doc")
					{
						last = Some(n);
						if first.is_none() {
							first = Some(n);
						}
						sib = n.prev_sibling();
						continue;
					}
				}
				break;
			}
			match (first, last) {
				(Some(f), Some(l)) => Some(f.start_byte()..l.end_byte()),
				_ => None,
			}
		}
	}
}

fn normalize_ws(text: &str) -> String {
	let mut out = String::new();
	let mut prev_space = true;
	for c in text.chars() {
		if c.is_whitespace() {
			if !prev_space {
				out.push(' ');
				prev_space = true;
			}
		} else {
			out.push(c);
			prev_space = false;
		}
	}
	if out.ends_with(' ') {
		out.pop();
	}
	out
}

pub fn elixir_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer:   Arc::new(ExNameLexer),
		anchors:      vec![
			AnchorPattern {
				name:    "defmodule",
				matcher: |n, src| {
					if n.kind() != "call" {
						return false;
					}
					let Some(target) = n.child_by_field_name("target") else {
						return false;
					};
					src.get(target.start_byte()..target.end_byte()) == Some("defmodule")
				},
			},
			AnchorPattern {
				name:    "def",
				matcher: |n, src| {
					if n.kind() != "call" {
						return false;
					}
					let Some(target) = n.child_by_field_name("target") else {
						return false;
					};
					src.get(target.start_byte()..target.end_byte()) == Some("def")
				},
			},
			AnchorPattern {
				name:    "defp",
				matcher: |n, src| {
					if n.kind() != "call" {
						return false;
					}
					let Some(target) = n.child_by_field_name("target") else {
						return false;
					};
					src.get(target.start_byte()..target.end_byte()) == Some("defp")
				},
			},
			AnchorPattern {
				name:    "first-import",
				matcher: |n, src| {
					if n.kind() != "call" {
						return false;
					}
					let Some(target) = n.child_by_field_name("target") else {
						return false;
					};
					let Some(text) = src.get(target.start_byte()..target.end_byte()) else {
						return false;
					};
					if !matches!(text, "alias" | "import" | "require" | "use") {
						return false;
					}
					let mut sib = n.prev_sibling();
					while let Some(p) = sib {
						if p.kind() == "call"
							&& let Some(ptarget) = p.child_by_field_name("target")
							&& let Some(ptext) = src.get(ptarget.start_byte()..ptarget.end_byte())
							&& matches!(ptext, "alias" | "import" | "require" | "use")
						{
							return false;
						}
						sib = p.prev_sibling();
					}
					true
				},
			},
		],
		qualifiers:   vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["call".into()],
				resolve:    Arc::new(qualifiers::Body),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["call".into()],
				resolve:    Arc::new(qualifiers::Sig),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["call".into()],
				resolve:    Arc::new(qualifiers::Name),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["call".into()],
				resolve:    Arc::new(qualifiers::Docstring),
			},
		],
		edge_kinds:   EdgeKindSet::default(),
		kind_aliases: std::collections::HashMap::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_simple_ident() {
		let mut input = "foo";
		let payload = ExNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "foo"));
	}

	#[test]
	fn parses_dotted_path() {
		let mut input = "Foo.Bar.baz";
		let payload = ExNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo.Bar.baz"));
	}

	#[test]
	fn parses_arity() {
		let mut input = "Foo.bar/2";
		let payload = ExNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Quoted(s) if s == "Foo.bar/2"));
	}

	#[test]
	fn stops_at_predicate() {
		let mut input = "foo[0]";
		let payload = ExNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "foo"));
		assert_eq!(input, "[0]");
	}

	#[test]
	fn stops_at_qualifier() {
		let mut input = "foo#body";
		let payload = ExNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "foo"));
		assert_eq!(input, "#body");
	}

	#[test]
	fn double_dot_rejected() {
		let mut input = "Foo..Bar";
		let result = ExNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn empty_rejected() {
		let mut input = "";
		let result = ExNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn parses_unterminated_quoted() {
		let mut input = "`foo";
		let result = ExNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn round_trip_via_codepath_parser() {
		let cp = crate::parser::parse_code_path("foo.ex::Mod.fn#body", &ExNameLexer)
			.expect("parse should succeed");
		assert_eq!(cp.qualifier.as_ref().unwrap().name, "body");
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = elixir_dialect();
		assert_eq!(d.anchors.len(), 4);
		assert_eq!(d.qualifiers.len(), 4);
	}
}
