//! Go NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/04-go.md`. Names use `.` separator
//! with `(*Type).Method` and `(Type).Method` receiver-method form.

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
			NamePayload::Quoted(s) => s.clone(),
		}
	}

fn matches(&self, n: &NamePayload, node: Node<'_>, src: &str) -> bool {
	let name = match n {
		NamePayload::Raw(s) => s,
		NamePayload::Quoted(_) => return false,
	};
	let segments = match parse_name(name) {
		Some(s) => s,
		None => return false,
	};

	match node.kind() {
		"function_declaration" => {
			if segments.len() == 1 {
				if let Some(GoSegment::Ident(ident)) = segments.first() {
					if let Some(name_node) = node.child_by_field_name("name") {
						if let Some(text) = src.get(name_node.start_byte()..name_node.end_byte()) {
							return text == ident;
						}
					}
				}
			}
			false
		},
		"method_declaration" => {
			let Some(name_node) = node.child_by_field_name("name") else {
				return false;
			};
			let Some(text) = src.get(name_node.start_byte()..name_node.end_byte()) else {
				return false;
			};
			match segments.as_slice() {
				[GoSegment::Receiver { ptr, ty, method }] => {
					if text != method {
						return false;
					}
					let Some(recv_node) = node.child_by_field_name("receiver") else {
						return false;
					};
					let Some(recv_text) = src.get(recv_node.start_byte()..recv_node.end_byte()) else {
						return false;
					};
					let expected = if *ptr { format!("*{}", ty) } else { ty.clone() };
					recv_text.contains(&expected)
				},
				[GoSegment::Ident(ty), GoSegment::Ident(method)] => {
					if text != method {
						return false;
					}
					let Some(recv_node) = node.child_by_field_name("receiver") else {
						return false;
					};
					let Some(recv_text) = src.get(recv_node.start_byte()..recv_node.end_byte()) else {
						return false;
					};
					recv_text.contains(ty)
				},
				[GoSegment::Ident(method)] => text == method,
				_ => false,
			}
		},
		"type_spec" => {
			if segments.len() == 1 {
				if let Some(GoSegment::Ident(ident)) = segments.first() {
					if let Some(name_node) = node.child_by_field_name("name") {
						if let Some(text) = src.get(name_node.start_byte()..name_node.end_byte()) {
							return text == ident;
						}
					}
				}
			}
			false
		},
		_ => false,
	}
}
}

fn parse_name(input: &str) -> Option<Vec<GoSegment>> {
	let mut input = input;
	if input.starts_with('(') {
		return parse_receiver(&mut input).ok().map(|s| vec![s]);
	}
	let mut segments = Vec::new();
	let first = parse_ident(&mut input).ok()?;
	segments.push(GoSegment::Ident(first));
	while input.starts_with('.') {
		let snapshot = input;
		input = &input[1..];
		match parse_ident(&mut input) {
			Ok(s) => segments.push(GoSegment::Ident(s)),
			Err(_) => {
				input = snapshot;
				break;
			},
		}
	}
	Some(segments)
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
	let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
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
	segs
		.iter()
		.map(render_segment)
		.collect::<Vec<_>>()
		.join(".")
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

mod qualifiers {
	use std::ops::Range;

	use tree_sitter::Node;

	use crate::dialect::QualifierResolver;

	pub struct Body;
	impl QualifierResolver for Body {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("body")
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

	pub struct Name;
	impl QualifierResolver for Name {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("name")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Receiver;
	impl QualifierResolver for Receiver {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("receiver")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Returns;
	impl QualifierResolver for Returns {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("result")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct TypeParams;
	impl QualifierResolver for TypeParams {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("type_parameters")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct StructTag;
	impl QualifierResolver for StructTag {
		fn resolve(&self, node: Node<'_>, src: &str, args: Option<&str>) -> Option<Range<usize>> {
			let key = args?;

			let tag_node = if node.kind() == "field_declaration" {
				node.child_by_field_name("tag")?
			} else if node.kind() == "type_spec" {
				let type_node = node.child_by_field_name("type")?;
				if type_node.kind() != "struct_type" {
					return None;
				}
				let mut found: Option<Node> = None;
				let mut cursor = type_node.walk();
				for child in type_node.children(&mut cursor) {
					if child.kind() == "field_declaration_list" {
						let mut inner_cursor = child.walk();
						for field in child.children(&mut inner_cursor) {
							if field.kind() == "field_declaration" {
								if let Some(tag) = field.child_by_field_name("tag") {
									if let Some(tag_text) = src.get(tag.start_byte()..tag.end_byte()) {
										if tag_text.contains(&format!("{}:\"", key)) {
											found = Some(tag);
											break;
										}
									}
								}
							}
						}
					}
				}
				found?
			} else {
				return None;
			};

			let tag_text = src.get(tag_node.start_byte()..tag_node.end_byte())?;
			let needle = format!("{}:\"", key);
			let start = tag_text.find(&needle)?;
			let val_start = start + needle.len();
			let val_end = tag_text[val_start..].find('"')?;
			let abs_start = tag_node.start_byte() + start;
			let abs_end = tag_node.start_byte() + start + needle.len() + val_end;
			Some(abs_start..abs_end)
		}
	}

	pub struct InterfaceMethodSet;
	impl QualifierResolver for InterfaceMethodSet {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let target = if node.kind() == "type_spec" {
				node.child_by_field_name("type")?
			} else {
				node
			};
			if target.kind() != "interface_type" {
				return None;
			}
			let mut first: Option<Node> = None;
			let mut last: Option<Node> = None;
			let mut cursor = target.walk();
			for child in target.children(&mut cursor) {
				if child.kind() == "method_elem" {
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

	pub struct NamedReturns;
	impl QualifierResolver for NamedReturns {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let result = node.child_by_field_name("result")?;
			if result.kind() != "parameter_list" {
				return None;
			}
			let mut cursor = result.walk();
			for child in result.children(&mut cursor) {
				if child.kind() == "parameter_declaration" {
					if child.child_by_field_name("name").is_some() {
						return Some(result.start_byte()..result.end_byte());
					}
				}
			}
			None
		}
	}
}

pub fn go_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(GoNameLexer),
		anchors:    vec![
			AnchorPattern {
				name:    "defer",
				matcher: |n, _s| has_descendant_kind(*n, "defer_statement"),
			},
			AnchorPattern {
				name:    "panic",
				matcher: |n, s| {
					if n.kind() != "call_expression" {
						return false;
					}
					let Some(func) = n.child_by_field_name("function") else {
						return false;
					};
					if func.kind() != "identifier" {
						return false;
					}
					let Some(text) = s.get(func.start_byte()..func.end_byte()) else {
						return false;
					};
					text == "panic"
				},
			},
			AnchorPattern {
				name:    "recover",
				matcher: |n, s| {
					if n.kind() != "call_expression" {
						return false;
					}
					let Some(func) = n.child_by_field_name("function") else {
						return false;
					};
					if func.kind() != "identifier" {
						return false;
					}
					let Some(text) = s.get(func.start_byte()..func.end_byte()) else {
						return false;
					};
					text == "recover"
				},
			},
			AnchorPattern {
				name:    "error-check",
				matcher: |n, s| {
					let mut stack = vec![*n];
					while let Some(node) = stack.pop() {
						if node.kind() == "if_statement" {
							if let Some(text) = s.get(node.start_byte()..node.end_byte()) {
								if text.contains("err != nil") {
									return true;
								}
							}
						}
						let mut cursor = node.walk();
						for child in node.children(&mut cursor) {
							stack.push(child);
						}
					}
					false
				},
			},
			AnchorPattern {
				name:    "return",
				matcher: |n, _s| has_descendant_kind(*n, "return_statement"),
			},
			AnchorPattern {
				name:    "first-import",
				matcher: |n, _s| {
					if n.kind() != "import_declaration" {
						return false;
					}
					let mut sib = n.prev_sibling();
					while let Some(p) = sib {
						if p.kind() == "import_declaration" {
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
					if n.kind() != "import_declaration" {
						return false;
					}
					let mut sib = n.next_sibling();
					while let Some(p) = sib {
						if p.kind() == "import_declaration" {
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
				applies_to: vec!["function_declaration".into(), "method_declaration".into()],
				resolve:    Arc::new(qualifiers::Body),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_declaration".into(), "method_declaration".into()],
				resolve:    Arc::new(qualifiers::Sig),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec![
					"function_declaration".into(),
					"method_declaration".into(),
					"type_spec".into(),
				],
				resolve:    Arc::new(qualifiers::Name),
			},
			QualifierSpec {
				name:       "receiver",
				applies_to: vec!["method_declaration".into()],
				resolve:    Arc::new(qualifiers::Receiver),
			},
			QualifierSpec {
				name:       "returns",
				applies_to: vec!["function_declaration".into(), "method_declaration".into()],
				resolve:    Arc::new(qualifiers::Returns),
			},
			QualifierSpec {
				name:       "type-params",
				applies_to: vec!["function_declaration".into(), "method_declaration".into()],
				resolve:    Arc::new(qualifiers::TypeParams),
			},
			QualifierSpec {
				name:       "struct-tag",
				applies_to: vec!["field_declaration".into(), "type_spec".into()],
				resolve:    Arc::new(qualifiers::StructTag),
			},
			QualifierSpec {
				name:       "interface-method-set",
				applies_to: vec!["interface_type".into(), "type_spec".into()],
				resolve:    Arc::new(qualifiers::InterfaceMethodSet),
			},
			QualifierSpec {
				name:       "named-returns",
				applies_to: vec!["function_declaration".into(), "method_declaration".into()],
				resolve:    Arc::new(qualifiers::NamedReturns),
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
		assert_eq!(d.anchors.len(), 7);
		assert_eq!(d.qualifiers.len(), 9);
	}
}
