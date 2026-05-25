//! PLAN-318 W1: end-to-end test for napi.rs edge-combinator dispatch.
//!
//! Exercises the full path: parser → edge_dispatch → code_graph_cache →
//! pi-code-graph build → EdgeResolverImpl traversal → marshal.

use std::path::PathBuf;

use pi_natives::{
	code_path::napi::{CodePathChunk, CodePathTaskOptions, execute_code_path_inner},
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
		session_id:         Some("edge-e2e".into()),
		home:               None,
		session_dir:        None,
	}
}

fn execute(target: &str) -> Vec<CodePathChunk> {
	execute_code_path_inner(opts(target), CancelToken::default()).unwrap()
}

#[test]
fn def_arrow_returns_chunks_without_error() {
	// Smoke: parser accepts trailing def→, dispatcher runs through, no panic.
	let chunks = execute("edge_target.ts::compute def\u{2192}");
	assert!(!chunks.is_empty(), "must return at least one chunk");
	let first = &chunks[0];
	// The chunk diagnostic list may contain a graph build hint or an empty
	// neighbour set; what we care about is that no error path panicked and
	// the request was acknowledged.
	let _ = first.nodes.len();
}

#[test]
fn explicit_call_kind_returns_chunks_without_error() {
	let chunks = execute("edge_target.ts::compute def\u{2192}\u{00a7}call_expression");
	assert!(!chunks.is_empty());
}

#[test]
fn call_arrow_returns_chunks_without_error() {
	// main calls compute → call→ on main should walk outgoing call edges.
	let chunks = execute("edge_target.ts::main call\u{2192}");
	assert!(!chunks.is_empty());
}
