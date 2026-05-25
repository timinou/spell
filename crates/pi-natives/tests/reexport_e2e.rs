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

fn has_file_not_found(chunks: &[CodePathChunk]) -> bool {
	chunks.iter().any(|c| {
		c.diagnostics
			.iter()
			.any(|d| d.variant.eq_ignore_ascii_case("FileNotFound"))
	})
}

fn locators(chunks: &[CodePathChunk]) -> Vec<String> {
	chunks
		.iter()
		.flat_map(|c| c.nodes.iter().map(|n| n.locator.clone()))
		.collect()
}

#[test]
fn def_arrow_on_reexported_class_surfaces_consumer_through_reexport() {
	// PLAN-318 W5g: real assertion. ToolThing is defined in tool_target.ts
	// and re-exported by reexport_root.ts; reexport_consumer.ts imports
	// ToolThing through reexport_root.ts. Without the Aliases-edge hop,
	// def→ on ToolThing wouldn't surface reexport_consumer (its binding
	// references reexport_root, not the symbol). With the hop, the
	// re-exporter file itself (reexport_root.ts) shows up as a referrer.
	let chunks = execute("tool_target.ts::ToolThing def\u{2192}");
	assert!(!chunks.is_empty(), "must return at least one chunk");
	assert!(
		!has_file_not_found(&chunks),
		"def→ on re-exported symbol must not FileNotFound; got diags: {:?}",
		chunks.iter().flat_map(|c| c.diagnostics.iter().map(|d| d.message.clone())).collect::<Vec<_>>()
	);
	let locs = locators(&chunks);
	assert!(
		locs.iter().any(|l| l.contains("reexport_root.ts") || l.contains("reexport_consumer.ts")),
		"expected re-exporter or consumer to surface as referrer; got locators: {locs:?}"
	);
}
