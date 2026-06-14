//! PLAN-315 W2 — daemon-side org/memory lane.
//!
//! Warm-load pipeline:
//! 1. Scan `!tasks/` and `.spell/memory/` under `repo_root`
//! 2. Parse each `.org` file via `pi_org_engine::extract_items_from_source`
//! 3. Build `RecallDoc`s, `SearchIndex<OrgItem>` (BM25), `VectorIndex` (usearch
//!    via DaemonEmbedder), `TypedGraph` (from RELATIONS drawer)
//! 4. Persist via `pi_knowledge_core::cache::save_all`
//!
//! Query path: hold a `pi_knowledge_core::recall::RecallContext` over the
//! warm state; route `Search`, `About`, `Neighbors`, `Since` commands here.

use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU8, AtomicUsize, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use pi_knowledge_core::{
	bm25::SearchIndex,
	graph::EdgeKind,
	recall::{
		Embedder, RecallContext, RecallDoc, RecallGraph, RecallHit, RecallProfileRegistry,
		RecallQuery, recall,
	},
	vec::{VectorEntry, VectorIndex},
};
use pi_org_engine::{
	OrgItem,
	graph::{TypedGraph, build_typed_graph},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
	embedder_adapter::DaemonEmbedder,
	org_cache::{OrgVecCache, carry_forward, plan_embeds},
};

const SCANNED_SUBDIRS: &[&str] = &["!tasks", ".spell/memory"];
const EMBEDDER_DIM: usize = 1024;
/// Embedder identity persisted in the org vec cache manifest. A change here
/// (model swap) invalidates every cached vector via `OrgVecManifest` check.
const EMBEDDER_MODEL: &str = "bge-m3";

/// Env var gating the embedding (vector) lane. Set to `0`/`false`/`off` by a
/// declarative autonomous domain (`knowledge { embeddings #false }`) to skip
/// the fastembed bge-m3 model load entirely: no model download, no RAM, no
/// embed stall. Recall self-degrades to BM25 + graph (the `search()`
/// `vec.is_empty()` path), so the lane stays fully servable — just lexical.
const EMBEDDINGS_ENV_VAR: &str = "PI_KNOWLEDGE_WORKER_EMBEDDINGS";

/// True when embeddings are explicitly disabled via env. Absent/unrecognized
/// → enabled (embeddings are the default; opt-out only).
pub fn embeddings_disabled() -> bool {
	matches!(
		std::env::var(EMBEDDINGS_ENV_VAR).ok().as_deref(),
		Some("0") | Some("false") | Some("off") | Some("FALSE") | Some("OFF")
	)
}

// ---------------------------------------------------------------------------
// Warm-load progress
// ---------------------------------------------------------------------------

/// Phase of an in-flight warm-load. Encoded as `AtomicU8` so callers can
/// snapshot progress without acquiring any heavy lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum WarmPhase {
	Cold  = 0,
	Scan  = 1,
	Embed = 2,
	Index = 3,
	Done  = 4,
}

impl WarmPhase {
	const fn from_u8(v: u8) -> Self {
		match v {
			1 => Self::Scan,
			2 => Self::Embed,
			3 => Self::Index,
			4 => Self::Done,
			_ => Self::Cold,
		}
	}

	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Cold => "cold",
			Self::Scan => "scan",
			Self::Embed => "embed",
			Self::Index => "index",
			Self::Done => "done",
		}
	}
}

/// Shared progress payload for a single warm-load run. The fields are
/// independent atomics so a `stats` call can read them without blocking
/// the worker thread building the lane.
#[derive(Debug)]
pub struct WarmProgress {
	phase:         AtomicU8,
	done:          AtomicUsize,
	total:         AtomicUsize,
	started_at_ms: u64,
}

impl WarmProgress {
	pub fn new() -> Self {
		Self {
			phase:         AtomicU8::new(WarmPhase::Cold as u8),
			done:          AtomicUsize::new(0),
			total:         AtomicUsize::new(0),
			started_at_ms: now_unix_ms(),
		}
	}

	pub fn phase(&self) -> WarmPhase {
		WarmPhase::from_u8(self.phase.load(Ordering::SeqCst))
	}

	pub fn done(&self) -> usize {
		self.done.load(Ordering::SeqCst)
	}

	pub fn total(&self) -> usize {
		self.total.load(Ordering::SeqCst)
	}

	pub const fn started_at_ms(&self) -> u64 {
		self.started_at_ms
	}

	/// Compact JSON snapshot suitable for the `stats` daemon response.
	pub fn snapshot(&self) -> Value {
		json!({
			"phase":      self.phase().as_str(),
			"done":       self.done(),
			"total":      self.total(),
			"started_ms": self.started_at_ms,
		})
	}

	fn enter(&self, phase: WarmPhase, total: usize) {
		self.total.store(total, Ordering::SeqCst);
		self.done.store(0, Ordering::SeqCst);
		self.phase.store(phase as u8, Ordering::SeqCst);
	}

	fn bump_done(&self) {
		self.done.fetch_add(1, Ordering::SeqCst);
	}
}

impl Default for WarmProgress {
	fn default() -> Self {
		Self::new()
	}
}

fn now_unix_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| d.as_millis() as u64)
}

/// Warm state for the org/memory lane of one repo.
pub struct OrgLane {
	pub repo_root:  PathBuf,
	pub items:      Vec<OrgItem>,
	pub docs:       Vec<RecallDoc>,
	pub bm25:       SearchIndex,
	pub vec:        VectorIndex,
	pub graph:      TypedGraph,
	pub profiles:   RecallProfileRegistry,
	pub last_built: SystemTime,
}

impl OrgLane {
	/// Convenience wrapper: warm-load with the global `DaemonEmbedder` and
	/// a throwaway progress counter. Used by callers that don't surface
	/// progress to the UI (legacy / test convenience).
	pub fn warm_load(repo_root: &Path) -> Result<Self, String> {
		let progress = WarmProgress::new();
		Self::warm_load_with(repo_root, &progress, &DaemonEmbedder, |_| {})
	}

	/// Warm-load the org-memory lane, publishing phase + per-item
	/// progress to `progress` and routing embeddings through `embedder`.
	/// The embedder is dyn-dispatched so daemon code can pass
	/// `DaemonEmbedder` while tests pass a deterministic stub.
	///
	/// BM25-first ordering: the lexical corpus (scan → BM25 → graph) is
	/// built **before** embedding, since BM25 + graph need no model. The
	/// `on_partial` callback fires with a fully servable lexical-only lane
	/// (empty vector index) the moment that corpus is ready, so the daemon
	/// can answer searches with BM25 + graph hits while the 5–30 s bge-m3
	/// embed phase runs in the background. `search()` self-degrades when
	/// `vec.is_empty()`, so the partial lane never triggers a model load.
	pub fn warm_load_with(
		repo_root: &Path,
		progress: &WarmProgress,
		embedder: &dyn Embedder,
		on_partial: impl FnOnce(OrgLane),
	) -> Result<Self, String> {
		// Phase 1 — scan.
		progress.enter(WarmPhase::Scan, 0);
		let items = scan_items(repo_root);
		progress.total.store(items.len(), Ordering::SeqCst);
		progress.done.store(items.len(), Ordering::SeqCst);

		let docs = project_docs(&items);

		// Phase 2 — index (BM25 + graph). Cheap (sub-second), no model.
		progress.enter(WarmPhase::Index, items.len());
		progress.done.store(items.len(), Ordering::SeqCst);
		let bm25 = SearchIndex::from_docs(&docs);

		// Publish a servable lexical-only lane (empty vec) before embedding.
		// `TypedGraph` isn't `Clone` (graph-backed inner store), so the
		// partial gets its own deterministic rebuild — cheap, in-memory, no
		// IO. One bounded corpus clone (items/docs/bm25) buys lane
		// immutability + concurrent lexical serving during the slow embed.
		let empty_vec = VectorIndex::new(EMBEDDER_DIM, items.len().max(1))
			.map_err(|e| format!("vec init: {e}"))?;
		on_partial(Self {
			repo_root: repo_root.to_path_buf(),
			items: items.clone(),
			docs: docs.clone(),
			bm25: bm25.clone(),
			vec: empty_vec,
			graph: build_typed_graph(&items),
			profiles: RecallProfileRegistry::default(),
			last_built: SystemTime::now(),
		});

		let graph = build_typed_graph(&items);

		// Phase 3 — embed (the expensive, model-bound phase). Skipped entirely
		// when embeddings are disabled (autonomous/container profile): the lane
		// keeps an empty vector index and `search()` degrades to BM25 + graph,
		// avoiding the bge-m3 model load (download + RAM) altogether.
		//
		// BUG-474/476: cache-aware + chunked. `build_vec_index_with` loads the
		// prior persisted index, re-embeds only changed/new items in bounded
		// chunks (bumping `progress.done` per chunk so the marker actually
		// climbs), carries unchanged vectors forward, prunes vanished ids, and
		// persists the result for the next warm.
		progress.enter(WarmPhase::Embed, items.len());
		let vec = if embeddings_disabled() {
			progress.done.store(items.len(), Ordering::SeqCst);
			VectorIndex::new(EMBEDDER_DIM, items.len().max(1)).map_err(|e| format!("vec init: {e}"))?
		} else {
			build_vec_index_with(repo_root, &items, embedder, progress)?
		};

		// Phase 4 — done.
		progress.enter(WarmPhase::Done, items.len());
		progress.done.store(items.len(), Ordering::SeqCst);

		Ok(Self {
			repo_root: repo_root.to_path_buf(),
			items,
			docs,
			bm25,
			vec,
			graph,
			profiles: RecallProfileRegistry::default(),
			last_built: SystemTime::now(),
		})
	}

	pub fn search(&self, query: RecallQuery) -> Result<Vec<RecallHit>, String> {
		let embedder = DaemonEmbedder;
		// BM25-first / partial-warm safety: when no vectors are present
		// (lexical-only partial lane, or a worker-down build) disable the
		// vector lane so BM25 + graph hits still surface instead of paying
		// the embedder model-load stall or propagating an embed error.
		// Mirrors `pi_natives::recall_engine` vec.is_empty() degradation.
		let query = if self.vec.is_empty() {
			let mut weights = query.weights.clone().unwrap_or_default();
			weights.vector = 0.0;
			RecallQuery { weights: Some(weights), ..query }
		} else {
			query
		};
		let ctx = RecallContext {
			docs:     &self.docs,
			bm25:     &self.bm25,
			vec:      &self.vec,
			embedder: &embedder,
			graph:    &self.graph,
			profiles: &self.profiles,
		};
		recall(query, &ctx).map_err(|e| format!("recall: {e}"))
	}

	/// `about(id)` — return node + 1-hop neighbors + distillation lineage.
	pub fn about(&self, id: &str) -> Result<Value, String> {
		let Some(item) = self.items.iter().find(|it| it.id == id) else {
			return Err(format!("unknown id: {id}"));
		};
		let node = json!({
			"id": item.id,
			"title": item.title,
			"kind": item.properties.get("KIND").cloned().unwrap_or_default(),
			"body": item.body,
			"file": item.file,
		});
		let neighbors_raw = self.graph.neighbors(id);
		let mut neighbors_out: Vec<Value> = Vec::with_capacity(neighbors_raw.len());
		for (nb_id, edge) in &neighbors_raw {
			let nb_item = self.items.iter().find(|it| &it.id == nb_id);
			neighbors_out.push(json!({
				"id": nb_id,
				"title": nb_item.map(|it| it.title.clone()).unwrap_or_default(),
				"kind": nb_item
					.and_then(|it| it.properties.get("KIND"))
					.cloned()
					.unwrap_or_default(),
				"via": {
					"kind": format!("{edge:?}"),
					"direction": "out",
				},
			}));
		}
		let lineage: Vec<Value> = neighbors_raw
			.iter()
			.filter(|(_, k)| matches!(k, EdgeKind::DistilledFrom))
			.filter_map(|(id, _)| self.items.iter().find(|it| &it.id == id))
			.map(|it| json!({"id": it.id, "title": it.title}))
			.collect();
		Ok(json!({
			"node": node,
			"neighbors": neighbors_out,
			"lineage": lineage,
		}))
	}

	/// `neighbors(focus, hops, kinds)` — BFS expansion. `hops=0` returns just
	/// the focus.
	pub fn neighbors(&self, focus: &str, hops: u8, kinds: &[String]) -> Result<Value, String> {
		// EdgeKind::parse never fails (unknown tokens become EdgeKind::Other),
		// so we collect *known* kinds only; empty filter == accept-all.
		let kind_filter: Vec<EdgeKind> = kinds
			.iter()
			.map(|s| EdgeKind::parse(s))
			.filter(EdgeKind::is_known)
			.collect();
		let mut visited: Vec<String> = vec![focus.to_string()];
		let mut frontier: Vec<String> = vec![focus.to_string()];
		let mut edges: Vec<Value> = Vec::new();
		for _ in 0..hops {
			let mut next: Vec<String> = Vec::new();
			for node in &frontier {
				for (nb_id, edge) in self.graph.neighbors(node) {
					if !kind_filter.is_empty() && !kind_filter.contains(&edge) {
						continue;
					}
					edges.push(json!({
						"from": node,
						"to": nb_id,
						"kind": format!("{edge:?}"),
					}));
					if !visited.contains(&nb_id) {
						visited.push(nb_id.clone());
						next.push(nb_id);
					}
				}
			}
			frontier = next;
			if frontier.is_empty() {
				break;
			}
		}
		let nodes: Vec<Value> = visited
			.iter()
			.map(|id| {
				let it = self.items.iter().find(|x| &x.id == id);
				json!({
					"id": id,
					"title": it.map(|i| i.title.clone()).unwrap_or_default(),
					"kind": it
						.and_then(|i| i.properties.get("KIND"))
						.cloned()
						.unwrap_or_default(),
				})
			})
			.collect();
		Ok(json!({ "nodes": nodes, "edges": edges }))
	}

	/// `since(ts)` — items modified after a timestamp (ms epoch or ISO-8601).
	pub fn since(&self, ts: &SinceTimestamp) -> Result<Value, String> {
		let cutoff_ms = ts.to_epoch_ms()?;
		let mut items: Vec<Value> = Vec::new();
		for item in &self.items {
			let path = Path::new(&item.file);
			let Ok(meta) = fs::metadata(path) else {
				continue;
			};
			let modified_ms = meta
				.modified()
				.ok()
				.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
				.map(|d| d.as_millis() as u64)
				.unwrap_or(0);
			if modified_ms >= cutoff_ms {
				items.push(json!({
					"id": item.id,
					"title": item.title,
					"file": item.file,
					"modified_ms": modified_ms,
				}));
			}
		}
		items.sort_by(|a, b| {
			b["modified_ms"]
				.as_u64()
				.unwrap_or(0)
				.cmp(&a["modified_ms"].as_u64().unwrap_or(0))
		});
		Ok(json!({ "items": items, "cutoff_ms": cutoff_ms }))
	}
}

/// Accepts either an ISO-8601 string or an epoch-ms number.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum SinceTimestamp {
	Epoch(u64),
	Iso(String),
}

impl SinceTimestamp {
	fn to_epoch_ms(&self) -> Result<u64, String> {
		match self {
			Self::Epoch(ms) => Ok(*ms),
			Self::Iso(iso) => {
				// Lightweight ISO-8601 parser: accept "YYYY-MM-DDTHH:MM:SSZ"
				// or "YYYY-MM-DDTHH:MM:SS.sssZ". Defer to chrono if available;
				// fall back to naive parsing otherwise.
				parse_iso8601_to_ms(iso)
			},
		}
	}
}

/// Parse "YYYY-MM-DDTHH:MM:SS[.fff][Z]" → epoch ms. No timezone offsets;
/// assumes UTC. For PLAN-315 W2 this covers the memory-loop and TUI cases.
fn parse_iso8601_to_ms(s: &str) -> Result<u64, String> {
	let s = s.trim_end_matches('Z');
	let parts: Vec<&str> = s.split('T').collect();
	if parts.len() != 2 {
		return Err(format!("invalid ISO-8601 (no T separator): {s}"));
	}
	let date_parts: Vec<&str> = parts[0].split('-').collect();
	let time_parts: Vec<&str> = parts[1].split([':', '.']).collect();
	if date_parts.len() != 3 || time_parts.len() < 3 {
		return Err(format!("invalid ISO-8601 components: {s}"));
	}
	let year: i64 = date_parts[0].parse().map_err(|e| format!("year: {e}"))?;
	let month: u32 = date_parts[1].parse().map_err(|e| format!("month: {e}"))?;
	let day: u32 = date_parts[2].parse().map_err(|e| format!("day: {e}"))?;
	let hour: u32 = time_parts[0].parse().map_err(|e| format!("hour: {e}"))?;
	let minute: u32 = time_parts[1].parse().map_err(|e| format!("minute: {e}"))?;
	let second: u32 = time_parts[2].parse().map_err(|e| format!("second: {e}"))?;
	let millis: u32 = time_parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

	// Days from epoch: simple Zeller/Howard math; year>=1970 only.
	if year < 1970 {
		return Err(format!("ISO-8601 year < 1970 unsupported: {s}"));
	}
	let mut days: i64 = 0;
	for y in 1970..year {
		days += if is_leap(y) { 366 } else { 365 };
	}
	let dim = [31, if is_leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	for m in 1..month {
		days += dim[(m - 1) as usize];
	}
	days += i64::from(day - 1);
	let secs = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second);
	Ok((secs as u64) * 1_000 + u64::from(millis))
}

fn is_leap(year: i64) -> bool {
	(year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn scan_items(repo_root: &Path) -> Vec<OrgItem> {
	let mut items = Vec::new();
	for subdir in SCANNED_SUBDIRS {
		let dir = repo_root.join(subdir);
		if !dir.is_dir() {
			continue;
		}
		for file in walk_org_files(&dir) {
			let path_str = file.to_string_lossy();
			let Ok(source) = fs::read_to_string(&file) else {
				continue;
			};
			let Ok(parsed) =
				pi_org_engine::extract_items_from_source(&source, &[], "", "", &path_str, false)
			else {
				continue;
			};
			items.extend(parsed);
		}
	}
	items
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

/// Default embed chunk size. Bounded so `progress.done` advances smoothly and
/// the engine lock is released between chunks (BUG-476/478). Override via
/// `KNOWLEDGE_EMBED_CHUNK`.
const DEFAULT_EMBED_CHUNK: usize = 256;

fn embed_chunk_size() -> usize {
	std::env::var("KNOWLEDGE_EMBED_CHUNK")
		.ok()
		.and_then(|v| v.parse().ok())
		.filter(|n| *n > 0)
		.unwrap_or(DEFAULT_EMBED_CHUNK)
}

/// Build (or incrementally refresh) the vector index for `items`.
///
/// BUG-474 (cache) + BUG-476 (chunking):
/// 1. Load the prior persisted index + manifest for `repo_root`.
/// 2. Partition items into reuse (unchanged content hash) vs embed (new/changed).
/// 3. Carry reused vectors forward; embed the rest in bounded chunks, bumping
///    `progress.done` per chunk so the warm marker climbs in real time.
/// 4. Persist the refreshed index + manifest for the next warm.
///
/// Vanished ids are pruned implicitly: the new index only contains keys for
/// the current `items`.
fn build_vec_index_with(
	repo_root: &Path,
	items: &[OrgItem],
	embedder: &dyn Embedder,
	progress: &WarmProgress,
) -> Result<VectorIndex, String> {
	let mut vec =
		VectorIndex::new(EMBEDDER_DIM, items.len().max(1)).map_err(|e| format!("vec init: {e}"))?;
	if items.is_empty() {
		return Ok(vec);
	}

	let cache = OrgVecCache::for_repo(repo_root, EMBEDDER_MODEL, EMBEDDER_DIM);
	let prior = cache.as_ref().and_then(OrgVecCache::load);
	let plan = plan_embeds(items, prior.as_ref());

	// Carry forward unchanged vectors from the prior index.
	let mut live: BTreeMap<u64, u64> = BTreeMap::new();
	if let Some(loaded) = prior.as_ref() {
		for (key, item) in &plan.reuse {
			if let Err(e) = carry_forward(&mut vec, &loaded.index, *key) {
				eprintln!("carry-forward {}: {e}", item.id);
			}
			if let Some(hash) = loaded.manifest.entries.get(key) {
				live.insert(*key, *hash);
			}
		}
	}
	// Reused items are already accounted for in the progress total.
	for _ in 0..plan.reuse.len() {
		progress.bump_done();
	}

	// Embed the changed/new items in bounded chunks.
	let chunk_size = embed_chunk_size();
	let mut embed_failed = false;
	for chunk in plan.embed.chunks(chunk_size) {
		let refs: Vec<&str> = chunk.iter().map(|(_, _, text, _)| text.as_str()).collect();
		match embedder.embed_batch(&refs) {
			Ok(vectors) => {
				for ((key, item, _text, hash), v) in chunk.iter().zip(vectors.iter()) {
					if let Err(e) = vec.upsert(VectorEntry { node_id: *key, vector: v.clone() }) {
						eprintln!("vec upsert for {}: {e}", item.id);
					} else {
						live.insert(*key, *hash);
					}
					progress.bump_done();
				}
			},
			Err(e) => {
				// Embedder unavailable mid-build: stop embedding, keep whatever
				// (reused + earlier-chunk) vectors we have. search() degrades to
				// BM25 for the unembedded remainder.
				eprintln!("daemon embedder unavailable; partial vector lane: {e}");
				embed_failed = true;
				progress.done.store(items.len(), Ordering::SeqCst);
				break;
			},
		}
	}

	// Persist only a complete, embedder-healthy build so a transient embed
	// failure never poisons the cache with a half-corpus index.
	if !embed_failed
		&& let Some(cache) = cache.as_ref()
		&& let Err(e) = cache.save(&vec, &live)
	{
		eprintln!("org vec cache save: {e}");
	}
	Ok(vec)
}


#[cfg(test)]
mod tests {
	use std::sync::{Mutex, MutexGuard, PoisonError};

	use tempfile::TempDir;

	use super::*;

	// Tests run sequentially because they share static state in the embedder.
	static LANE_TEST_LOCK: Mutex<()> = Mutex::new(());

	fn lane_lock() -> MutexGuard<'static, ()> {
		LANE_TEST_LOCK
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
	}

	fn seed_corpus(root: &Path) {
		let memory = root.join(".spell/memory/concepts");
		fs::create_dir_all(&memory).expect("mk concepts");
		fs::write(
			memory.join("alpha.org"),
			"* CON-alpha\n:PROPERTIES:\n:CUSTOM_ID: CON-alpha\n:KIND: concept\n:END:\n\nalpha body",
		)
		.expect("write alpha");
		fs::write(
			memory.join("beta.org"),
			"* CON-beta\n:PROPERTIES:\n:CUSTOM_ID: CON-beta\n:KIND: concept\n:END:\n\nbeta body",
		)
		.expect("write beta");
	}

	#[test]
	fn warm_load_picks_up_corpus_items() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		seed_corpus(tmp.path());
		let lane = OrgLane::warm_load(tmp.path()).expect("warm");
		assert!(lane.items.len() >= 2, "expected >=2 items, got {}", lane.items.len());
		assert!(lane.docs.len() == lane.items.len());
		assert!(lane.items.iter().any(|i| i.id == "CON-alpha"));
	}

	#[test]
	fn embeddings_disabled_skips_vector_lane() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		seed_corpus(tmp.path());
		// SAFETY: lane_lock serialises env mutation across lane tests.
		unsafe { std::env::set_var(EMBEDDINGS_ENV_VAR, "0") };
		let lane = OrgLane::warm_load(tmp.path()).expect("warm");
		unsafe { std::env::remove_var(EMBEDDINGS_ENV_VAR) };
		// Items + lexical corpus present, but the vector lane is empty: the
		// embed phase was skipped (no model load). search() degrades to BM25.
		assert!(lane.items.len() >= 2, "corpus still scanned");
		assert!(lane.vec.is_empty(), "vector lane must be empty when embeddings disabled");
	}

	#[test]
	fn embeddings_disabled_recognizes_falsey_values() {
		let _g = lane_lock();
		for (val, want) in [("0", true), ("false", true), ("off", true), ("1", false), ("", false)] {
			// SAFETY: lane_lock serialises env mutation.
			unsafe { std::env::set_var(EMBEDDINGS_ENV_VAR, val) };
			assert_eq!(embeddings_disabled(), want, "value {val:?}");
		}
		unsafe { std::env::remove_var(EMBEDDINGS_ENV_VAR) };
	}

	#[test]
	fn warm_load_empty_repo_returns_empty_lane() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		let lane = OrgLane::warm_load(tmp.path()).expect("warm empty");
		assert_eq!(lane.items.len(), 0);
		assert_eq!(lane.docs.len(), 0);
	}

	#[test]
	fn about_returns_node_and_neighbors() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		seed_corpus(tmp.path());
		let lane = OrgLane::warm_load(tmp.path()).expect("warm");
		let result = lane.about("CON-alpha").expect("about");
		assert_eq!(result["node"]["id"], "CON-alpha");
		assert!(result["neighbors"].is_array());
		assert!(result["lineage"].is_array());
	}

	#[test]
	fn about_unknown_id_errors() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		seed_corpus(tmp.path());
		let lane = OrgLane::warm_load(tmp.path()).expect("warm");
		let err = lane.about("CON-nope").err().expect("expected err");
		assert!(err.contains("unknown id"));
	}

	#[test]
	fn neighbors_with_hops_zero_returns_only_focus() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		seed_corpus(tmp.path());
		let lane = OrgLane::warm_load(tmp.path()).expect("warm");
		let result = lane.neighbors("CON-alpha", 0, &[]).expect("neighbors");
		let nodes = result["nodes"].as_array().expect("nodes");
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0]["id"], "CON-alpha");
		assert_eq!(result["edges"].as_array().unwrap().len(), 0);
	}

	#[test]
	fn since_returns_items_with_metadata() {
		let _g = lane_lock();
		let tmp = TempDir::new().expect("tmp");
		seed_corpus(tmp.path());
		let lane = OrgLane::warm_load(tmp.path()).expect("warm");
		// Cutoff at epoch 0 → all items.
		let result = lane.since(&SinceTimestamp::Epoch(0)).expect("since");
		let items = result["items"].as_array().expect("items");
		assert!(!items.is_empty());
	}

	#[test]
	fn iso8601_parses_zulu_timestamp() {
		// 2026-05-22T00:00:00Z = 1779408000 (verified via python3 datetime)
		let ms = parse_iso8601_to_ms("2026-05-22T00:00:00Z").expect("parse");
		assert_eq!(ms, 1_779_408_000_000);
	}

	#[test]
	fn iso8601_parses_with_milliseconds() {
		let ms = parse_iso8601_to_ms("2026-05-22T00:00:00.123Z").expect("parse");
		assert_eq!(ms, 1_779_408_000_123);
	}

	#[test]
	fn iso8601_handles_leap_year_boundary() {
		// 2024 is leap (366 days); Mar 1 2024 = epoch 1709251200.
		let ms = parse_iso8601_to_ms("2024-03-01T00:00:00Z").expect("parse");
		assert_eq!(ms, 1_709_251_200_000);
	}

	#[test]
	fn iso8601_rejects_pre_epoch_year() {
		assert!(parse_iso8601_to_ms("1969-12-31T23:59:59Z").is_err());
	}
}
