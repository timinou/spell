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

fn temp_py(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

// ------------------------------------------------------------------
// Qualifier range tests
// ------------------------------------------------------------------

#[test]
fn qualifier_body_returns_block_range() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_py("foo.py", "def greet():\n    \"\"\"doc\"\"\"\n    x = 1\n", dir.path());
	let cp =
		parse_code_path("foo.py::greet#body", &pi_code_path::dialects::python::PyNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("x = 1"), "body should contain inner code, got: {}", text);
	assert!(!text.contains("def greet"), "body should not contain sig");
}

#[test]
fn qualifier_sig_excludes_body() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_py("foo.py", "def greet() -> str:\n    \"\"\"doc\"\"\"\n    x = 1\n", dir.path());
	let cp =
		parse_code_path("foo.py::greet#sig", &pi_code_path::dialects::python::PyNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("def greet"), "sig should contain declaration, got: {}", text);
	assert!(text.contains("-> str"), "sig should contain return annotation, got: {}", text);
	assert!(!text.contains("x = 1"), "sig should not contain body");
}

#[test]
fn qualifier_docstring_first_string_statement() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_py("foo.py", "def greet():\n    \"\"\"hello\"\"\"\n    pass\n", dir.path());
	let cp =
		parse_code_path("foo.py::greet#docstring", &pi_code_path::dialects::python::PyNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("hello"), "docstring should contain hello, got: {}", text);
	assert!(!text.contains("pass"), "docstring should not contain pass");
}

#[test]
fn qualifier_decorators_aggregate_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_py("foo.py", "@deco1\n@deco2\ndef greet():\n    pass\n", dir.path());
	let cp =
		parse_code_path("foo.py::greet#decorators", &pi_code_path::dialects::python::PyNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("@deco1"), "decorators should contain @deco1, got: {}", text);
	assert!(text.contains("@deco2"), "decorators should contain @deco2, got: {}", text);
}

#[test]
fn qualifier_return_annotation_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_py("foo.py", "def greet() -> str:\n    pass\n", dir.path());
	let cp = parse_code_path(
		"foo.py::greet#return-annotation",
		&pi_code_path::dialects::python::PyNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("str"), "return-annotation should contain str, got: {}", text);
}

#[test]
fn qualifier_base_classes_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_py("foo.py", "class Foo(BaseA, BaseB):\n    pass\n", dir.path());
	let cp =
		parse_code_path("foo.py::Foo#base-classes", &pi_code_path::dialects::python::PyNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("BaseA"), "base-classes should contain BaseA, got: {}", text);
	assert!(text.contains("BaseB"), "base-classes should contain BaseB, got: {}", text);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_async_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_py("foo.py", "async def greet():\n    pass\n\ndef normal():\n    pass\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_definition".into()),
		predicates: vec![Predicate::AnchorFilter("async".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one async match");
	assert_eq!(results.len(), 1, "only greet should match");
	assert_eq!(results[0].kind, "§function_definition");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("async"), "expected async fn, got: {}", matched);
}

#[test]
fn anchor_default_param_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_py("foo.py", "def greet(x=1):\n    pass\n\ndef no_default():\n    pass\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_definition".into()),
		predicates: vec![Predicate::AnchorFilter("default-param".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one default-param match");
	assert_eq!(results.len(), 1, "only greet should match");
	assert_eq!(results[0].kind, "§function_definition");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("greet"), "expected greet fn, got: {}", matched);
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
