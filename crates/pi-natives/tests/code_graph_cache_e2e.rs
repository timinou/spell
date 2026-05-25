//! BUG-414 e2e: code_graph_cache invalidation on external file change.
//!
//! These tests verify the cache invalidation-to-rebuild roundtrip. The
//! watcher subscription callback (on_change in lib.rs) is unit-tested in
//! pi-code-engine watcher::tests; this file focuses on the cache semantics
//! that the callback triggers — invalidate_for_file → cold peek → rebuild
//! returns a fresh graph.

use std::sync::Arc;

use pi_natives::code_graph_cache;

#[test]
fn external_write_invalidate_rebuild_returns_fresh_arc() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	let src = root.join("src");
	std::fs::create_dir_all(&src).unwrap();

	std::fs::write(src.join("a.ts"), b"export const greeting = 'hello';\n").unwrap();

	let g1 = code_graph_cache::get_or_build_graph(root).expect("first build");
	assert!(code_graph_cache::peek(root).is_some(), "cache warm after first build");

	// External write + invalidate (simulating watcher callback)
	std::fs::write(
		src.join("a.ts"),
		b"export const greeting = 'hello';\nexport const farewell = 'bye';\n",
	)
	.unwrap();
	let hits = code_graph_cache::invalidate_for_file(&src.join("a.ts"));
	assert_eq!(hits, 1, "invalidate_for_file must find the cached root");
	assert!(code_graph_cache::peek(root).is_none(), "cache cold after invalidation");

	let g2 = code_graph_cache::get_or_build_graph(root).expect("rebuild after invalidation");
	assert!(
		!Arc::ptr_eq(&g1, &g2),
		"post-invalidation rebuild must return a new Arc (not the stale one)"
	);
}

#[test]
fn invalidate_for_root_drops_and_rebuild_succeeds() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	std::fs::write(root.join("index.ts"), b"export const v = 1;\n").unwrap();

	let _g1 = code_graph_cache::get_or_build_graph(root).expect("build");
	assert!(code_graph_cache::peek(root).is_some());

	code_graph_cache::invalidate(root);
	assert!(code_graph_cache::peek(root).is_none(), "root invalidate drops entry");

	let _g2 = code_graph_cache::get_or_build_graph(root).expect("rebuild after root invalidate");
	assert!(code_graph_cache::peek(root).is_some());
}

#[test]
fn invalidate_for_file_on_unrelated_path_leaves_cache_warm() {
	let dir_a = tempfile::tempdir().unwrap();
	let dir_b = tempfile::tempdir().unwrap();
	std::fs::write(dir_a.path().join("a.ts"), b"export const a = 1;\n").unwrap();
	std::fs::write(dir_b.path().join("b.ts"), b"export const b = 2;\n").unwrap();

	let _ga = code_graph_cache::get_or_build_graph(dir_a.path()).unwrap();
	assert!(code_graph_cache::peek(dir_a.path()).is_some());

	let hits = code_graph_cache::invalidate_for_file(&dir_b.path().join("b.ts"));
	assert_eq!(hits, 0, "unrelated file must not invalidate dir_a's cache");
	assert!(code_graph_cache::peek(dir_a.path()).is_some(), "cache a stays warm");
}

#[test]
fn multiple_invalidate_rebuild_cycles_work() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();

	std::fs::write(root.join("one.ts"), b"export const one = 1;\n").unwrap();
	let g1 = code_graph_cache::get_or_build_graph(root).expect("build with one.ts");

	// Cycle 1: add file, invalidate, rebuild
	std::fs::write(root.join("two.ts"), b"export const two = 2;\n").unwrap();
	code_graph_cache::invalidate_for_file(&root.join("two.ts"));
	let g2 = code_graph_cache::get_or_build_graph(root).expect("rebuild 1");
	assert!(!Arc::ptr_eq(&g1, &g2));

	// Cycle 2: add another file, invalidate, rebuild
	std::fs::write(root.join("three.ts"), b"export const three = 3;\n").unwrap();
	code_graph_cache::invalidate_for_file(&root.join("three.ts"));
	let g3 = code_graph_cache::get_or_build_graph(root).expect("rebuild 2");
	assert!(!Arc::ptr_eq(&g2, &g3));
}

