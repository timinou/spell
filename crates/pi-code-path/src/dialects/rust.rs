//! Rust NameLexer.
//!
//! Per `specs/code-graph/code-path-dialects/02-rust.md`. Names use `::` as
//! path separator with turbofish (`Foo::<T>::bar`), `impl Trait for Type`
//! shape, raw identifiers (`r#type`), and keyword segments (`crate`, `self`,
//! `super`, `Self`).
//!
//! Payload shape: `RustName { segments: Vec<RustSegment> }`. Encoded as
//! `NamePayload::Raw(rendered)` per kernel-wide convention.

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
}

pub struct RustNameLexer;

impl NameLexer for RustNameLexer {
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
		// Tree-sitter integration deferred to NAPI layer (PROJ-066 CodeResolver).
		false
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
	// Raw identifier: r#ident
	if input.starts_with("r#") {
		*input = &input[2..];
		let s: &str =
			take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
		return Ok(RustSegment::Raw(s.to_string()));
	}
	let s: &str =
		take_while(1.., |c: char| c.is_alphanumeric() || c == '_').parse_next(input)?;
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

// ── Anchors and qualifiers (stub matchers for now) ──────────────

struct StubResolver;
impl QualifierResolver for StubResolver {
	fn resolve(
		&self,
		_node: Node<'_>,
		_src: &str,
		_args: Option<&str>,
	) -> Option<Range<usize>> {
		// Real implementation lives in PROJ-066 (CodeResolver); this returns a
		// placeholder so the dialect compiles and registry round-trips.
		Some(0..0)
	}
}

fn match_kind(node: &Node<'_>, kinds: &[&str]) -> bool {
	kinds.contains(&node.kind())
}

pub fn rust_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(RustNameLexer),
		anchors: vec![
			AnchorPattern {
				name:    "test-attr",
				matcher: |n, _s| match_kind(n, &["attribute_item"]),
			},
			AnchorPattern {
				name:    "derive",
				matcher: |n, _s| match_kind(n, &["attribute_item"]),
			},
			AnchorPattern {
				name:    "unsafe-block",
				matcher: |n, _s| match_kind(n, &["unsafe_block"]),
			},
			AnchorPattern {
				name:    "pub",
				matcher: |n, _s| match_kind(n, &["visibility_modifier"]),
			},
			AnchorPattern { name: "mut", matcher: |n, _s| match_kind(n, &["mutable_specifier"]) },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function_item".into(), "impl_item".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_item".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["function_item".into(), "struct_item".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["function_item".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "return-type",
				applies_to: vec!["function_item".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "generics",
				applies_to: vec!["function_item".into(), "struct_item".into()],
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
		let cp = crate::parser::parse_code_path("src/lib.rs::crate::util::parse#body", &RustNameLexer)
			.expect("parse should succeed");
		assert_eq!(cp.qualifier.as_ref().unwrap().name, "body");
	}

	#[test]
	fn dialect_factory_populates_registries() {
		let d = rust_dialect();
		assert_eq!(d.anchors.len(), 5);
		assert_eq!(d.qualifiers.len(), 6);
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
