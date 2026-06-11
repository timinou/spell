//! BUG-413 (PLAN-318 W0): universal `§kind` aliases per-dialect.
//!
//! These tests exercise the kind-alias dispatch: `§function` / `§method` /
//! `§class` / `§call` / `§import` / `§binding` / `§identifier` resolve to
//! the right tree-sitter grammar kinds for each language. Raw grammar
//! kinds (`§function_declaration`, `§method_definition`, etc.) remain
//! first-class and must continue to match (no-regression).

use std::{path::PathBuf, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver() -> CodeResolverImpl {
	let reg = LanguageRegistry::with_builtins().expect("builtins");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_ts(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

#[test]
fn alias_method_matches_method_definition() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "class Foo { bar(x: number): void { return; } }\n", dir.path());
	let cp =
		parse_code_path("foo.ts::§method", &pi_code_path::dialects::typescript::TsNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(
		!results.is_empty(),
		"§method should match TS method_definition; got: {:?}",
		results.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
	assert!(
		results.iter().any(|n| n.kind == "§method_definition"),
		"expected at least one method_definition node"
	);
}

#[test]
fn alias_function_matches_arrow_and_declaration() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts(
		"foo.ts",
		"function f1() {}\nconst f2 = () => {};\nconst f3 = function() {};\n",
		dir.path(),
	);
	let cp = parse_code_path("foo.ts::§function", &pi_code_path::dialects::typescript::TsNameLexer)
		.unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(
		results.len() >= 3,
		"§function alias should match at least 3 forms (decl+arrow+expr); got {}: {:?}",
		results.len(),
		results.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
}

#[test]
fn alias_class_matches_class_declaration() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "class Foo {}\nclass Bar {}\n", dir.path());
	let cp =
		parse_code_path("foo.ts::§class", &pi_code_path::dialects::typescript::TsNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(
		results.iter().any(|n| n.kind == "§class_declaration"),
		"§class alias must match class_declaration nodes; got: {:?}",
		results.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
}

#[test]
fn alias_call_matches_call_expression() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "foo(); bar(1, 2); new Baz();\n", dir.path());
	let cp =
		parse_code_path("foo.ts::§call", &pi_code_path::dialects::typescript::TsNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(
		results.len() >= 2,
		"§call should match at least 2 call_expression / new_expression nodes; got {}",
		results.len()
	);
}

#[test]
fn alias_import_matches_import_statement() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "import { x } from './x';\nimport y from './y';\n", dir.path());
	let cp =
		parse_code_path("foo.ts::§import", &pi_code_path::dialects::typescript::TsNameLexer).unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(
		results.iter().any(|n| n.kind == "§import_statement"),
		"§import alias must match import_statement nodes; got: {:?}",
		results.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
}

#[test]
fn alias_unknown_yields_no_match() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "function f() {}\n", dir.path());
	let cp =
		parse_code_path("foo.ts::§frobnicate", &pi_code_path::dialects::typescript::TsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(results.is_empty(), "unknown §frobnicate should not match anything");
}

#[test]
fn raw_kind_still_matches() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "class Foo {}\n", dir.path());
	let cp = parse_code_path(
		"foo.ts::§class_declaration",
		&pi_code_path::dialects::typescript::TsNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(
		results.len(),
		1,
		"raw tree-sitter kind §class_declaration must still match (no-regression)"
	);
}
