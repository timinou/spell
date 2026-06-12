//! End-to-end tests for the unified edit surface.
//!
//! Tests the full pipeline: unified action → Op dispatch → mutation resolver →
//! buffer edit → output verification + re-parse.
//!
//! Each test: inlines a fixture, applies a unified action, verifies output
//! matches expected, and verifies re-parse produces no syntax errors.

use std::{path::Path, sync::Arc};

use pi_code_engine::language::LanguageRegistry;
use pi_code_path::{
	ast::{ActionContent, CodePath},
	op::{Identifier, Op},
	resolver::traits::{CancellationToken, MutationResolver},
	unified::{TargetShape, UnifiedAction},
};

use super::code_resolver::NativeResolver;

// ── Helpers ───────────────────────────────────────────────────────

fn action_replace(content: &str) -> UnifiedAction {
	UnifiedAction::Replace {
		content: ActionContent::Single(content.to_string()),
		find:    None,
		place:   None,
	}
}

fn action_rename(new_name: &str) -> UnifiedAction {
	UnifiedAction::Rename { content: Identifier(new_name.to_string()) }
}

fn action_delete() -> UnifiedAction {
	UnifiedAction::Delete
}

/// Build an Op from a CodePath + unified action, dispatch via the resolver.
fn apply_unified(
	cp: &CodePath,
	action: &UnifiedAction,
	resolver: &NativeResolver,
) -> Result<pi_code_path::ast::MutationOutcome, String> {
	let op = pi_code_path::unified::unified_op_from_action(cp, action)
		.map_err(|d| d.message)?;
	resolver.try_apply(&op, &CancellationToken::new())
		.ok_or_else(|| "no resolver claimed this op".to_string())?
		.map_err(|d| d.message)
}

/// Resolve a CodePath string and apply a unified action against a fixture.
fn assert_unified_edit(
	lang: &str,
	fixture: &str,
	target_str: &str,
	action: &UnifiedAction,
	expected: &str,
) {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let ext = match lang {
		"ts" => "ts", "rs" => "rs", "py" => "py", "go" => "go", "elixir" => "ex",
		_ => panic!("unknown lang: {lang}"),
	};
	let file_path = root.join(format!("test.{ext}"));
	std::fs::write(&file_path, fixture).unwrap();

	let registry = Arc::new(LanguageRegistry::with_builtins().unwrap());
	let resolver = NativeResolver::new(registry).with_root(root.clone());

	let lexer = pi_code_path::dialects::typescript::TsNameLexer;
	let cp = pi_code_path::parser::parse_code_path(target_str, &lexer)
		.unwrap_or_else(|e| panic!("failed to parse target '{target_str}': {}", e.message));

	let _outcome = apply_unified(&cp, action, &resolver)
		.unwrap_or_else(|e| panic!(
			"edit failed for {lang}/{target_str}: {e}\nfixture:\n{fixture}"
		));

	let actual = std::fs::read_to_string(&file_path).unwrap();
	assert_eq!(actual, expected,
		"\n═══ FAIL: {lang} ═══\nTARGET: {target_str}\nFIXTURE:\n{fixture}\nEXPECTED:\n{expected}\nACTUAL:\n{actual}\n═══"
	);

	// Verify output re-parses without syntax errors
	reparse_verify(lang, &actual);
}

/// Verify that `source` re-parses without syntax errors for the given
/// language. Uses the LanguageRegistry which has all grammars built-in.
fn reparse_verify(lang: &str, source: &str) {
	let registry = LanguageRegistry::with_builtins().unwrap();
	let profile = match lang {
		"ts" => registry.match_path(Path::new("test.ts")),
		"rs" => registry.match_path(Path::new("test.rs")),
		"py" => registry.match_path(Path::new("test.py")),
		"go" => registry.match_path(Path::new("test.go")),
		"elixir" => registry.match_path(Path::new("test.ex")),
		_ => return,
	};
	let Some(profile) = profile else { return };
	let Some(_dialect) = &profile.dialect else { return };

	let mut parser = tree_sitter::Parser::new();
	parser.set_language(&profile.ts_language).unwrap();
	let tree = parser.parse(source, None).unwrap();
	let root = tree.root_node();
	if root.has_error() {
		let mut errors = Vec::new();
		collect_errors(root, source, &mut errors);
		panic!(
			"\n═══ PARSE ERROR: {lang} ═══\nEdit produced unparseable output:\n{}\nOUTPUT:\n{source}\n═══",
			errors.join("\n")
		);
	}
}

fn collect_errors(node: tree_sitter::Node<'_>, source: &str, out: &mut Vec<String>) {
	if node.is_error() || node.is_missing() {
		let pos = node.start_position();
		let text = source.get(node.start_byte()..node.end_byte()).unwrap_or("?");
		out.push(format!("  L{}:{} {} {:?}", pos.row + 1, pos.column + 1, node.kind(), text));
	}
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		collect_errors(child, source, out);
	}
}

// ── TypeScript ────────────────────────────────────────────────────

#[test]
fn ts_replace_whole() {
	assert_unified_edit("ts",
		"function foo() { return 1; }\n",
		"test.ts::foo",
		&action_replace("function bar() { return 99; }"),
		"function bar() { return 99; }\n",
	);
}

#[test]
fn ts_rename() {
	assert_unified_edit("ts",
		"function oldName() { return 1; }\n",
		"test.ts::oldName",
		&action_rename("newName"),
		"function newName() { return 1; }\n",
	);
}

#[test]
fn ts_delete() {
	// Delete leaves a blank line separator — verify reparse is clean
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let path = root.join("test.ts");
	std::fs::write(&path, "function dead() { return 1; }\nfunction alive() { return 2; }\n").unwrap();
	let registry = Arc::new(LanguageRegistry::with_builtins().unwrap());
	let resolver = NativeResolver::new(registry).with_root(root.clone());
	let cp = parse("test.ts::dead");
	let _outcome = apply_unified(&cp, &action_delete(), &resolver).unwrap();
	let actual = std::fs::read_to_string(&path).unwrap();
	// After delete, remaining function should be in output
	assert!(actual.contains("alive"), "expected 'alive' in output, got: {actual}");
	assert!(!actual.contains("dead"), "expected 'dead' removed, got: {actual}");
	reparse_verify("ts", &actual);
}

#[test]
fn ts_replace_body_reparse() {
	// Body replace: verify reparse is clean
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let path = root.join("test.ts");
	std::fs::write(&path, "function foo() { return 1; }\n").unwrap();
	let registry = Arc::new(LanguageRegistry::with_builtins().unwrap());
	let resolver = NativeResolver::new(registry).with_root(root.clone());
	let cp = parse("test.ts::foo");
	apply_unified(&cp, &action_replace("function foo() { return 42; }"), &resolver).unwrap();
	let actual = std::fs::read_to_string(&path).unwrap();
	assert!(actual.contains("return 42"), "expected return 42 in: {actual}");
	reparse_verify("ts", &actual);
}

// ── Rust ──────────────────────────────────────────────────────────

#[test]
fn rs_rename() {
	assert_unified_edit("rs",
		"fn old_fn() -> i32 { 1 }\n",
		"test.rs::old_fn",
		&action_rename("new_fn"),
		"fn new_fn() -> i32 { 1 }\n",
	);
}

#[test]
fn rs_replace_reparse() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let path = root.join("test.rs");
	std::fs::write(&path, "fn foo() -> i32 { 1 }\n").unwrap();
	let registry = Arc::new(LanguageRegistry::with_builtins().unwrap());
	let resolver = NativeResolver::new(registry).with_root(root.clone());
	let cp = parse("test.rs::foo");
	apply_unified(&cp, &action_replace("fn foo() -> i32 { 42 }"), &resolver).unwrap();
	let actual = std::fs::read_to_string(&path).unwrap();
	assert!(actual.contains("42"), "expected 42 in: {actual}");
	reparse_verify("rs", &actual);
}

// Note: py_rename and go_rename not yet routed through unified dispatch
// They work at the Op level but need dialect-specific name lexer wiring
// in the unified dispatch path. Cross-language coverage for template
// engine is verified in pi-code-path::template tests (Wave 1).

// ── Shape classification dispatch ─────────────────────────────────

#[test]
fn dispatch_symbol_body_qualifier() {
	let cp = parse("test.ts::foo#body");
	assert_eq!(TargetShape::classify(&cp), TargetShape::SymbolBody);
}

#[test]
fn dispatch_file_find_replace() {
	let cp = parse("test.ts");
	let op = pi_code_path::unified::unified_op_from_action(&cp, &UnifiedAction::Replace {
		content: ActionContent::Single("new".into()),
		find: Some(ActionContent::Single("old".into())),
		place: None,
	}).unwrap();
	assert!(matches!(op, Op::FileFindReplace { .. }));
}

#[test]
fn dispatch_rename_file_target_errors() {
	let cp = parse("test.ts");
	let result = pi_code_path::unified::unified_op_from_action(&cp, &UnifiedAction::Rename {
		content: Identifier("bar".into()),
	});
	assert!(result.is_err());
}

fn parse(target: &str) -> CodePath {
	pi_code_path::parser::parse_code_path(
		target,
		&pi_code_path::dialects::typescript::TsNameLexer,
	).unwrap()
}
