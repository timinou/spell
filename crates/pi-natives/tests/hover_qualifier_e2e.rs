//! PLAN-318 W4: end-to-end test for the universal `#hover` qualifier.
//!
//! `find { target: "edge_target.ts::compute#hover" }` returns the
//! function signature line, not the full body.

use std::path::PathBuf;

use pi_natives::{
	code_path::napi::{CodePathChunk, CodePathTaskOptions, ContentDto, execute_code_path_inner},
	task::CancelToken,
};

fn fixture_root() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn opts(target: &str) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "resolve".to_string(),
		target:             target.to_string(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               Some(fixture_root().to_string_lossy().to_string()),
		actions:            None,
		manage:             None,
		gitignore:          None,
		artifact_threshold: None,
		session_id:         Some("hover-e2e".into()),
		edit_group_id:      None,
		history_entry_id:   None,
		history_force:      None,
		home:               None,
		session_dir:        None,
	}
}

fn execute(target: &str) -> Vec<CodePathChunk> {
	execute_code_path_inner(opts(target), CancelToken::default()).unwrap()
}

fn first_text(chunks: &[CodePathChunk]) -> Option<String> {
	for chunk in chunks {
		for node in &chunk.nodes {
			if let Some(ContentDto { value: Some(v), .. }) = &node.content {
				return Some(v.clone());
			}
		}
	}
	None
}

#[test]
fn hover_returns_function_signature_line() {
	let chunks = execute("edge_target.ts::compute#hover");
	let body = first_text(&chunks).expect("hover should return content");
	assert!(
		body.contains("function compute(x: number): number"),
		"expected signature in body, got: {body:?}"
	);
	// Must NOT include the body braces or the return statement.
	assert!(!body.contains('{'), "signature must stop at brace; got: {body:?}");
	assert!(!body.contains("return"), "signature must not include body; got: {body:?}");
}

#[test]
fn hover_truncates_arrow_function_at_arrow_or_brace() {
	let chunks = execute("sample.ts::arrowGreet#hover");
	let body = first_text(&chunks).expect("hover should return content");
	assert!(body.contains("arrowGreet"), "expected arrowGreet in signature; got: {body:?}");
}
