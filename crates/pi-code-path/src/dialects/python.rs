//! Python NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/03-python.md`. Names use `.` as
//! separator with dotted attribute access (`mod.cls.method`).

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
pub struct PyName {
	pub segments: Vec<PySegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PySegment {
	Ident(String),
	DecoratorRef(String),
}

pub struct PyNameLexer;

impl NameLexer for PyNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		let segments = parse_segments(input)?;
		if segments.is_empty() {
			return Err(winnow::error::ContextError::default());
		}
		Ok(NamePayload::Raw(render_segments(&segments)))
	}

	fn render(&self, n: &NamePayload) -> String {
		match n {
			NamePayload::Raw(s) => s.clone(),
		}
	}

	fn matches(&self, _n: &NamePayload, _node: Node<'_>, _src: &str) -> bool {
		// Tree-sitter integration deferred to NAPI layer.
		false
	}
}

fn parse_segments(input: &mut &str) -> winnow::Result<Vec<PySegment>> {
	let mut segments = Vec::new();
	let first = parse_ident(input)?;
	segments.push(PySegment::Ident(first));
	while input.starts_with('.') {
		let snapshot = *input;
		*input = &input[1..];
		// Reject double-dot (`foo..bar`).
		if input.starts_with('.') {
			*input = snapshot;
			return Err(winnow::error::ContextError::default());
		}
		match parse_ident(input) {
			Ok(s) => segments.push(PySegment::Ident(s)),
			Err(_) => {
				*input = snapshot;
				break;
			},
		}
	}
	Ok(segments)
}

fn parse_ident(input: &mut &str) -> winnow::Result<String> {
	let s: &str =
		take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
	Ok(s.to_string())
}

fn render_segments(segs: &[PySegment]) -> String {
	segs.iter()
		.map(|s| match s {
			PySegment::Ident(i) => i.clone(),
			PySegment::DecoratorRef(d) => format!("@{d}"),
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

pub fn python_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(PyNameLexer),
		anchors: vec![
			AnchorPattern { name: "pytest-fixture", matcher: |n, _s| match_kind(n, &["decorator"]) },
			AnchorPattern { name: "staticmethod", matcher: |n, _s| match_kind(n, &["decorator"]) },
			AnchorPattern { name: "classmethod", matcher: |n, _s| match_kind(n, &["decorator"]) },
			AnchorPattern { name: "property", matcher: |n, _s| match_kind(n, &["decorator"]) },
			AnchorPattern {
				name:    "async",
				matcher: |n, _s| match_kind(n, &["async_function_definition"]),
			},
			AnchorPattern {
				name:    "abstract",
				matcher: |n, _s| match_kind(n, &["decorator"]),
			},
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_definition".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["function_definition".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "decorators",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
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
		let mut input = "parse_config";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "parse_config"));
	}

	#[test]
	fn parse_dotted() {
		let mut input = "mod.cls.method";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "mod.cls.method"));
	}

	#[test]
	fn parse_dunder() {
		let mut input = "__init__";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "__init__"));
	}

	#[test]
	fn parse_numpy_chain() {
		let mut input = "numpy.array.shape";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "numpy.array.shape"));
	}

	#[test]
	fn stops_at_kernel_slash() {
		let mut input = "foo.bar/baz";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "foo.bar"));
		assert_eq!(input, "/baz");
	}

	#[test]
	fn stops_at_predicate() {
		let mut input = "foo[0]";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "foo"));
		assert_eq!(input, "[0]");
	}

	#[test]
	fn stops_at_qualifier() {
		let mut input = "foo#body";
		let payload = PyNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "foo"));
		assert_eq!(input, "#body");
	}

	#[test]
	fn double_dot_rejected() {
		let mut input = "foo..bar";
		let result = PyNameLexer.parse(&mut input);
		assert!(result.is_err());
	}

	#[test]
	fn round_trip_via_codepath_parser() {
		let cp = crate::parser::parse_code_path("foo.py::mod.cls.method#body", &PyNameLexer)
			.expect("parse should succeed");
		assert_eq!(cp.qualifier.as_ref().unwrap().name, "body");
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = python_dialect();
		assert_eq!(d.anchors.len(), 6);
		assert_eq!(d.qualifiers.len(), 5);
	}
}
