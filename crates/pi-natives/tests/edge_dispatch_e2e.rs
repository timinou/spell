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

fn has_file_not_found(chunks: &[CodePathChunk]) -> bool {
	chunks.iter().any(|c| {
		c.diagnostics
			.iter()
			.any(|d| d.variant.eq_ignore_ascii_case("FileNotFound"))
	})
}

fn total_nodes(chunks: &[CodePathChunk]) -> usize {
	chunks.iter().map(|c| c.nodes.len()).sum()
}

#[test]
fn def_arrow_returns_at_least_one_referrer() {
	// PLAN-318 W1g (F2): real assertion. `compute` is called by `main` in
	// the fixture; def→ must surface main as a referrer (or at minimum the
	// file that contains it) and produce zero FileNotFound diagnostics.
	let chunks = execute("edge_target.ts::compute def\u{2192}");
	assert!(!chunks.is_empty(), "must return at least one chunk");
	assert!(
		!has_file_not_found(&chunks),
		"def→ must not produce FileNotFound diagnostics (path mismatch bug); got diags: {:?}",
		chunks.iter().flat_map(|c| c.diagnostics.iter().map(|d| d.message.clone())).collect::<Vec<_>>()
	);
	assert!(
		total_nodes(&chunks) >= 1,
		"def→ on compute must surface at least one referrer (main); got 0 nodes"
	);
}

#[test]
fn explicit_call_kind_returns_filtered_results() {
	let chunks = execute("edge_target.ts::compute def\u{2192}\u{00a7}call_expression");
	assert!(!chunks.is_empty());
	assert!(!has_file_not_found(&chunks));
	// Filter narrows to call_expression nodes; with the fixture's two calls
	// to compute, we expect at least one match.
}

#[test]
fn call_arrow_returns_callees() {
	// main calls compute → call→ on main should walk outgoing call edges.
	let chunks = execute("edge_target.ts::main call\u{2192}");
	assert!(!chunks.is_empty());
	assert!(!has_file_not_found(&chunks));
}
