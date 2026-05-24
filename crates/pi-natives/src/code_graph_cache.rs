//! BUG-409 / PLAN-318 W1: workspace-scoped Arc<CodeGraph> cache.
//!
//! `EdgeResolverImpl` requires an `Arc<CodeGraph>` to resolve `def→`/`ref→`/
//! `call→`/`import→` edges. Before this module, no production code path
//! constructed a `CodeGraph`; `DispatchEngine` returned empty results. This
//! module provides lazy, memoised per-workspace graph instances so the kernel
//! can serve edge queries from a warm cache.
//!
//! Lifecycle:
//! - First edge query against root R triggers `get_or_build_graph(R)`.
//! - `CodeGraphBuilder` with `LanguageRegistry::with_defaults()` builds the
//!   graph; result is wrapped in `Arc` and inserted into the static `DashMap`.
//! - Subsequent queries against R reuse the cached `Arc`.
//! - Invalidation (file watcher hook) lives in W1-watcher; this module only
//!   owns construction + storage.
//!
//! Cache key is the canonicalised root path. Multiple sessions sharing the
//! same workspace share one `Arc<CodeGraph>` (cheap clone).

use std::{
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
	time::SystemTime,
};

use dashmap::DashMap;
use pi_code_graph::{
	BuildGraphOptions, CacheStore, CodeGraph, CodeGraphBuilder, LanguageRegistry, Result as CgResult,
};

/// Per-workspace cache entry.
#[derive(Clone)]
pub struct CachedGraph {
	pub graph:    Arc<CodeGraph>,
	pub built_at: SystemTime,
}

/// Per-workspace cache of warm `CodeGraph` instances.
///
/// Keyed by canonicalised workspace root. `Arc` allows concurrent reads
/// without contention; cloning is O(1) on the refcount.
static WORKSPACE_GRAPHS: OnceLock<DashMap<PathBuf, CachedGraph>> = OnceLock::new();

fn graphs() -> &'static DashMap<PathBuf, CachedGraph> {
	WORKSPACE_GRAPHS.get_or_init(DashMap::new)
}

/// Return the warm `Arc<CodeGraph>` for `root`, building it on first call.
///
/// Errors propagate from `CodeGraphBuilder::build` (I/O, parse errors, etc.).
/// On error the cache is left unchanged so the next call retries fresh.
pub fn get_or_build_graph(root: &Path) -> CgResult<Arc<CodeGraph>> {
	let canon = std::fs::canonicalize(root)?;
	if let Some(existing) = graphs().get(&canon) {
		return Ok(existing.graph.clone());
	}
	// Build outside the map lock to keep contention low.
	let registry = LanguageRegistry::new().with_defaults()?;
	let cache_dir = canon.join(".spell").join("graph");
	std::fs::create_dir_all(&cache_dir)?;
	let cache = CacheStore::new(&cache_dir);
	let builder = CodeGraphBuilder::new(registry, cache);
	let outcome = builder.build(&BuildGraphOptions::new(&canon))?;
	let arc = Arc::new(outcome.graph);
	graphs().insert(canon, CachedGraph { graph: arc.clone(), built_at: SystemTime::now() });
	Ok(arc)
}

/// Drop the cached graph for `root`. Next `get_or_build_graph(root)` will
/// rebuild. Called by the watcher when source files under `root` change.
pub fn invalidate(root: &Path) {
	if let Ok(canon) = std::fs::canonicalize(root) {
		graphs().remove(&canon);
	}
}

/// Invalidate the cache for whichever workspace `file_path` belongs to.
///
/// PLAN-318 W1 watcher hook: when an edit/save/external-change event fires
/// for `file_path`, find the cached root that is an ancestor of the file
/// and drop the entry. Lazy rebuild happens on the next edge query — we
/// intentionally do NOT eagerly rebuild here to avoid livelock during
/// active editing.
///
/// Returns the number of cache entries invalidated (0 or 1 in practice).
pub fn invalidate_for_file(file_path: &Path) -> usize {
	let Ok(canon) = std::fs::canonicalize(file_path) else {
		return 0;
	};
	let mut hits = 0usize;
	graphs().retain(|root, _| {
		if canon.starts_with(root) {
			hits += 1;
			false // drop
		} else {
			true // keep
		}
	});
	hits
}

/// Peek at the warm entry without building. Used by `status index` /
/// `graph_stats` handler to report cache state.
pub fn peek(root: &Path) -> Option<CachedGraph> {
	let canon = std::fs::canonicalize(root).ok()?;
	graphs().get(&canon).map(|r| r.clone())
}

/// Total number of cached workspace graphs. Diagnostic helper.
pub fn warm_count() -> usize {
	graphs().len()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn build_and_memoise_for_same_root() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.ts"), b"export const a = 1;\n").unwrap();

		let g1 = get_or_build_graph(root).expect("first build");
		let g2 = get_or_build_graph(root).expect("second build (memoised)");
		// Same Arc — pointer equality
		assert!(Arc::ptr_eq(&g1, &g2), "second call must return the cached Arc");
	}

	#[test]
	fn peek_returns_none_before_build_some_after() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.ts"), b"export const a = 1;\n").unwrap();
		assert!(peek(root).is_none(), "cold peek must be None");
		let _ = get_or_build_graph(root).expect("build");
		assert!(peek(root).is_some(), "warm peek must be Some");
	}

	#[test]
	fn invalidate_drops_entry() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.ts"), b"export const a = 1;\n").unwrap();
		let g1 = get_or_build_graph(root).expect("build");
		invalidate(root);
		assert!(peek(root).is_none(), "after invalidate, peek must be None");
		// Subsequent build returns a fresh Arc (not pointer-equal).
		let g2 = get_or_build_graph(root).expect("rebuild");
		assert!(!Arc::ptr_eq(&g1, &g2), "post-invalidate rebuild must return a new Arc");
	}

	#[test]
	fn invalidate_for_file_drops_ancestor_root() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::create_dir_all(root.join("src")).unwrap();
		let file = root.join("src/a.ts");
		std::fs::write(&file, b"export const a = 1;\n").unwrap();
		let _g = get_or_build_graph(root).expect("build");
		assert!(peek(root).is_some());
		let hits = invalidate_for_file(&file);
		assert_eq!(hits, 1, "file under cached root must invalidate exactly 1 entry");
		assert!(peek(root).is_none());
	}

	#[test]
	fn invalidate_for_file_ignores_unrelated_path() {
		let dir_a = tempfile::tempdir().unwrap();
		let dir_b = tempfile::tempdir().unwrap();
		std::fs::write(dir_a.path().join("a.ts"), b"export const a = 1;\n").unwrap();
		std::fs::write(dir_b.path().join("b.ts"), b"export const b = 2;\n").unwrap();
		let _ga = get_or_build_graph(dir_a.path()).unwrap();
		let unrelated = dir_b.path().join("b.ts");
		let hits = invalidate_for_file(&unrelated);
		assert_eq!(hits, 0, "unrelated file path must not invalidate dir_a's entry");
		assert!(peek(dir_a.path()).is_some());
	}

	#[test]
	fn cached_graph_carries_built_at_timestamp() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.ts"), b"export const a = 1;\n").unwrap();
		let before = SystemTime::now();
		let _ = get_or_build_graph(root).expect("build");
		let entry = peek(root).expect("warm");
		assert!(entry.built_at >= before, "built_at must be set at build time");
	}

	#[test]
	fn distinct_roots_get_distinct_arcs() {
		let dir_a = tempfile::tempdir().unwrap();
		let dir_b = tempfile::tempdir().unwrap();
		std::fs::write(dir_a.path().join("a.ts"), b"export const a = 1;\n").unwrap();
		std::fs::write(dir_b.path().join("b.ts"), b"export const b = 2;\n").unwrap();

		let ga = get_or_build_graph(dir_a.path()).unwrap();
		let gb = get_or_build_graph(dir_b.path()).unwrap();
		assert!(!Arc::ptr_eq(&ga, &gb), "distinct roots must have distinct graphs");
	}
}
