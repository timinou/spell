//! Integration tests for the CodePath NAPI bridge.

use std::path::PathBuf;

use pi_code_path::resolver::CancellationToken;

use super::napi::{
	execute_code_path_inner, parse_code_path_napi, render_code_path_napi, CodePathChunk,
	CodePathTaskOptions,
};

fn opts(target: impl Into<String>) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command: "resolve".to_string(),
		target:  target.into(),
		limit:   None,
		head:    None,
		tail:    None,
		offset:  None,
		format:  None,
		root:    None,
		actions: None,
		manage:  None,
	}
}

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
	}
}

#[test]
fn bare_path_returns_file_node() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), b"hello").unwrap();

	let chunks = execute_code_path_inner(opts_with_root("a.txt", root.clone()),
		crate::task::CancelToken::default()).unwrap();
	assert_eq!(chunks.len(), 1);
	assert!(chunks[0].done);
	assert_eq!(chunks[0].nodes.len(), 1);
	assert_eq!(chunks[0].nodes[0].kind, "§file");
}

#[test]
fn glob_returns_multiple_files() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), b"a").unwrap();
	std::fs::write(root.join("b.txt"), b"b").unwrap();
	std::fs::write(root.join("c.rs"), b"c").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root("*.txt", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 2);
	assert!(nodes.iter().any(|n| n.locator.ends_with("a.txt")));
	assert!(nodes.iter().any(|n| n.locator.ends_with("b.txt")));
}

#[test]
#[ignore = "PLAN-296 follow-up: NAPI bridge integration glue (range semantics, qualifier dispatch, suffix-fallback, cancellation propagation)"]
fn line_slice_returns_sliced_text() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\n").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root("a.txt::§line[1..3]", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 2);
	assert!(nodes[0].locator.contains("<line 2>"));
	assert!(nodes[1].locator.contains("<line 3>"));
}

#[test]
#[ignore = "PLAN-296 follow-up: NAPI bridge integration glue (range semantics, qualifier dispatch, suffix-fallback, cancellation propagation)"]
fn regex_grep_over_glob() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), b"foo\nbar\nbaz\n").unwrap();
	std::fs::write(root.join("b.txt"), b"qux\nbar\n").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root(r#"*.txt::§line[text~="ba."]"#, root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 2);
	assert!(nodes.iter().any(|n| n.locator.contains("a.txt") && n.locator.contains("<line 2>")));
	assert!(nodes.iter().any(|n| n.locator.contains("b.txt") && n.locator.contains("<line 2>")));
}

#[test]
fn memory_uri_scheme() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::create_dir_all(root.join("memory")).unwrap();
	std::fs::write(root.join("memory/root"), b"memory data").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root("memory://root", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	assert_eq!(chunks.len(), 1);
	assert!(chunks[0].done);
	assert_eq!(chunks[0].nodes.len(), 1);
	assert_eq!(chunks[0].nodes[0].kind, "§memory");
	assert_eq!(chunks[0].nodes[0].locator, "memory://root");
}

#[test]
#[ignore = "PLAN-296 follow-up: NAPI bridge integration glue (range semantics, qualifier dispatch, suffix-fallback, cancellation propagation)"]
fn cancellation_aborts_mid_walk() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	for i in 0..10 {
		std::fs::write(root.join(format!("{i}.txt")), b"a\n").unwrap();
	}

	let cancel = crate::task::CancelToken::default();
	let abort = cancel.abort_token();
	abort.abort(crate::task::AbortReason::User);

	let chunks = execute_code_path_inner(
		opts_with_root("*.txt::§line", root),
		cancel,
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(nodes.len() < 10, "expected cancellation to reduce results, got {}", nodes.len());
}

#[test]
#[ignore = "PLAN-296 follow-up: NAPI bridge integration glue (range semantics, qualifier dispatch, suffix-fallback, cancellation propagation)"]
fn suffix_fallback_typo_path() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("actual.txt"), b"data").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root("actul.txt", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(
		nodes.iter().any(|n| n.locator.ends_with("actual.txt")),
		"expected suffix fallback to actual.txt, got {:?}",
		nodes
	);
}

#[test]
#[ignore = "PLAN-296 follow-up: NAPI bridge integration glue (range semantics, qualifier dispatch, suffix-fallback, cancellation propagation)"]
fn qualifier_raw_returns_content() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.txt"), b"hello world").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root("a.txt#raw", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 1);
	assert!(nodes[0].content.is_some());
}

#[test]
fn parse_render_round_trip() {
	let target = "src/foo.ts::Bar//§call[0..5]#body";
	let ast = parse_code_path_napi(target.to_string()).unwrap();
	let rendered = render_code_path_napi(ast).unwrap();
	let ast2 = parse_code_path_napi(rendered.clone()).unwrap();
	let rendered2 = render_code_path_napi(ast2).unwrap();
	assert_eq!(rendered, rendered2, "round-trip mismatch: {} vs {}", rendered, rendered2);
}

#[test]
fn chunking_sixty_four_nodes() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	for i in 0..70 {
		std::fs::write(root.join(format!("{i}.txt")), b"x\n").unwrap();
	}

	let chunks = execute_code_path_inner(
		opts_with_root("*.txt::§line", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	assert_eq!(chunks.len(), 2, "expected 2 chunks for 70 nodes");
	assert_eq!(chunks[0].nodes.len(), 64);
	assert!(!chunks[0].done);
	assert_eq!(chunks[1].nodes.len(), 6);
	assert!(chunks[1].done);
}

#[test]
fn empty_result_emits_done_chunk() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();

	let chunks = execute_code_path_inner(
		opts_with_root("*.nonexistent", root),
		crate::task::CancelToken::default(),
	)
	.unwrap();
	assert_eq!(chunks.len(), 1);
	assert!(chunks[0].done);
	assert!(chunks[0].nodes.is_empty());
}

#[test]
fn parse_code_path_returns_json() {
	let ast = parse_code_path_napi("src/a.ts::Foo".to_string()).unwrap();
	assert!(ast.is_object());
	let locator = ast.get("locator").and_then(|l| l.as_object());
	assert!(locator.is_some());
}

#[test]
#[ignore = "PLAN-296 follow-up: NAPI bridge integration glue (range semantics, qualifier dispatch, suffix-fallback, cancellation propagation)"]
fn projection_limit_truncates_results() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	for i in 0..5 {
		std::fs::write(root.join(format!("{i}.txt")), b"x\n").unwrap();
	}

	let mut o = opts_with_root("*.txt::§line", root);
	 o.limit = Some(2);
	let chunks = execute_code_path_inner(o, crate::task::CancelToken::default()).unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 2);
}
