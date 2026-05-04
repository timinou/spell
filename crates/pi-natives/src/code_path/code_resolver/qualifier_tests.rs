use std::{path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Head, NamePayload, Predicate, Query, Step},
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver() -> CodeResolverImpl {
	let reg = LanguageRegistry::with_builtins().expect("builtins");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_rs(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
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
	let path = temp_rs("foo.rs", r#"fn my_fn() { let x = 1; }"#, dir.path());
	let cp =
		parse_code_path("foo.rs::my_fn#body", &pi_code_path::dialects::rust::RustNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let node = &results[0];
	let text = node.content.as_ref().unwrap().value();
	assert!(text.contains("let x = 1"), "body should contain inner code, got: {}", text);
	assert!(!text.contains("fn my_fn"), "body should not contain sig");
}

#[test]
fn qualifier_sig_excludes_body() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs("foo.rs", r#"fn my_fn() { let x = 1; }"#, dir.path());
	let cp =
		parse_code_path("foo.rs::my_fn#sig", &pi_code_path::dialects::rust::RustNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("fn my_fn"), "sig should contain declaration");
	assert!(!text.contains("let x = 1"), "sig should not contain body");
}

#[test]
fn qualifier_name_returns_identifier_range() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs("foo.rs", r#"fn my_fn() {}"#, dir.path());
	let cp =
		parse_code_path("foo.rs::my_fn#name", &pi_code_path::dialects::rust::RustNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert_eq!(text.trim(), "my_fn");
}

#[test]
fn qualifier_generics_on_impl_block() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs("foo.rs", r#"struct Foo<T>(T);"#, dir.path());
	let cp = parse_code_path("foo.rs::Foo#generics", &pi_code_path::dialects::rust::RustNameLexer)
		.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains('<'), "generics should contain <, got: {}", text);
	assert!(text.contains('>'), "generics should contain >, got: {}", text);
}

#[test]
fn qualifier_attrs_aggregate_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"#[derive(Debug)]
#[derive(Clone)]
fn my_fn() {}
"#,
		dir.path(),
	);
	let cp =
		parse_code_path("foo.rs::my_fn#attrs", &pi_code_path::dialects::rust::RustNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("derive(Debug)"), "attrs should contain first attr, got: {}", text);
	assert!(text.contains("derive(Clone)"), "attrs should contain second attr, got: {}", text);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_test_body_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"#[test]
fn it_works() {}
fn normal() {}
"#,
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Anchor),
		head:       Head::AnchorName("test-body".into()),
		predicates: vec![],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one test-body match");
	assert!(results.iter().any(|r| r.kind == "§function_item"));
}

#[test]
fn anchor_unsafe_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"fn foo() { unsafe { let x = 1; } }
fn bar() {}
"#,
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_item".into()),
		predicates: vec![Predicate::AnchorFilter("unsafe".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one unsafe match");
}

#[test]
fn anchor_doc_comment_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"/// A documented function
fn doc_fn() {}
fn undoc_fn() {}
"#,
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_item".into()),
		predicates: vec![Predicate::AnchorFilter("doc-comment".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one doc-comment match");
	assert_eq!(results.len(), 1, "only doc_fn should match");
}

#[test]
fn has_descendant_return_matches_fn() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"fn my_fn() { return 1; }
fn no_return() {}
"#,
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::Name(NamePayload::Raw("my_fn".into())),
		predicates: vec![Predicate::HasDescendant(Box::new(Query::single(Step {
			axis:       Some(pi_code_path::ast::Axis::Structural),
			head:       Head::NodeKind("return_expression".into()),
			predicates: vec![],
		})))],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	assert_eq!(results[0].kind, "§function_item");
}

#[test]
fn anchor_not_found_returns_empty() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"fn foo() {}
"#,
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_item".into()),
		predicates: vec![Predicate::AnchorFilter("bench-body".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(results.is_empty(), "expected empty results for unmatched anchor");
}

#[test]
fn qualifier_on_non_applicable_node_emits_diagnostic() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_rs(
		"foo.rs",
		r#"const X: u32 = 1;
"#,
		dir.path(),
	);
	let cp =
		parse_code_path("foo.rs::X#body", &pi_code_path::dialects::rust::RustNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let node = &results[0];
	assert!(node.content.is_none(), "content should be empty for non-applicable qualifier");
	assert!(
		node
			.diagnostics
			.iter()
			.any(|d| d.message.contains("does not apply")),
		"expected diagnostic about non-applicable qualifier, got: {:?}",
		node.diagnostics
	);
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
