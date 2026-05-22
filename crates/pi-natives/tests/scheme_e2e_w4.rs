//! W4 e2e: URI locator goes through executeCodePath → kernel SchemeRegistry,
//! no TS-side router involvement. Validates the Locator::Uri branch wiring.

use pi_natives::code_path::napi::{CodePathTaskOptions, execute_code_path_inner};
use pi_natives::task::CancelToken;
use tempfile::TempDir;

#[test]
fn execute_code_path_resolves_skill_uri() {
	let dir = TempDir::new().unwrap();
	let skill = dir.path().join(".spell/skills/canvas/SKILL.md");
	std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
	std::fs::write(&skill, "# canvas skill content\n").unwrap();

	let opts = CodePathTaskOptions {
		command: "get".into(),
		target:  "skill://canvas".into(),
		root:    Some(dir.path().to_string_lossy().into()),
		home:    Some("/home/u".into()),
		..Default::default()
	};
	let chunks = execute_code_path_inner(opts, CancelToken::default()).unwrap();
	assert_eq!(chunks.len(), 1);
	let nodes = &chunks[0].nodes;
	assert_eq!(nodes.len(), 1);
	assert_eq!(nodes[0].locator, "skill://canvas");
	assert_eq!(nodes[0].kind, "§skill");
	match &nodes[0].content {
		Some(c) if c.kind == "text" => {
			assert!(c.value.as_deref().unwrap_or("").contains("canvas skill content"));
		},
		other => panic!("expected Text content, got {other:?}"),
	}
}

#[test]
fn execute_code_path_resolves_pi_uri_virtual() {
	let opts = CodePathTaskOptions {
		command: "get".into(),
		target:  "pi://memory.md".into(),
		root:    Some("/tmp".into()),
		home:    Some("/home/u".into()),
		..Default::default()
	};
	let chunks = execute_code_path_inner(opts, CancelToken::default()).unwrap();
	let nodes = &chunks[0].nodes;
	assert_eq!(nodes.len(), 1);
	assert_eq!(nodes[0].kind, "§pi");
	assert!(nodes[0].content.as_ref().map(|c| c.kind == "text").unwrap_or(false));
}

#[test]
fn execute_code_path_unknown_scheme_errors() {
	let opts = CodePathTaskOptions {
		command: "get".into(),
		target:  "nope://foo".into(),
		root:    Some("/tmp".into()),
		..Default::default()
	};
	let result = execute_code_path_inner(opts, CancelToken::default());
	let err = match result { Ok(_) => panic!("expected error"), Err(e) => e };
	let msg = err.to_string();
	assert!(msg.contains("unknown URI scheme") || msg.contains("nope"));
}
