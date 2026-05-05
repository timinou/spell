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

	fn matches(&self, n: &NamePayload, node: Node<'_>, src: &str) -> bool {
		let rendered = self.render(n);
		let kind = node.kind();
		// Only match structural heading/section nodes
		if !matches!(kind, "section" | "atx_heading" | "setext_heading" | "headline") {
			return false;
		}
		if let Some(heading) = heading_child(node) {
			if let Some(text_node) = heading_text_node(heading) {
				if let Some(text) = src.get(text_node.start_byte()..text_node.end_byte()) {
					return text.trim() == rendered.trim();
				}
			}
		}
		if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
			return text.trim() == rendered.trim();
		}
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

fn heading_child(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if match_kind(&child, &["atx_heading", "setext_heading", "headline"]) {
			return Some(child);
		}
	}
	None
}

fn heading_text_node(node: Node<'_>) -> Option<Node<'_>> {
	if let Some(field) = node.child_by_field_name("heading_content") {
		return Some(field);
	}
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == "inline" {
			return Some(child);
		}
		if child.kind() == "item" {
			return Some(child);
		}
	}
	None
}

fn first_child_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == kind {
			return Some(child);
		}
	}
	None
}

mod qualifiers {
	use std::ops::Range;
	use tree_sitter::Node;
	use crate::dialect::QualifierResolver;
	use crate::dialects::mdorg::{first_child_kind, has_descendant_kind, heading_child, heading_text_node, match_kind};

	pub struct Body;
	impl QualifierResolver for Body {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			Some(heading.end_byte()..node.end_byte())
		}
	}

	pub struct Intro;
	impl QualifierResolver for Intro {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			let heading_end = heading.end_byte();
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "section" && child.start_byte() >= heading_end {
					return Some(heading_end..child.start_byte());
				}
			}
			Some(heading_end..node.end_byte())
		}
	}

	pub struct FirstPara;
	impl QualifierResolver for FirstPara {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "paragraph" && child.start_byte() >= heading.end_byte() {
					return Some(child.start_byte()..child.end_byte());
				}
			}
			None
		}
	}

	pub struct Title;
	impl QualifierResolver for Title {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			heading_text_node(heading).map(|n| n.start_byte()..n.end_byte())
		}
	}

	pub struct Level;
	impl QualifierResolver for Level {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			let mut cursor = heading.walk();
			for child in heading.children(&mut cursor) {
				let kind = child.kind();
				if kind.starts_with("atx_h") && kind.ends_with("_marker") {
					return Some(child.start_byte()..child.end_byte());
				}
				if kind == "stars" {
					return Some(child.start_byte()..child.end_byte());
				}
			}
			None
		}
	}

	pub struct Toc;
	impl QualifierResolver for Toc {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "list" && child.start_byte() >= heading.end_byte() {
					return Some(child.start_byte()..child.end_byte());
				}
			}
			None
		}
	}

	pub struct Frontmatter;
	impl QualifierResolver for Frontmatter {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			if node.kind() != "document" {
				return None;
			}
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if match_kind(&child, &["minus_metadata", "plus_metadata"]) {
					return Some(child.start_byte()..child.end_byte());
				}
			}
			None
		}
	}

	pub struct Logbook;
	impl QualifierResolver for Logbook {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "drawer" {
					if let Some(name_node) = first_child_kind(child, "expr") {
						if let Some(name) = src.get(name_node.start_byte()..name_node.end_byte()) {
							if name == "LOGBOOK" {
								return first_child_kind(child, "contents")
									.map(|n| n.start_byte()..n.end_byte());
							}
						}
					}
				}
			}
			None
		}
	}

	pub struct Properties;
	impl QualifierResolver for Properties {
		fn resolve(&self, node: Node<'_>, src: &str, args: Option<&str>) -> Option<Range<usize>> {
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "drawer" {
					if let Some(name_node) = first_child_kind(child, "expr") {
						if let Some(name) = src.get(name_node.start_byte()..name_node.end_byte()) {
							if name == "PROPERTIES" {
								if let Some(key) = args {
									if let Some(contents) = first_child_kind(child, "contents") {
										let text = src.get(contents.start_byte()..contents.end_byte())?;
										let needle = format!(":{}:", key);
										if let Some(start) = text.find(&needle) {
											let line_start = contents.start_byte() + start;
											let rest = &text[start + needle.len()..];
											let line_end = if let Some(nl) = rest.find('\n') {
												contents.start_byte() + start + needle.len() + nl
											} else {
												contents.end_byte()
											};
											return Some(line_start..line_end);
										}
									}
									return None;
								}
								return first_child_kind(child, "contents")
									.map(|n| n.start_byte()..n.end_byte());
							}
						}
					}
				}
			}
			None
		}
	}

	pub struct TodoState;
	impl QualifierResolver for TodoState {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			let item = heading_text_node(heading)?;
			let text = src.get(item.start_byte()..item.end_byte())?;
			let first_word = text.split_whitespace().next()?;
			const TODO_KEYWORDS: &[&str] = &["TODO", "DONE", "DOING", "CANCELLED", "WAITING", "HOLD", "IDEA"];
			if TODO_KEYWORDS.iter().any(|k| *k == first_word) {
				let start = item.start_byte();
				return Some(start..start + first_word.len());
			}
			None
		}
	}

	pub struct Priority;
	impl QualifierResolver for Priority {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			let item = heading_text_node(heading)?;
			let text = src.get(item.start_byte()..item.end_byte())?;
			if let Some(start) = text.find("#A").or_else(|| text.find("#B")).or_else(|| text.find("#C")) {
				let abs_start = item.start_byte() + start;
				return Some(abs_start..abs_start + 2);
			}
			None
		}
	}

	pub struct Tags;
	impl QualifierResolver for Tags {
		fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let heading = heading_child(node)?;
			first_child_kind(heading, "tag_list").map(|n| n.start_byte()..n.end_byte())
		}
	}

	pub struct Scheduled;
	impl QualifierResolver for Scheduled {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "plan" {
					let mut c2 = child.walk();
					for entry in child.children(&mut c2) {
						if entry.kind() == "entry" {
							if let Some(name_node) = entry.child_by_field_name("entry_name") {
								if let Some(name) = src.get(name_node.start_byte()..name_node.end_byte()) {
									if name == "SCHEDULED" {
										return Some(entry.start_byte()..entry.end_byte());
									}
								}
							}
						}
					}
				}
			}
			None
		}
	}

	pub struct Deadline;
	impl QualifierResolver for Deadline {
		fn resolve(&self, node: Node<'_>, src: &str, _args: Option<&str>) -> Option<Range<usize>> {
			let mut cursor = node.walk();
			for child in node.children(&mut cursor) {
				if child.kind() == "plan" {
					let mut c2 = child.walk();
					for entry in child.children(&mut c2) {
						if entry.kind() == "entry" {
							if let Some(name_node) = entry.child_by_field_name("entry_name") {
								if let Some(name) = src.get(name_node.start_byte()..name_node.end_byte()) {
									if name == "DEADLINE" {
										return Some(entry.start_byte()..entry.end_byte());
									}
								}
							}
						}
					}
				}
			}
			None
		}
	}
}

/// Bundle the Markdown / Org dialect.
pub fn markdown_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(MdNameLexer),
		anchors: vec![
			AnchorPattern {
				name: "code-block",
				matcher: |n, _s| {
					match_kind(n, &["fenced_code_block", "code_fence_content"])
						|| (n.kind() == "section" && has_descendant_kind(*n, "fenced_code_block"))
				},
			},
			AnchorPattern { name: "quote", matcher: |n, _s| match_kind(n, &["block_quote"]) },
			AnchorPattern {
				name: "table",
				matcher: |n, _s| {
					match_kind(n, &["pipe_table", "table"])
						|| (n.kind() == "section" && (has_descendant_kind(*n, "pipe_table") || has_descendant_kind(*n, "table")))
				},
			},
			AnchorPattern {
				name: "image",
				matcher: |n, s| {
					if n.kind() != "paragraph" {
						return false;
					}
					if let Some(inline) = first_child_kind(*n, "inline") {
						if let Some(text) = s.get(inline.start_byte()..inline.end_byte()) {
							return text.starts_with("![");
						}
					}
					false
				},
			},
			AnchorPattern {
				name: "footnote",
				matcher: |n, s| {
					if n.kind() != "paragraph" {
						return false;
					}
					if let Some(inline) = first_child_kind(*n, "inline") {
						if let Some(text) = s.get(inline.start_byte()..inline.end_byte()) {
							return text.starts_with("[^");
						}
					}
					false
				},
			},
			AnchorPattern {
				name: "agenda-item",
				matcher: |n, s| {
					if n.kind() != "section" {
						return false;
					}
					let Some(heading) = heading_child(*n) else { return false };
					let Some(item) = heading_text_node(heading) else { return false };
					let Some(text) = s.get(item.start_byte()..item.end_byte()) else { return false };
					let first = text.split_whitespace().next().unwrap_or("");
					!matches!(first, "DONE" | "CANCELLED")
						&& ["TODO", "DOING", "WAITING", "HOLD", "IDEA"].contains(&first)
				},
			},
			AnchorPattern {
				name: "archived",
				matcher: |n, s| {
					if n.kind() != "section" {
						return false;
					}
					let text = s.get(n.start_byte()..n.end_byte()).unwrap_or("");
					text.contains(":ARCHIVE:") || text.contains("#+ARCHIVE:")
				},
			},
			AnchorPattern {
				name: "checkbox",
				matcher: |n, _s| n.kind() == "listitem" && has_descendant_kind(*n, "checkbox"),
			},
			AnchorPattern {
				name: "deadline-soon",
				matcher: |n, s| {
					if n.kind() != "section" {
						return false;
					}
					let mut cursor = n.walk();
					for child in n.children(&mut cursor) {
						if child.kind() == "plan" {
							let mut c2 = child.walk();
							for entry in child.children(&mut c2) {
								if entry.kind() == "entry" {
									if let Some(name) = entry.child_by_field_name("entry_name") {
										if let Some(text) = s.get(name.start_byte()..name.end_byte()) {
											if text == "DEADLINE" {
												return true;
											}
										}
									}
								}
							}
						}
					}
					false
				},
			},
		],
		qualifiers: vec![
			QualifierSpec {
				name: "body",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Body),
			},
			QualifierSpec {
				name: "intro",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Intro),
			},
			QualifierSpec {
				name: "first-para",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::FirstPara),
			},
			QualifierSpec {
				name: "toc",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Toc),
			},
			QualifierSpec {
				name: "frontmatter",
				applies_to: vec!["document".into()],
				resolve: Arc::new(qualifiers::Frontmatter),
			},
			QualifierSpec {
				name: "title",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Title),
			},
			QualifierSpec {
				name: "level",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Level),
			},
			QualifierSpec {
				name: "logbook",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Logbook),
			},
			QualifierSpec {
				name: "properties",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Properties),
			},
			QualifierSpec {
				name: "todo-state",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::TodoState),
			},
			QualifierSpec {
				name: "priority",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Priority),
			},
			QualifierSpec {
				name: "tags",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Tags),
			},
			QualifierSpec {
				name: "scheduled",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Scheduled),
			},
			QualifierSpec {
				name: "deadline",
				applies_to: vec!["section".into()],
				resolve: Arc::new(qualifiers::Deadline),
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
		assert_eq!(d.anchors.len(), 9);
		assert_eq!(d.qualifiers.len(), 14);
	}
}
