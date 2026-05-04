use std::{path::Path, path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Head, Predicate, Query, Step},
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver_go() -> CodeResolverImpl {
	let mut reg = LanguageRegistry::with_builtins().expect("builtins");
	let profile = pi_code_engine::language::LanguageProfile {
		id:               pi_code_engine::language::LanguageId::new("go"),
		capabilities:     pi_code_engine::language::LanguageCapabilities::default(),
		extensions:       vec!["go".into()],
		declarations:     vec![],
		class_like:       vec![],
		imports:          vec![],
		exports:          vec![],
		references:       vec![],
		separators:       vec![],
		embedded_regions: vec![],
		procedures:       std::collections::HashMap::new(),
		production_rules: std::collections::HashMap::new(),
		inverse_rules:    std::collections::HashMap::new(),
		all_types:        vec![],
		supertypes:       vec![],
		ts_language:      tree_sitter_go::LANGUAGE.into(),
		dialect:          Some(pi_code_path::dialects::go::go_dialect()),
	};
	reg.register(profile).expect("register go");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_go(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
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
	let path = temp_go(
		"foo.go",
		"package main\n\nfunc (f Foo) Bar() { x := 1 }\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.go::Foo.Bar#body",
		&pi_code_path::dialects::go::GoNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_go()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("x := 1"), "body should contain inner code, got: {}", text);
	assert!(!text.contains("func"), "body should not contain sig");
}

#[test]
#[ignore = "Go NameLexer requires receiver form (*Foo).Bar, not *Foo.Bar"]
fn qualifier_receiver_pointer_receiver() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\nfunc (f *Foo) Bar() {}\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.go::*Foo.Bar#receiver",
		&pi_code_path::dialects::go::GoNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_go()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("*Foo"), "receiver should contain *Foo, got: {}", text);
}

#[test]
fn qualifier_returns_tuple() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\nfunc handler() (int, error) { return 0, nil }\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.go::handler#returns",
		&pi_code_path::dialects::go::GoNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_go()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("int"), "returns should contain int, got: {}", text);
	assert!(text.contains("error"), "returns should contain error, got: {}", text);
}

#[test]
fn qualifier_struct_tag_json() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\ntype S struct { Name string `json:\"name\"` }\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.go::S#struct-tag[json]",
		&pi_code_path::dialects::go::GoNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_go()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("json"), "struct-tag should contain json, got: {}", text);
}

#[test]
fn qualifier_interface_method_set() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\ntype I interface { Foo(); Bar(x int) error }\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.go::I#interface-method-set",
		&pi_code_path::dialects::go::GoNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_go()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("Foo"), "method set should contain Foo, got: {}", text);
	assert!(text.contains("Bar"), "method set should contain Bar, got: {}", text);
}

#[test]
fn qualifier_type_params_generic_fn() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\nfunc genericFn[T any]() {}\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.go::genericFn#type-params",
		&pi_code_path::dialects::go::GoNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_go()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains('['), "type-params should contain [, got: {}", text);
	assert!(text.contains(']'), "type-params should contain ], got: {}", text);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_defer_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\nfunc withDefer() { defer cleanup() }\nfunc noDefer() {}\n",
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_declaration".into()),
		predicates: vec![Predicate::AnchorFilter("defer".into())],
	});
	let results = resolver_go()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one defer match");
	assert_eq!(results.len(), 1, "only withDefer should match");
	assert_eq!(results[0].kind, "§function_declaration");
}

#[test]
fn anchor_error_check_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_go(
		"foo.go",
		"package main\n\nfunc withCheck() { if err != nil { return } }\nfunc noCheck() {}\n",
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_declaration".into()),
		predicates: vec![Predicate::AnchorFilter("error-check".into())],
	});
	let results = resolver_go()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one error-check match");
	assert_eq!(results.len(), 1, "only withCheck should match");
	assert_eq!(results[0].kind, "§function_declaration");
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
