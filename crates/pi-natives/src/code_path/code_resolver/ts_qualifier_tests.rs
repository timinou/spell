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

fn temp_ts(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
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
	let path = temp_ts(
		"foo.ts",
		"const handler = (x: number): Promise<void> => { return x; };\n",
		dir.path(),
	);
	let cp =
		parse_code_path("foo.ts::handler#body", &pi_code_path::dialects::typescript::TsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let node = &results[0];
	let text = node.content.as_ref().unwrap().value();
	assert!(text.contains("return x"), "body should contain inner code, got: {}", text);
	assert!(!text.contains("handler"), "body should not contain sig");
}

#[test]
fn qualifier_sig_excludes_body() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts(
		"foo.ts",
		"const handler = (x: number): Promise<void> => { return x; };\n",
		dir.path(),
	);
	let cp =
		parse_code_path("foo.ts::handler#sig", &pi_code_path::dialects::typescript::TsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("x: number"), "sig should contain params, got: {}", text);
	assert!(text.contains("Promise"), "sig should contain return type, got: {}", text);
	assert!(!text.contains("return x"), "sig should not contain body");
}

#[test]
fn qualifier_return_type_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts(
		"foo.ts",
		"const handler = (x: number): Promise<void> => { return x; };\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"foo.ts::handler#return-type",
		&pi_code_path::dialects::typescript::TsNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("Promise"), "return-type should contain Promise, got: {}", text);
	assert!(text.contains("void"), "return-type should contain void, got: {}", text);
}

#[test]
fn qualifier_decorators_aggregate_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "@injectable()\nclass Bar {}\n", dir.path());
	let cp =
		parse_code_path("foo.ts::Bar#decorators", &pi_code_path::dialects::typescript::TsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains("@injectable"), "decorators should contain @injectable, got: {}", text);
}

#[test]
fn qualifier_type_params_span() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "function Bar<T extends X>(): void {}\n", dir.path());
	let cp =
		parse_code_path("foo.ts::Bar#type-params", &pi_code_path::dialects::typescript::TsNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = results[0].content.as_ref().unwrap().value();
	assert!(text.contains('<'), "type-params should contain <, got: {}", text);
	assert!(text.contains('>'), "type-params should contain >, got: {}", text);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_default_export_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "const App = () => {};\nexport default App;\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("export_statement".into()),
		predicates: vec![Predicate::AnchorFilter("default-export".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(
		results.iter().any(|r| r.kind == "§export_statement"),
		"expected export_statement match"
	);
	assert_eq!(results.len(), 1, "only default export should match");
}

#[test]
fn anchor_hook_deps_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "useEffect(() => {}, []);\nconsole.log(1);\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("call_expression".into()),
		predicates: vec![Predicate::AnchorFilter("hook-deps".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	assert_eq!(results[0].kind, "§call_expression");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("useEffect"), "expected useEffect call, got: {}", matched);
}

#[test]
fn anchor_return_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_ts("foo.ts", "function myFn() { return 1; }\nfunction noReturn() {}\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("function_declaration".into()),
		predicates: vec![Predicate::AnchorFilter("return".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one return match");
	assert!(
		results.iter().any(|r| r.kind == "§function_declaration"),
		"expected function_declaration match"
	);
	assert_eq!(results.len(), 1, "only myFn should match, not noReturn");
}

#[test]
fn anchor_first_import_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "import { a } from \"a\";\nimport { b } from \"b\";\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("import_statement".into()),
		predicates: vec![Predicate::AnchorFilter("first-import".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1);
	let text = std::fs::read_to_string(&path).unwrap();
	let first_import_text = &text[results[0].range.clone()];
	assert!(first_import_text.contains("a"), "expected first import, got: {}", first_import_text);
	assert!(
		!first_import_text.contains("b"),
		"expected first import only, got: {}",
		first_import_text
	);
}

#[test]
fn anchor_module_side_effect_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_ts("foo.ts", "import { a } from \"a\";\nconsole.log(1);\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("expression_statement".into()),
		predicates: vec![Predicate::AnchorFilter("module-side-effect".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one module-side-effect match");
	assert_eq!(results.len(), 1);
	let text = std::fs::read_to_string(&path).unwrap();
	let matched_text = &text[results[0].range.clone()];
	assert!(matched_text.contains("console.log"), "expected console.log, got: {}", matched_text);
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
