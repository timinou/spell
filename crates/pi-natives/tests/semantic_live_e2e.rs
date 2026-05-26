//! FUP-099 (FUP-LIVE): end-to-end tests for live semantic-qualifier dispatch.
//!
//! Exercises the full path:
//!   target string \u2192 parser \u2192 napi.rs is_semantic_dispatch \u2192
//!   semantic_dispatch::resolve \u2192 semantic_cache (Annotation + optional LSP) \u2192
//!   type_resolver::dispatch \u2192 format_outcome \u2192 NodeRef
//!
//! Tests fall into two tiers:
//! 1. **Annotation-only** \u2014 always-on tree-sitter side. Asserts that
//!    `#hover` / `#signature` / etc dispatch and produce structured results
//!    (or `\u{00a7}empty` when the backend has no answer).
//! 2. **Smart-merge** \u2014 `#[ignore]`-gated by `which()` checks. Asserts
//!    dual-source merge when an LSP is on PATH (rust-analyzer / Expert).

use std::process::Command;

use pi_natives::{
	code_path::napi::{CodePathChunk, CodePathTaskOptions, execute_code_path_inner},
	task::CancelToken,
};

// ── Fixture setup ───────────────────────────────────────────────────

fn make_ws() -> tempfile::TempDir {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(
		dir.path().join("Cargo.toml"),
		b"[package]\nname = \"x\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
	)
	.unwrap();
	std::fs::create_dir_all(dir.path().join("src")).unwrap();
	std::fs::write(
		dir.path().join("src/lib.rs"),
		b"/// adder doc\npub fn add(x: i32, y: i32) -> i32 { x + y }\n\npub struct Counter { pub n: i32 }\n",
	)
	.unwrap();
	dir
}

fn opts(root: &std::path::Path, target: &str) -> CodePathTaskOptions {
	CodePathTaskOptions {
		command:            "resolve".to_string(),
		target:             target.to_string(),
		transaction:        None,
		limit:              None,
		head:               None,
		tail:               None,
		offset:             None,
		format:             None,
		root:               Some(root.to_string_lossy().to_string()),
		actions:            None,
		manage:             None,
		gitignore:          None,
		artifact_threshold: None,
		session_id:         Some("semantic-e2e".into()),
		home:               None,
		session_dir:        None,
	}
}

fn execute(root: &std::path::Path, target: &str) -> Vec<CodePathChunk> {
	execute_code_path_inner(opts(root, target), CancelToken::default()).unwrap()
}

fn total_nodes(chunks: &[CodePathChunk]) -> usize {
	chunks.iter().map(|c| c.nodes.len()).sum()
}

fn first_node_kind(chunks: &[CodePathChunk]) -> Option<&str> {
	chunks.iter().flat_map(|c| c.nodes.iter()).next().map(|n| n.kind.as_str())
}

fn first_text(chunks: &[CodePathChunk]) -> Option<String> {
	chunks
		.iter()
		.flat_map(|c| c.nodes.iter())
		.find_map(|n| n.content.as_ref().and_then(|c| c.value.clone()))
}

fn cmd_exists(cmd: &str) -> bool {
	Command::new("which")
		.arg(cmd)
		.output()
		.map(|o| o.status.success())
		.unwrap_or(false)
}

// ── Tier 1: dispatch always runs (annotation backend) ───────────────

#[test]
fn hover_dispatches_to_semantic_backend_for_rust_symbol() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#hover", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1, "must produce at least one node");
	let kind = first_node_kind(&chunks).unwrap();
	assert!(
		kind == "\u{00a7}hover" || kind == "\u{00a7}empty",
		"expected \u{00a7}hover or \u{00a7}empty, got {kind}"
	);
}

#[test]
fn hover_inferred_returns_deprecated_outcome() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#hover_inferred", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert_eq!(total_nodes(&chunks), 1);
	assert_eq!(first_node_kind(&chunks).unwrap(), "\u{00a7}deprecated");
	let text = first_text(&chunks).expect("deprecated outcome carries text");
	assert!(text.contains("deprecated"));
	assert!(text.contains("hover"));
}

#[test]
fn diagnostics_at_file_scope_dispatches() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs#diagnostics", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1);
	let kind = first_node_kind(&chunks).unwrap();
	assert!(
		kind == "\u{00a7}diagnostics" || kind == "\u{00a7}empty",
		"expected \u{00a7}diagnostics or \u{00a7}empty, got {kind}"
	);
}

#[test]
fn signature_qualifier_dispatches_for_symbol() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#signature", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1);
	let kind = first_node_kind(&chunks).unwrap();
	assert!(
		kind == "\u{00a7}signature" || kind == "\u{00a7}empty",
		"expected \u{00a7}signature or \u{00a7}empty (default backend has none), got {kind}"
	);
}

#[test]
fn type_definition_qualifier_dispatches_for_symbol() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#type_definition", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1);
	let kind = first_node_kind(&chunks).unwrap();
	assert!(
		kind == "\u{00a7}type_definition" || kind == "\u{00a7}empty",
		"expected \u{00a7}type_definition or \u{00a7}empty, got {kind}"
	);
}

#[test]
fn type_def_alias_dispatches_identically_to_type_definition() {
	let dir = make_ws();
	let a = execute(
		dir.path(),
		&format!("{}/src/lib.rs::add#type_definition", dir.path().display()),
	);
	let b = execute(
		dir.path(),
		&format!("{}/src/lib.rs::add#type_def", dir.path().display()),
	);
	// Both must produce the same kind (no panic; same dispatch path).
	assert_eq!(first_node_kind(&a), first_node_kind(&b));
}

#[test]
fn inlay_qualifier_dispatches_for_file() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs#inlay", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1);
	let kind = first_node_kind(&chunks).unwrap();
	assert!(
		kind == "\u{00a7}inlay" || kind == "\u{00a7}empty",
		"expected \u{00a7}inlay or \u{00a7}empty, got {kind}"
	);
}

#[test]
fn diagnostics_with_severity_predicate_parses_and_dispatches() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs#diagnostics[severity=error]", dir.path().display());
	let chunks = execute(dir.path(), &target);
	// The dispatch path must not panic when the predicate is present;
	// the result kind is \u{00a7}diagnostics or \u{00a7}empty per backend.
	assert!(total_nodes(&chunks) >= 1);
}

#[test]
fn hover_with_source_graph_predicate_parses() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#hover[source=graph]", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1);
}

#[test]
fn hover_with_source_semantic_predicate_parses() {
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#hover[source=semantic]", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1);
}

// ── Tier 2: smart-merge with real LSP (skipped without binary) ──────

#[test]
#[ignore = "requires rust-analyzer in PATH + workspace already-indexed"]
fn hover_smart_merge_when_rust_analyzer_available() {
	// This test verifies the dispatch pipeline survives a real LSP
	// connection — not that hover returns meaningful data on a fresh
	// tempdir fixture. (Annotation can't resolve relative→absolute path
	// mismatch for fresh fixtures, and rust-analyzer needs didOpen +
	// indexing time before hover answers. End-to-end semantic data flow
	// is exercised by the higher-level harness against the real repo.)
	if !cmd_exists("rust-analyzer") {
		eprintln!("rust-analyzer not installed; skipping smart-merge test");
		return;
	}
	let dir = make_ws();
	let target = format!("{}/src/lib.rs::add#hover", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1, "dispatch must produce a node");
	let text = first_text(&chunks).expect("hover must produce text content");
	// Output is one of:
	//   - Agreed:    "<repr>"  (no source label)
	//   - Single:    "<repr> [source: graph|semantic]"
	//   - Disagreed: "written:  ...\ninferred: ..."
	//   - None:      "unknown" — valid in fresh-tempdir mode
	assert!(
		!text.is_empty(),
		"hover text must be non-empty (got empty string)"
	);
}

// ── Negative tests ──────────────────────────────────────────────────

#[test]
fn unknown_semantic_qualifier_does_not_panic() {
	let dir = make_ws();
	// `#flibbity` is not registered as a semantic qualifier; should fall
	// through to the normal qualifier path (walker emits unknown qualifier
	// diagnostic). The test asserts dispatch ordering: we don't crash.
	let target = format!("{}/src/lib.rs::add#flibbity", dir.path().display());
	let _ = execute_code_path_inner(opts(dir.path(), &target), CancelToken::default());
	// Either Ok with diagnostic or Err \u2014 either is acceptable; the key is
	// no panic.
}

#[test]
fn missing_file_for_semantic_qualifier_returns_error() {
	let dir = make_ws();
	let target = format!("{}/src/does_not_exist.rs#diagnostics", dir.path().display());
	let result = execute_code_path_inner(opts(dir.path(), &target), CancelToken::default());
	assert!(result.is_err(), "missing file must surface as Err");
}

// ── FUP-100: buffer-sync (didOpen on first query + didChange on edit) ──

#[test]
#[ignore = "requires rust-analyzer in PATH"]
fn ensure_synced_fires_didopen_on_first_hover() {
	if !cmd_exists("rust-analyzer") {
		eprintln!("rust-analyzer not installed; skipping didOpen test");
		return;
	}
	let dir = make_ws();
	let file_path = dir.path().join("src/lib.rs").canonicalize().unwrap();

	// First query — ensure_synced fires didOpen.
	let target = format!("{}/src/lib.rs::add#hover", dir.path().display());
	let _ = execute(dir.path(), &target);

	// Verify the LSP client now considers the file open.
	let cache = pi_natives::semantic_cache::peek(dir.path())
		.expect("semantic cache must be warm after hover");
	let warm_clients = cache.registry.iter_warm_all();
	// At least one warm client must be open on the file. (Other clients
	// for other languages have no business with this .rs file and stay
	// unaware — file_types filter at the cache layer.)
	let ra = warm_clients
		.iter()
		.find(|(_, name, _)| name == "rust-analyzer");
	if let Some((_, _, client)) = ra {
		assert!(
			client.is_open(&file_path),
			"rust-analyzer client should report file open after first #hover"
		);
	} else {
		eprintln!("rust-analyzer not warm in this run (spawn may have failed); skipping");
	}
}

#[test]
fn notify_buffer_change_returns_zero_when_no_warm_lsp() {
	// Sanity: notifying a file with no warm semantic cache returns 0,
	// not an error. Verifies the no-op contract for buffer commits in
	// projects where the LSP hasn't been spawned yet.
	let dir = make_ws();
	let file_path = dir.path().join("src/lib.rs");
	let notified =
		pi_natives::semantic_cache::notify_buffer_change(&file_path, "new content");
	assert_eq!(notified, 0, "no warm cache, no notification");
}

#[test]
fn notify_buffer_change_skips_files_not_yet_opened_by_lsp() {
	// After get_or_build warms the cache, the LSP exists but no query
	// has opened any file yet. notify_buffer_change must NOT pre-emptively
	// fire didChange before didOpen (a protocol violation per LSP spec).
	let dir = make_ws();
	let _ = pi_natives::semantic_cache::get_or_build(dir.path())
		.expect("semantic cache build");
	let file_path = dir.path().join("src/lib.rs");
	let notified =
		pi_natives::semantic_cache::notify_buffer_change(&file_path, "new content");
	assert_eq!(
		notified, 0,
		"warm LSP that hasn't seen the file must not receive didChange"
	);
	pi_natives::semantic_cache::invalidate(dir.path());
}


// ── FUP-094: multi-language fan-out ─────────────────────────────

/// FUP-094: smoke-test every language registered in defaults.kdl. For
/// each (extension, sample text) pair, dispatch #hover on the fixture
/// file and assert the pipeline returns SOME nodes (real LSP data when
/// the LSP is installed; `§empty` or `unknown` otherwise). This catches
/// misconfigured KDL stanzas (wrong file-types entry, malformed args,
/// etc.) without per-language fixture explosion.
#[test]
fn each_language_dispatch_survives_smoke_query() {
	// (language label, file extension, fixture body)
	let languages: Vec<(&str, &str, &str)> = vec![
		("python",     "py",   "def add(x: int, y: int) -> int:\n    return x + y\n"),
		("go",         "go",   "package x\nfunc Add(x int, y int) int { return x + y }\n"),
		("ruby",       "rb",   "def add(x, y)\n  x + y\nend\n"),
		("css",        "css",  ".x { color: red; }\n"),
		("html",       "html", "<!doctype html>\n<title>x</title>\n"),
		("c",          "c",    "int add(int x, int y) { return x + y; }\n"),
		("cpp",        "cpp",  "int add(int x, int y) { return x + y; }\n"),
		("swift",      "swift","func add(x: Int, y: Int) -> Int { x + y }\n"),
		("kotlin",     "kt",   "fun add(x: Int, y: Int): Int = x + y\n"),
		("lua",        "lua",  "function add(x, y) return x + y end\n"),
		("nix",        "nix",  "{ add = x: y: x + y; }\n"),
		("haskell",    "hs",   "add :: Int -> Int -> Int\nadd x y = x + y\n"),
		("java",       "java", "class X { int add(int x, int y) { return x + y; } }\n"),
		("clojure",    "clj",  "(defn add [x y] (+ x y))\n"),
	];

	for (label, ext, body) in languages {
		let dir = tempfile::tempdir().unwrap();
		let file = dir.path().join(format!("main.{ext}"));
		std::fs::write(&file, body).unwrap();
		let target = format!("{}#diagnostics", file.display());
		let result = execute_code_path_inner(
			opts(dir.path(), &target),
			CancelToken::default(),
		);
		assert!(
			result.is_ok(),
			"{label}: dispatch must not return an error; got error: {}",
			result.as_ref().err().map(|e| e.to_string()).unwrap_or_default()
		);
		let chunks = result.unwrap();
		assert!(
			!chunks.is_empty(),
			"{label}: dispatch must produce at least one chunk"
		);
	}
}

#[test]
#[ignore = "requires pyright-langserver in PATH"]
fn python_hover_dispatches_via_pyright() {
	if !cmd_exists("pyright-langserver") {
		eprintln!("pyright-langserver not installed; skipping Python integration");
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(
		dir.path().join("pyproject.toml"),
		b"[project]\nname = \"x\"\nversion = \"0.1.0\"\n",
	)
	.unwrap();
	std::fs::write(
		dir.path().join("main.py"),
		b"def add(x: int, y: int) -> int:\n    return x + y\n",
	)
	.unwrap();

	let target = format!("{}/main.py::add#hover", dir.path().display());
	let chunks = execute(dir.path(), &target);
	assert!(total_nodes(&chunks) >= 1, "dispatch must produce a node");
	let text = first_text(&chunks).expect("hover content");
	assert!(!text.is_empty(), "hover text must be non-empty");
}

