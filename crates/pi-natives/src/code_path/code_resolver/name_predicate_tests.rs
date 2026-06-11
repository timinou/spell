//! Resolver-level regression tests for the `[name=VALUE]` attribute
//! predicate (BUG-454).
//!
//! `§call[name=console.log]` is the marquee structural-replace recipe in the
//! edit tool cheat sheet. A `call_expression` has no `name` field — its callee
//! lives in the `function` (or, for Rust macros, `macro`) field — so the
//! predicate must consult those fields, otherwise the documented recipe
//! resolves to zero nodes.

use std::sync::Arc;

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	dialects::typescript::TsNameLexer,
	parser::parse_code_path,
	resolver::{CancellationToken, CodeResolver},
};

use super::walker::CodeResolverImpl;

fn resolver() -> CodeResolverImpl {
	let reg = LanguageRegistry::with_builtins().expect("builtins");
	CodeResolverImpl::new(Arc::new(reg))
}

fn temp_file(name: &str, content: &str, dir: &std::path::Path) -> std::path::PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

fn node_count(target: &str, content: &str, file: &str) -> usize {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_file(file, content, dir.path());
	let cp = parse_code_path(target, &TsNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap()
		.len()
}

/// BUG-454 core: `§call[name=console.log]` must resolve the call node.
/// Before the fix this returned 0 (callee lives in the `function` field, which
/// the predicate never consulted).
#[test]
fn call_name_predicate_matches_callee() {
	let src = "function f() {\n  console.log(\"hi\");\n  other();\n}\n";
	let n = node_count("svc.ts::§call[name=console.log]", src, "svc.ts");
	assert_eq!(n, 1, "§call[name=console.log] should match exactly the console.log call");
}

/// The predicate must still discriminate — a non-matching callee yields none.
#[test]
fn call_name_predicate_rejects_other_callee() {
	let src = "function f() {\n  console.log(\"hi\");\n}\n";
	let n = node_count("svc.ts::§call[name=missing.fn]", src, "svc.ts");
	assert_eq!(n, 0, "non-matching callee name must not resolve");
}

/// A bare-identifier callee (no member access) also resolves via the
/// `function` field.
#[test]
fn call_name_predicate_matches_bare_callee() {
	let src = "function f() {\n  doThing(1);\n  doThing(2);\n}\n";
	let n = node_count("svc.ts::§call[name=doThing]", src, "svc.ts");
	assert_eq!(n, 2, "both doThing() calls should match");
}

/// Declaration `name` fields still match (no regression on the original path).
#[test]
fn name_predicate_still_matches_declaration() {
	let src = "function target() { return 1; }\nfunction other() { return 2; }\n";
	let n = node_count("svc.ts::§function[name=target]", src, "svc.ts");
	assert_eq!(n, 1, "declaration name= match must still work");
}
