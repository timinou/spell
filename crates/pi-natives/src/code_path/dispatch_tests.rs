use std::path::Path;

use super::{
	dialect_registry::select_dialect,
	napi::{
		CodePathTaskOptions, execute_code_path_inner, get_registered_extensions, parse_code_path_napi,
	},
};
use crate::task::CancelToken;

fn opts(target: impl Into<String>) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "resolve".to_string(),
		target:             target.into(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               None,
		actions:            None,
		manage:             None,
		artifact_threshold: None,
		gitignore:          None,
		session_id:         None,
		home:               None,
		session_dir:        None,
	}
}

fn opts_with_root(target: impl Into<String>, root: std::path::PathBuf) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "resolve".to_string(),
		target:             target.into(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               Some(root.to_string_lossy().to_string()),
		actions:            None,
		manage:             None,
		artifact_threshold: None,
		gitignore:          None,
		session_id:         None,
		home:               None,
		session_dir:        None,
	}
}

// 1. TS dispatch — real tempfile, verify no error and node returned.
#[test]
fn ts_dialect_dispatch() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("foo.ts"), b"const x = Foo.bar.baz;\n").unwrap();
	let chunks =
		execute_code_path_inner(opts_with_root("foo.ts::Foo.bar.baz", root), CancelToken::default())
			.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(!nodes.is_empty(), "expected at least one node for TS dispatch");
}

// 2. Python dispatch — real tempfile, verify no error and node returned.
#[test]
fn py_dialect_dispatch() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(
		root.join("foo.py"),
		b"class ClassA:\n    def method(self):\n        pass\nx = ClassA.method\n",
	)
	.unwrap();
	let chunks = execute_code_path_inner(
		opts_with_root("foo.py::ClassA.method", root),
		CancelToken::default(),
	)
	.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(!nodes.is_empty(), "expected at least one node for Python dispatch");
}

// 3. Glob prefix falls back to DotLexer and emits a diagnostic.
#[test]
fn glob_prefix_fallback_with_diagnostic() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.ts"), b"function Foo() {}\n").unwrap();
	let chunks =
		execute_code_path_inner(opts_with_root("*.ts::Foo", root), CancelToken::default()).unwrap();
	let has_diag = chunks.iter().any(|c| {
		c.diagnostics
			.iter()
			.any(|d| d.message.contains("glob path prefix"))
	});
	assert!(has_diag, "expected fallback diagnostic for glob prefix");
}

// 4. Unknown extension falls back to DotLexer gracefully.
#[test]
fn unknown_extension_fallback() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("foo.unknown"), b"data").unwrap();
	let chunks =
		execute_code_path_inner(opts_with_root("foo.unknown::Bar", root), CancelToken::default())
			.unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert!(
		!nodes.is_empty() || chunks.iter().all(|c| c.done),
		"expected graceful fallback for unknown extension"
	);
}

// 5. Bare path (no `::`) — no lexer dispatch needed; parses as file locator.
#[test]
fn bare_path_no_dispatch() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::create_dir_all(root.join("src")).unwrap();
	std::fs::write(root.join("src").join("foo.go"), b"package main\n").unwrap();
	let chunks =
		execute_code_path_inner(opts_with_root("src/foo.go", root), CancelToken::default()).unwrap();
	let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
	assert_eq!(nodes.len(), 1);
	assert_eq!(nodes[0].kind, "§file");
}

// 6. Round-trip parse via NAPI — Rust path with `::` segments.
#[test]
fn parse_round_trip_rust_path() {
	let ast = parse_code_path_napi("src/lib.rs::std::collections::HashMap".to_string()).unwrap();
	assert!(ast.get("locator").is_some());
	let query = ast.get("query").and_then(|q| q.as_object()).unwrap();
	let head = query.get("head").and_then(|h| h.as_object()).unwrap();
	let head_head = head.get("head").unwrap();
	let name_payload = head_head
		.get("Name")
		.and_then(|n| n.get("Raw"))
		.and_then(|r| r.as_str())
		.unwrap();
	assert_eq!(name_payload, "std::collections::HashMap");
}

// 7a. Empty FS prefix `::Foo` — parse fails gracefully (no panic).
#[test]
fn empty_prefix_fallback_gracefully() {
	let result = parse_code_path_napi("::Foo".to_string());
	assert!(result.is_err(), "expected parse error for empty prefix");
}

// 7b. Non-UTF-8 path — select_dialect returns None (falls back).
#[cfg(unix)]
#[test]
fn non_utf8_path_fallback() {
	use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
	let bad = OsStr::from_bytes(b"foo.\xff");
	let path = Path::new(bad);
	assert!(select_dialect(path).is_none(), "expected None for non-UTF-8 extension");
}

// Outline qualifier returns symbols, not full content
#[test]
fn outline_qualifier_returns_top_level_symbols() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	let src = "export function foo(a: number): number { return a + 1; }\nexport const BAR = \
	           42;\nclass Baz { x = 3; }\n";
	std::fs::write(root.join("outline.ts"), src).unwrap();

	let mut opts = opts_with_root("outline.ts#outline", root);
	opts.format = Some("content-only".into());
	let chunks = execute_code_path_inner(opts, CancelToken::default()).unwrap();

	// Should produce output (not empty)
	assert!(!chunks.is_empty(), "outline should produce chunks");
	let all_text: String = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.filter_map(|n| n.content.as_ref().and_then(|c| c.value.clone()))
		.collect::<Vec<_>>()
		.join(" ");

	// Should contain symbol names
	assert!(all_text.contains("foo"), "expected outline to contain 'foo', got: '{}'", all_text);
	assert!(all_text.contains("BAR"), "expected outline to contain 'BAR', got: '{}'", all_text);
	assert!(all_text.contains("Baz"), "expected outline to contain 'Baz', got: '{}'", all_text);

	// Outline shows first line of each top-level declaration.
	// Single-line functions will include their full text (first line = entire
	// decl). Multi-line classes will show only the first line (signature).
	// Verify multi-line class: first line contains class name, not method body
	assert!(
		!all_text.contains("this.x"),
		"outline should not contain multi-line class method bodies"
	);
}

#[test]
fn registered_extensions_includes_ts_and_py() {
	let exts = get_registered_extensions().unwrap();
	assert!(exts.contains(&"ts".to_string()));
	assert!(exts.contains(&"py".to_string()));
}


// ─────────────────────────────────────────────────────────────────
// PLAN-318 W0 / BUG-411: informational diagnostic for glob FS prefix
// must be suppressed when the query head is a NodeKind / FieldName /
// AnchorName (the name lexer is not used), and the variant must NOT
// read as `unsupported_operation`.
// ─────────────────────────────────────────────────────────────────

#[test]
fn glob_prefix_with_nodekind_query_suppresses_diagnostic() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.ts"), b"function Foo() {}\n").unwrap();

	let chunks = execute_code_path_inner(
		opts_with_root("*.ts::§function_declaration", root),
		CancelToken::default(),
	)
	.unwrap();

	let diags: Vec<_> = chunks
		.iter()
		.flat_map(|c| c.diagnostics.iter())
		.collect();

	assert!(
		!diags
			.iter()
			.any(|d| d.message.contains("NamePayload") || d.message.contains("DotLexer")),
		"glob+NodeKind query must not emit name-lexer fallback diagnostic; got: {:?}",
		diags.iter().map(|d| &d.message).collect::<Vec<_>>()
	);
}

#[test]
fn glob_prefix_with_name_query_emits_informational_not_unsupported() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::write(root.join("a.ts"), b"function Foo() {}\n").unwrap();

	let chunks =
		execute_code_path_inner(opts_with_root("*.ts::Foo", root), CancelToken::default()).unwrap();

	let diags: Vec<_> = chunks
		.iter()
		.flat_map(|c| c.diagnostics.iter())
		.collect();

	// Must emit *some* fallback diagnostic for Name-head queries (the lexer
	// choice actually matters here), but the variant must be `informational`
	// (not `unsupported_operation`), and the wording must avoid internal jargon
	// like `NamePayload` / `DotLexer`.
	let relevant: Vec<_> = diags
		.iter()
		.filter(|d| d.message.to_lowercase().contains("name") || d.message.to_lowercase().contains("lexer"))
		.collect();
	assert!(!relevant.is_empty(), "expected a name-lexer fallback hint for Name-head query");
	for d in &relevant {
		assert_ne!(
			d.variant, "unsupported_operation",
			"name-lexer fallback hint must not be classified as unsupported_operation; got variant={} msg={}",
			d.variant, d.message
		);
		assert!(
			!d.message.contains("NamePayload") && !d.message.contains("DotLexer"),
			"wording must avoid internal jargon; got: {}",
			d.message
		);
	}
}



// BUG-410 (PLAN-318 W0): end-to-end edit error must have exactly one prefix.
#[test]
fn edit_diagnostic_has_single_prefix_end_to_end() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	// Create a file with content that won't match the find string.
	std::fs::write(root.join("target.ts"), b"const a = 1;\n").unwrap();

	let mut opts = opts_with_root("target.ts", root);
	opts.command = "edit".to_string();
	opts.actions = Some(serde_json::json!([{
		"kind": "fileFindReplace",
		"find": "missing_token_xyz",
		"content": "x"
	}]));

	let chunks = execute_code_path_inner(opts, CancelToken::default()).unwrap();
	let diags: Vec<_> = chunks.iter().flat_map(|c| c.diagnostics.iter()).collect();

	assert!(!diags.is_empty(), "expected at least one diagnostic for failing edit");
	for d in &diags {
		let n = d.message.matches("edit error:").count();
		assert!(
			n <= 1,
			"diagnostic message must not contain doubled `edit error:` prefix; got {n} in: {}",
			d.message
		);
	}
}



// BUG-405 (PLAN-318 W0): end-to-end — invalid glob in `find` target must
// return zero file nodes plus a diagnostic naming the invalid pattern, NOT
// fall through to an unfiltered workspace walk.
#[test]
fn invalid_glob_predicate_lookalike_zero_results_with_diagnostic() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().to_path_buf();
	std::fs::create_dir_all(root.join("src")).unwrap();
	std::fs::write(root.join("src/a.ts"), b"").unwrap();
	std::fs::write(root.join("src/b.ts"), b"").unwrap();

	// The predicate-lookalike `[mtime>2026-05-20]` is parsed as a glob
	// CharClass; globset rejects the invalid range `2-0` -> 6-0 etc.
	let chunks = execute_code_path_inner(
		opts_with_root("src/*.ts[mtime>2026-05-20]", root),
		CancelToken::default(),
	)
	.unwrap();

	let file_nodes: Vec<_> = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.filter(|n| n.kind == "§file" || n.kind == "§dir")
		.collect();
	let diags: Vec<_> = chunks
		.iter()
		.flat_map(|c| c.diagnostics.iter())
		.collect();

	assert!(
		file_nodes.is_empty(),
		"invalid glob must not return file/dir matches; got {} nodes",
		file_nodes.len()
	);
	// Diagnostic may surface either in chunk.diagnostics or as a §not-found
	// node's own diagnostics. Allow either path.
	let node_diag_mentions_glob = chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.flat_map(|n| n.diagnostics.iter())
		.any(|d| d.message.to_lowercase().contains("glob"));
	let chunk_diag_mentions_glob =
		diags.iter().any(|d| d.message.to_lowercase().contains("glob"));
	assert!(
		node_diag_mentions_glob || chunk_diag_mentions_glob,
		"expected a diagnostic naming the invalid glob somewhere"
	);
}

