//! Haskell NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/05-haskell.md`. Names support
//! module-qualified `Data.List.sort`, parens-wrapped operators `(>>=)`,
//! `(<$>)`, and typeclass-method form `(Functor).fmap`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tree_sitter::Node;
use winnow::{Parser, token::take_while};

use crate::{
	ast::NamePayload,
	dialect::{
		AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierSpec,
	},
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HsName {
	pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HsSegment {
	Ident(String),
	Operator(String),
	TypeClassMethod { class_: String, method: String },
	Quoted(String),
}

pub struct HsNameLexer;

fn parse_segment(input: &mut &str) -> winnow::Result<HsSegment> {
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
		return Ok(HsSegment::Quoted(buf));
	}
	let s = parse_ident(input)?;
	Ok(HsSegment::Ident(s))
}

impl NameLexer for HsNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		// Operator in parens: `(>>=)`, `(<$>)`
		if input.starts_with('(') {
			return parse_paren_form(input);
		}
		// Module-qualified or simple ident, dot-separated.
		let mut segments = Vec::new();
		let first = parse_segment(input)?;
		segments.push(first);
		while input.starts_with('.') {
			let snapshot = *input;
			*input = &input[1..];
			match parse_segment(input) {
				Ok(s) => segments.push(s),
				Err(_) => {
					*input = snapshot;
					break;
				},
			}
		}
		if segments.iter().any(|s| matches!(s, HsSegment::Quoted(_))) {
			Ok(NamePayload::Quoted(render_segments(&segments)))
		} else {
			Ok(NamePayload::Raw(render_segments(&segments)))
		}
	}

	fn render(&self, n: &NamePayload) -> String {
		match n {
			NamePayload::Raw(s) => s.clone(),
			NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(&self, _n: &NamePayload, _node: Node<'_>, _src: &str) -> bool {
		false
	}
}

fn render_segments(segs: &[HsSegment]) -> String {
	segs
		.iter()
		.map(|s| match s {
			HsSegment::Ident(i) => i.clone(),
			HsSegment::Operator(o) => format!("({o})"),
			HsSegment::TypeClassMethod { class_, method } => format!("({class_}).{method}"),
			HsSegment::Quoted(q) => q.clone(),
		})
		.collect::<Vec<_>>()
		.join(".")
}
fn parse_paren_form(input: &mut &str) -> winnow::Result<NamePayload> {
	let snapshot = *input;
	*input = &input[1..]; // '('
	// Take everything up to ')'. Empty operator `()` is rejected.
	let mut buf = String::new();
	let mut closed = false;
	let mut chars = input.char_indices();
	let mut consumed = 0;
	for (idx, c) in chars.by_ref() {
		if c == ')' {
			closed = true;
			consumed = idx + 1;
			break;
		}
		buf.push(c);
		consumed = idx + c.len_utf8();
	}
	if !closed || buf.is_empty() {
		*input = snapshot;
		return Err(winnow::error::ContextError::default());
	}
	*input = &input[consumed..];
	// `(Class).method` form
	if input.starts_with('.') {
		*input = &input[1..];
		match parse_ident(input) {
			Ok(method) => Ok(NamePayload::Raw(format!("({buf}).{method}"))),
			Err(_) => Ok(NamePayload::Raw(format!("({buf})"))),
		}
	} else {
		Ok(NamePayload::Raw(format!("({buf})")))
	}
}

fn parse_ident(input: &mut &str) -> winnow::Result<String> {
	let s: &str =
		take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '\'').parse_next(input)?;
	Ok(s.to_string())
}

fn match_kind(node: &Node<'_>, kinds: &[&str]) -> bool {
	kinds.contains(&node.kind())
}

fn has_descendant_kind(node: Node<'_>, kind: &str) -> bool {
	let mut stack = vec![node];
	while let Some(n) = stack.pop() {
		if n.kind() == kind {
			return true;
		}
		let mut cursor = n.walk();
		for child in n.children(&mut cursor) {
			stack.push(child);
		}
	}
	false
}

fn has_descendant_text(node: Node<'_>, src: &str, needle: &str) -> bool {
	let mut stack = vec![node];
	while let Some(n) = stack.pop() {
		if let Some(text) = src.get(n.start_byte()..n.end_byte()) {
			if text == needle {
				return true;
			}
		}
		let mut cursor = n.walk();
		for child in n.children(&mut cursor) {
			stack.push(child);
		}
	}
	false
}

// ── Anchors and qualifiers ──────────────────────────────────────

mod qualifiers {
	use std::ops::Range;

	use tree_sitter::Node;

	use crate::dialect::QualifierResolver;

	pub struct Body;
	impl QualifierResolver for Body {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut first: Option<Node> = None;
			let mut last: Option<Node> = None;
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "match" {
					if first.is_none() {
						first = Some(child);
					}
					last = Some(child);
				}
			}
			match (first, last) {
				(Some(f), Some(l)) => Some(f.start_byte()..l.end_byte()),
				_ => None,
			}
		}
	}

	pub struct Name;
	impl QualifierResolver for Name {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("name")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Sig;
	impl QualifierResolver for Sig {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			Some(node.start_byte()..node.end_byte())
		}
	}

	pub struct WhereClause;
	impl QualifierResolver for WhereClause {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("binds")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Guards;
	impl QualifierResolver for Guards {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut first: Option<Node> = None;
			let mut last: Option<Node> = None;
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "match" {
					if let Some(guards) = child.child_by_field_name("guards") {
						if first.is_none() {
							first = Some(guards);
						}
						last = Some(guards);
					}
				}
			}
			match (first, last) {
				(Some(f), Some(l)) => Some(f.start_byte()..l.end_byte()),
				_ => None,
			}
		}
	}

	pub struct Exports;
	impl QualifierResolver for Exports {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			if node.kind() == "exports" {
				return Some(node.start_byte()..node.end_byte());
			}
			node
				.child_by_field_name("exports")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Pragmas;
	impl QualifierResolver for Pragmas {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			Some(node.start_byte()..node.end_byte())
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

pub fn haskell_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(HsNameLexer),
		anchors:    vec![
			AnchorPattern {
				name:    "return",
				matcher: |n, src| {
					if !match_kind(n, &["function", "bind"]) {
						return false;
					}
					has_descendant_text(*n, src, "return")
				},
			},
			AnchorPattern {
				name:    "guard",
				matcher: |n, _src| {
					if n.kind() != "function" {
						return false;
					}
					let mut cursor = n.walk();
					n.children(&mut cursor).any(|c| {
						if c.kind() == "match" {
							c.child_by_field_name("guards").is_some()
						} else {
							false
						}
					})
				},
			},
			AnchorPattern {
				name:    "where-binding",
				matcher: |n, _src| {
					if n.kind() != "function" {
						return false;
					}
					n.child_by_field_name("binds").is_some()
				},
			},
			AnchorPattern {
				name:    "pattern-match",
				matcher: |n, _src| match_kind(n, &["function", "lambda", "alternative"]),
			},
			AnchorPattern { name: "case-of", matcher: |n, _src| n.kind() == "case" },
			AnchorPattern { name: "lambda", matcher: |n, _src| n.kind() == "lambda" },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function".into(), "bind".into()],
				resolve:    Arc::new(qualifiers::Body),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["signature".into()],
				resolve:    Arc::new(qualifiers::Sig),
			},
			QualifierSpec {
				name:       "type-signature",
				applies_to: vec!["signature".into()],
				resolve:    Arc::new(qualifiers::Sig),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec![
					"function".into(),
					"bind".into(),
					"signature".into(),
					"data_type".into(),
					"class".into(),
				],
				resolve:    Arc::new(qualifiers::Name),
			},
			QualifierSpec {
				name:       "where-clause",
				applies_to: vec!["function".into()],
				resolve:    Arc::new(qualifiers::WhereClause),
			},
			QualifierSpec {
				name:       "guards",
				applies_to: vec!["function".into()],
				resolve:    Arc::new(qualifiers::Guards),
			},
			QualifierSpec {
				name:       "exports",
				applies_to: vec!["header".into(), "exports".into()],
				resolve:    Arc::new(qualifiers::Exports),
			},
			QualifierSpec {
				name:       "pragmas",
				applies_to: vec!["pragma".into()],
				resolve:    Arc::new(qualifiers::Pragmas),
			},
		],
		edge_kinds: EdgeKindSet::default(),
		kind_aliases: std::collections::HashMap::new(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_simple_ident() {
		let mut input = "sort";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "sort"));
	}

	#[test]
	fn parse_module_qualified() {
		let mut input = "Data.List.sort";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Data.List.sort"));
	}

	#[test]
	fn parse_prelude_map() {
		let mut input = "Prelude.map";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Prelude.map"));
	}

	#[test]
	fn parse_operator() {
		let mut input = "(>>=)";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "(>>=)"));
	}

	#[test]
	fn parse_fmap_operator() {
		let mut input = "(<$>)";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "(<$>)"));
	}

	#[test]
	fn parse_typeclass_method() {
		let mut input = "(Functor).fmap";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "(Functor).fmap"));
	}

	#[test]
	fn stops_at_kernel_slash() {
		let mut input = "Foo/bar";
		let payload = HsNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
	}

	#[test]
	fn empty_operator_rejected() {
		let mut input = "()";
		let result = HsNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn unbalanced_paren_rejected() {
		let mut input = "(>>=";
		let result = HsNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = haskell_dialect();
		assert_eq!(d.anchors.len(), 6);
		assert_eq!(d.qualifiers.len(), 8);
	}
}
