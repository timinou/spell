//! W4 e2e: URI locator goes through executeCodePath → kernel SchemeRegistry,
//! no TS-side router involvement. Validates the Locator::Uri branch wiring.

use pi_natives::{
	code_path::napi::{CodePathTaskOptions, execute_code_path_inner},
	task::CancelToken,
};
use tempfile::TempDir;

#[test]
#[ignore = "PLAN-310 BUG-394: skill:// moved to dynamic callback registration; \
	this static-profile test no longer applies. The end-to-end behavior is \
	validated via the bun-test suite which exercises registerScheme at session \
	start, OR via scheme_callback_w2.rs::rule_callback_resolves_with_source_path \
	(same shape)."]
fn execute_code_path_resolves_skill_uri() {}

#[test]
fn execute_code_path_resolves_pi_uri_virtual() {
	let opts = CodePathTaskOptions {
		command: "get".into(),
		target: "pi://memory.md".into(),
		root: Some("/tmp".into()),
		home: Some("/home/u".into()),
		..Default::default()
	};
	let chunks = execute_code_path_inner(opts, CancelToken::default()).unwrap();
	let nodes = &chunks[0].nodes;
	assert_eq!(nodes.len(), 1);
	assert_eq!(nodes[0].kind, "§pi");
	assert!(
		nodes[0]
			.content
			.as_ref()
			.map(|c| c.kind == "text")
			.unwrap_or(false)
	);
}

#[test]
fn execute_code_path_unknown_scheme_errors() {
	let opts = CodePathTaskOptions {
		command: "get".into(),
		target: "nope://foo".into(),
		root: Some("/tmp".into()),
		..Default::default()
	};
	let result = execute_code_path_inner(opts, CancelToken::default());
	let err = match result {
		Ok(_) => panic!("expected error"),
		Err(e) => e,
	};
	let msg = err.to_string();
	assert!(msg.contains("unknown URI scheme") || msg.contains("nope"));
}

#[test]
fn execute_code_path_forwards_suffix_to_source_path() {
	use pi_natives::code_path::napi::{execute_code_path_inner, CodePathTaskOptions};
	use pi_natives::task::CancelToken as NativesCancelToken;

	let dir = tempfile::TempDir::new().unwrap();
	let mem_file = dir.path().join(".spell/memory/memory_summary.md");
	std::fs::create_dir_all(mem_file.parent().unwrap()).unwrap();
	std::fs::write(&mem_file, "LINE_ONE\nLINE_TWO\nLINE_THREE\n").unwrap();

	let opts = CodePathTaskOptions {
		command: "get".into(),
		target: "memory://root::§line[2..2]".into(),
		root: Some(dir.path().display().to_string()),
		home: Some("/home/u".into()),
		..Default::default()
	};
	let token = NativesCancelToken::new(None, None);
	let chunks = execute_code_path_inner(opts, token).unwrap();
	let all_text: String = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.filter_map(|n| n.content.as_ref())
		.filter_map(|c| c.value.clone().or_else(|| c.text.clone()))
		.collect::<Vec<_>>()
		.join("\n");
	assert!(all_text.contains("LINE_TWO"), "got: {all_text}");
	assert!(!all_text.contains("LINE_ONE"), "line 2 should not include line 1: {all_text}");
}


#[test]
fn execute_code_path_json_qualifier_extracts_field() {
	use pi_natives::code_path::napi::{execute_code_path_inner, CodePathTaskOptions};
	use pi_natives::task::CancelToken as NativesCancelToken;

	let dir = tempfile::TempDir::new().unwrap();
	let mem_file = dir.path().join(".spell/memory/data.json");
	std::fs::create_dir_all(mem_file.parent().unwrap()).unwrap();
	std::fs::write(&mem_file, r#"{"foo":{"bar":"hello"},"arr":[1,2,3]}"#).unwrap();

	let opts = CodePathTaskOptions {
		command: "get".into(),
		target: "memory://root/data.json#json:.foo.bar".into(),
		root: Some(dir.path().display().to_string()),
		home: Some("/home/u".into()),
		..Default::default()
	};
	let token = NativesCancelToken::new(None, None);
	let chunks = execute_code_path_inner(opts, token).unwrap();
	let text: String = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.filter_map(|n| n.content.as_ref())
		.filter_map(|c| c.value.clone())
		.collect::<Vec<_>>()
		.join("\n");
	assert!(text.contains("hello"), "got: {text}");
}

#[test]
fn execute_code_path_json_qualifier_array_index() {
	use pi_natives::code_path::napi::{execute_code_path_inner, CodePathTaskOptions};
	use pi_natives::task::CancelToken as NativesCancelToken;

	let dir = tempfile::TempDir::new().unwrap();
	let mem_file = dir.path().join(".spell/memory/arr.json");
	std::fs::create_dir_all(mem_file.parent().unwrap()).unwrap();
	std::fs::write(&mem_file, r#"{"items":["a","b","c"]}"#).unwrap();

	let opts = CodePathTaskOptions {
		command: "get".into(),
		target: "memory://root/arr.json#json:.items[1]".into(),
		root: Some(dir.path().display().to_string()),
		home: Some("/home/u".into()),
		..Default::default()
	};
	let token = NativesCancelToken::new(None, None);
	let chunks = execute_code_path_inner(opts, token).unwrap();
	let text: String = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.filter_map(|n| n.content.as_ref())
		.filter_map(|c| c.value.clone())
		.collect::<Vec<_>>()
		.join("\n");
	assert!(text.contains("b"), "got: {text}");
}


#[test]
fn execute_code_path_agent_path_form_extracts_via_jq() {
	use pi_natives::code_path::napi::{execute_code_path_inner, CodePathTaskOptions};
	use pi_natives::task::CancelToken as NativesCancelToken;

	let dir = tempfile::TempDir::new().unwrap();
	let sess_dir = dir.path().to_path_buf();
	let agent_file = sess_dir.join("X.md");
	std::fs::write(&agent_file, r#"{"foo":["bar"]}"#).unwrap();

	let opts = CodePathTaskOptions {
		command: "get".into(),
		target: "agent://X/foo/0".into(),
		root: Some(dir.path().display().to_string()),
		home: Some("/home/u".into()),
		session_dir: Some(sess_dir.display().to_string()),
		..Default::default()
	};
	let token = NativesCancelToken::new(None, None);
	let chunks = execute_code_path_inner(opts, token).unwrap();
	let text: String = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.filter_map(|n| n.content.as_ref())
		.filter_map(|c| c.value.clone())
		.collect::<Vec<_>>()
		.join("\n");
	assert!(text.contains("bar"), "path-form should extract via #json: — got: {text}");
}

