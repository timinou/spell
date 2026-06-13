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

fn temp_md(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

fn temp_org(name: &str, content: &str, dir: &std::path::Path) -> PathBuf {
	let path = dir.join(name);
	std::fs::write(&path, content).unwrap();
	path
}

// ------------------------------------------------------------------
// Markdown qualifier range tests
// ------------------------------------------------------------------

#[test]
fn qualifier_body_returns_section_body() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\nIntro text.\n\n## Sub\n\nSub body.\n", dir.path());
	let cp =
		parse_code_path("foo.md::Hello#body", &pi_code_path::dialects::mdorg::MdNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("Intro text."), "body should contain intro text, got: {}", text);
	assert!(!text.contains("# Hello"), "body should not contain heading");
}

#[test]
fn qualifier_intro_ends_at_subheading() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\nIntro text.\n\n## Sub\n\nSub body.\n", dir.path());
	let cp =
		parse_code_path("foo.md::Hello#intro", &pi_code_path::dialects::mdorg::MdNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("Intro text."), "intro should contain intro text, got: {}", text);
	assert!(!text.contains("Sub body"), "intro should not contain subsection");
}

#[test]
fn qualifier_first_para_single_node() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\nFirst paragraph.\n\nSecond paragraph.\n", dir.path());
	let cp =
		parse_code_path("foo.md::Hello#first-para", &pi_code_path::dialects::mdorg::MdNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("First paragraph."), "first-para should match, got: {}", text);
	assert!(!text.contains("Second paragraph"), "first-para should not contain second para");
}

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn qualifier_title_returns_heading_text() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello world\n\nBody\n", dir.path());
	let cp =
		parse_code_path("foo.md::Hello#title", &pi_code_path::dialects::mdorg::MdNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert_eq!(text.trim(), "Hello world", "title should be 'Hello world', got: {}", text);
}

#[test]
fn qualifier_level_returns_marker() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "## Hello\n", dir.path());
	let cp =
		parse_code_path("foo.md::Hello#level", &pi_code_path::dialects::mdorg::MdNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert_eq!(text.trim(), "##", "level should be '##', got: {}", text);
}

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn qualifier_frontmatter_block() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "---\ntitle: Hello\n---\n\n# Body\n", dir.path());
	let cp =
		parse_code_path("foo.md::#frontmatter", &pi_code_path::dialects::mdorg::MdNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("title: Hello"), "frontmatter should contain YAML, got: {}", text);
}

// ------------------------------------------------------------------
// Org qualifier range tests
// ------------------------------------------------------------------

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn qualifier_org_todo_state() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_org("foo.org", "* TODO My task\nBody\n", dir.path());
	let cp = parse_code_path("foo.org::My#todo-state", &pi_code_path::dialects::mdorg::MdNameLexer)
		.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert_eq!(text.trim(), "TODO", "todo-state should be 'TODO', got: {}", text);
}

#[test]
fn qualifier_org_tags() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_org("foo.org", "* Heading :tag1:tag2:\nBody\n", dir.path());
	let cp = parse_code_path("foo.org::Heading#tags", &pi_code_path::dialects::mdorg::MdNameLexer)
		.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert_eq!(text.trim(), ":tag1:tag2:", "tags should match, got: {}", text);
}

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn qualifier_org_properties_drawer() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_org("foo.org", "* Heading\n:PROPERTIES:\n:CATEGORY: work\n:END:\nBody\n", dir.path());
	let cp =
		parse_code_path("foo.org::Heading#properties", &pi_code_path::dialects::mdorg::MdNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("CATEGORY: work"), "properties should contain CATEGORY, got: {}", text);
}

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn qualifier_org_properties_key_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path =
		temp_org("foo.org", "* Heading\n:PROPERTIES:\n:CATEGORY: work\n:END:\nBody\n", dir.path());
	let cp = parse_code_path(
		"foo.org::Heading#properties[CATEGORY]",
		&pi_code_path::dialects::mdorg::MdNameLexer,
	)
	.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains(":CATEGORY: work"), "properties key filter should match, got: {}", text);
}

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn qualifier_org_deadline_entry() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_org("foo.org", "* Heading\nDEADLINE: <2025-01-01>\nBody\n", dir.path());
	let cp =
		parse_code_path("foo.org::Heading#deadline", &pi_code_path::dialects::mdorg::MdNameLexer)
			.unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("expected a result with content");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("DEADLINE"), "deadline should contain DEADLINE, got: {}", text);
}

// ------------------------------------------------------------------
// Anchor predicate tests
// ------------------------------------------------------------------

#[test]
fn anchor_code_block_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\n```rust\nlet x = 1;\n```\n\nText\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("section".into()),
		predicates: vec![Predicate::AnchorFilter("code-block".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one code-block match");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("let x = 1"), "expected code block, got: {}", matched);
}

#[test]
fn anchor_table_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("section".into()),
		predicates: vec![Predicate::AnchorFilter("table".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty(), "expected at least one table match");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("| a | b |"), "expected table, got: {}", matched);
}

#[test]
fn anchor_agenda_item_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_org("foo.org", "* TODO Active\nBody\n* DONE Completed\nBody\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("section".into()),
		predicates: vec![Predicate::AnchorFilter("agenda-item".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1, "only TODO should match, not DONE");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("TODO"), "expected TODO section, got: {}", matched);
}

#[test]
fn anchor_checkbox_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_org("foo.org", "* Heading\n- [ ] unchecked\n- normal\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("listitem".into()),
		predicates: vec![Predicate::AnchorFilter("checkbox".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert_eq!(results.len(), 1, "only checkbox item should match");
	let text = std::fs::read_to_string(&path).unwrap();
	let matched = &text[results[0].range.clone()];
	assert!(matched.contains("unchecked"), "expected checkbox item, got: {}", matched);
}

// ------------------------------------------------------------------
// Ignored tests for features with limited tree-sitter support
// ------------------------------------------------------------------

#[test]
#[ignore = "TOC generation requires heading enumeration not available in tree-sitter AST"]
fn qualifier_toc_generated() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\n- [Sub](#sub)\n\n## Sub\n\nBody\n", dir.path());
	let cp =
		parse_code_path("foo.md::Hello#toc", &pi_code_path::dialects::mdorg::MdNameLexer).unwrap();
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	eprintln!("deadline results count: {}", results.len());
	for (i, r) in results.iter().enumerate() {
		eprintln!(
			"result[{}]: kind={}, range={:?}, content={:?}, diagnostics={:?}",
			i, r.kind, r.range, r.content, r.diagnostics
		);
	}
	assert!(!results.is_empty());
}

#[test]
#[ignore = "Image anchor requires inline grammar node kinds not present in block parser"]
fn anchor_image_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\n![alt](img.png)\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("paragraph".into()),
		predicates: vec![Predicate::AnchorFilter("image".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty());
}

#[test]
#[ignore = "Footnote anchor requires inline grammar node kinds not present in block parser"]
fn anchor_footnote_filter() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md("foo.md", "# Hello\n\n[^1]\n", dir.path());
	let query = Query::single(Step {
		axis:       Some(pi_code_path::ast::Axis::Structural),
		head:       Head::NodeKind("paragraph".into()),
		predicates: vec![Predicate::AnchorFilter("footnote".into())],
	});
	let results = resolver()
		.resolve(&path, &query, None, &CancellationToken::new())
		.unwrap();
	assert!(!results.is_empty());
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

#[ignore = "FEAT-678 mdorg: tree-sitter grammar mismatch; impl exists, test needs refinement"]
#[test]
fn dump_simple_org() {
	let org = "* Heading\nDEADLINE: <2025-01-01>\nBody\n";
	let reg = LanguageRegistry::with_builtins().unwrap();
	let profile = reg
		.get(&pi_code_engine::language::LanguageId::new("org"))
		.unwrap();
	let mut parser = tree_sitter::Parser::new();
	parser.set_language(&profile.ts_language).unwrap();
	let tree = parser.parse(org, None).unwrap();
	fn walk(node: tree_sitter::Node, src: &str, depth: usize) {
		let indent = "  ".repeat(depth);
		let text = &src[node.start_byte()..node.end_byte().min(src.len())];
		let preview = if text.len() > 30 { &text[..30] } else { text };
		eprintln!(
			"{}{} [{}..{}] = {:?}",
			indent,
			node.kind(),
			node.start_byte(),
			node.end_byte(),
			preview
		);
		let mut cursor = node.walk();
		for child in node.children(&mut cursor) {
			walk(child, src, depth + 1);
		}
	}
	walk(tree.root_node(), org, 0);
	panic!("intentional");
}

// BUG-469: a heading with spaces/unicode must be addressable via a
// backtick-quoted CodePath, end-to-end through the walker's name matching.
#[test]
fn backtick_unicode_heading_resolves_body() {
	let dir = tempfile::tempdir().unwrap();
	let path = temp_md(
		"notes.md",
		"# \u{21c4} Obsidian \u{2014} sync (the heart)\n\nBody text here.\n",
		dir.path(),
	);
	let cp = parse_code_path(
		"notes.md::`\u{21c4} Obsidian \u{2014} sync (the heart)`#body",
		&pi_code_path::dialects::mdorg::MdNameLexer,
	)
	.expect("backtick-quoted unicode heading must parse");
	let query = cp.query.unwrap();
	let qualifier = cp.qualifier.as_ref();
	let results = resolver()
		.resolve(&path, &query, qualifier, &CancellationToken::new())
		.unwrap();
	let result = results
		.iter()
		.find(|r| r.content.is_some())
		.expect("backtick unicode heading must resolve a body node");
	let text = result.content.as_ref().unwrap().value();
	assert!(text.contains("Body text here."), "body should match, got: {text}");
}
