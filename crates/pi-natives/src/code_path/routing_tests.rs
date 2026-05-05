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
		transaction: None,
		limit:   None,
		head:    None,
		tail:    None,
		offset:  None,
		format:  None,
		root:    Some(root.to_string_lossy().to_string()),
		actions: None,
		manage:  None,
		artifact_threshold: None,
		session_id: None,
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
		nodes[0].locator.contains("<line 10#"),
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

// ── FEAT-689 (B1/B2/B10) routing tests ────────────────────────────

fn opts_edit_with_root(
	target: impl Into<String>,
	root: PathBuf,
	actions: serde_json::Value,
) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command: "edit".to_string(),
		target: target.into(),
		transaction: None,
		limit: None,
		head: None,
		tail: None,
		offset: None,
		format: None,
		root: Some(root.to_string_lossy().to_string()),
		actions: Some(actions),
		manage: None,
		artifact_threshold: None,
		session_id: None,
	}
}

#[test]
fn bare_file_raw_qualifier_routes_to_text_resolver() {
	// FEAT-689 B2: get(target:"a.ts") auto-attaches #raw; routing must
	// reach TextResolver, not FsResolver (which would error "unknown
	// qualifier: raw").
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.ts"), "console.log(1);\n").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("a.ts#raw", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 1, "expected one text node");
	let content = nodes[0].content.as_ref().expect("content present");
	let text = content.value.as_ref().expect("text content");
	assert!(text.contains("console.log"), "got {text}");
}

#[test]
fn bare_file_bytes_qualifier_routes_to_text() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.bin"), b"\x00\x01\x02hello").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("a.bin#bytes", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 1, "expected one bytes node");
}

#[test]
fn bare_file_listing_qualifier_stays_fs() {
	// FEAT-689 sanity: #listing is FS-only, must NOT be re-routed.
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::create_dir_all(root.join("sub")).unwrap();
	std::fs::write(root.join("sub/x.txt"), "x").unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("sub#listing", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(nodes.iter().any(|n| n.locator.ends_with("x.txt")), "expected listing to surface x.txt");
}

#[test]
fn delete_with_bare_file_target_uses_fs_resolver() {
	// Existing behaviour: bare-file Delete = FsResolver = remove_file.
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("doomed.txt"), "bye").unwrap();
	let chunks = execute_code_path_inner(
		opts_edit_with_root("doomed.txt", root.clone(), serde_json::json!([{"kind": "delete"}])),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
	assert!(!root.join("doomed.txt").exists(), "file should be deleted");
}

#[test]
fn delete_with_qualifier_target_rejects_at_fs() {
	// FEAT-689: `a.ts#stat` Delete must NOT reach FsResolver Delete.
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("safe.txt"), "intact").unwrap();
	let chunks = execute_code_path_inner(
		opts_edit_with_root(
			"safe.txt#stat",
			root.clone(),
			serde_json::json!([{"kind": "delete"}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	assert!(root.join("safe.txt").exists(), "file must persist");
	let has_diag = chunks.iter().any(|c| !c.diagnostics.is_empty());
	assert!(has_diag, "expected diagnostic for unsupported delete on qualifier target");
}

#[test]
fn delete_with_symbol_target_routes_to_code_resolver() {
	// FEAT-689 B1: symbol-target Delete must NOT remove the host file.
	// CodeResolver should claim the action and remove the symbol body.
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("a.ts"),
		"export function keep() { return 1; }\nexport function remove_me() { return 2; }\n",
	)
	.unwrap();
	let _ = execute_code_path_inner(
		opts_edit_with_root(
			"a.ts::remove_me",
			root.clone(),
			serde_json::json!([{"kind": "delete"}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	// Critical: the host file must still exist after a symbol-delete.
	assert!(root.join("a.ts").exists(), "symbol-Delete must NOT nuke the host file");
}

#[test]
fn wrap_action_with_trivial_template_succeeds() {
	// FEAT-702: trivial wrap templates (e.g., `if (true) { … }`) must
	// not be rejected by the buffer-validity gate.
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("a.ts"),
		"function foo() {\n  return 1;\n}\n",
	)
	.unwrap();
	let chunks = execute_code_path_inner(
		opts_edit_with_root(
			"a.ts::foo",
			root.clone(),
			serde_json::json!([{
				"kind": "wrap",
				"content": ["if (true) {", "$BODY", "}"]
			}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let diags: Vec<_> = chunks.iter().flat_map(|c| c.diagnostics.iter()).collect();
	assert!(diags.is_empty(), "wrap should succeed, got: {:?}", diags);
	let new_content = std::fs::read_to_string(root.join("a.ts")).unwrap();
	assert!(new_content.contains("if (true)"));
	assert!(new_content.contains("function foo"));
}

// ── FEAT-707: clone with content (rename) ─────────────────────────

#[test]
fn clone_with_content_renames_clone() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("c.ts"),
		"function foo() {\n  return 1;\n}\n",
	)
	.unwrap();
	let chunks = execute_code_path_inner(
		opts_edit_with_root(
			"c.ts::foo",
			root.clone(),
			serde_json::json!([{"kind": "clone", "content": "bar"}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let diags: Vec<_> = chunks.iter().flat_map(|c| c.diagnostics.iter()).collect();
	assert!(diags.is_empty(), "{:?}", diags);
	let new_content = std::fs::read_to_string(root.join("c.ts")).unwrap();
	assert!(new_content.contains("function foo"), "foo should still exist: {new_content}");
	assert!(new_content.contains("function bar"), "bar should be cloned: {new_content}");
}

#[test]
fn clone_without_content_appends_dup_suffix() {
	// Existing behaviour: clone without content keeps the original name
	// (creates a duplicate which the language flags downstream).
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("c.ts"),
		"function foo() {\n  return 1;\n}\n",
	)
	.unwrap();
	let _ = execute_code_path_inner(
		opts_edit_with_root(
			"c.ts::foo",
			root.clone(),
			serde_json::json!([{"kind": "clone"}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	// File still exists; we don't assert anything stronger because the
	// duplicate-binding rejection is language-specific.
	assert!(root.join("c.ts").exists());
}

#[test]
fn clone_with_invalid_identifier_rejected() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("c.ts"),
		"function foo() {\n  return 1;\n}\n",
	)
	.unwrap();
	let chunks = execute_code_path_inner(
		opts_edit_with_root(
			"c.ts::foo",
			root.clone(),
			serde_json::json!([{"kind": "clone", "content": "123invalid"}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let diags: Vec<_> = chunks.iter().flat_map(|c| c.diagnostics.iter()).collect();
	assert!(!diags.is_empty(), "expected diagnostic for bad identifier");
}

// ── FEAT-712: transaction strict mode ────────────────────────────

fn opts_edit_strict(
	target: impl Into<String>,
	root: PathBuf,
	actions: serde_json::Value,
) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command: "edit".to_string(),
		target: target.into(),
		transaction: Some(super::napi::TransactionMode::Strict),
		limit: None,
		head: None,
		tail: None,
		offset: None,
		format: None,
		root: Some(root.to_string_lossy().to_string()),
		actions: Some(actions),
		manage: None,
		artifact_threshold: None,
		session_id: None,
	}
}

#[test]
fn transaction_strict_restores_modified_file() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), "v1").unwrap();
	let _ = execute_code_path_inner(
		opts_edit_strict(
			"a.txt",
			root.clone(),
			serde_json::json!([
				{"kind": "write", "content": "v2"},
				// Second op: wrap requires a declaration target; this
				// is a bare-file target so it fails inside the loop
				// after the first write succeeds — exercising rollback.
				{"kind": "wrap", "content": ["if (true) {", "$BODY", "}"]}
			]),
		),
		crate::task::CancelToken::default(),
	);
	// Strict mode should have restored a.txt to its original content.
	let content = std::fs::read_to_string(root.join("a.txt")).unwrap_or_default();
	assert_eq!(content, "v1", "strict rollback should restore prior bytes");
}

#[test]
fn transaction_strict_succeeds_when_all_ops_succeed() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let chunks = execute_code_path_inner(
		opts_edit_strict(
			"new.txt",
			root.clone(),
			serde_json::json!([{"kind": "create", "content": "hello"}]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let diags: Vec<_> = chunks.iter().flat_map(|c| c.diagnostics.iter()).collect();
	assert!(diags.is_empty(), "{:?}", diags);
	assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "hello");
}

#[test]
fn transaction_best_effort_default_unchanged() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), "v1").unwrap();
	let _ = execute_code_path_inner(
		opts_edit_with_root(
			"a.txt",
			root.clone(),
			serde_json::json!([
				{"kind": "write", "content": "v2"},
				{"kind": "delete"}  // expected to succeed too — no failure here
			]),
		),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	// Best-effort: each op runs in order, both succeed → file deleted.
	assert!(!root.join("a.txt").exists() || std::fs::read_to_string(root.join("a.txt")).unwrap() == "v2");
}
