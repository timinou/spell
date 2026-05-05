//! Python NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/03-python.md`. Names use `.` as
//! separator with dotted attribute access (`mod.cls.method`).

use std::{ops::Range, sync::Arc};

use serde::{Deserialize, Serialize};
use tree_sitter::Node;
use winnow::{Parser, token::take_while};

use crate::{
	ast::NamePayload,
	dialect::{
		AnchorPattern, EdgeKindSet, LanguageDialect, NameLexer, QualifierResolver, QualifierSpec,
	},
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
			NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(&self, n: &NamePayload, node: Node<'_>, src: &str) -> bool {
		// FEAT-708: extract the declared name from common Python
		// declaration kinds and compare to the requested name.
		let target = match n {
			NamePayload::Raw(s) => s.as_str(),
			NamePayload::Quoted(_) => return false,
		};
		let leaf = target.rsplit('.').next().unwrap_or(target);
		if matches!(
			node.kind(),
			"function_definition"
				| "class_definition"
				| "decorated_definition"
		) {
			if let Some(name_child) = node.child_by_field_name("name")
				&& let Some(text) = src.get(name_child.start_byte()..name_child.end_byte())
			{
				return text == leaf;
			}
		}
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
	let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
	Ok(s.to_string())
}

fn render_segments(segs: &[PySegment]) -> String {
	segs
		.iter()
		.map(|s| match s {
			PySegment::Ident(i) => i.clone(),
			PySegment::DecoratorRef(d) => format!("@{d}"),
		})
		.collect::<Vec<_>>()
		.join(".")
}

// ── Anchors and qualifiers ──────────────────────────────────────

mod qualifiers {
	use std::ops::Range;

	use tree_sitter::Node;

	use crate::dialect::QualifierResolver;

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

	pub fn has_descendant_if_with_return(node: Node<'_>) -> bool {
		let mut stack = vec![node];
		while let Some(n) = stack.pop() {
			if n.kind() == "if_statement" {
				if has_descendant_kind(n, "return_statement") {
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

	fn first_docstring(node: Node<'_>) -> Option<Node<'_>> {
		let body = node.child_by_field_name("body")?;
		let mut cursor = body.walk();
		for child in body.children(&mut cursor) {
			if child.kind() == "expression_statement" {
				let mut inner = child.walk();
				for grandchild in child.children(&mut inner) {
					if grandchild.kind() == "string" {
						return Some(grandchild);
					}
				}
			}
		}
		None
	}

	fn parent_decorated_definition(node: Node<'_>) -> Option<Node<'_>> {
		node.parent().filter(|p| p.kind() == "decorated_definition")
	}

	pub struct Body;
	impl QualifierResolver for Body {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("body")
				.map(|c| c.start_byte()..c.end_byte())
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
			match node.child_by_field_name("body") {
				Some(body) => Some(node.start_byte()..body.start_byte()),
				None => Some(node.start_byte()..node.end_byte()),
			}
		}
	}

	pub struct Docstring;
	impl QualifierResolver for Docstring {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			first_docstring(node).map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Decorators;
	impl QualifierResolver for Decorators {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let parent = parent_decorated_definition(node)?;
			let mut first: Option<Node> = None;
			let mut last: Option<Node> = None;
			let mut cursor = parent.walk();
			for child in parent.children(&mut cursor) {
				if child.kind() == "decorator" {
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

	pub struct ReturnAnnotation;
	impl QualifierResolver for ReturnAnnotation {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("return_type")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct BaseClasses;
	impl QualifierResolver for BaseClasses {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("superclasses")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}
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

pub fn python_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(PyNameLexer),
		anchors:    vec![
			AnchorPattern {
				name:    "return",
				matcher: |n, _s| has_descendant_kind(*n, "return_statement"),
			},
			AnchorPattern {
				name:    "guard",
				matcher: |n, _s| {
					match_kind(n, &["function_definition"])
						&& qualifiers::has_descendant_if_with_return(*n)
				},
			},
			AnchorPattern {
				name:    "async",
				matcher: |n, _s| {
					if !match_kind(n, &["function_definition"]) {
						return false;
					}
					let mut cursor = n.walk();
					n.children(&mut cursor)
						.next()
						.map_or(false, |c| c.kind() == "async")
				},
			},
			AnchorPattern {
				name:    "default-param",
				matcher: |n, _s| {
					if !match_kind(n, &["function_definition"]) {
						return false;
					}
					let Some(params) = n.child_by_field_name("parameters") else {
						return false;
					};
					let mut cursor = params.walk();
					params
						.children(&mut cursor)
						.any(|c| c.kind() == "default_parameter")
				},
			},
			AnchorPattern {
				name:    "first-import",
				matcher: |n, _s| {
					if !match_kind(n, &["import_statement", "import_from_statement"]) {
						return false;
					}
					let mut sib = n.prev_sibling();
					while let Some(p) = sib {
						if match_kind(&p, &["import_statement", "import_from_statement"]) {
							return false;
						}
						sib = p.prev_sibling();
					}
					true
				},
			},
			AnchorPattern {
				name:    "last-import",
				matcher: |n, _s| {
					if !match_kind(n, &["import_statement", "import_from_statement"]) {
						return false;
					}
					let mut sib = n.next_sibling();
					while let Some(p) = sib {
						if match_kind(&p, &["import_statement", "import_from_statement"]) {
							return false;
						}
						sib = p.next_sibling();
					}
					true
				},
			},
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(qualifiers::Body),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(qualifiers::Sig),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(qualifiers::Name),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(qualifiers::Docstring),
			},
			QualifierSpec {
				name:       "decorators",
				applies_to: vec!["function_definition".into(), "class_definition".into()],
				resolve:    Arc::new(qualifiers::Decorators),
			},
			QualifierSpec {
				name:       "return-annotation",
				applies_to: vec!["function_definition".into()],
				resolve:    Arc::new(qualifiers::ReturnAnnotation),
			},
			QualifierSpec {
				name:       "base-classes",
				applies_to: vec!["class_definition".into()],
				resolve:    Arc::new(qualifiers::BaseClasses),
			},
		],
		edge_kinds: {
			let set = EdgeKindSet::default();
			// TODO: type→/inherits→/override→ deferred until EdgeKind extension
			set
		},
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
		assert_eq!(d.qualifiers.len(), 7);
	}
}
