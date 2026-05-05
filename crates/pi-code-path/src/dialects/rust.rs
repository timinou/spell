//! Rust NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/02-rust.md`. Names use `::` as
//! path separator with turbofish (`Foo::<T>::bar`), `impl Trait for Type`
//! shape, raw identifiers (`r#type`), and keyword segments (`crate`, `self`,
//! `super`, `Self`).
//!
//! Payload shape: `RustName { segments: Vec<RustSegment> }`. Encoded as
//! `NamePayload::Raw(rendered)` per kernel-wide convention.

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
pub struct RustName {
	pub segments: Vec<RustSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RustSegment {
	/// Plain identifier (`Buffer`, `from_str`).
	Ident(String),
	/// Raw identifier prefixed `r#` (`r#type`, `r#match`).
	Raw(String),
	/// Path keyword (`crate`, `self`, `super`, `Self`).
	Keyword(String),
	/// Turbofish generic args, e.g. `<T>` or `<i32, String>`. Held as raw
	/// inside-the-`<>` source for round-trip.
	Turbofish(String),
	/// `impl Trait for Type` clause encoded as a single segment for
	/// path purposes; the final method segment follows in subsequent segments.
	ImplFor { trait_: String, ty: String },
	/// Backtick-quoted verbatim text.
	Quoted(String),
}

pub struct RustNameLexer;

impl NameLexer for RustNameLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
		let segments = parse_segments(input)?;
		if segments.is_empty() {
			return Err(winnow::error::ContextError::default());
		}
		if segments.iter().any(|s| matches!(s, RustSegment::Quoted(_))) {
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

	fn matches(&self, n: &NamePayload, _node: Node<'_>, _src: &str) -> bool {
		match n {
			NamePayload::Raw(_) => false,
			NamePayload::Quoted(_) => false,
		}
	}
}

fn parse_segments(input: &mut &str) -> winnow::Result<Vec<RustSegment>> {
	// Handle `impl Trait for Type` prefix as a single ImplFor segment.
	if let Some(rest) = input.strip_prefix("impl ") {
		// Find " for " separator and trailing "::<rest>".
		if let Some(for_idx) = rest.find(" for ") {
			let trait_part = &rest[..for_idx];
			let after_for = &rest[for_idx + 5..];
			// Type goes up to "::" or end/kernel-op.
			let mut ty_end = 0;
			let bytes = after_for.as_bytes();
			while ty_end < bytes.len() {
				let ch = bytes[ty_end] as char;
				if ch.is_ascii_alphanumeric() || ch == '_' || ch == '<' || ch == '>' {
					ty_end += 1;
				} else {
					break;
				}
			}
			if ty_end > 0 {
				let ty = &after_for[..ty_end];
				let mut segments = vec![RustSegment::ImplFor {
					trait_: trait_part.to_string(),
					ty:     ty.to_string(),
				}];
				// Consume input up to here.
				let consumed = "impl ".len() + for_idx + 5 + ty_end;
				*input = &input[consumed..];
				// Optional `::method` continuation.
				if input.starts_with("::") {
					*input = &input[2..];
					let extra = parse_segments(input)?;
					segments.extend(extra);
				}
				return Ok(segments);
			}
		}
	}

	let mut segments = Vec::new();
	let first = parse_segment(input)?;
	segments.push(first);
	while input.starts_with("::") {
		let snapshot = *input;
		*input = &input[2..];
		// Turbofish: ::<T>
		if input.starts_with('<') {
			*input = &input[1..];
			let mut depth = 1;
			let mut buf = String::new();
			let mut chars = input.char_indices();
			let mut consumed = 0;
			for (idx, c) in chars.by_ref() {
				match c {
					'<' => {
						depth += 1;
						buf.push(c);
					},
					'>' => {
						depth -= 1;
						if depth == 0 {
							consumed = idx + c.len_utf8();
							break;
						}
						buf.push(c);
					},
					_ => buf.push(c),
				}
			}
			if depth != 0 || buf.is_empty() {
				// reject `Vec::<>` (empty turbofish) and unbalanced.
				*input = snapshot;
				break;
			}
			*input = &input[consumed..];
			segments.push(RustSegment::Turbofish(buf));
			continue;
		}
		match parse_segment(input) {
			Ok(seg) => segments.push(seg),
			Err(_) => {
				*input = snapshot;
				break;
			},
		}
	}
	Ok(segments)
}

fn parse_segment(input: &mut &str) -> winnow::Result<RustSegment> {
	// Backtick-quoted verbatim text
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
		return Ok(RustSegment::Quoted(buf));
	}
	// Raw identifier: r#ident
	if input.starts_with("r#") {
		*input = &input[2..];
		let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
		return Ok(RustSegment::Raw(s.to_string()));
	}
	let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
	let owned = s.to_string();
	if matches!(owned.as_str(), "crate" | "self" | "super" | "Self") {
		Ok(RustSegment::Keyword(owned))
	} else {
		Ok(RustSegment::Ident(owned))
	}
}

fn render_segments(segs: &[RustSegment]) -> String {
	let mut out = String::new();
	let mut first = true;
	for seg in segs {
		match seg {
			RustSegment::Turbofish(args) => {
				out.push_str("::<");
				out.push_str(args);
				out.push('>');
			},
			RustSegment::ImplFor { trait_, ty } => {
				if !first {
					out.push_str("::");
				}
				out.push_str("impl ");
				out.push_str(trait_);
				out.push_str(" for ");
				out.push_str(ty);
			},
			seg => {
				if !first {
					out.push_str("::");
				}
				match seg {
					RustSegment::Ident(s) | RustSegment::Keyword(s) => out.push_str(s),
					RustSegment::Raw(s) => {
						out.push_str("r#");
						out.push_str(s);
					},
					_ => unreachable!(),
				}
			},
		}
		first = false;
	}
	out
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

	pub struct Generics;
	impl QualifierResolver for Generics {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("type_parameters")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct WhereClause;
	impl QualifierResolver for WhereClause {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("where_clause")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct Attrs;
	impl QualifierResolver for Attrs {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut first: Option<Node> = None;
			let mut last: Option<Node> = None;
			// Try children first (some tree-sitter versions embed attrs).
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "attribute_item" {
					if first.is_none() {
						first = Some(child);
					}
					last = Some(child);
				}
			}
			// Fall back to prev-siblings (attrs as siblings preceding decl).
			if first.is_none() {
				let mut sib = node.prev_sibling();
				while let Some(n) = sib {
					if n.kind() == "attribute_item" {
						if last.is_none() {
							last = Some(n);
						}
						first = Some(n);
						sib = n.prev_sibling();
					} else if n.is_named() {
						break;
					} else {
						sib = n.prev_sibling();
					}
				}
			}
			match (first, last) {
				(Some(f), Some(l)) => Some(f.start_byte()..l.end_byte()),
				_ => None,
			}
		}
	}

	pub struct Visibility;
	impl QualifierResolver for Visibility {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			node
				.child_by_field_name("visibility_modifier")
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct MatchArm;
	impl QualifierResolver for MatchArm {
		fn resolve(&self, node: Node<'_>, _src: &str, args: Option<&str>) -> Option<Range<usize>> {
			let idx = args.and_then(|a| a.parse::<usize>().ok()).unwrap_or(0);
			let mut cursor = node.walk();
			node
				.children(&mut cursor)
				.filter(|c| c.kind() == "match_arm")
				.nth(idx)
				.map(|c| c.start_byte()..c.end_byte())
		}
	}

	pub struct UnsafeBlock;
	impl QualifierResolver for UnsafeBlock {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut stack = vec![node];
			while let Some(n) = stack.pop() {
				if n.kind() == "unsafe_block" {
					return Some(n.start_byte()..n.end_byte());
				}
				let mut cursor = n.walk();
				for child in n.children(&mut cursor) {
					stack.push(child);
				}
			}
			None
		}
	}
}

fn match_kind(node: &Node<'_>, kinds: &[&str]) -> bool {
	kinds.contains(&node.kind())
}

fn has_prev_sibling_attr(node: &Node<'_>, src: &str, needle: &str) -> bool {
	let mut sib = node.prev_sibling();
	while let Some(n) = sib {
		if n.kind() == "attribute_item" {
			if let Some(text) = src.get(n.start_byte()..n.end_byte()) {
				if text.contains(needle) {
					return true;
				}
			}
		}
		sib = n.prev_sibling();
	}
	false
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
pub fn rust_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(RustNameLexer),
		anchors:    vec![
			AnchorPattern {
				name:    "test-body",
				matcher: |n, src| {
					match_kind(n, &["function_item"]) && has_prev_sibling_attr(n, src, "#[test]")
				},
			},
			AnchorPattern {
				name:    "bench-body",
				matcher: |n, src| {
					match_kind(n, &["function_item"]) && has_prev_sibling_attr(n, src, "#[bench]")
				},
			},
			AnchorPattern {
				name:    "unsafe",
				matcher: |n, src| {
					if match_kind(n, &["unsafe_block"]) {
						return true;
					}
					if has_descendant_kind(*n, "unsafe_block") {
						return true;
					}
					if let Some(text) = src.get(n.start_byte()..n.end_byte()) {
						if text.contains("unsafe") {
							return true;
						}
					}
					false
				},
			},
			AnchorPattern {
				name:    "return",
				matcher: |n, _src| has_descendant_kind(*n, "return_expression"),
			},
			AnchorPattern {
				name:    "guard",
				matcher: |n, src| {
					if has_descendant_kind(*n, "if_let_expression") {
						return true;
					}
					if let Some(text) = src.get(n.start_byte()..n.end_byte()) {
						if text.contains("else { return") || text.contains("else {return") {
							return true;
						}
					}
					false
				},
			},
			AnchorPattern {
				name:    "error-path",
				matcher: |n, src| {
					if has_descendant_kind(*n, "try_expression") {
						return true;
					}
					if let Some(text) = src.get(n.start_byte()..n.end_byte()) {
						if text.contains('?') {
							return true;
						}
					}
					false
				},
			},
			AnchorPattern {
				name:    "first-use",
				matcher: |n, _src| {
					if n.kind() != "use_declaration" {
						return false;
					}
					let mut sib = n.prev_sibling();
					while let Some(p) = sib {
						if p.kind() == "use_declaration" {
							return false;
						}
						sib = p.prev_sibling();
					}
					true
				},
			},
			AnchorPattern {
				name:    "last-use",
				matcher: |n, _src| {
					if n.kind() != "use_declaration" {
						return false;
					}
					let mut sib = n.next_sibling();
					while let Some(p) = sib {
						if p.kind() == "use_declaration" {
							return false;
						}
						sib = p.next_sibling();
					}
					true
				},
			},
			AnchorPattern {
				name:    "mod-side-effect",
				matcher: |n, _src| {
					if n.kind() != "mod_item" {
						return false;
					}
					let mut cursor = n.walk();
					for child in n.children(&mut cursor) {
						if child.kind() == "expression_statement" {
							return true;
						}
					}
					false
				},
			},
			AnchorPattern {
				name:    "doc-comment",
				matcher: |n, src| {
					let mut sib = n.prev_sibling();
					while let Some(p) = sib {
						if p.kind() == "line_comment" {
							if let Some(text) = src.get(p.start_byte()..p.end_byte()) {
								if text.starts_with("///") || text.starts_with("//!") {
									return true;
								}
							}
							sib = p.prev_sibling();
						} else if p.is_named() {
							break;
						} else {
							sib = p.prev_sibling();
						}
					}
					false
				},
			},
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec![
					"function_item".into(),
					"impl_item".into(),
					"mod_item".into(),
					"trait_item".into(),
				],
				resolve:    Arc::new(qualifiers::Body),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_item".into()],
				resolve:    Arc::new(qualifiers::Sig),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec![
					"function_item".into(),
					"struct_item".into(),
					"enum_item".into(),
					"trait_item".into(),
					"impl_item".into(),
					"type_item".into(),
					"module".into(),
					"mod_item".into(),
				],
				resolve:    Arc::new(qualifiers::Name),
			},
			QualifierSpec {
				name:       "generics",
				applies_to: vec![
					"function_item".into(),
					"struct_item".into(),
					"enum_item".into(),
					"trait_item".into(),
					"impl_item".into(),
					"type_item".into(),
				],
				resolve:    Arc::new(qualifiers::Generics),
			},
			QualifierSpec {
				name:       "where",
				applies_to: vec!["function_item".into(), "trait_item".into(), "impl_item".into()],
				resolve:    Arc::new(qualifiers::WhereClause),
			},
			QualifierSpec {
				name:       "attrs",
				applies_to: vec![
					"function_item".into(),
					"struct_item".into(),
					"enum_item".into(),
					"trait_item".into(),
					"impl_item".into(),
					"mod_item".into(),
				],
				resolve:    Arc::new(qualifiers::Attrs),
			},
			QualifierSpec {
				name:       "visibility",
				applies_to: vec![
					"function_item".into(),
					"struct_item".into(),
					"enum_item".into(),
					"trait_item".into(),
					"impl_item".into(),
					"mod_item".into(),
					"const_item".into(),
					"static_item".into(),
					"type_item".into(),
				],
				resolve:    Arc::new(qualifiers::Visibility),
			},
			QualifierSpec {
				name:       "match-arm",
				applies_to: vec!["match_expression".into(), "match_block".into()],
				resolve:    Arc::new(qualifiers::MatchArm),
			},
			QualifierSpec {
				name:       "unsafe-block",
				applies_to: vec!["function_item".into(), "impl_item".into(), "block".into()],
				resolve:    Arc::new(qualifiers::UnsafeBlock),
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
		let mut input = "parseConfig";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "parseConfig"));
	}

	#[test]
	fn parse_double_colon_path() {
		let mut input = "crate::util::parse";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "crate::util::parse"));
	}

	#[test]
	fn parse_std_path() {
		let mut input = "std::collections::HashMap";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "std::collections::HashMap"));
	}

	#[test]
	fn parse_turbofish() {
		let mut input = "Vec::<T>::new";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Vec::<T>::new"));
	}

	#[test]
	fn parse_turbofish_nested() {
		let mut input = "Vec::<Box<dyn T>>";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Vec::<Box<dyn T>>"));
	}

	#[test]
	fn parse_raw_ident() {
		let mut input = "r#type";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "r#type"));
	}

	#[test]
	fn parse_impl_for() {
		let mut input = "impl Write for Buffer::write_all";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "impl Write for Buffer::write_all"));
	}

	#[test]
	fn stops_at_kernel_slash() {
		let mut input = "Foo::bar/baz";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo::bar"));
		assert_eq!(input, "/baz");
	}

	#[test]
	fn stops_at_predicate() {
		let mut input = "Foo[0]";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
		assert_eq!(input, "[0]");
	}

	#[test]
	fn stops_at_qualifier() {
		let mut input = "Foo#body";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
		assert_eq!(input, "#body");
	}

	#[test]
	fn round_trip_via_codepath_parser() {
		let cp =
			crate::parser::parse_code_path("src/lib.rs::crate::util::parse#body", &RustNameLexer)
				.expect("parse should succeed");
		assert_eq!(cp.qualifier.as_ref().unwrap().name, "body");
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = rust_dialect();
		assert_eq!(d.anchors.len(), 10);
		assert_eq!(d.qualifiers.len(), 9);
		assert!(d.edge_kinds.kinds.len() >= 4);
	}

	#[test]
	fn empty_turbofish_rejected() {
		let mut input = "Vec::<>";
		let payload = RustNameLexer.parse(&mut input).unwrap();
		// Empty turbofish leaves `::<>` unconsumed; only `Vec` is taken.
		assert!(matches!(payload, NamePayload::Raw(s) if s == "Vec"));
	}
}
