use std::{path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Head, Predicate, Query, Step},
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver() -> CodeResolverImpl {
	let reg = LanguageRegistry::with_builtins().expect("builtins");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_html(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

// ------------------------------------------------------------------
// Qualifier range tests
// ------------------------------------------------------------------

#[test]
fn qualifier_inner_html_excludes_tags() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_html("foo.html", "<div class=\"foo\">hello <span>world</span></div>\n", dir.path());
	let cp =
		parse_code_path("foo.html::div#innerHTML", &pi_code_path::dialects::html::HtmlNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let elems: Vec<_> = results.iter().filter(|r| r.kind == "§element").collect();
	assert_eq!(elems.len(), 1, "expected one element match, got: {:?}", results);
	let text = elems[0].content.as_ref().unwrap().value();
	assert!(text.contains("hello"), "innerHTML should contain text, got: {}", text);
	assert!(text.contains("world"), "innerHTML should contain nested text, got: {}", text);
	assert!(!text.contains("<div"), "innerHTML should not contain start tag");
	assert!(!text.contains("</div>"), "innerHTML should not contain end tag");
}

#[test]
fn qualifier_outer_html_includes_tags() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_html("foo.html", "<div class=\"foo\">hello <span>world</span></div>\n", dir.path());
	let cp =
		parse_code_path("foo.html::div#outerHTML", &pi_code_path::dialects::html::HtmlNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let elems: Vec<_> = results.iter().filter(|r| r.kind == "§element").collect();
	assert_eq!(elems.len(), 1, "expected one element match, got: {:?}", results);
	let text = elems[0].content.as_ref().unwrap().value();
	assert!(text.contains("<div"), "outerHTML should contain start tag, got: {}", text);
	assert!(text.contains("</div>"), "outerHTML should contain end tag, got: {}", text);
	assert!(text.contains("hello"), "outerHTML should contain text");
}

#[test]
fn qualifier_text_concatenates() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_html("foo.html", "<div class=\"foo\">hello <span>world</span></div>\n", dir.path());
	let cp =
		parse_code_path("foo.html::div#text", &pi_code_path::dialects::html::HtmlNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let elems: Vec<_> = results.iter().filter(|r| r.kind == "§element").collect();
	assert_eq!(elems.len(), 1, "expected one element match, got: {:?}", results);
	let text = elems[0].content.as_ref().unwrap().value();
	assert!(text.contains("hello"), "text should contain hello, got: {}", text);
	assert!(text.contains("world"), "text should contain world, got: {}", text);
}

#[test]
fn qualifier_attr_returns_value() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_html("foo.html", "<div class=\"foo\" id=\"app\">content</div>\n", dir.path());
	let cp =
		parse_code_path("foo.html::div#attr[class]", &pi_code_path::dialects::html::HtmlNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let elems: Vec<_> = results.iter().filter(|r| r.kind == "§element").collect();
	assert_eq!(elems.len(), 1, "expected one element match, got: {:?}", results);
	let text = elems[0].content.as_ref().unwrap().value();
	assert_eq!(text, "\"foo\"", "attr should return quoted value, got: {}", text);
}

#[test]
fn qualifier_tag_returns_tag_name() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_html("foo.html", "<div>content</div>\n", dir.path());
	let cp =
		parse_code_path("foo.html::div#tag", &pi_code_path::dialects::html::HtmlNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let elems: Vec<_> = results.iter().filter(|r| r.kind == "§element").collect();
	assert_eq!(elems.len(), 1, "expected one element match, got: {:?}", results);
	let text = elems[0].content.as_ref().unwrap().value();
	assert_eq!(text, "div", "tag should return tag name, got: {}", text);
}

#[test]
fn qualifier_self_closing_empty_inner_html() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_html("foo.html", "<br/>\n", dir.path());
	let cp = parse_code_path("foo.html::br#innerHTML", &pi_code_path::dialects::html::HtmlNameLexer)
		.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let elems: Vec<_> = results.iter().filter(|r| r.kind == "§element").collect();
	assert_eq!(elems.len(), 1, "expected one element match, got: {:?}", results);
	let nref = elems[0];
	assert!(
		nref
			.diagnostics
			.iter()
			.any(|d| d.message.contains("empty range")),
		"expected diagnostic for empty innerHTML on self-closing tag, got: {:?}",
		nref.diagnostics
	);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_landmark_by_role_matches_landmark_tags() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_html("foo.html", "<header>hdr</header>\n<nav>nav</nav>\n<div>plain</div>\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("element".into()),
		predicates: vec![Predicate::AnchorFilter("landmark-by-role".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 2, "header and nav should match");
	let kinds: Vec<_> = results.iter().map(|r| r.kind.as_str()).collect();
	assert!(kinds.contains(&"§element"), "expected element matches");
}

#[test]
fn anchor_landmark_by_role_matches_role_attribute() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_html("foo.html", "<div role=\"main\">main</div>\n<span>plain</span>\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("element".into()),
		predicates: vec![Predicate::AnchorFilter("landmark-by-role".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	assert_eq!(results[0].kind, "§element");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("main"), "expected main div, got: {}", matched);
}

// Helper trait for tests to extract text from Content
trait ContentValue {
	fn value(&self) -> &str;
}

impl ContentValue for pi_code_path::types::Content {
	fn value(&self) -> &str {
		match self {
			pi_code_path::types::Content::Text { value } => value.as_str(),
			_ => panic!("expected Text content"),
		}
	}
}
