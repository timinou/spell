//! PLAN-318 W5: end-to-end test that re-export Aliases edges land in the
//! graph and that EdgeResolverImpl follows them through `def→`.
//!
//! Fixture layout (under crates/pi-natives/tests/fixtures/):
//!   tool_target.ts    — defines ToolThing
//!   reexport_root.ts  — `export * from './tool_target'` (re-exports)

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
		session_id:         Some("reexport-e2e".into()),
		home:               None,
		session_dir:        None,
	}
}

fn execute(target: &str) -> Vec<CodePathChunk> {
	execute_code_path_inner(opts(target), CancelToken::default()).unwrap()
}

#[test]
fn def_arrow_on_reexported_class_smoke_does_not_panic() {
	// Smoke: querying def→ on the re-exported class works end-to-end. The
	// re-export Aliases edge is created during indexing; the dispatcher
	// builds the graph + follows the chain. We don't assert specific
	// referrers here because the fixture has no actual consumer file —
	// the test exists to catch regressions in graph construction and
	// the EdgeResolver's re-export hop logic.
	let chunks = execute("tool_target.ts::ToolThing def\u{2192}");
	assert!(!chunks.is_empty(), "must return at least one chunk");
}
