//! AST tests for Haskell dialect qualifier/anchor resolvers (FEAT-675).

use std::{path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{Head, Predicate, Query, Step},
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver_hs() -> CodeResolverImpl {
	let mut reg = LanguageRegistry::with_builtins().expect("builtins");
	let profile = pi_code_engine::language::LanguageProfile {
		id:                        pi_code_engine::language::LanguageId::new("haskell"),
		capabilities:              pi_code_engine::language::LanguageCapabilities::default(),
		extensions:                vec!["hs".into()],
		declarations:              vec![],
		class_like:                vec![],
		imports:                   vec![],
		exports:                   vec![],
		references:                vec![],
		separators:                vec![],
		embedded_regions:          vec![],
		procedures:                std::collections::HashMap::new(),
		production_rules:          std::collections::HashMap::new(),
		inverse_rules:             std::collections::HashMap::new(),
		all_types:                 vec![],
		supertypes:                vec![],
		ts_language:               tree_sitter_haskell::LANGUAGE.into(),
		dialect:                   Some(pi_code_path::dialects::haskell::haskell_dialect()),
		enclosing_statement_kinds: Vec::new(),
	};
	reg.register(profile).expect("register haskell");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_hs(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

// ------------------------------------------------------------------
// Qualifier range tests
// ------------------------------------------------------------------

#[test]
fn qualifier_body_of_function() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo x = x + 1\n", dir.path());
	let cp =
		parse_code_path("sample.hs::foo#body", &pi_code_path::dialects::haskell::HsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let funcs: Vec<_> = results.iter().filter(|r| r.kind == "§function").collect();
	assert_eq!(funcs.len(), 1, "expected exactly one function result, got {:?}", results);
	let text = funcs[0].content.as_ref().unwrap().value();
	assert!(text.contains("x + 1"), "body should contain RHS, got: {}", text);
}

#[test]
fn qualifier_body_of_bind() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo = 42\n", dir.path());
	let cp =
		parse_code_path("sample.hs::foo#body", &pi_code_path::dialects::haskell::HsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let binds: Vec<_> = results.iter().filter(|r| r.kind == "§bind").collect();
	assert_eq!(binds.len(), 1, "expected exactly one bind result, got {:?}", results);
	let text = binds[0].content.as_ref().unwrap().value();
	assert!(text.contains("42"), "body should contain RHS, got: {}", text);
}

#[test]
fn qualifier_sig_returns_type_signature() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo :: Int -> Int\n", dir.path());
	let cp =
		parse_code_path("sample.hs::foo#sig", &pi_code_path::dialects::haskell::HsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let sigs: Vec<_> = results.iter().filter(|r| r.kind == "§signature").collect();
	assert_eq!(sigs.len(), 1, "expected exactly one signature result, got {:?}", results);
	let text = sigs[0].content.as_ref().unwrap().value();
	assert!(text.contains("Int -> Int"), "sig should contain type, got: {}", text);
}

#[test]
fn qualifier_name_of_function() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo x = x + 1\n", dir.path());
	let cp =
		parse_code_path("sample.hs::foo#name", &pi_code_path::dialects::haskell::HsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let funcs: Vec<_> = results.iter().filter(|r| r.kind == "§function").collect();
	assert_eq!(funcs.len(), 1, "expected exactly one function result, got {:?}", results);
	let text = funcs[0].content.as_ref().unwrap().value();
	assert_eq!(text, "foo", "name should be foo, got: {}", text);
}

#[test]
fn qualifier_where_clause_extracted() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo x = y + 1 where y = x\n", dir.path());
	let cp = parse_code_path(
		"sample.hs::foo#where-clause",
		&pi_code_path::dialects::haskell::HsNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let funcs: Vec<_> = results.iter().filter(|r| r.kind == "§function").collect();
	assert_eq!(funcs.len(), 1, "expected exactly one function result, got {:?}", results);
	let text = funcs[0].content.as_ref().unwrap().value();
	assert!(text.contains("y = x"), "where-clause should contain binding, got: {}", text);
}

#[test]
fn qualifier_guards_extracted() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo x | x > 0 = 1 | otherwise = 0\n", dir.path());
	let cp =
		parse_code_path("sample.hs::foo#guards", &pi_code_path::dialects::haskell::HsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let funcs: Vec<_> = results.iter().filter(|r| r.kind == "§function").collect();
	assert_eq!(funcs.len(), 1, "expected exactly one function result, got {:?}", results);
	let text = funcs[0].content.as_ref().unwrap().value();
	assert!(text.contains("x > 0"), "guards should contain first guard, got: {}", text);
	assert!(
		text.contains("otherwise"),
		"guards should contain second guard, got: {}",
		text
	);
}

#[test]
fn qualifier_exports_list() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "module Foo (bar, baz) where\n", dir.path());
	// module_id matches "Foo" but #exports only applies to header/exports;
	// verify the resolver handles the mismatch gracefully (no panic).
	let cp = parse_code_path(
		"sample.hs::Foo#exports",
		&pi_code_path::dialects::haskell::HsNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one match for Foo");
}

#[test]
fn qualifier_pragmas() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "{-# LANGUAGE OverloadedStrings #-}\n", dir.path());
	// Pragmas are not addressable by name; verify qualifier doesn't crash.
	let cp = parse_code_path(
		"sample.hs::LANGUAGE#pragmas",
		&pi_code_path::dialects::haskell::HsNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver_hs()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert!(results.is_empty() || results.iter().all(|r| r.diagnostics.is_empty()));
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_guard_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs(
		"sample.hs",
		"foo x | x > 0 = 1\nbar x = x + 1\n",
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function".into()),
		predicates: vec![Predicate::AnchorFilter("guard".into())],
	});
	let results = resolver_hs()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one guard match");
	assert_eq!(results.len(), 1, "only foo should match");
	assert_eq!(results[0].kind, "§function");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("foo"), "expected foo fn, got: {}", matched);
}

#[test]
fn anchor_lambda_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs("sample.hs", "foo = \\x -> x + 1\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("lambda".into()),
		predicates: vec![Predicate::AnchorFilter("lambda".into())],
	});
	let results = resolver_hs()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one lambda match");
	assert_eq!(results.len(), 1);
	assert_eq!(results[0].kind, "§lambda");
}

#[test]
fn anchor_pattern_match_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_hs(
		"sample.hs",
		"foo x = x + 1\nbar = \\x -> x\n",
		dir.path(),
	);
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function".into()),
		predicates: vec![Predicate::AnchorFilter("pattern-match".into())],
	});
	let results = resolver_hs()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one pattern-match match");
	assert_eq!(results.len(), 1, "only foo should match (bar is a bind)");
	assert_eq!(results[0].kind, "§function");
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
