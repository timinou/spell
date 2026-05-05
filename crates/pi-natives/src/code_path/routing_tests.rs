//! End-to-end routing tests for non-tree-sitter-code dialects (FEAT-679).
//!
//! Verifies that symbol queries on md/org/html/css route through CodeResolver
//! rather than falling back to FsResolver file nodes.

use std::path::PathBuf;

use super::napi::{execute_code_path_inner, CodePathTaskOptions};

fn opts_with_root(target: impl Into<String>, root: PathBuf) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command: "resolve".to_string(),
		target:  target.into(),
		limit:   None,
		head:    None,
		tail:    None,
		offset:  None,
		format:  None,
		root:    Some(root.to_string_lossy().to_string()),
		actions: None,
		manage:  None,
		artifact_threshold: None,
	}
}

// ------------------------------------------------------------------
// 1. Markdown symbol query returns heading node, not file node
// ------------------------------------------------------------------
#[test]
fn md_symbol_query_returns_section() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("doc.md"), "# Hello\n\nBody text.\n").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("doc.md::Hello", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(
		nodes.iter().any(|n| n.kind == "§section" || n.kind == "§atx_heading"),
		"expected §section or §atx_heading for md heading, got kinds: {:?}",
		nodes.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
	assert!(
		!nodes.iter().any(|n| n.kind == "§file"),
		"symbol query should not return §file, got: {:?}",
		nodes
	);
}

// ------------------------------------------------------------------
// 2. Org symbol query returns heading node, not file node
// ------------------------------------------------------------------
#[test]
fn org_symbol_query_returns_heading() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("doc.org"), "* Task\nSome content.\n").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("doc.org::Task", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(
		nodes.iter().any(|n| n.kind == "§section" || n.kind == "§headline"),
		"expected §section or §headline for org heading, got kinds: {:?}",
		nodes.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
	assert!(
		!nodes.iter().any(|n| n.kind == "§file"),
		"symbol query should not return §file, got: {:?}",
		nodes
	);
}

// ------------------------------------------------------------------
// 3. CSS symbol query returns rule_set node
// ------------------------------------------------------------------
#[test]
fn css_symbol_query_returns_rule() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("styles.css"), ".btn { color: red; }\n").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("styles.css::.btn", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(
		nodes.iter().any(|n| n.kind == "§rule_set"),
		"expected §rule_set for css selector, got kinds: {:?}",
		nodes.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
	assert!(
		!nodes.iter().any(|n| n.kind == "§file"),
		"symbol query should not return §file, got: {:?}",
		nodes
	);
}

// ------------------------------------------------------------------
// 4. HTML symbol query returns element node
// ------------------------------------------------------------------
#[test]
fn html_symbol_query_returns_element() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("index.html"), "<div class=\"app\">hello</div>\n").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("index.html::div", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(
		nodes.iter().any(|n| n.kind == "§element"),
		"expected §element for html tag, got kinds: {:?}",
		nodes.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
	assert!(
		!nodes.iter().any(|n| n.kind == "§file"),
		"symbol query should not return §file, got: {:?}",
		nodes
	);
}

// ------------------------------------------------------------------
// 5. Text-axis line query still routes through TextResolver
// ------------------------------------------------------------------
#[test]
fn md_text_axis_line_query_returns_line() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let content: String = (1..=20).map(|i| format!("line {i}\n")).collect();
	std::fs::write(root.join("doc.md"), content).unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("doc.md::§line[10]", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 1, "expected exactly one line node");
	assert_eq!(nodes[0].kind, "§line", "expected §line from TextResolver");
	assert!(
		nodes[0].locator.contains("<line 10>"),
		"expected locator to reference line 10, got: {}",
		nodes[0].locator
	);
}

// ------------------------------------------------------------------
// 6. Bare path (no ::) returns single file node
// ------------------------------------------------------------------
#[test]
fn bare_md_path_returns_file_node() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("doc.md"), "# Hello\n").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("doc.md", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 1, "expected exactly one node for bare path");
	assert_eq!(nodes[0].kind, "§file", "expected §file for bare path");
}

// ------------------------------------------------------------------
// 7. Markdown heading + qualifier chain
// ------------------------------------------------------------------
#[test]
fn md_symbol_qualifier_chain() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("doc.md"),
		"# Foo\n\nFirst paragraph.\n\nSecond paragraph.\n",
	)
	.unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("doc.md::Foo#first-para", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	let section = nodes.iter().find(|n| n.kind == "§section");
	assert!(
		section.is_some(),
		"expected §section node, got kinds: {:?}",
		nodes.iter().map(|n| &n.kind).collect::<Vec<_>>()
	);
	let text = section
		.unwrap()
		.content
		.as_ref()
		.and_then(|c| c.value.as_ref())
		.map(|s| s.as_str())
		.unwrap_or("");
	assert!(
		text.contains("First paragraph."),
		"expected first paragraph content, got: {}",
		text
	);
}
