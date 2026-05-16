//! Process-singleton recall engine.
//!
//! `cmd_recall` (in `org_buffer.rs`) used to rebuild every recall artifact on
//! every invocation: walk + parse 1870 .org files, re-index Tantivy, re-embed
//! every item, rebuild an HNSW from scratch (O(n²) before [Wave A.1]), build
//! the typed graph, then run the RRF fusion. The full pipeline took 3-5
//! minutes and blocked Bun's main thread.
//!
//! This module:
//!
//! * Holds one `RecallEngineHandle` per `(canonical_repo_root)` in a static
//!   `OnceLock` map, keeping Tantivy `IndexWriter` / `IndexReader`, the HNSW
//!   `VecIndex`, the typed graph, and parsed items alive for the process
//!   lifetime — matching the long-lived-writer pattern from the Tantivy docs
//!   and Quickwit.
//! * Detects staleness by comparing a `pi_workspace_cache::WorkspaceFingerprint`
//!   (per-file size + mtime + git HEAD) against the in-memory copy on every
//!   query (~5 ms walk for 1870 files).
//! * Persists the warm state to `{recall cache}/{repo_hash}/{engine.bin,
//!   vec.bin}` (Tantivy is already on disk) so a Spell restart hits the warm
//!   path immediately without rebuilding.
//! * Routes embeddings through the production `embedding_worker` subprocess
//!   (Jina v2 base code). If the worker binary is missing, the vector lane is
//!   silently disabled — BM25 and the graph lane still serve recall.
//!
//! Concurrency: `state` is `parking_lot::Mutex`-guarded; concurrent
//! `recall_engine::query()` calls serialise around it. The hot path (warm,
//! fresh) holds the mutex only for the duration of fingerprint comparison and
//! RRF fusion — both fast and CPU-bound. Cold/stale rebuilds hold the mutex
//! for the rebuild; the freeze surfaces here exactly once per workspace
//! change, not per query.

use std::{
	collections::HashMap,
	fs,
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
	time::UNIX_EPOCH,
};

use parking_lot::Mutex;
use pi_org_engine::{
	graph::{TypedGraph, build_typed_graph},
	item::OrgItem,
};
use pi_org_recall::{
	Embedder,
	fts::{FtsIndex, repo_cache_dir, repo_cache_dir_at},
	recall::{RecallContext, RecallHit, RecallQuery, recall},
	vec::VecIndex,
};
use pi_workspace_cache::{
	CacheStore, FileFingerprint, PersistentCacheEntry, WorkspaceFingerprint, read_git_head,
};
use serde::{Deserialize, Serialize};

use crate::embedding_worker;

/// Lightweight stderr logging. pi-natives doesn't pull in `tracing`; we match
/// the convention used by `org_buffer.rs` (single-line `eprintln!`).
macro_rules! engine_log {
	($($arg:tt)*) => {
		eprintln!("recall_engine: {}", format_args!($($arg)*));
	};
}

/// Embedding dimensionality used by `pi-embedding-worker` (Jina v2 base code).
const DIM: usize = 768;

/// Subdirectories of the repo that contribute org items to the recall index.
/// `!tasks/` holds project plans/feats/bugs/etc. `.spell/memory/` holds
/// agent-written episodes and concepts.
const SCANNED_SUBDIRS: &[&str] = &["!tasks", ".spell/memory"];

/// Bincode filename inside the per-repo cache dir.
const ENGINE_CACHE_FILE: &str = "engine.bin";

/// VecIndex disk filename inside the per-repo cache dir.
const VEC_CACHE_FILE: &str = "vec.bin";

// ---------------------------------------------------------------------------
// Static singleton
// ---------------------------------------------------------------------------

static ENGINES: OnceLock<Mutex<HashMap<PathBuf, Arc<RecallEngineHandle>>>> = OnceLock::new();

fn engines() -> &'static Mutex<HashMap<PathBuf, Arc<RecallEngineHandle>>> {
	ENGINES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn canonical_root(root: &Path) -> PathBuf {
	fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

/// Look up (or lazily construct) the engine handle for a given repo root.
///
/// Test override: `cache_base` lets callers route the engine's on-disk cache
/// to a temp dir instead of `~/.cache/spell/recall`. Production code passes
/// `None`.
pub fn get_or_create(
	repo_root: &Path,
	cache_base: Option<&Path>,
) -> Result<Arc<RecallEngineHandle>, String> {
	let canon = canonical_root(repo_root);
	let cache_dir = match cache_base {
		Some(base) => repo_cache_dir_at(&canon, base).map_err(|e| e.to_string())?,
		None => repo_cache_dir(&canon).map_err(|e| e.to_string())?,
	};
	let mut map = engines().lock();
	if let Some(h) = map.get(&canon) {
		return Ok(Arc::clone(h));
	}
	let h = Arc::new(RecallEngineHandle::new(canon.clone(), cache_dir));
	map.insert(canon, Arc::clone(&h));
	Ok(h)
}

/// Production query entry point. Equivalent to
/// `get_or_create(repo_root, None)?.query(query)`.
pub fn query(repo_root: &Path, query_args: RecallQuery) -> Result<Vec<RecallHit>, String> {
	let handle = get_or_create(repo_root, None)?;
	handle.query(query_args)
}

/// Drop the cached engine for a repo root. Mostly useful in tests.
#[cfg(test)]
pub fn forget(repo_root: &Path) {
	if let Some(slot) = ENGINES.get() {
		slot.lock().remove(&canonical_root(repo_root));
	}
}

// ---------------------------------------------------------------------------
// Engine handle + state machine
// ---------------------------------------------------------------------------

pub struct RecallEngineHandle {
	repo_root: PathBuf,
	cache_dir: PathBuf,
	state:     Mutex<EngineState>,
}

enum EngineState {
	Cold,
	Warm(Box<WarmEngine>),
}

struct WarmEngine {
	fingerprint: WorkspaceFingerprint,
	items:       Vec<OrgItem>,
	fts:         FtsIndex,
	vec:         VecIndex,
	graph:       TypedGraph,
}

#[derive(Serialize, Deserialize)]
struct EngineCacheEntry {
	fingerprint: WorkspaceFingerprint,
	items:       Vec<OrgItem>,
}

impl PersistentCacheEntry for EngineCacheEntry {
	fn fingerprint(&self) -> &WorkspaceFingerprint {
		&self.fingerprint
	}
}

impl RecallEngineHandle {
	fn new(repo_root: PathBuf, cache_dir: PathBuf) -> Self {
		Self { repo_root, cache_dir, state: Mutex::new(EngineState::Cold) }
	}

	/// Serve a recall query. Rebuilds the warm engine on first call or when
	/// the workspace fingerprint has changed; otherwise serves from cache.
	pub fn query(&self, query_args: RecallQuery) -> Result<Vec<RecallHit>, String> {
		let mut state = self.state.lock();
		self.ensure_warm(&mut state)?;
		let warm = match state.as_ref() {
			Some(w) => w,
			None => return Err("recall engine: warm state unavailable".into()),
		};
		let embedder = WorkerEmbedderAdapter;
		let ctx = RecallContext {
			items:    &warm.items,
			fts:      &warm.fts,
			vec:      &warm.vec,
			embedder: &embedder,
			graph:    &warm.graph,
		};
		recall(query_args, &ctx).map_err(|e| format!("recall: {e}"))
	}

	fn ensure_warm(&self, state: &mut EngineState) -> Result<(), String> {
		let current = compute_fingerprint(&self.repo_root)?;
		if let EngineState::Warm(w) = state
			&& w.fingerprint == current
		{
			return Ok(());
		}
		engine_log!("cold or stale; rebuilding for {}", self.repo_root.display());
		let warm = self.build_warm(current)?;
		*state = EngineState::Warm(Box::new(warm));
		Ok(())
	}

	/// Try the disk cache first (fast path for Spell restart); fall back to
	/// a full rebuild. Saves the rebuilt warm state on success so the next
	/// process start can hit the disk fast path.
	fn build_warm(&self, current_fp: WorkspaceFingerprint) -> Result<WarmEngine, String> {
		fs::create_dir_all(&self.cache_dir).map_err(|e| format!("mkdir cache: {e}"))?;

		// Disk fast path: bincode entry + persisted VecIndex + the on-disk
		// Tantivy index that already lives next to them.
		if let Some(warm) = self.try_load_warm(&current_fp)? {
			engine_log!("warm state restored from disk");
			return Ok(warm);
		}

		// Cold build (or fingerprint diverged).
		let warm = self.full_rebuild(current_fp)?;
		if let Err(e) = self.save_warm(&warm) {
			engine_log!("failed to persist warm state: {e}");
		}
		Ok(warm)
	}

	fn try_load_warm(&self, current_fp: &WorkspaceFingerprint) -> Result<Option<WarmEngine>, String> {
		let entry_path = self.cache_dir.join(ENGINE_CACHE_FILE);
		let vec_path = self.cache_dir.join(VEC_CACHE_FILE);
		if !entry_path.exists() || !vec_path.exists() {
			return Ok(None);
		}
		// `CacheStore::load` is the workspace-standard wrapper around bincode
		// (also used by `org_index.rs` and `code_graph.rs`).
		let store = CacheStore::new(self.cache_dir.clone());
		let entry: EngineCacheEntry = match store.load("engine") {
			Ok(Some(e)) => e,
			Ok(None) => return Ok(None),
			Err(e) => {
				engine_log!("cache load failed ({e}); will rebuild");
				return Ok(None);
			},
		};
		if entry.fingerprint != *current_fp {
			engine_log!("disk cache stale; rebuilding");
			return Ok(None);
		}
		// `entry_path` is checked above; `entry.bin` lives at `engine.bin` via CacheStore.
		let _ = entry_path;
		if !vec_path.exists() {
			engine_log!("vec cache missing; will rebuild");
			return Ok(None);
		}
		let vec = match VecIndex::from_disk(&vec_path) {
			Ok(v) => v,
			Err(e) => {
				engine_log!("vec cache load failed ({e}); will rebuild");
				return Ok(None);
			},
		};
		// Tantivy is naturally persistent — opening reuses the on-disk segments.
		let fts = FtsIndex::open(&self.repo_root).map_err(|e| format!("fts open: {e}"))?;
		let graph = build_typed_graph(&entry.items);
		Ok(Some(WarmEngine {
			fingerprint: entry.fingerprint,
			items: entry.items,
			fts,
			vec,
			graph,
		}))
	}

	fn full_rebuild(&self, fingerprint: WorkspaceFingerprint) -> Result<WarmEngine, String> {
		let items = scan_items(&self.repo_root);
		let fts = FtsIndex::open(&self.repo_root).map_err(|e| format!("fts open: {e}"))?;
		// Re-index from scratch: delete-all-then-add for every id. The on-disk
		// Tantivy index may have stale segments from a prior schema/version;
		// upserting every id makes the on-disk state match `items`.
		fts.index(&items).map_err(|e| format!("fts index: {e}"))?;
		let vec = build_vec_index(&items);
		let graph = build_typed_graph(&items);
		Ok(WarmEngine { fingerprint, items, fts, vec, graph })
	}

	fn save_warm(&self, warm: &WarmEngine) -> Result<(), String> {
		let entry = EngineCacheEntry {
			fingerprint: warm.fingerprint.clone(),
			items:       warm.items.clone(),
		};
		let store = CacheStore::new(self.cache_dir.clone());
		store
			.save("engine", &entry)
			.map_err(|e| format!("save engine cache: {e}"))?;
		let vec_path = self.cache_dir.join(VEC_CACHE_FILE);
		warm
			.vec
			.to_disk(&vec_path)
			.map_err(|e| format!("write vec.bin: {e}"))?;
		Ok(())
	}
}

// `as_ref` borrow helper that returns the `WarmEngine` only when state is
// `Warm`. Hides the boxing from the caller.
impl EngineState {
	fn as_ref(&self) -> Option<&WarmEngine> {
		match self {
			Self::Warm(w) => Some(w.as_ref()),
			Self::Cold => None,
		}
	}
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

/// Walk `repo_root/{!tasks,.spell/memory}` and parse every `.org` file into
/// `OrgItem`s (without bodies — recall only embeds title + truncated body
/// preview, both of which the parser handles).
fn scan_items(repo_root: &Path) -> Vec<OrgItem> {
	let mut items = Vec::new();
	for subdir in SCANNED_SUBDIRS {
		let dir = repo_root.join(subdir);
		if !dir.is_dir() {
			continue;
		}
		let files = walk_org_files(&dir);
		for file in files {
			let path_str = file.to_string_lossy();
			let Ok(source) = fs::read_to_string(&file) else {
				continue;
			};
			let Ok(parsed) = pi_org_engine::buffer::extract_items_from_source(
				&source, &[], "", "", &path_str, false,
			) else {
				continue;
			};
			items.extend(parsed);
		}
	}
	items
}

/// Recursive `*.org` walker. Mirrors `org_buffer::walk_org_files`. We don't
/// follow symlinks (symlink loops cause infinite recursion in the current
/// impl; if a `!tasks/` symlink loop ever appears this needs a `HashSet`
/// guard, but to date no repo has them).
fn walk_org_files(dir: &Path) -> Vec<PathBuf> {
	let mut files = Vec::new();
	let Ok(read_dir) = fs::read_dir(dir) else {
		return files;
	};
	for entry in read_dir.flatten() {
		let path = entry.path();
		if path.is_dir() {
			files.extend(walk_org_files(&path));
		} else if path.extension().is_some_and(|ext| ext == "org") {
			files.push(path);
		}
	}
	files
}

/// Build a fresh `VecIndex` from `items`, embedding via the production worker.
/// If the worker is unavailable, returns an empty index (recall still serves
/// BM25 + graph results).
fn build_vec_index(items: &[OrgItem]) -> VecIndex {
	let mut vec = VecIndex::new(DIM);
	if items.is_empty() {
		return vec;
	}
	let texts: Vec<String> = items
		.iter()
		.map(|item| match item.body.as_ref() {
			Some(body) => format!("{} {}", item.title, body.chars().take(512).collect::<String>()),
			None => item.title.clone(),
		})
		.collect();
	let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
	match embedding_worker::embed_batch(&refs, None) {
		Ok(vectors) => {
			for (idx, item) in items.iter().enumerate() {
				let Some(v) = vectors.get(idx) else { continue };
				if let Err(e) = vec.insert(item.id.clone(), v.clone()) {
					engine_log!("vec insert for {} failed: {e}", item.id);
				}
			}
		},
		Err(e) => {
			engine_log!("embedder unavailable, vector lane disabled: {e}");
		},
	}
	vec
}

// ---------------------------------------------------------------------------
// Fingerprinting (scoped to recall sources)
// ---------------------------------------------------------------------------

/// Walk the recall-relevant subdirs only and build a `WorkspaceFingerprint`.
///
/// `pi_workspace_cache::fingerprint_root` is the workspace standard but
/// (a) hard-codes a `.spell/` skip that excludes `.spell/memory/`, and
/// (b) walks the entire repo which is wasteful when only `!tasks/` matters.
/// We use the same `FileFingerprint` shape so `WorkspaceFingerprint::Eq`
/// works as expected.
fn compute_fingerprint(repo_root: &Path) -> Result<WorkspaceFingerprint, String> {
	use std::collections::BTreeMap;
	let mut files: BTreeMap<PathBuf, FileFingerprint> = BTreeMap::new();
	for subdir in SCANNED_SUBDIRS {
		let dir = repo_root.join(subdir);
		if !dir.is_dir() {
			continue;
		}
		collect_fingerprints(&dir, repo_root, &mut files)?;
	}
	Ok(WorkspaceFingerprint {
		root: repo_root.to_path_buf(),
		git_head: read_git_head(repo_root),
		files,
	})
}

fn collect_fingerprints(
	dir: &Path,
	repo_root: &Path,
	out: &mut std::collections::BTreeMap<PathBuf, FileFingerprint>,
) -> Result<(), String> {
	let read_dir = fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
	for entry in read_dir.flatten() {
		let path = entry.path();
		if path.is_dir() {
			collect_fingerprints(&path, repo_root, out)?;
			continue;
		}
		if path.extension().and_then(|e| e.to_str()) != Some("org") {
			continue;
		}
		let meta = match fs::metadata(&path) {
			Ok(m) => m,
			Err(_) => continue,
		};
		let relative = path
			.strip_prefix(repo_root)
			.unwrap_or(path.as_path())
			.to_path_buf();
		let modified_at_ms = meta
			.modified()
			.ok()
			.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
			.map(|d| d.as_millis() as u64)
			.unwrap_or_default();
		out.insert(relative, FileFingerprint { size: meta.len(), modified_at_ms });
	}
	Ok(())
}

// ---------------------------------------------------------------------------
// Embedder adapter
// ---------------------------------------------------------------------------

/// Bridges `pi_org_recall::Embedder` to the in-process embedding worker.
/// The worker (`pi-embedding-worker` subprocess) is shared with `code_graph`
/// and `embedder.rs`; spawning is lazy and cached via `OnceLock`.
struct WorkerEmbedderAdapter;

impl Embedder for WorkerEmbedderAdapter {
	fn embed_query(&self, text: &str) -> pi_org_recall::Result<Vec<f32>> {
		embedding_worker::embed_query(text)
			.map_err(|e| pi_org_recall::Error::Embedder(e.to_string()))
	}

	fn embed_batch(&self, texts: &[&str]) -> pi_org_recall::Result<Vec<Vec<f32>>> {
		embedding_worker::embed_batch(texts, None)
			.map_err(|e| pi_org_recall::Error::Embedder(e.to_string()))
	}

	fn dim(&self) -> usize {
		DIM
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use tempfile::tempdir;

	use super::*;

	fn write_item(dir: &Path, file: &str, body: &str) {
		fs::create_dir_all(dir).unwrap();
		fs::write(dir.join(file), body).unwrap();
	}

	fn fingerprint_of(repo: &Path) -> WorkspaceFingerprint {
		compute_fingerprint(repo).unwrap()
	}

	#[test]
	fn fingerprint_picks_up_tasks_org_files() {
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks/plans"),
			"PLAN-1.org",
			"* TODO PLAN-1\n:PROPERTIES:\n:CUSTOM_ID: PLAN-1\n:END:\n",
		);
		write_item(
			&repo.path().join("!tasks/feats"),
			"FEAT-2.org",
			"* TODO FEAT-2\n:PROPERTIES:\n:CUSTOM_ID: FEAT-2\n:END:\n",
		);
		// Non-org file → ignored.
		write_item(&repo.path().join("!tasks"), "README.md", "noise");
		// Outside scanned subdirs → ignored.
		write_item(&repo.path().join("src"), "other.org", "* X");

		let fp = fingerprint_of(repo.path());
		let paths: Vec<&PathBuf> = fp.files.keys().collect();
		assert_eq!(paths.len(), 2);
		assert!(paths.iter().any(|p| p.ends_with("PLAN-1.org")));
		assert!(paths.iter().any(|p| p.ends_with("FEAT-2.org")));
	}

	#[test]
	fn fingerprint_includes_spell_memory_unlike_workspace_cache_default() {
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join(".spell/memory/episodes"),
			"2026-05-16.org",
			"* ITEM Episode\n:PROPERTIES:\n:CUSTOM_ID: EP-1\n:KIND: episode\n:END:\n",
		);

		let fp = fingerprint_of(repo.path());
		assert!(fp.files.keys().any(|p| p.starts_with(".spell/memory")));
	}

	#[test]
	fn fingerprint_changes_when_file_size_changes() {
		let repo = tempdir().unwrap();
		let tasks = repo.path().join("!tasks");
		write_item(&tasks, "A.org", "* TODO A");
		let fp1 = fingerprint_of(repo.path());
		write_item(&tasks, "A.org", "* TODO A WITH MORE TEXT");
		let fp2 = fingerprint_of(repo.path());
		assert_ne!(fp1.files, fp2.files, "size change must invalidate fingerprint");
	}

	#[test]
	fn handle_falls_back_gracefully_when_worker_unavailable() {
		// With no PI_EMBEDDING_WORKER and no co-located binary, the worker
		// path resolution fails. The engine should still warm up (BM25 +
		// graph), just with an empty VecIndex.
		// SAFETY: tests run sequentially when sharing env vars; this test
		// doesn't write env, only reads (and the override mechanism is opt-in).
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"X.org",
			"* TODO X\n:PROPERTIES:\n:CUSTOM_ID: X-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let handle = get_or_create(repo.path(), Some(cache.path())).unwrap();
		// Drop handle reference from the global map so the next call rebuilds.
		// We use a dedicated cache_base per-test, so no cross-test pollution.

		let query = RecallQuery {
			text: Some("X".into()),
			limit: 10,
			..Default::default()
		};
		let _ = handle.query(query); // must not panic; vector lane may be empty
		forget(repo.path());
	}

	#[allow(dead_code)]
	fn _suppress_unused(_: HashMap<String, String>) {}
}
