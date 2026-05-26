//! FUP-099 (FUP-LIVE): workspace-scoped `Arc<CompositeSemanticBackend>` cache.
//!
//! Mirror of [`crate::code_graph_cache`] for the SemanticBackend layer:
//! per-workspace lazy construction + warm reuse. The backend is the
//! production entry point the find tool's semantic dispatch uses to answer
//! `#hover` / `#signature` / `#type_definition` / `#inlay` / `#diagnostics`
//! queries.
//!
//! Lifecycle:
//! - First semantic query against root R triggers `get_or_build(R)`.
//! - We build an `AnnotationSemanticBackend` from the cached `Arc<CodeGraph>`
//!   for R (via `code_graph_cache`), wrap it in a `CompositeSemanticBackend`,
//!   then layer per-language `LspSemanticBackend` instances on top using the
//!   layered `SemanticConfig` (defaults → `~/.spell` → `<project>/.spell`).
//! - LSP spawn is best-effort: a `SpawnFailed` for one language degrades
//!   gracefully to Annotation-only for that extension and emits a
//!   `tracing::warn!` carrying the install hint.
//! - Subsequent queries against R reuse the cached `Arc`.
//! - Invalidation (file watcher hook) drops the cache; next call rebuilds.
//!
//! Cache key is the canonicalised workspace root. Multiple sessions sharing
//! the same workspace share one composite (cheap `Arc` clone).

use std::{
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
	time::SystemTime,
};

use dashmap::DashMap;
use pi_code_graph::{
	AnnotationSemanticBackend, CompositeSemanticBackend, LspRegistry, LspSemanticBackend,
	semantic::{
		config::{ConfigError, SemanticConfig},
		lsp::LspClientError,
	},
};

use crate::code_graph_cache;

/// Per-workspace cache entry.
#[derive(Clone)]
pub struct CachedSemantic {
	pub composite: Arc<CompositeSemanticBackend>,
	/// Held so the registry stays warm for the life of the cache entry —
	/// LRU eviction inside the registry is a separate, finer-grained
	/// concern.
	pub registry:  Arc<LspRegistry>,
	pub built_at:  SystemTime,
}

static WORKSPACE_BACKENDS: OnceLock<DashMap<PathBuf, CachedSemantic>> = OnceLock::new();

fn backends() -> &'static DashMap<PathBuf, CachedSemantic> {
	WORKSPACE_BACKENDS.get_or_init(DashMap::new)
}

/// Errors surfaced by `get_or_build`. Wraps the underlying causes so callers
/// can pattern-match without depending on every upstream crate.
#[derive(Debug)]
pub enum SemanticCacheError {
	Io(std::io::Error),
	Config(ConfigError),
	Graph(pi_code_graph::CodeGraphError),
}

impl std::fmt::Display for SemanticCacheError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Io(e) => write!(f, "semantic cache I/O error: {e}"),
			Self::Config(e) => write!(f, "semantic config error: {e}"),
			Self::Graph(e) => write!(f, "semantic cache graph error: {e}"),
		}
	}
}

impl std::error::Error for SemanticCacheError {}

impl From<std::io::Error> for SemanticCacheError {
	fn from(e: std::io::Error) -> Self { Self::Io(e) }
}
impl From<ConfigError> for SemanticCacheError {
	fn from(e: ConfigError) -> Self { Self::Config(e) }
}
impl From<pi_code_graph::CodeGraphError> for SemanticCacheError {
	fn from(e: pi_code_graph::CodeGraphError) -> Self { Self::Graph(e) }
}

/// Return the warm `Arc<CompositeSemanticBackend>` for `root`, building on
/// first call. Errors propagate from the underlying graph/config build;
/// individual per-language LSP spawn failures are NOT propagated — they
/// degrade gracefully to Annotation-only for that extension.
pub fn get_or_build(root: &Path) -> Result<Arc<CompositeSemanticBackend>, SemanticCacheError> {
	let canon = std::fs::canonicalize(root)?;
	if let Some(existing) = backends().get(&canon) {
		return Ok(existing.composite.clone());
	}

	// Build outside the map lock to keep contention low.
	let graph = code_graph_cache::get_or_build_graph(&canon)?;
	let annotation = Arc::new(
		AnnotationSemanticBackend::new(graph).with_workspace_root(canon.clone()),
	);
	let mut composite = CompositeSemanticBackend::new(annotation);

	let config = SemanticConfig::load_layered(&canon)?.resolve();
	let registry = Arc::new(LspRegistry::new(
		config.max_warm_servers(),
		config.idle_ttl(),
	));
	for spec in config.server_specs.values() {
		registry.register_spec(spec.clone());
	}

	// Per-language LSP wiring: best-effort, fail-graceful.
	for lb in config.language_backends.values() {
		let Some(server_name) = lb.lsp.as_ref() else { continue };
		let Some(spec) = config.server_specs.get(server_name) else {
			eprintln!(
				"warn[semantic]: config references undefined server '{server_name}' for language '{}'",
				lb.language
			);
			continue;
		};
		match registry.get_or_spawn(&canon, server_name) {
			Ok(client) => {
				// FUP-100: pass language_id so the backend can ensure_opened()
				// before each LSP request. Without this, the LSP returns empty
				// hover/signature/etc until the document is opened.
				let backend = Arc::new(
					LspSemanticBackend::with_language_id(client, &lb.language),
				);
				let exts = spec.file_extensions.clone();
				composite.register_lsp(exts, backend);
			},
			Err(LspClientError::SpawnFailed(msg)) => {
				let hint = spec.install_hint.as_deref().unwrap_or("(no install hint configured)");
				eprintln!(
					"warn[semantic]: LSP spawn failed for '{server_name}' (language '{}'): {msg} -- {hint}",
					lb.language
				);
			},
			Err(other) => {
				eprintln!("warn[semantic]: LSP error for '{server_name}': {other:?}");
			},
		}
	}

	let arc = Arc::new(composite);
	backends().insert(
		canon,
		CachedSemantic { composite: arc.clone(), registry, built_at: SystemTime::now() },
	);
	Ok(arc)
}

/// Drop the cached entry for `root`. Next `get_or_build(root)` rebuilds.
pub fn invalidate(root: &Path) {
	if let Ok(canon) = std::fs::canonicalize(root) {
		backends().remove(&canon);
	}
}

/// Invalidate the cache for whichever workspace contains `file_path`.
///
/// Same shape as `code_graph_cache::invalidate_for_file`: caller is the
/// watcher hook; we drop entries whose root is an ancestor of the changed
/// file. Next semantic query rebuilds.
pub fn invalidate_for_file(file_path: &Path) -> usize {
	let Ok(canon) = std::fs::canonicalize(file_path) else {
		return 0;
	};
	let mut hits = 0usize;
	backends().retain(|root, _| {
		if canon.starts_with(root) {
			hits += 1;
			false
		} else {
			true
		}
	});
	hits
}

/// Peek without building. Diagnostic helper.
pub fn peek(root: &Path) -> Option<CachedSemantic> {
	let canon = std::fs::canonicalize(root).ok()?;
	backends().get(&canon).map(|r| r.clone())
}

/// Number of warm workspace backends. Diagnostic helper.
pub fn warm_count() -> usize {
	backends().len()
}

/// FUP-100: notify all warm LSP clients whose workspace contains `file`
/// that the file's content has changed. Translates to one
/// `textDocument/didChange` per affected LSP via
/// [`LspClient::notify_changed`].
///
/// Callers: the `code_buffer` commit path — same callsite that fires
/// `code_graph_cache::invalidate_for_file` — ensuring single-source-of-
/// truth for buffer events across the graph + semantic layers.
///
/// Returns the number of `(workspace, server)` pairs notified. Zero is
/// normal (no warm semantic cache for that root, or no LSP registered
/// for the file's extension); callers should not treat it as an error.
pub fn notify_buffer_change(file: &Path, text: &str) -> usize {
	let Ok(canon_file) = std::fs::canonicalize(file) else {
		return 0;
	};
	let mut notified = 0usize;
	for entry in backends().iter() {
		let (root, cached) = (entry.key(), entry.value());
		if !canon_file.starts_with(root) {
			continue;
		}
		for (_server_name, client) in cached.registry.iter_warm_for(root) {
			// Only notify clients that have already opened this path. A
			// client that hasn't seen the file yet doesn't need a
			// didChange — the next semantic query will fire didOpen with
			// the on-disk read; if that read races with our in-memory
			// text, the next notify_buffer_change wins via version
			// monotonicity.
			if !client.is_open(&canon_file) {
				continue;
			}
			client.notify_changed(&canon_file, text);
			notified += 1;
		}
	}
	notified
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Module-level lock: the global cache is process-wide; tests that read
	/// or mutate it must serialise. Otherwise distinct tempdirs are fine but
	/// `warm_count` assertions race.
	fn lock() -> std::sync::MutexGuard<'static, ()> {
		static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
		LOCK.lock().unwrap_or_else(|p| p.into_inner())
	}

	fn ws_with_ts(file: &str) -> tempfile::TempDir {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join(file), b"export const a = 1;\n").unwrap();
		dir
	}

	#[test]
	fn build_and_memoise_for_same_root() {
		let _g = lock();
		let dir = ws_with_ts("a.ts");
		let root = dir.path();

		let b1 = get_or_build(root).expect("first build");
		let b2 = get_or_build(root).expect("second build (memoised)");
		assert!(Arc::ptr_eq(&b1, &b2), "second call must return cached Arc");
	}

	#[test]
	fn peek_returns_none_before_build_some_after() {
		let _g = lock();
		let dir = ws_with_ts("a.ts");
		let root = dir.path();

		// Note: code_graph_cache may already have an entry from a prior test
		// running before us; this is fine \u2014 we test semantic_cache state.
		assert!(peek(root).is_none(), "cold peek must be None");
		let _ = get_or_build(root).expect("build");
		assert!(peek(root).is_some(), "warm peek must be Some");

		// Cleanup: drop our entry so a parallel test's warm_count sees fresh state.
		invalidate(root);
	}

	#[test]
	fn invalidate_drops_entry() {
		let _g = lock();
		let dir = ws_with_ts("a.ts");
		let root = dir.path();

		let b1 = get_or_build(root).expect("build");
		invalidate(root);
		assert!(peek(root).is_none(), "after invalidate, peek must be None");

		let b2 = get_or_build(root).expect("rebuild");
		assert!(
			!Arc::ptr_eq(&b1, &b2),
			"post-invalidate rebuild must return a new Arc"
		);
		invalidate(root);
	}

	#[test]
	fn invalidate_for_file_drops_ancestor_root() {
		let _g = lock();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::create_dir_all(root.join("src")).unwrap();
		let file = root.join("src/a.ts");
		std::fs::write(&file, b"export const a = 1;\n").unwrap();

		let _ = get_or_build(root).expect("build");
		assert!(peek(root).is_some());

		let hits = invalidate_for_file(&file);
		assert_eq!(hits, 1);
		assert!(peek(root).is_none());
	}

	#[test]
	fn unspawnable_lsp_does_not_fail_build() {
		// Config that points at a non-existent command. Build must succeed,
		// just degrade to Annotation-only for the .made-up extension.
		let _g = lock();
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.ts"), b"export const a = 1;\n").unwrap();

		std::fs::create_dir_all(root.join(".spell")).unwrap();
		std::fs::write(
			root.join(".spell/config.kdl"),
			r#"semantic {
                language "fakelang" { lsp "ghost-lsp-binary-that-does-not-exist" }
                server "ghost-lsp-binary-that-does-not-exist" {
                    command "/no/such/binary/please/no"
                    file-types ".madeup"
                    root-markers ""
                    install-hint "this lsp does not exist; that is the point"
                }
            }
"#,
		)
		.unwrap();

		let composite = get_or_build(root)
			.expect("build must succeed even when an LSP cannot spawn");
		// The composite is usable; we got back an Arc.
		assert!(Arc::strong_count(&composite) >= 1);
		invalidate(root);
	}
}
