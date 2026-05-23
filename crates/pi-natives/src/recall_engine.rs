//! Process-singleton recall engine.
//!
//! `cmd_recall` (in `org_buffer.rs`) used to rebuild every recall artifact on
//! every invocation: walk + parse 1870 .org files, re-index BM25, re-embed
//! every item, rebuild a HNSW from scratch, build the typed graph, then run
//! the RRF fusion. The full pipeline took 3-5 minutes and blocked Bun's main
//! thread.
//!
//! This module:
//!
//! * Holds one `RecallEngineHandle` per `(canonical_repo_root)` in a static
//!   `OnceLock` map, keeping the in-memory `SearchIndex` (BM25), the usearch
//!   `VectorIndex`, the typed graph, and parsed items alive for the process
//!   lifetime.
//! * Detects staleness by comparing a
//!   `pi_workspace_cache::WorkspaceFingerprint` (per-file size + mtime + git
//!   HEAD) against the in-memory copy on every query (~5 ms walk for 1870
//!   files).
//! * Persists the warm state to `{recall cache}/{repo_hash}/{engine.bin,
//!   bm25.bin, vec.uidx}` so a Spell restart hits the warm path immediately
//!   without rebuilding.
//! * Routes embeddings through the production `embedding_worker` subprocess
//!   (BAAI/bge-m3). If the worker binary is missing, the vector lane is
//!   silently disabled — BM25 and the graph lane still serve recall.
//!
//! W5: Tantivy + the `pi-org-recall` crate are gone. BM25 is now the
//! in-memory `pi_knowledge_core::bm25::SearchIndex` (bincode-persisted);
//! vectors live in `pi_knowledge_core::vec::VectorIndex` (usearch, `u64`-keyed
//! via [`pi_knowledge_core::vec::id_hash`]).
//!
//! Concurrency: `state` is `parking_lot::Mutex`-guarded; concurrent
//! `recall_engine::query()` calls serialise around it. The hot path (warm,
//! fresh) holds the mutex only for the duration of fingerprint comparison and
//! RRF fusion. Cold/stale rebuilds hold the mutex for the rebuild.

use std::{
	fs,
	io::{BufReader, BufWriter},
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
	time::{Duration, Instant, UNIX_EPOCH},
};

use parking_lot::Mutex;
use pi_knowledge_core::{
	bm25::SearchIndex,
	cache::KnowledgeMeta,
	ingest::purge_if_stale,
	recall::{
		Embedder, RecallContext, RecallDoc, RecallHit, RecallProfileRegistry, RecallQuery, recall,
	},
	vec::{VectorEntry, VectorIndex, id_hash},
};
use pi_org_engine::{
	graph::{TypedGraph, build_typed_graph},
	item::OrgItem,
};
use pi_workspace_cache::{FileFingerprint, WorkspaceFingerprint, read_git_head};
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

/// Embedding dimensionality used by `pi-knowledge-worker` (BAAI/bge-m3).
const DIM: usize = 1024;

/// Subdirectories of the repo that contribute org items to the recall index.
/// `!tasks/` holds project plans/feats/bugs/etc. `.spell/memory/` holds
/// agent-written episodes and concepts.
const SCANNED_SUBDIRS: &[&str] = &["!tasks", ".spell/memory"];

/// Cap on the `ENGINES` LRU. Each entry holds the in-memory BM25 index, an
/// HNSW (one 1024-f32 vector per item), and the full parsed item vector —
/// easily 60-200 MB resident. Sized for the common case (a session works
/// one repo at a time); cross-repo work pays one warm-restore on switch.
const ENGINES_CAP: usize = 1;

/// Idle TTL: drop cached handles whose `last_used` is older than this on the
/// next `get_or_create` miss for a different repo.
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

/// BM25 SearchIndex bincode filename inside the per-repo cache dir.
const BM25_CACHE_FILE: &str = "bm25.bin";

/// `VectorIndex` usearch filename inside the per-repo cache dir.
const VEC_CACHE_FILE: &str = "vec.uidx";

/// `KnowledgeMeta` filename inside the per-repo cache dir. Consumed by
/// `pi_knowledge_core::ingest::purge_if_stale` — see W5.5 F2.
const META_CACHE_FILE: &str = "meta.bin";

/// Default embedder model name when `PI_EMBEDDING_MODEL` is unset. Matches
/// the production worker default (BAAI/bge-m3). The exact string is part of
/// the cache invalidation contract; changing it wipes everyone's cache.
const DEFAULT_EMBEDDER_MODEL: &str = "bge-m3";

fn current_embedder_model() -> String {
	std::env::var("PI_EMBEDDING_MODEL").unwrap_or_else(|_| DEFAULT_EMBEDDER_MODEL.into())
}

/// Process-wide profile registry. Built once, shared across queries. Profiles
/// are pure-data and `Send + Sync`; the `OnceLock` is cheap.
static PROFILES: OnceLock<RecallProfileRegistry> = OnceLock::new();
fn profiles() -> &'static RecallProfileRegistry {
	PROFILES.get_or_init(RecallProfileRegistry::defaults)
}

// ---------------------------------------------------------------------------
// Cache path helpers (local; the old `pi_org_recall::fts` helpers are gone).
// ---------------------------------------------------------------------------

/// 12-character FNV-1a hex of the canonicalised repo path.
fn repo_hash_str(canon: &Path) -> String {
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	for b in canon.to_string_lossy().bytes() {
		h ^= u64::from(b);
		h = h.wrapping_mul(0x0000_0001_0000_01b3);
	}
	format!("{h:012x}")
}

/// Default recall cache base. Resolves XDG → HOME → cwd fallback.
fn default_cache_base() -> PathBuf {
	if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
		return PathBuf::from(xdg).join("spell/recall");
	}
	if let Some(home) = std::env::var_os("HOME") {
		return PathBuf::from(home).join(".cache/spell/recall");
	}
	PathBuf::from("./.spell-cache/recall")
}

/// Per-repo cache directory under a caller-provided base.
fn repo_cache_dir_at(repo_root: &Path, cache_base: &Path) -> PathBuf {
	cache_base.join(repo_hash_str(repo_root))
}

/// Per-repo cache directory at the default base.
fn repo_cache_dir(repo_root: &Path) -> PathBuf {
	repo_cache_dir_at(repo_root, &default_cache_base())
}

// ---------------------------------------------------------------------------
// Static singleton
// ---------------------------------------------------------------------------

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
pub fn get_or_create(
	repo_root: &Path,
	cache_base: Option<&Path>,
) -> Result<Arc<RecallEngineHandle>, String> {
	let canon = canonical_root(repo_root);
	let cache_dir = match cache_base {
		Some(base) => repo_cache_dir_at(&canon, base),
		None => repo_cache_dir(&canon),
	};
	let mut map = engines().lock();
	let now = Instant::now();
	if let Some(pos) = map.iter().position(|e| e.repo == canon) {
		let mut entry = map.remove(pos);
		entry.last_used = now;
		let handle = Arc::clone(&entry.handle);
		map.push(entry);
		return Ok(handle);
	}
	let ttl = idle_ttl();
	for idx in (0..map.len()).rev() {
		if now.duration_since(map[idx].last_used) > ttl && Arc::strong_count(&map[idx].handle) == 1 {
			let evicted = map.remove(idx);
			engine_log!(
				"TTL evicted {} (idle {:?} > {:?})",
				evicted.repo.display(),
				now.duration_since(evicted.last_used),
				ttl,
			);
		}
	}
	let h = Arc::new(RecallEngineHandle::new(canon.clone(), cache_dir));
	map.push(LruEntry { repo: canon, handle: Arc::clone(&h), last_used: now });
	let mut scan_idx = 0;
	while map.len() > ENGINES_CAP && scan_idx < map.len() {
		if Arc::strong_count(&map[scan_idx].handle) == 1 {
			let evicted = map.remove(scan_idx);
			engine_log!(
				"LRU evicted {} (cap={ENGINES_CAP}, len was {})",
				evicted.repo.display(),
				map.len() + 1,
			);
		} else {
			scan_idx += 1;
		}
	}
	Ok(h)
}

/// Production query entry point.
pub fn query(repo_root: &Path, query_args: RecallQuery) -> Result<Vec<RecallHit>, String> {
	let handle = get_or_create(repo_root, None)?;
	handle.query(query_args)
}

/// Open the repo handle on the embedding daemon if reachable, returning
/// the JSON open response (`{ repo_handle, warm, status, lanes, ... }`).
/// Non-blocking on the daemon side since PLAN-316: a cold repo returns
/// immediately with `status: "warming"`.
///
/// Returns `Ok(None)` when the daemon doesn't speak the knowledge
/// protocol; callers treat that as "feature unavailable, skip silently".
pub fn warm(repo_root: &Path) -> Result<Option<serde_json::Value>, String> {
	// Use the *non-init* probe: a startup `warm` call must never pay the
	// 5–30 s bge-m3 model-load cost just to discover whether the daemon
	// speaks the knowledge protocol. If init hasn't happened yet, return
	// `None` so callers treat the feature as unavailable.
	if !matches!(embedding_worker::try_knowledge_capable(), Some(true)) {
		return Ok(None);
	}
	let handle = get_or_create(repo_root, None)?;
	handle.warm_via_rpc().map(Some)
}

/// Read the current warm-load progress for a repo. The result is the
/// `org_lane` block of the daemon `stats` response: `{status, progress?,
/// error?}` where `progress = {phase, done, total, started_ms}`.
///
/// Returns `Ok(None)` when the daemon is unreachable or the protocol
/// doesn't speak knowledge — callers should treat that as "warm" so the
/// UI doesn't latch on a stale spinner.
pub fn progress(repo_root: &Path) -> Result<Option<serde_json::Value>, String> {
	// Non-init probe — same rationale as `warm`. Surfacing progress in
	// the TUI must never block startup on a model load.
	if !matches!(embedding_worker::try_knowledge_capable(), Some(true)) {
		return Ok(None);
	}
	let handle = get_or_create(repo_root, None)?;
	handle.progress_via_rpc().map(Some)
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
	repo_root:  PathBuf,
	cache_dir:  PathBuf,
	state:      Mutex<EngineState>,
	/// PLAN-315 W2: daemon-side repo handle cached after first `open`.
	rpc_handle: Mutex<Option<String>>,
}

enum EngineState {
	Cold,
	Warm(Box<WarmEngine>),
}

struct WarmEngine {
	fingerprint: WorkspaceFingerprint,
	items:       Vec<OrgItem>,
	docs:        Vec<RecallDoc>,
	bm25:        SearchIndex,
	vec:         VectorIndex,
	graph:       TypedGraph,
}

/// On-disk cache entry. Uses `PersistedOrgItem` (not `OrgItem`) because
/// `OrgItem`'s serde derive marks several fields with `skip_serializing_if`
/// — fatal for bincode (positional, non-self-describing).
#[derive(Serialize, Deserialize)]
struct EngineCacheEntry {
	fingerprint: WorkspaceFingerprint,
	items:       Vec<PersistedOrgItem>,
}

impl RecallEngineHandle {
	fn new(repo_root: PathBuf, cache_dir: PathBuf) -> Self {
		Self {
			repo_root,
			cache_dir,
			state: Mutex::new(EngineState::Cold),
			rpc_handle: Mutex::new(None),
		}
	}

	/// Serve a recall query. Rebuilds the warm engine on first call or when
	/// the workspace fingerprint has changed; otherwise serves from cache.
	///
	/// If the embedder worker was unavailable at index-build time, the vector
	/// lane is *operationally disabled* for this query by forcing its weight
	/// to 0 — BM25 and the graph lane still serve recall. This preserves the
	/// W5 "silently disabled" contract while keeping the underlying
	/// `pi_knowledge_core::recall` strict about error propagation (W5.5 F1).
 pub fn query(&self, query_args: RecallQuery) -> Result<Vec<RecallHit>, String> {
 		use embedding_worker::WorkerMode;

 		// PLAN-315 W5: explicit PI_KNOWLEDGE_WORKER mode dispatch.
 		// - Daemon (default): route over the socket; fail-loud on any RPC
 		//   error — no silent fallback to in-process WarmEngine.
 		// - Inprocess: skip RPC entirely; use in-process WarmEngine directly
 		//   (preserves test/offline/CI behaviour).
 		match embedding_worker::worker_mode() {
 			WorkerMode::Daemon => {
 				if !embedding_worker::knowledge_capable() {
 					return Err(
 						"recall via daemon not available: daemon does not support protocol v2, \
 						  or no daemon is reachable \
 						  (set PI_KNOWLEDGE_WORKER=inprocess for offline)".to_string(),
 					);
 				}
 				return self.query_via_rpc(&query_args).map_err(|e| {
 					format!(
 						"recall via daemon failed (set PI_KNOWLEDGE_WORKER=inprocess for offline): {e}",
 					)
 				});
 			},
 			WorkerMode::Inprocess => {
 				// Skip RPC entirely — use in-process WarmEngine.
 			},
 		}

 		let mut state = self.state.lock();
		self.ensure_warm(&mut state)?;
		let warm = match state.as_ref() {
			Some(w) => w,
			None => return Err("recall engine: warm state unavailable".into()),
		};
		let embedder = WorkerEmbedderAdapter;
		// Disable vector lane when no vectors were upserted (worker was down
		// at build time). Without this, recall() would propagate the worker
		// error and BM25 hits would never reach the caller.
		let effective_query = if warm.vec.is_empty() {
			let mut w = query_args.weights.clone().unwrap_or_default();
			w.vector = 0.0;
			RecallQuery { weights: Some(w), ..query_args }
		} else {
			query_args
		};
		let ctx = RecallContext {
			docs:     &warm.docs,
			bm25:     &warm.bm25,
			vec:      &warm.vec,
			embedder: &embedder,
			graph:    &warm.graph,
			profiles: profiles(),
		};
		recall(effective_query, &ctx).map_err(|e| format!("recall: {e}"))
	}

	/// PLAN-315 W2 RPC dispatch. Opens the repo handle on the daemon on
	/// first call (cached locally), then forwards `search`. Errors propagate
	/// to the caller of `query`; caller falls through to in-process path.
	fn query_via_rpc(&self, query_args: &RecallQuery) -> Result<Vec<RecallHit>, String> {
		let handle = self.ensure_rpc_open()?;
		let args = serde_json::json!({
			"repo_handle": handle,
			// Splat the RecallQuery fields at the top level (matches the
			// daemon's `#[serde(flatten)] query: RecallQuery` shape).
			"text": query_args.text,
			"scope": query_args.scope,
			"focus": query_args.focus,
			"graph_hops": query_args.graph_hops,
			"graph_kinds": query_args.graph_kinds,
			"limit": query_args.limit,
			"weights": query_args.weights,
			"profile": query_args.profile,
		});
		let response = embedding_worker::knowledge_request("search", args)
			.map_err(|e| format!("rpc search: {e}"))?;
		if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
			let err = response
				.get("error")
				.and_then(serde_json::Value::as_str)
				.unwrap_or("unknown daemon error");
			return Err(format!("rpc search failed: {err}"));
		}
		let hits = response
			.get("hits")
			.cloned()
			.unwrap_or(serde_json::Value::Array(vec![]));
		serde_json::from_value::<Vec<RecallHit>>(hits)
			.map_err(|e| format!("rpc search hit deserialise: {e}"))
	}

	/// Open the daemon-side repo handle without performing any search.
	/// Returns the daemon's full open response so callers can read the
	/// `status` field (`warming|warm`). Cached after first call.
	fn warm_via_rpc(&self) -> Result<serde_json::Value, String> {
		self.open_rpc_response()
	}

	/// Read the current `org_lane` payload from the daemon `stats`
	/// response for this repo's handle. The lane state machine on the
	/// daemon side (PLAN-316) guarantees this read does not contend with
	/// the warm-load worker.
	fn progress_via_rpc(&self) -> Result<serde_json::Value, String> {
		let handle = self.ensure_rpc_open()?;
		let response =
			embedding_worker::knowledge_request("stats", serde_json::json!({ "repo_handle": handle }))
				.map_err(|e| format!("rpc stats: {e}"))?;
		if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
			let err = response
				.get("error")
				.and_then(serde_json::Value::as_str)
				.unwrap_or("unknown daemon error");
			return Err(format!("rpc stats failed: {err}"));
		}
		Ok(response
			.get("org_lane")
			.cloned()
			.unwrap_or_else(|| serde_json::json!({ "status": "warm" })))
	}

	/// Issue an `open` RPC and return the full response object. Caches
	/// the resulting `repo_handle` like `ensure_rpc_open` does.
	fn open_rpc_response(&self) -> Result<serde_json::Value, String> {
		let response = embedding_worker::knowledge_request(
			"open",
			serde_json::json!({
				"repo_root": self.repo_root,
				"lanes": ["org_memory"],
			}),
		)
		.map_err(|e| format!("rpc open: {e}"))?;
		if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
			let err = response
				.get("error")
				.and_then(serde_json::Value::as_str)
				.unwrap_or("unknown daemon error");
			return Err(format!("rpc open failed: {err}"));
		}
		if let Some(h) = response
			.get("repo_handle")
			.and_then(serde_json::Value::as_str)
		{
			*self.rpc_handle.lock() = Some(h.to_string());
		}
		Ok(response)
	}

	fn ensure_rpc_open(&self) -> Result<String, String> {
		let mut cached = self.rpc_handle.lock();
		if let Some(h) = cached.as_ref() {
			return Ok(h.clone());
		}
		let response = embedding_worker::knowledge_request(
			"open",
			serde_json::json!({
				"repo_root": self.repo_root,
				"lanes": ["org_memory"],
			}),
		)
		.map_err(|e| format!("rpc open: {e}"))?;
		if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
			let err = response
				.get("error")
				.and_then(serde_json::Value::as_str)
				.unwrap_or("unknown daemon error");
			return Err(format!("rpc open failed: {err}"));
		}
		let handle = response
			.get("repo_handle")
			.and_then(serde_json::Value::as_str)
			.ok_or_else(|| "rpc open response missing repo_handle".to_string())?
			.to_string();
		*cached = Some(handle.clone());
		Ok(handle)
	}

	fn ensure_warm(&self, state: &mut EngineState) -> Result<(), String> {
		let current = compute_fingerprint(&self.repo_root)?;
		if let EngineState::Warm(w) = state
			&& w.fingerprint == current
		{
			return Ok(());
		}
		engine_log!("cold or stale; rebuilding for {}", self.repo_root.display());
		*state = EngineState::Cold;
		let warm = self.build_warm(current)?;
		*state = EngineState::Warm(Box::new(warm));
		Ok(())
	}

	fn build_warm(&self, current_fp: WorkspaceFingerprint) -> Result<WarmEngine, String> {
		fs::create_dir_all(&self.cache_dir).map_err(|e| format!("mkdir cache: {e}"))?;
		if let Some(warm) = self.try_load_warm(&current_fp) {
			engine_log!("warm state restored from disk");
			return Ok(warm);
		}
		let warm = self.full_rebuild(current_fp)?;
		if let Err(e) = self.save_warm(&warm) {
			engine_log!("failed to persist warm state: {e}");
		}
		Ok(warm)
	}

	fn try_load_warm(&self, current_fp: &WorkspaceFingerprint) -> Option<WarmEngine> {
		let entry_path = self.cache_dir.join(ENGINE_CACHE_FILE);
		let bm25_path = self.cache_dir.join(BM25_CACHE_FILE);
		let vec_path = self.cache_dir.join(VEC_CACHE_FILE);
		if !entry_path.exists() || !bm25_path.exists() || !vec_path.exists() {
			return None;
		}
		// W5.5 F2: gate the disk fast-path on KnowledgeMeta. Schema bumps,
		// embedder swaps (model name or dim), and fingerprint divergence all
		// wipe the cache dir wholesale via `purge_if_stale`.
		let model = current_embedder_model();
		match purge_if_stale(&self.cache_dir, current_fp, &model, DIM) {
			Ok(true) => {},
			Ok(false) => {
				engine_log!("meta.bin missing or stale; will rebuild");
				return None;
			},
			Err(e) => {
				engine_log!("purge_if_stale failed ({e}); will rebuild");
				return None;
			},
		}
		let entry: EngineCacheEntry = match load_bincode(&entry_path) {
			Ok(e) => e,
			Err(e) => {
				engine_log!("engine.bin load failed ({e}); will rebuild");
				return None;
			},
		};
		if entry.fingerprint != *current_fp {
			engine_log!("disk cache stale; rebuilding");
			return None;
		}
		let bm25: SearchIndex = match load_bincode(&bm25_path) {
			Ok(v) => v,
			Err(e) => {
				engine_log!("bm25.bin load failed ({e}); will rebuild");
				return None;
			},
		};
		let vec = match VectorIndex::load(&vec_path) {
			Ok(v) => v,
			Err(e) => {
				engine_log!("vec.uidx load failed ({e}); will rebuild");
				return None;
			},
		};
		let unique_id_count = entry
			.items
			.iter()
			.map(|item| item.id.as_str())
			.collect::<std::collections::HashSet<_>>()
			.len();
		if bm25.doc_count() < unique_id_count {
			engine_log!(
				"bm25/items mismatch (bm25={}, unique_ids={unique_id_count}); will rebuild",
				bm25.doc_count(),
			);
			return None;
		}
		let items: Vec<OrgItem> = entry.items.into_iter().map(OrgItem::from).collect();
		let docs = project_docs(&items);
		let graph = build_typed_graph(&items);
		Some(WarmEngine { fingerprint: entry.fingerprint, items, docs, bm25, vec, graph })
	}

	fn full_rebuild(&self, fingerprint: WorkspaceFingerprint) -> Result<WarmEngine, String> {
		let items = scan_items(&self.repo_root);
		let docs = project_docs(&items);
		let bm25 = SearchIndex::from_docs(&docs);
		let vec = build_vec_index(&items)?;
		let graph = build_typed_graph(&items);
		Ok(WarmEngine { fingerprint, items, docs, bm25, vec, graph })
	}

	fn save_warm(&self, warm: &WarmEngine) -> Result<(), String> {
		let entry = EngineCacheEntry {
			fingerprint: warm.fingerprint.clone(),
			items:       warm
				.items
				.iter()
				.cloned()
				.map(PersistedOrgItem::from)
				.collect(),
		};
		save_bincode(&self.cache_dir.join(ENGINE_CACHE_FILE), &entry)
			.map_err(|e| format!("save engine.bin: {e}"))?;
		save_bincode(&self.cache_dir.join(BM25_CACHE_FILE), &warm.bm25)
			.map_err(|e| format!("save bm25.bin: {e}"))?;
		warm
			.vec
			.save(&self.cache_dir.join(VEC_CACHE_FILE))
			.map_err(|e| format!("save vec.uidx: {e}"))?;
		// W5.5 F2: persist KnowledgeMeta alongside the heavy blobs. Written
		// *last* so a crash leaves a half-built cache that fails the
		// `purge_if_stale` check on next load (rather than appearing Fresh
		// atop stale blobs).
		let mut meta = KnowledgeMeta::new(warm.fingerprint.clone());
		meta.embedder_model = current_embedder_model();
		meta.embedder_dim = DIM;
		save_bincode(&self.cache_dir.join(META_CACHE_FILE), &meta)
			.map_err(|e| format!("save meta.bin: {e}"))?;
		Ok(())
	}
}

impl EngineState {
	fn as_ref(&self) -> Option<&WarmEngine> {
		match self {
			Self::Warm(w) => Some(w.as_ref()),
			Self::Cold => None,
		}
	}
}

// ---------------------------------------------------------------------------
// Bincode atomic write helpers (tmp + rename).
// ---------------------------------------------------------------------------

fn save_bincode<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let tmp = path.with_extension("bin.tmp");
	{
		let file = fs::File::create(&tmp)?;
		let mut writer = BufWriter::new(file);
		bincode::serialize_into(&mut writer, value)
			.map_err(|e| std::io::Error::other(e.to_string()))?;
		writer
			.into_inner()
			.map_err(|e| std::io::Error::other(e.to_string()))?
			.sync_all()?;
	}
	fs::rename(&tmp, path)?;
	Ok(())
}

fn load_bincode<T: serde::de::DeserializeOwned>(path: &Path) -> std::io::Result<T> {
	let file = fs::File::open(path)?;
	let reader = BufReader::new(file);
	bincode::deserialize_from(reader).map_err(|e| std::io::Error::other(e.to_string()))
}

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

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
				&source,
				&[],
				"",
				"",
				&path_str,
				false,
			) else {
				continue;
			};
			items.extend(parsed);
		}
	}
	items
}

/// Project `[OrgItem]` into the domain-agnostic `[RecallDoc]` consumed by the
/// recall pipeline.
fn project_docs(items: &[OrgItem]) -> Vec<RecallDoc> {
	items
		.iter()
		.map(|item| RecallDoc {
			id:    item.id.clone(),
			kind:  item.properties.get("KIND").cloned().unwrap_or_default(),
			title: item.title.clone(),
			body:  item.body.clone(),
		})
		.collect()
}

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

fn build_vec_index(items: &[OrgItem]) -> Result<VectorIndex, String> {
	let mut vec = VectorIndex::new(DIM, items.len().max(1)).map_err(|e| format!("vec init: {e}"))?;
	if items.is_empty() {
		return Ok(vec);
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
				if let Err(e) =
					vec.upsert(VectorEntry { node_id: id_hash(&item.id), vector: v.clone() })
				{
					engine_log!("vec upsert for {} failed: {e}", item.id);
				}
			}
		},
		Err(e) => {
			engine_log!("embedder unavailable, vector lane disabled: {e}");
		},
	}
	Ok(vec)
}

// ---------------------------------------------------------------------------
// Fingerprinting (scoped to recall sources)
// ---------------------------------------------------------------------------

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

/// Bridges `pi_knowledge_core::recall::Embedder` to the in-process embedding
/// worker. The worker (`pi-knowledge-worker` subprocess / daemon) is shared
/// with `code_graph` and is spawned lazily.
struct WorkerEmbedderAdapter;

impl Embedder for WorkerEmbedderAdapter {
	fn embed_query(&self, text: &str) -> pi_knowledge_core::Result<Vec<f32>> {
		embedding_worker::embed_query(text)
			.map_err(|e| pi_knowledge_core::Error::Embedder(e.to_string()))
	}

	fn embed_batch(&self, texts: &[&str]) -> pi_knowledge_core::Result<Vec<Vec<f32>>> {
		embedding_worker::embed_batch(texts, None)
			.map_err(|e| pi_knowledge_core::Error::Embedder(e.to_string()))
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
		write_item(&repo.path().join("!tasks"), "README.md", "noise");
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

	

 /// RAII guard that sets `PI_EMBEDDING_WORKER` to a nonexistent path AND
 	/// `PI_KNOWLEDGE_WORKER=inprocess` so the WarmEngine path (not RPC) is
 	/// exercised in tests. Restores both env vars and resets cached mode on drop.
 	struct NoWorkerFixture {
 		_locked:       std::sync::RwLockWriteGuard<'static, ()>,
 		prior_worker:  Option<std::ffi::OsString>,
 		prior_mode:    Option<std::ffi::OsString>,
 	}

 	impl Drop for NoWorkerFixture {
 		fn drop(&mut self) {
 			// SAFETY: `_locked` is still held until `self` is fully dropped.
 			unsafe {
 				match &self.prior_worker {
 					Some(v) => std::env::set_var("PI_EMBEDDING_WORKER", v),
 					None => std::env::remove_var("PI_EMBEDDING_WORKER"),
 				}
 				match &self.prior_mode {
 					Some(v) => std::env::set_var("PI_KNOWLEDGE_WORKER", v),
 					None => std::env::remove_var("PI_KNOWLEDGE_WORKER"),
 				}
 			}
 			crate::embedding_worker::reset_worker_mode_for_tests();
 		}
 	}

 	/// Set the environment for a test that must NOT talk to a real worker process.
 	/// - Sets `PI_KNOWLEDGE_WORKER=inprocess` so `worker_mode()` returns
 	///   `Inprocess`, bypassing RPC dispatch (W5: fail-loud default).
 	/// - Sets `PI_EMBEDDING_WORKER` to a nonexistent path so `embed_batch()`
 	///   calls from the WarmEngine fail gracefully (vector lane disabled).
 	fn force_no_worker(test_name: &'static str) -> NoWorkerFixture {
 		let locked = crate::embedding_worker::lock_test_env();
 		let prior_worker = std::env::var_os("PI_EMBEDDING_WORKER");
 		let prior_mode = std::env::var_os("PI_KNOWLEDGE_WORKER");
 		// SAFETY: `locked` serialises env mutation across tests in this process.
 		unsafe {
 			std::env::set_var("PI_KNOWLEDGE_WORKER", "inprocess");
 			std::env::set_var(
 				"PI_EMBEDDING_WORKER",
 				&format!("/nonexistent/pi-knowledge-worker-{test_name}"),
 			);
 		}
 		crate::embedding_worker::reset_worker_mode_for_tests();
 		NoWorkerFixture { _locked: locked, prior_worker, prior_mode }
 	}

	fn q(text: &str) -> RecallQuery {
		RecallQuery { text: Some(text.into()), limit: 10, ..Default::default() }
	}

	#[test]
	fn cache_base_override_relocates_bm25_to_provided_dir() {
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
		let expected = repo_cache_dir_at(&canon, cache.path()).join(BM25_CACHE_FILE);
		assert!(expected.is_file(), "override bm25 file missing at {}", expected.display(),);
		forget(repo.path());
	}

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
		let engine_bin = repo_cache_dir_at(&canon, cache.path()).join(ENGINE_CACHE_FILE);

		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("E"))
			.unwrap();
		assert!(engine_bin.is_file(), "cold build must persist engine.bin");
		let mtime_cold = fs::metadata(&engine_bin).unwrap().modified().unwrap();

		forget(repo.path());
		std::thread::sleep(std::time::Duration::from_millis(50));

		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("E"))
			.unwrap();
		assert!(
			hits.iter().any(|h| h.id == "E-1"),
			"disk fast path should surface E-1; got {hits:?}"
		);
		let mtime_warm = fs::metadata(&engine_bin).unwrap().modified().unwrap();
		assert_eq!(
			mtime_cold, mtime_warm,
			"disk fast path triggered a rebuild (engine.bin mtime advanced)"
		);
		forget(repo.path());
	}

	#[test]
	fn warm_restore_rejected_when_bm25_is_wiped() {
		let _no_worker = force_no_worker("warm-restore-wipe");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"A.org",
			"* TODO A\n:PROPERTIES:\n:CUSTOM_ID: A-1\n:END:\n",
		);
		let cache = tempdir().unwrap();

		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("A"))
			.unwrap();
		forget(repo.path());

		let canon = canonical_root(repo.path());
		let bm25_path = repo_cache_dir_at(&canon, cache.path()).join(BM25_CACHE_FILE);
		assert!(bm25_path.is_file(), "precondition: bm25.bin must exist at {}", bm25_path.display(),);
		fs::remove_file(&bm25_path).unwrap();

		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("A"))
			.unwrap();
		assert!(
			hits.iter().any(|h| h.id == "A-1"),
			"after bm25 wipe, second query should rebuild and surface A-1; got {hits:?}"
		);
		forget(repo.path());
	}

	#[test]
	fn warm_restore_serves_unchanged_repo_without_rebuild() {
		let _no_worker = force_no_worker("warm-restore-happy");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"C.org",
			"* TODO C\n:PROPERTIES:\n:CUSTOM_ID: C-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		let canon = canonical_root(repo.path());
		let engine_bin = repo_cache_dir_at(&canon, cache.path()).join(ENGINE_CACHE_FILE);

		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("C"))
			.unwrap();
		let mtime1 = fs::metadata(&engine_bin).unwrap().modified().unwrap();
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
		let _no_worker = force_no_worker("stale-fingerprint");
		let repo = tempdir().unwrap();
		let tasks = repo.path().join("!tasks");
		write_item(&tasks, "D.org", "* TODO D first\n:PROPERTIES:\n:CUSTOM_ID: D-1\n:END:\n");
		let cache = tempdir().unwrap();
		let canon = canonical_root(repo.path());
		let engine_bin = repo_cache_dir_at(&canon, cache.path()).join(ENGINE_CACHE_FILE);

		let hits1 = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("first"))
			.unwrap();
		assert!(hits1.iter().any(|h| h.id == "D-1"));
		let mtime1 = fs::metadata(&engine_bin).unwrap().modified().unwrap();

		std::thread::sleep(std::time::Duration::from_millis(50));
		write_item(
			&tasks,
			"D.org",
			"* TODO D second uniqueazaza\n:PROPERTIES:\n:CUSTOM_ID: D-1\n:END:\n",
		);

		let hits2 = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("uniqueazaza"))
			.unwrap();
		assert!(
			hits2.iter().any(|h| h.id == "D-1"),
			"after edit, recall should surface new content; got {hits2:?}"
		);
		let mtime2 = fs::metadata(&engine_bin).unwrap().modified().unwrap();
		assert!(mtime2 > mtime1, "engine.bin mtime should advance after stale-fingerprint rebuild");
		forget(repo.path());
	}

	#[test]
	fn disk_fast_path_preserves_relations_drawer() {
		let _no_worker = force_no_worker("disk-relations");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"F.org",
			"* TODO F\n:PROPERTIES:\n:CUSTOM_ID: F-1\n:END:\n:RELATIONS:\nABOUT: G-1\nINVOLVED: \
			 H-1\n:END:\n* TODO G\n:PROPERTIES:\n:CUSTOM_ID: G-1\n:END:\n* TODO \
			 H\n:PROPERTIES:\n:CUSTOM_ID: H-1\n:END:\n",
		);
		let cache = tempdir().unwrap();

		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("F"))
			.unwrap();
		forget(repo.path());

		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(RecallQuery {
				text: None,
				focus: Some("F-1".into()),
				graph_hops: 1,
				limit: 10,
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

	fn engines_contains(repo: &Path) -> bool {
		let Some(slot) = ENGINES.get() else {
			return false;
		};
		let canon = canonical_root(repo);
		slot.lock().iter().any(|e| e.repo == canon)
	}

	#[test]
	fn idle_ttl_evicts_unused_engine_on_next_miss() {
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

		get_or_create(repo_a.path(), Some(cache.path()))
			.unwrap()
			.query(q("A"))
			.unwrap();
		assert!(engines_contains(repo_a.path()), "precondition: A cached");

		std::thread::sleep(Duration::from_millis(100));

		get_or_create(repo_b.path(), Some(cache.path()))
			.unwrap()
			.query(q("B"))
			.unwrap();

		assert!(!engines_contains(repo_a.path()), "A should have been TTL-evicted on B's miss");
		assert!(engines_contains(repo_b.path()), "B should be cached");

		forget(repo_a.path());
		forget(repo_b.path());
	}

	#[test]
	fn idle_ttl_skips_handles_held_by_inflight_queries() {
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

		let held_a = get_or_create(repo_a.path(), Some(cache.path())).unwrap();
		held_a.query(q("A")).unwrap();
		assert_eq!(Arc::strong_count(&held_a), 2, "precondition: held_a + ENGINES = 2 strong refs");

		std::thread::sleep(Duration::from_millis(100));

		let _hb = get_or_create(repo_b.path(), Some(cache.path())).unwrap();
		_hb.query(q("B")).unwrap();

		assert!(
			engines_contains(repo_a.path()),
			"A must survive TTL sweep while held outside ENGINES"
		);
		assert!(engines_contains(repo_b.path()), "B should be cached");

		drop(held_a);
		drop(_hb);
		forget(repo_a.path());
		forget(repo_b.path());
	}

	#[test]
	fn handle_falls_back_gracefully_when_worker_unavailable() {
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

	// --- W5.5 F2: cache invalidation via KnowledgeMeta ---------------------

	#[test]
	fn recall_engine_writes_meta_bin_on_save() {
		let _no_worker = force_no_worker("meta-bin-written");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"M.org",
			"* TODO M\n:PROPERTIES:\n:CUSTOM_ID: M-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("M"))
			.unwrap();
		let canon = canonical_root(repo.path());
		let meta_path = repo_cache_dir_at(&canon, cache.path()).join(META_CACHE_FILE);
		assert!(
			meta_path.is_file(),
			"meta.bin must be persisted by save_warm; expected at {}",
			meta_path.display(),
		);
		forget(repo.path());
	}

	#[test]
	fn recall_engine_invalidates_cache_on_schema_bump() {
		use pi_knowledge_core::cache::KnowledgeMeta;
		let _no_worker = force_no_worker("schema-bump");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"S.org",
			"* TODO S\n:PROPERTIES:\n:CUSTOM_ID: S-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("S"))
			.unwrap();
		let canon = canonical_root(repo.path());
		let dir = repo_cache_dir_at(&canon, cache.path());
		let meta_path = dir.join(META_CACHE_FILE);
		assert!(meta_path.is_file(), "precondition: meta.bin exists");

		// Rewrite meta.bin with a schema version that no longer matches
		// current code.
		let fp = compute_fingerprint(repo.path()).unwrap();
		let mut bad = KnowledgeMeta::new(fp);
		bad.schema_version = 0;
		bad.embedder_model = current_embedder_model();
		bad.embedder_dim = DIM;
		let bytes = bincode::serialize(&bad).unwrap();
		std::fs::write(&meta_path, bytes).unwrap();
		forget(repo.path());

		// Next query should observe the stale meta, wipe the cache dir, and
		// rebuild. The dir gets removed wholesale by purge_if_stale, so the
		// engine.bin path should disappear before the rebuild rewrites it.
		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("S"))
			.unwrap();
		assert!(
			hits.iter().any(|h| h.id == "S-1"),
			"after schema-bump invalidation, recall must still surface S-1; got {hits:?}",
		);
		assert!(meta_path.is_file(), "rebuild must re-persist meta.bin at {}", meta_path.display(),);
		// Verify the new meta has the current schema.
		let fresh: KnowledgeMeta = bincode::deserialize(&std::fs::read(&meta_path).unwrap()).unwrap();
		assert_eq!(
			fresh.schema_version,
			pi_knowledge_core::cache::KNOWLEDGE_SCHEMA_VERSION,
			"rewritten meta must carry current schema version",
		);
		forget(repo.path());
	}

	#[test]
	fn recall_engine_invalidates_cache_on_embedder_swap() {
		use pi_knowledge_core::cache::KnowledgeMeta;
		let _no_worker = force_no_worker("embedder-swap");
		let repo = tempdir().unwrap();
		write_item(
			&repo.path().join("!tasks"),
			"K.org",
			"* TODO K\n:PROPERTIES:\n:CUSTOM_ID: K-1\n:END:\n",
		);
		let cache = tempdir().unwrap();
		get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("K"))
			.unwrap();
		let canon = canonical_root(repo.path());
		let meta_path = repo_cache_dir_at(&canon, cache.path()).join(META_CACHE_FILE);

		// Forge meta with a different embedder model.
		let fp = compute_fingerprint(repo.path()).unwrap();
		let mut forged = KnowledgeMeta::new(fp);
		forged.embedder_model = "some-other-model".into();
		forged.embedder_dim = DIM;
		std::fs::write(&meta_path, bincode::serialize(&forged).unwrap()).unwrap();
		forget(repo.path());

		let hits = get_or_create(repo.path(), Some(cache.path()))
			.unwrap()
			.query(q("K"))
			.unwrap();
		assert!(
			hits.iter().any(|h| h.id == "K-1"),
			"embedder-swap meta must trigger rebuild + still surface K-1",
		);
		forget(repo.path());
	}

	// --- W5.5 F7: build_vec_index returns Result --------------------------

	#[test]
	fn build_vec_index_returns_err_not_panics_on_dim_zero() {
		// Smoke check: build_vec_index against the empty corpus must yield
		// `Ok(empty_index)` rather than panicking. Before W5.5 F7 the helper
		// panicked on any `VectorIndex::new` failure; the Result shape now
		// surfaces all init errors as `Err(String)` and the empty-corpus
		// fast-path returns a usable empty index without invoking the worker.
		let result = build_vec_index(&[]);
		assert!(result.is_ok(), "empty corpus must yield Ok, not panic; got {result:?}",);
		assert!(result.unwrap().is_empty());
	}

	#[test]
	fn build_vec_index_signature_propagates_err() {
		// Compile-time check that callers can `?` the Result. Without this,
		// a regression to the panicking shape would be silent at the type
		// level until something actually triggered the panic.
		fn _assert_sig(f: fn(&[OrgItem]) -> Result<VectorIndex, String>) {
			let _: fn(&[OrgItem]) -> Result<VectorIndex, String> = f;
		}
		_assert_sig(build_vec_index);
	}
}
