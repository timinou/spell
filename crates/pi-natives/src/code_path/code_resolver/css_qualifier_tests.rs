//! AST tests for CSS dialect qualifier/anchor resolvers (FEAT-677).
use std::{path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Head, NamePayload, Predicate, Query, Step},
	dialects::css::CssNameLexer,
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver() -> CodeResolverImpl {
	let reg = LanguageRegistry::with_builtins().expect("builtins");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_css(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
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

fn has_content(results: &[pi_code_path::types::NodeRef], expected: &str) -> bool {
	results.iter().any(|r| {
		r.content
			.as_ref()
			.map(|c| c.value().trim() == expected)
			.unwrap_or(false)
	})
}

// ------------------------------------------------------------------
// Qualifier range tests
// ------------------------------------------------------------------

#[test]
fn qualifier_selector() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { color: red; }\n", dir.path());
	let cp = parse_code_path("styles.css::.btn#selector", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(has_content(&results, ".btn"), "expected .btn selector in results, got: {:?}", results);
}

#[test]
fn qualifier_declaration() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { color: red; }\n", dir.path());
	let cp = parse_code_path("styles.css::.btn#declaration[color]", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(
		has_content(&results, "color: red;"),
		"expected color: red; declaration in results, got: {:?}",
		results
	);
}

#[test]
fn qualifier_value() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { color: red; }\n", dir.path());
	let cp = parse_code_path("styles.css::.btn#value", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(has_content(&results, "red"), "expected red value in results, got: {:?}", results);
}

#[test]
fn qualifier_value_excludes_important() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { color: red !important; }\n", dir.path());
	let cp = parse_code_path("styles.css::.btn#value", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(
		has_content(&results, "red"),
		"expected red value (without !important) in results, got: {:?}",
		results
	);
}

#[test]
fn qualifier_specificity_returns_selectors() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { color: red; }\n", dir.path());
	let cp = parse_code_path("styles.css::.btn#specificity", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(
		has_content(&results, ".btn"),
		"expected .btn specificity range in results, got: {:?}",
		results
	);
}

#[test]
fn qualifier_prelude_on_media() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_css("styles.css", "@media (max-width: 600px) { .card { margin: 0; } }\n", dir.path());
	let query = Query::single(Step {
		axis:       None,
		head:       Head::Name(NamePayload::Raw("*".into())),
		predicates: vec![Predicate::KindFilter("media_statement".into())],
	});
	let qualifier = pi_code_path::ast::Qualifier { name: "prelude".into(), args: None };
	let results = resolver()
		.resolve(&path, &query, Some(&qualifier), &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert_eq!(
		text.trim(),
		"@media (max-width: 600px)",
		"prelude should be @media (max-width: 600px), got: {}",
		text
	);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_important_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { color: red !important; margin: 0; }\n", dir.path());
	let cp = parse_code_path("styles.css::*[¶important]", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1, "expected exactly one !important declaration");
	assert_eq!(results[0].kind, "§declaration");
	let src = std::fs::read_to_string(&path).unwrap();
	let text = &src[results[0].range.clone()];
	assert!(text.contains("important"), "expected important in {}", text);
}

#[test]
fn anchor_custom_prop_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css("styles.css", ".btn { --my-var: blue; color: red; }\n", dir.path());
	let cp = parse_code_path("styles.css::*[¶custom-prop]", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1, "expected exactly one custom property declaration");
	assert_eq!(results[0].kind, "§declaration");
	let src = std::fs::read_to_string(&path).unwrap();
	let text = &src[results[0].range.clone()];
	assert!(text.contains("--my-var"), "expected --my-var in {}", text);
}

#[test]
fn anchor_vendor_prefix_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_css(
		"styles.css",
		".btn { -webkit-transform: rotate(45deg); color: red; }\n",
		dir.path(),
	);
	let cp = parse_code_path("styles.css::*[¶vendor-prefix]", &CssNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1, "expected exactly one vendor-prefixed declaration");
	assert_eq!(results[0].kind, "§declaration");
	let src = std::fs::read_to_string(&path).unwrap();
	let text = &src[results[0].range.clone()];
	assert!(text.contains("-webkit-transform"), "expected -webkit-transform in {}", text);
}
