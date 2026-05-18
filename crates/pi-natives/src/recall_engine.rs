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
	fs,
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
	time::{Duration, Instant, UNIX_EPOCH},
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

use crate::{embedding_worker, org_index::PersistedOrgItem};

/// Lightweight stderr logging. pi-natives doesn't pull in `tracing`; we match
/// the convention used by `org_buffer.rs` (single-line `eprintln!`). Gated
/// behind `PI_RECALL_LOG` so agent-driven workflows (frequent fingerprint
/// invalidations) don't spam stderr; set the var to any value to enable.
macro_rules! engine_log {
	($($arg:tt)*) => {
		if std::env::var_os("PI_RECALL_LOG").is_some() {
			eprintln!("recall_engine: {}", format_args!($($arg)*));
		}
	};
}

/// Embedding dimensionality used by `pi-embedding-worker` (Jina v2 base code).
const DIM: usize = 768;

/// Subdirectories of the repo that contribute org items to the recall index.
/// `!tasks/` holds project plans/feats/bugs/etc. `.spell/memory/` holds
/// agent-written episodes and concepts.
const SCANNED_SUBDIRS: &[&str] = &["!tasks", ".spell/memory"];

/// Cap on the `ENGINES` LRU. Each entry holds a Tantivy `IndexWriter` (50 MB
/// arena), an HNSW (one 768-f32 vector per item), and the full parsed item
/// vector — easily 60-200 MB resident. Sized for the common case (a session
/// works one repo at a time); cross-repo work pays one warm-restore on
/// switch (~50 ms with disk cache). Cross-session sharing is PLAN-309's
/// territory; this cap addresses single-session memory only (BUG-382).
const ENGINES_CAP: usize = 1;

/// Idle TTL: drop cached handles whose `last_used` is older than this on the
/// next `get_or_create` miss for a different repo. Eviction respects the
/// same `Arc::strong_count == 1` invariant as LRU eviction — an in-flight
/// query keeps its handle alive past the TTL. The warm-restore on re-use is
/// ~50 ms; 10 min idle window is sized so an operator's lunch break frees
/// the ~60-200 MB without penalising active back-to-back work.
const IDLE_TTL: Duration = Duration::from_secs(600);

/// Test-only override for `IDLE_TTL`. Tests acquire `lock_test_env()` before
/// mutating to serialise across the test binary. `None` ⇒ use `IDLE_TTL`.
#[cfg(test)]
static IDLE_TTL_OVERRIDE: parking_lot::Mutex<Option<Duration>> = parking_lot::Mutex::new(None);

#[inline]
fn idle_ttl() -> Duration {
	#[cfg(test)]
	if let Some(d) = *IDLE_TTL_OVERRIDE.lock() {
		return d;
	}
	IDLE_TTL
}

/// Bincode filename inside the per-repo cache dir.
const ENGINE_CACHE_FILE: &str = "engine.bin";

/// VecIndex disk filename inside the per-repo cache dir.
const VEC_CACHE_FILE: &str = "vec.bin";

// ---------------------------------------------------------------------------
// Static singleton
// ---------------------------------------------------------------------------

/// LRU map of repo-keyed engine handles. Bound by `ENGINES_CAP` to keep
/// memory bounded across long Spell sessions that touch many repos, plus
/// `IDLE_TTL`-based eviction so a single-repo session that goes idle for
/// a long stretch (lunch break, overnight) frees its 60-200 MB without
/// waiting for a different repo to push it out. Ordered LRU-first (last
/// touched at the back). At the current cap (1) the linear scans are O(1)
/// in practice; the structure stays a `Vec` to keep eviction semantics
/// explicit and avoid pulling in an LRU crate.
struct LruEntry {
	repo:      PathBuf,
	handle:    Arc<RecallEngineHandle>,
	last_used: Instant,
}

static ENGINES: OnceLock<Mutex<Vec<LruEntry>>> = OnceLock::new();

fn engines() -> &'static Mutex<Vec<LruEntry>> {
	ENGINES.get_or_init(|| Mutex::new(Vec::new()))
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
	let now = Instant::now();
	// LRU lookup: linear scan, move-to-back on hit. Update `last_used` so
	// the TTL sweep below treats this entry as freshly touched.
	if let Some(pos) = map.iter().position(|e| e.repo == canon) {
		let mut entry = map.remove(pos);
		entry.last_used = now;
		let handle = Arc::clone(&entry.handle);
		map.push(entry);
		return Ok(handle);
	}
	// Miss path. Before we allocate the new handle, sweep idle entries so
	// the new handle doesn't push memory above where it needs to be. Same
	// `Arc::strong_count == 1` invariant as LRU eviction (54fef66f3): never
	// drop a handle held by an in-flight query, else Tantivy's
	// `INDEX_WRITER_LOCK` stays held and the next `open_fts` fails with
	// `LockBusy`. Walk back-to-front so removals don't shift unscanned
	// indices.
	let ttl = idle_ttl();
	for idx in (0..map.len()).rev() {
		if now.duration_since(map[idx].last_used) > ttl
			&& Arc::strong_count(&map[idx].handle) == 1
		{
			let evicted = map.remove(idx);
			engine_log!(
				"TTL evicted {} (idle {:?} > {:?})",
				evicted.repo.display(),
				now.duration_since(evicted.last_used),
				ttl,
			);
		}
	}
	let base_owned = cache_base.map(Path::to_path_buf);
	let h = Arc::new(RecallEngineHandle::new(canon.clone(), cache_dir, base_owned));
	map.push(LruEntry { repo: canon, handle: Arc::clone(&h), last_used: now });
	// LRU cap eviction: only evict entries whose Arc strong count is 1 (no
	// in-flight query holds a clone). Evicting an in-use handle would leak
	// its Tantivy `INDEX_WRITER_LOCK` until the in-flight query returns;
	// the next `get_or_create` for the evicted repo would then fail
	// `open_fts` with `LockBusy`. Walk LRU-first and skip live entries;
	// under sustained pressure the map may briefly exceed `ENGINES_CAP`,
	// but never indefinitely (queries are bounded in time).
	let mut scan_idx = 0;
	while map.len() > ENGINES_CAP && scan_idx < map.len() {
		if Arc::strong_count(&map[scan_idx].handle) == 1 {
			let evicted = map.remove(scan_idx);
			engine_log!(
				"LRU evicted {} (cap={ENGINES_CAP}, len was {})",
				evicted.repo.display(),
				map.len() + 1,
			);
			// scan_idx stays; next iteration retests this position.
		} else {
			scan_idx += 1;
		}
	}
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
		let canon = canonical_root(repo_root);
		let mut map = slot.lock();
		map.retain(|e| e.repo != canon);
	}
}

// ---------------------------------------------------------------------------
// Engine handle + state machine
// ---------------------------------------------------------------------------

pub struct RecallEngineHandle {
	repo_root: PathBuf,
	cache_dir: PathBuf,
	/// Mirrors the `cache_base` argument from `get_or_create`. When set, the
	/// engine opens `FtsIndex` via `open_at(repo_root, base)` so the Tantivy
	/// directory co-locates under the same base as `engine.bin` / `vec.bin`.
	/// `None` means production: `FtsIndex::open` resolves the default
	/// `cache_base()` and writes under `~/.cache/spell/recall/{hash}/fts/`.
	cache_base: Option<PathBuf>,
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

/// On-disk cache entry. Uses `PersistedOrgItem` (not `OrgItem`) because
/// `OrgItem`'s serde derive marks `body`, `clocks`, `children`, and
/// `relations` with `#[serde(skip_serializing_if = ...)]` — fatal for
/// bincode, a positional non-self-describing format. The encoder skips
/// absent fields, but the decoder still expects them at their byte
/// offsets, producing "failed to fill whole buffer". `PersistedOrgItem`
/// strips those attributes; the conversion is `From`-implemented in
/// `org_index.rs`.
#[derive(Serialize, Deserialize)]
struct EngineCacheEntry {
	fingerprint: WorkspaceFingerprint,
	items:       Vec<PersistedOrgItem>,
}

impl PersistentCacheEntry for EngineCacheEntry {
	fn fingerprint(&self) -> &WorkspaceFingerprint {
		&self.fingerprint
	}
}

impl RecallEngineHandle {
	fn new(repo_root: PathBuf, cache_dir: PathBuf, cache_base: Option<PathBuf>) -> Self {
		Self {
			repo_root,
			cache_dir,
			cache_base,
			state: Mutex::new(EngineState::Cold),
		}
	}

	/// Open `FtsIndex` honoring the cache_base override if set.
	fn open_fts(&self) -> Result<FtsIndex, String> {
		let result = match &self.cache_base {
			Some(base) => FtsIndex::open_at(&self.repo_root, base),
			None => FtsIndex::open(&self.repo_root),
		};
		result.map_err(|e| format!("fts open: {e}"))
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
		// Drop the previous `WarmEngine` (and the `FtsIndex` inside it) BEFORE
		// opening a new one. Tantivy's `INDEX_WRITER_LOCK` is held by the
		// `IndexWriter` stored inside `FtsIndex`; if we kept the old engine
		// alive while constructing the new one, `FtsIndex::open` would fail
		// with `LockBusy` (single-process exclusive writer). On rebuild failure
		// we leave state as `Cold` so the next query retries cleanly.
		*state = EngineState::Cold;
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
		let fts = self.open_fts()?;
		// Consistency probe: if the fingerprint matches but the Tantivy index
		// is empty (or doc count diverges from items), the on-disk fts/ was
		// wiped or corrupted under us. Fall back to full rebuild so we don't
		// serve BM25-empty results indefinitely.
		let on_disk_docs = match fts.doc_count() {
			Ok(n) => n,
			Err(e) => {
				engine_log!("fts doc_count failed ({e}); will rebuild");
				return Ok(None);
			},
		};
		// Compare against unique-id count, not raw items.len(). `FtsIndex::index`
		// does `delete_term(id) + add_document` per item, so duplicate CUSTOM_IDs
		// in `entry.items` collapse to one Tantivy doc each. Comparing raw
		// items.len() would loop a repo with duplicate ids into permanent
		// rebuild.
		let unique_id_count = entry
			.items
			.iter()
			.map(|item| item.id.as_str())
			.collect::<std::collections::HashSet<_>>()
			.len();
		if (on_disk_docs as usize) < unique_id_count {
			engine_log!(
				"fts/items mismatch (fts={on_disk_docs}, unique_ids={unique_id_count}); will rebuild",
			);
			return Ok(None);
		}
		// Convert persisted shape back to OrgItem for in-memory use.
		let items: Vec<OrgItem> = entry.items.into_iter().map(OrgItem::from).collect();
		let graph = build_typed_graph(&items);
		Ok(Some(WarmEngine {
			fingerprint: entry.fingerprint,
			items,
			fts,
			vec,
			graph,
		}))
	}

	fn full_rebuild(&self, fingerprint: WorkspaceFingerprint) -> Result<WarmEngine, String> {
		let items = scan_items(&self.repo_root);
		let fts = self.open_fts()?;
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
			items:       warm.items.iter().cloned().map(PersistedOrgItem::from).collect(),
		};
		// Atomic-save pattern: write to `<name>.tmp`, then rename over the
		// final path. `CacheStore::save` truncates in place, so a crash
		// mid-write would leave a half-written file that `from_disk` rejects
		// on magic-bytes mismatch — forcing a full 3-5 min rebuild on every
		// subsequent process start until a clean save lands. The temp+rename
		// dance guarantees that the on-disk artifact is either fully valid or
		// absent. Implemented locally rather than in `CacheStore` so this
		// change stays scoped to the recall hot path.
		let tmp_store = CacheStore::new(self.cache_dir.clone());
		tmp_store
			.save("engine.tmp", &entry)
			.map_err(|e| format!("save engine cache: {e}"))?;
		let src = self.cache_dir.join("engine.tmp.bin");
		let dst = self.cache_dir.join("engine.bin");
		fs::rename(&src, &dst).map_err(|e| format!("rename engine.bin: {e}"))?;

		let vec_final = self.cache_dir.join(VEC_CACHE_FILE);
		let vec_tmp = self.cache_dir.join("vec.bin.tmp");
		warm
			.vec
			.to_disk(&vec_tmp)
			.map_err(|e| format!("write vec.bin.tmp: {e}"))?;
		fs::rename(&vec_tmp, &vec_final).map_err(|e| format!("rename vec.bin: {e}"))?;
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

	/// Drop-based env-var guard. Saves the prior value of an env var on
	/// construction, sets the new one, and restores the prior value on drop
	/// even if the test body panics. Pairs with `lock_test_env`'s mutex so
	/// concurrent tests don't race on the same env.
	struct EnvVarGuard {
		key:     &'static str,
		prior:   Option<std::ffi::OsString>,
		_locked: std::sync::MutexGuard<'static, ()>,
	}

	impl EnvVarGuard {
		fn set(key: &'static str, value: &str) -> Self {
			let locked = crate::embedding_worker::lock_test_env();
			let prior = std::env::var_os(key);
			// SAFETY: `locked` serialises env mutation across tests in this
			// process. Other processes don't share the lock, but `cargo test`
			// runs each binary single-process and tests within a process see
			// the lock.
			unsafe { std::env::set_var(key, value) };
			Self { key, prior, _locked: locked }
		}
	}

	impl Drop for EnvVarGuard {
		fn drop(&mut self) {
			// SAFETY: lock guard is still held until self is fully dropped.
			unsafe {
				match &self.prior {
					Some(v) => std::env::set_var(self.key, v),
					None => std::env::remove_var(self.key),
				}
			}
		}
	}

	/// Convenience: force the embedding worker to be unresolvable so tests
	/// don't spawn the real subprocess or download the Jina model.
	fn force_no_worker(test_name: &'static str) -> EnvVarGuard {
		EnvVarGuard::set(
			"PI_EMBEDDING_WORKER",
			&format!("/nonexistent/pi-embedding-worker-{test_name}"),
		)
	}

	/// Convenience: tiny RecallQuery builder.
	fn q(text: &str) -> RecallQuery {
		RecallQuery {
			text: Some(text.into()),
			limit: 10,
			..Default::default()
		}
	}

	#[test]
	fn cache_base_override_relocates_fts_to_provided_dir() {
		// Locks in the P1 fix: passing Some(cache) to get_or_create must
		// route the Tantivy index under `cache/{repo_hash}/fts/`, NOT under
		// the default `cache_base()` (~/.cache/spell/recall/...). Otherwise
		// the warm-restore probe test could silently pass against the real
		// cache while the engine ignores the override.
		let _no_worker = force_no_worker("cache-base-relocates");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"B.org",
			"* TODO B\n:PROPERTIES:\n:CUSTOM_ID: B-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let handle = get_or_create(repo.path(), Some(cache.path())).unwrap();
		handle.query(q("B")).unwrap();

		let canon = canonical_root(repo.path());
		let expected = repo_cache_dir_at(&canon, cache.path()).unwrap().join("fts");
		assert!(
			expected.is_dir(),
			"override fts dir missing at {}",
			expected.display(),
		);
		forget(repo.path());
	}

	/// Disk fast path: cold-build, drop the in-memory handle via `forget()`,
	/// then `get_or_create` again with no source changes. `try_load_warm`
	/// must reconstruct the `WarmEngine` from `engine.bin` + `vec.bin` + the
	/// on-disk Tantivy directory WITHOUT calling `full_rebuild`. Validated by
	/// asserting `engine.bin` mtime is stable across the two queries.
	///
	/// Sibling `warm_restore_serves_unchanged_repo_without_rebuild` covers
	/// the in-memory warm path (no `forget`, same handle reused). Together
	/// they pin both halves of the cache hit story.
	#[test]
	fn disk_fast_path_restores_warm_engine_without_full_rebuild() {
		let _no_worker = force_no_worker("disk-fastpath");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"E.org",
			"* TODO E\n:PROPERTIES:\n:CUSTOM_ID: E-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let canon = canonical_root(repo.path());
		let engine_bin = repo_cache_dir_at(&canon, cache.path())
			.unwrap()
			.join("engine.bin");

		// Cold build via first get_or_create.
		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("E"))
			.unwrap();
		assert!(engine_bin.is_file(), "cold build must persist engine.bin");
		let mtime_cold = fs::metadata(&engine_bin).unwrap().modified().unwrap();

		// Drop the in-memory handle. The cache directory is untouched.
		forget(repo.path());
		std::thread::sleep(std::time::Duration::from_millis(50));

		// Second get_or_create: handle is gone, must hit try_load_warm.
		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("E"))
			.unwrap();
		assert!(
			hits.iter().any(|h| h.id == "E-1"),
			"disk fast path should surface E-1; got {hits:?}"
		);

		// If full_rebuild had run, save_warm would have rewritten engine.bin
		// and the mtime would advance. A successful disk-restore takes the
		// try_load_warm branch which does NOT call save_warm, so the file
		// must be untouched.
		let mtime_warm = fs::metadata(&engine_bin).unwrap().modified().unwrap();
		assert_eq!(
			mtime_cold, mtime_warm,
			"disk fast path triggered a rebuild (engine.bin mtime advanced)"
		);
		forget(repo.path());
	}

	#[test]
	fn warm_restore_rejected_when_fts_dir_is_wiped() {
		// Negative warm-restore: if fingerprint matches but Tantivy state was
		// wiped underneath us (rm -rf fts/, partial corruption, schema bump),
		// the doc_count probe must reject the disk fast-path and trigger a
		// full rebuild.
		let _no_worker = force_no_worker("warm-restore-wipe");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"A.org",
			"* TODO A\n:PROPERTIES:\n:CUSTOM_ID: A-1\n:END:\n",
		);
		let cache = tempdir().unwrap();

		// Cold build → engine.bin + vec.bin + fts/ on disk.
		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("A"))
			.unwrap();
		forget(repo.path());

		// Locate fts/ via the same path the engine uses. Assert (don't gate)
		// so a regression that ignores cache_base fails loudly here rather
		// than silently no-op'ing the wipe below.
		let canon = canonical_root(repo.path());
		let repo_cache = repo_cache_dir_at(&canon, cache.path()).unwrap();
		let fts_dir = repo_cache.join("fts");
		assert!(
			fts_dir.is_dir(),
			"precondition: fts/ must exist under override cache base at {} \
			 (cache_base override regressed?)",
			fts_dir.display(),
		);
		fs::remove_dir_all(&fts_dir).unwrap();

		// Second call: doc_count probe sees fts empty vs items=1 → rebuild.
		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("A"))
			.unwrap();
		assert!(
			hits.iter().any(|h| h.id == "A-1"),
			"after fts wipe, second query should rebuild and surface A-1; got {hits:?}"
		);
		forget(repo.path());
	}

	#[test]
	fn warm_restore_serves_unchanged_repo_without_rebuild() {
		// Positive warm-restore: two queries back-to-back with no source
		// changes. The second must serve from the WarmEngine in memory; we
		// approximate "didn't rebuild" by asserting engine.bin mtime is
		// unchanged across calls (full_rebuild calls save_warm which would
		// touch it).
		let _no_worker = force_no_worker("warm-restore-happy");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"C.org",
			"* TODO C\n:PROPERTIES:\n:CUSTOM_ID: C-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let canon = canonical_root(repo.path());
		let engine_bin = repo_cache_dir_at(&canon, cache.path())
			.unwrap()
			.join("engine.bin");

		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("C"))
			.unwrap();
		let mtime1 = fs::metadata(&engine_bin).unwrap().modified().unwrap();
		// Sleep briefly so a needless rewrite would advance mtime past
		// filesystem timestamp resolution (msec on most FSes, but EXT4 with
		// noatime sometimes coalesces).
		std::thread::sleep(std::time::Duration::from_millis(50));

		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("C"))
			.unwrap();
		let mtime2 = fs::metadata(&engine_bin).unwrap().modified().unwrap();
		assert_eq!(
			mtime1, mtime2,
			"second query rebuilt despite unchanged source (engine.bin mtime drifted)"
		);
		forget(repo.path());
	}

	#[test]
	fn stale_fingerprint_triggers_rebuild() {
		// Negative: editing a tracked .org file between queries must
		// invalidate the warm cache and rebuild. Approximated by asserting
		// engine.bin mtime advances and the new content is searchable.
		let _no_worker = force_no_worker("stale-fingerprint");
		let repo = tempdir().unwrap();
		let tasks = repo.path().join("!tasks");
		write_item(
			&tasks,
			"D.org",
			"* TODO D first\n:PROPERTIES:\n:CUSTOM_ID: D-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let canon = canonical_root(repo.path());
		let engine_bin = repo_cache_dir_at(&canon, cache.path())
			.unwrap()
			.join("engine.bin");

		// First query: cold build.
		let hits1 = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("first"))
			.unwrap();
		assert!(hits1.iter().any(|h| h.id == "D-1"));
		let mtime1 = fs::metadata(&engine_bin).unwrap().modified().unwrap();

		// Edit the file: change title + add a unique token. Sleep to
		// guarantee mtime resolution distinguishes the two writes.
		std::thread::sleep(std::time::Duration::from_millis(50));
		write_item(
			&tasks,
			"D.org",
			"* TODO D second uniqueazaza\n:PROPERTIES:\n:CUSTOM_ID: D-1\n:END:\n",
		);

		// Second query: must rebuild and surface the new token.
		let hits2 = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("uniqueazaza"))
			.unwrap();
		assert!(
			hits2.iter().any(|h| h.id == "D-1"),
			"after edit, recall should surface new content; got {hits2:?}"
		);
		let mtime2 = fs::metadata(&engine_bin).unwrap().modified().unwrap();
		assert!(
			mtime2 > mtime1,
			"engine.bin mtime should advance after stale-fingerprint rebuild"
		);
		forget(repo.path());
	}

	/// Regression: PersistedOrgItem used to omit the `relations` field, so a
	/// disk warm restore silently dropped every `:RELATIONS:` drawer edge
	/// (FEAT-631 Involved/About/Produced/etc.). The rebuilt TypedGraph was
	/// missing those edges — affecting the built-in `priors` profile and
	/// graph-kind queries until an unrelated invalidation triggered
	/// `full_rebuild`. Pin the round-trip here so a future regression to
	/// PersistedOrgItem (or its From impls) fails loudly.
	#[test]
	fn disk_fast_path_preserves_relations_drawer() {
		let _no_worker = force_no_worker("disk-relations");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"F.org",
			"* TODO F\n:PROPERTIES:\n:CUSTOM_ID: F-1\n:END:\n:RELATIONS:\nABOUT: G-1\nINVOLVED: H-1\n:END:\n* TODO G\n:PROPERTIES:\n:CUSTOM_ID: G-1\n:END:\n* TODO H\n:PROPERTIES:\n:CUSTOM_ID: H-1\n:END:\n",
		);
		let cache = tempdir().unwrap();

		// Cold build → engine.bin contains F-1 with its 2 relations.
		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("F"))
			.unwrap();
		forget(repo.path());

		// Disk fast path: re-open, then exercise a graph query that DEPENDS on
		// F-1's relations. Recall with text="" and focus="F-1" walks the
		// graph 1 hop from F-1; without relations the result is empty;
		// with relations preserved it surfaces G-1 / H-1.
		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(RecallQuery {
				text:        None,
				focus:       Some("F-1".into()),
				graph_hops:  1,
				limit:       10,
				..Default::default()
			})
			.unwrap();
		let ids: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
		assert!(
			ids.contains(&"G-1") || ids.contains(&"H-1"),
			"disk-restored graph must include 1-hop neighbours from :RELATIONS:; got {ids:?}"
		);
		forget(repo.path());
	}

	/// RAII override for `IDLE_TTL_OVERRIDE`. Pairs with `force_no_worker`'s
	/// env lock so concurrent tests don't race on the override slot.
	struct IdleTtlGuard;

	impl IdleTtlGuard {
		fn set(d: Duration) -> Self {
			*IDLE_TTL_OVERRIDE.lock() = Some(d);
			Self
		}
	}

	impl Drop for IdleTtlGuard {
		fn drop(&mut self) {
			*IDLE_TTL_OVERRIDE.lock() = None;
		}
	}

	/// Test-only inspection of the global LRU. Used to assert TTL behaviour
	/// without poking the static directly from each test body.
	fn engines_contains(repo: &Path) -> bool {
		let Some(slot) = ENGINES.get() else {
			return false;
		};
		let canon = canonical_root(repo);
		slot.lock().iter().any(|e| e.repo == canon)
	}

	#[test]
	fn idle_ttl_evicts_unused_engine_on_next_miss() {
		// TTL semantics: after `IDLE_TTL` of no use, the next `get_or_create`
		// for a *different* repo sweeps the idle entry before allocating the
		// new handle. Sweep runs on the miss path only — we never do work on
		// hit paths, so an actively-used engine never gets touched.
		let _no_worker = force_no_worker("ttl-evicts");
		let _ttl = IdleTtlGuard::set(Duration::from_millis(50));
		let repo_a = tempdir().unwrap();
		write_item(
			&repo_a.path().join("!tasks"),
			"A.org",
			"* TODO A\n:PROPERTIES:\n:CUSTOM_ID: TTL-A\n:END:\n",
		);
		let repo_b = tempdir().unwrap();
		write_item(
			&repo_b.path().join("!tasks"),
			"B.org",
			"* TODO B\n:PROPERTIES:\n:CUSTOM_ID: TTL-B\n:END:\n",
		);
		let cache = tempdir().unwrap();

		// Cold-build A. Temporary Arc drops at end of statement, leaving
		// strong_count = 1 (only ENGINES holds it).
		get_or_create(repo_a.path(), Some(cache.path()))
			.unwrap()
			.query(q("A"))
			.unwrap();
		assert!(engines_contains(repo_a.path()), "precondition: A cached");

		// Idle past TTL.
		std::thread::sleep(Duration::from_millis(100));

		// Get-or-create for B: miss path runs TTL sweep, sees A idle >
		// 50 ms with strong_count == 1, drops it.
		get_or_create(repo_b.path(), Some(cache.path()))
			.unwrap()
			.query(q("B"))
			.unwrap();

		assert!(
			!engines_contains(repo_a.path()),
			"A should have been TTL-evicted on B's miss"
		);
		assert!(engines_contains(repo_b.path()), "B should be cached");

		forget(repo_a.path());
		forget(repo_b.path());
	}

	#[test]
	fn idle_ttl_skips_handles_held_by_inflight_queries() {
		// Strong-count invariant (54fef66f3 carried forward to TTL path):
		// never drop a handle still held outside ENGINES. Dropping it would
		// keep Tantivy's `INDEX_WRITER_LOCK` held inside the still-live
		// `FtsIndex`, and the next `open_fts` on the same repo would fail
		// with `LockBusy`. Test: hold an explicit Arc clone, sleep past TTL,
		// trigger a sweep via a miss on a different repo, assert the held
		// handle survives.
		let _no_worker = force_no_worker("ttl-strong-count");
		let _ttl = IdleTtlGuard::set(Duration::from_millis(50));
		let repo_a = tempdir().unwrap();
		write_item(
			&repo_a.path().join("!tasks"),
			"A.org",
			"* TODO A\n:PROPERTIES:\n:CUSTOM_ID: TTL-HOLD-A\n:END:\n",
		);
		let repo_b = tempdir().unwrap();
		write_item(
			&repo_b.path().join("!tasks"),
			"B.org",
			"* TODO B\n:PROPERTIES:\n:CUSTOM_ID: TTL-HOLD-B\n:END:\n",
		);
		let cache = tempdir().unwrap();

		// Hold a clone outside ENGINES — simulates an in-flight query.
		let held_a = get_or_create(repo_a.path(), Some(cache.path())).unwrap();
		held_a.query(q("A")).unwrap();
		assert_eq!(
			Arc::strong_count(&held_a),
			2,
			"precondition: held_a + ENGINES = 2 strong refs"
		);

		std::thread::sleep(Duration::from_millis(100));

		// Miss on B triggers the sweep. A is idle but `strong_count == 2`
		// so the guard skips it. Also exercises LRU cap eviction: cap=1
		// would normally evict A, but the same strong-count guard skips it.
		let _hb = get_or_create(repo_b.path(), Some(cache.path())).unwrap();
		_hb.query(q("B")).unwrap();

		assert!(
			engines_contains(repo_a.path()),
			"A must survive TTL sweep while held outside ENGINES (Tantivy lock invariant)"
		);
		assert!(engines_contains(repo_b.path()), "B should be cached");

		drop(held_a);
		drop(_hb);
		forget(repo_a.path());
		forget(repo_b.path());
	}

	#[test]
	fn handle_falls_back_gracefully_when_worker_unavailable() {
		// Vector lane disabled → BM25 + graph still serve.
		let _no_worker = force_no_worker("worker-unavailable");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"X.org",
			"* TODO X\n:PROPERTIES:\n:CUSTOM_ID: X-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let handle = get_or_create(repo.path(), Some(cache.path())).unwrap();
		let result = handle.query(q("X"));
		assert!(result.is_ok(), "engine.query failed: {result:?}");
		forget(repo.path());
	}
}
