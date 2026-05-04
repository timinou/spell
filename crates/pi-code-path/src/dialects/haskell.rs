//! Haskell NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/05-haskell.md`. Names support
//! module-qualified `Data.List.sort`, parens-wrapped operators `(>>=)`,
//! `(<$>)`, and typeclass-method form `(Functor).fmap`.

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
pub struct HsName {
	pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HsSegment {
	Ident(String),
	Operator(String),
	TypeClassMethod { class_: String, method: String },
}

pub struct HsNameLexer;

impl NameLexer for HsNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		// Operator in parens: `(>>=)`, `(<$>)`
		if input.starts_with('(') {
			return parse_paren_form(input);
		}
		// Module-qualified or simple ident, dot-separated.
		let mut out = String::new();
		let first = parse_ident(input)?;
		out.push_str(&first);
		while input.starts_with('.') {
			let snapshot = *input;
			*input = &input[1..];
			match parse_ident(input) {
				Ok(s) => {
					out.push('.');
					out.push_str(&s);
				},
				Err(_) => {
					*input = snapshot;
					break;
				},
			}
		}
		Ok(NamePayload::Raw(out))
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
	let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '\'')
		.parse_next(input)?;
	Ok(s.to_string())
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

pub fn haskell_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(HsNameLexer),
		anchors: vec![
			AnchorPattern { name: "guard", matcher: |n, _s| match_kind(n, &["guards"]) },
			AnchorPattern { name: "instance", matcher: |n, _s| match_kind(n, &["instance"]) },
			AnchorPattern { name: "pragma", matcher: |n, _s| match_kind(n, &["pragma"]) },
			AnchorPattern { name: "type-sig", matcher: |n, _s| match_kind(n, &["signature"]) },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["signature".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["function".into(), "data_type".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["function".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "type",
				applies_to: vec!["function".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "instances",
				applies_to: vec!["class".into()],
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
		assert_eq!(d.anchors.len(), 4);
		assert_eq!(d.qualifiers.len(), 6);
	}
}
