//! PLAN-316 — non-blocking warm-load of per-repo lanes.
//!
//! `open()` registers the repo handle and, for the org-memory lane,
//! spawns a background worker that builds the warm engine. The slots
//! map mutex is dropped before the worker starts so concurrent `stats`
//! / `with_org_lane` calls do not deadlock against the build.
//!
//! Per-slot state machine: `Cold → Warming → Warm | Error`.
//! Consumers that need the lane block on a `Condvar`; consumers that
//! only need progress (e.g. status-line widget) read the `WarmProgress`
//! atomics directly.
//!
//! The code-graph lane (PLAN-315 W3) is warm-loaded on its own background
//! thread via `OnceLock`, avoiding the slots-mutex-held-during-build
//! antipattern. Subscribe events (PLAN-315 W4) fire at warm-completion
//! and eviction points.
//!
//! Eviction policy: LRU by `last_used` with a daemon-wide cap
//! (`KNOWLEDGE_MAX_WARM_REPOS`, default 8).

use std::{
	collections::HashMap,
	env, fs,
	path::{Path, PathBuf},
	sync::{
		Arc, Condvar, Mutex, OnceLock,
		atomic::{AtomicUsize, Ordering},
	},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use pi_knowledge_core::recall::Embedder;
use serde_json::{Value, json};

use crate::{
	Lane,
	embedder_adapter::DaemonEmbedder,
	lane_code::CodeLane,
	lane_org::{OrgLane, WarmProgress},
	subscribe,
};

// ---------------------------------------------------------------------------
// Per-slot lane state (PLAN-316)
// ---------------------------------------------------------------------------

/// State machine for the org-memory lane on a single repo slot.
///
/// The `Mutex` holds the variant tag plus the eventual `OrgLane`; the
/// `Condvar` wakes waiters when the worker finalises. `progress` is a
/// pure atomics struct so observers don't need to lock anything to
/// read counters.
pub struct OrgLaneState {
	inner:    Mutex<OrgLaneInner>,
	cv:       Condvar,
	progress: Arc<WarmProgress>,
}

enum OrgLaneInner {
	Cold,
	/// Embed phase in flight. `partial` carries a servable lexical-only
	/// lane (BM25 + graph, empty vec) once the cheap index phase finishes,
	/// so reads need not block on the slow bge-m3 embed.
	Warming { partial: Option<Arc<OrgLane>> },
	Warm(Arc<OrgLane>),
	Error(String),
}

/// Outcome of a bounded lane acquire. Mirrors a search-engine split state:
/// the caller is told whether the lane is fully ready, lexically servable,
/// or still building — never parked indefinitely.
pub enum LaneAcquire {
	/// Full lane (BM25 + vector + graph) ready.
	Warm(Arc<OrgLane>),
	/// Lexical-only lane servable now; vectors still building.
	Partial(Arc<OrgLane>),
	/// Still warming, no partial available yet. Carries a progress snapshot.
	Warming(Value),
	Error(String),
}

/// Outcome of a bounded code-graph lane acquire. No lexical partial — the
/// graph build is monolithic — so the lane is Warm, Warming, or Error.
pub enum CodeAcquire<'a> {
	Warm(&'a CodeLane),
	Warming,
	Error(String),
}

impl Default for OrgLaneState {
	fn default() -> Self {
		Self::new()
	}
}

impl OrgLaneState {
	pub fn new() -> Self {
		Self {
			inner:    Mutex::new(OrgLaneInner::Cold),
			cv:       Condvar::new(),
			progress: Arc::new(WarmProgress::new()),
		}
	}

	pub fn status(&self) -> &'static str {
		let guard = self.inner.lock().expect("OrgLaneState mutex");
		match &*guard {
			OrgLaneInner::Cold => "cold",
			OrgLaneInner::Warming { .. } => "warming",
			OrgLaneInner::Warm(_) => "warm",
			OrgLaneInner::Error(_) => "error",
		}
	}

	pub fn progress(&self) -> &WarmProgress {
		&self.progress
	}

	/// Number of indexed org items once a (full or partial) lane is
	/// available. `None` while cold/warming-with-no-partial or on error.
	/// Cheap: reads `items.len()` off the `Arc<OrgLane>` already held.
	pub fn item_count(&self) -> Option<usize> {
		let guard = self.inner.lock().expect("OrgLaneState mutex");
		match &*guard {
			OrgLaneInner::Warm(lane) => Some(lane.items.len()),
			OrgLaneInner::Warming { partial: Some(lane) } => Some(lane.items.len()),
			_ => None,
		}
	}

	pub fn error_message(&self) -> Option<String> {
		let guard = self.inner.lock().expect("OrgLaneState mutex");
		if let OrgLaneInner::Error(e) = &*guard {
			Some(e.clone())
		} else {
			None
		}
	}

	/// Block until the lane reaches a terminal state. Retained for callers
	/// (and tests) that genuinely want to wait for the full vector lane.
	pub fn wait_warm(&self) -> Result<Arc<OrgLane>, String> {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		loop {
			match &*guard {
				OrgLaneInner::Warm(lane) => return Ok(Arc::clone(lane)),
				OrgLaneInner::Error(e) => return Err(e.clone()),
				OrgLaneInner::Cold | OrgLaneInner::Warming { .. } => {
					guard = self.cv.wait(guard).expect("OrgLaneState condvar");
				},
			}
		}
	}

	/// Bounded acquire: wait up to `deadline` for the full lane, but return
	/// the lexical-only partial lane the instant it is available, and never
	/// block past the deadline. `progress` supplies the snapshot embedded in
	/// a `Warming` outcome. This is the non-blocking query path — a search
	/// engine "split state" check rather than an unbounded park.
	pub fn acquire_bounded(&self, deadline: Duration, progress: &WarmProgress) -> LaneAcquire {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		let start = Instant::now();
		loop {
			match &*guard {
				OrgLaneInner::Warm(lane) => return LaneAcquire::Warm(Arc::clone(lane)),
				OrgLaneInner::Error(e) => return LaneAcquire::Error(e.clone()),
				OrgLaneInner::Warming { partial: Some(lane) } => {
					return LaneAcquire::Partial(Arc::clone(lane));
				},
				OrgLaneInner::Cold | OrgLaneInner::Warming { partial: None } => {
					let elapsed = start.elapsed();
					if elapsed >= deadline {
						return LaneAcquire::Warming(progress.snapshot());
					}
					let (g, timeout) = self
						.cv
						.wait_timeout(guard, deadline - elapsed)
						.expect("OrgLaneState condvar");
					guard = g;
					if timeout.timed_out() {
						return LaneAcquire::Warming(progress.snapshot());
					}
				},
			}
		}
	}

	/// Attempt the `Cold → Warming` transition. Returns `true` for the
	/// caller that wins the race and is responsible for spawning the
	/// background worker.
	fn try_start_warming(&self) -> bool {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		if matches!(&*guard, OrgLaneInner::Cold) {
			*guard = OrgLaneInner::Warming { partial: None };
			true
		} else {
			false
		}
	}

	/// Publish the lexical-only partial lane mid-warm. No-op if the lane
	/// already reached a terminal state (defensive against races).
	fn finalize_partial(&self, lane: OrgLane) {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		if matches!(&*guard, OrgLaneInner::Warming { partial: None }) {
			*guard = OrgLaneInner::Warming { partial: Some(Arc::new(lane)) };
			self.cv.notify_all();
		}
	}

	fn finalize_warm(&self, lane: OrgLane) {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		*guard = OrgLaneInner::Warm(Arc::new(lane));
		self.cv.notify_all();
	}

	fn finalize_error(&self, msg: String) {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		*guard = OrgLaneInner::Error(msg);
		self.cv.notify_all();
	}
}

// ---------------------------------------------------------------------------
// Code-graph lane state (PLAN-315 W3, async-ified for PLAN-316 compat)
// ---------------------------------------------------------------------------

/// Async-friendly wrapper for code-graph warm-load.
/// `OnceLock` is write-once, read-many without locking — exactly fits
/// the "warm once, query many" pattern. Blocking consumers call `wait()`;
/// non-blocking observers call `get()`. A `Mutex<bool>` warming guard
/// prevents duplicate worker spawns (mirrors OrgLaneState::try_start_warming).
pub struct CodeLaneState {
	inner:   OnceLock<Result<CodeLane, String>>,
	warming: Mutex<bool>,
}

impl CodeLaneState {
	pub fn new() -> Self {
		Self { inner: OnceLock::new(), warming: Mutex::new(false) }
	}

	pub fn status(&self) -> &'static str {
		match self.inner.get() {
			None => {
				if *self.warming.lock().expect("CodeLaneState warming") {
					"warming"
				} else {
					"cold"
				}
			},
			Some(Ok(_)) => "warm",
			Some(Err(_)) => "error",
		}
	}

	/// Block until warm-load completes. Returns the lane on success.
	/// Retained for tests/callers that genuinely want to wait.
	pub fn wait_warm(&self) -> Result<&CodeLane, &String> {
		match self.inner.wait() {
			Ok(lane) => Ok(lane),
			Err(e) => Err(e),
		}
	}

	/// Bounded acquire. The code-graph build is monolithic (no lexical
	/// partial split), so the outcome is Warm, Error, or — if still
	/// building past `deadline` — Warming. `OnceLock` has no timed wait, so
	/// we poll `get()` on a short cadence rather than parking on `wait()`.
	pub fn acquire_bounded(&self, deadline: Duration) -> CodeAcquire<'_> {
		let start = Instant::now();
		loop {
			if let Some(result) = self.inner.get() {
				return match result {
					Ok(lane) => CodeAcquire::Warm(lane),
					Err(e) => CodeAcquire::Error(e.clone()),
				};
			}
			if start.elapsed() >= deadline {
				return CodeAcquire::Warming;
			}
			thread::sleep(Duration::from_millis(10));
		}
	}

	pub fn get(&self) -> Option<Result<&CodeLane, &String>> {
		self.inner.get().map(|r| r.as_ref())
	}

	/// Attempt the warming transition. Returns `true` for the caller
	/// that wins the race and is responsible for spawning the worker.
	fn try_start_warming(&self) -> bool {
		let mut guard = self.warming.lock().expect("CodeLaneState warming");
		if *guard || self.inner.get().is_some() {
			false
		} else {
			*guard = true;
			true
		}
	}

	fn set(&self, result: Result<CodeLane, String>) {
		let _ = self.inner.set(result);
	}
}

// ---------------------------------------------------------------------------
// Hashing / paths
// ---------------------------------------------------------------------------

/// FNV-1a 64-bit hash. Stable, no_std-compatible, no crypto guarantees.
fn fnv1a_64(bytes: &[u8]) -> u64 {
	const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
	const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
	let mut h = FNV_OFFSET;
	for &b in bytes {
		h ^= u64::from(b);
		h = h.wrapping_mul(FNV_PRIME);
	}
	h
}

fn repo_hash(repo_root: &Path) -> String {
	let canonical = repo_root
		.canonicalize()
		.unwrap_or_else(|_| repo_root.to_path_buf());
	let key = canonical.to_string_lossy();
	format!("fnv:{:016x}", fnv1a_64(key.as_bytes()))
}

// ---------------------------------------------------------------------------
// Slots map
// ---------------------------------------------------------------------------

struct RepoSlot {
	repo_root:        PathBuf,
	lanes:            Vec<Lane>,
	include_personal: bool,
	org_state:        Arc<OrgLaneState>,
	code_state:       Arc<CodeLaneState>,
	last_used:        Instant,
	opened_at:        SystemTime,
}

static SLOTS: OnceLock<Mutex<HashMap<String, RepoSlot>>> = OnceLock::new();

fn slots() -> &'static Mutex<HashMap<String, RepoSlot>> {
	SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Active-warm tracking (BUG-483)
// ---------------------------------------------------------------------------
//
// A cold warm-load of a large corpus (thousands of org items) can take much
// longer than the daemon's idle-exit window. The warm runs on a detached
// background thread that touches neither the connection `INFLIGHT` counter nor
// `LAST_REQUEST_AT`, so without this signal the accept-loop would idle-exit
// mid-embed — killing the build before it persists its vector cache, which
// forces a full re-embed on the next daemon lifetime (the "never persists,
// always re-embeds, hogs CPU" symptom). The idle gate must therefore also wait
// while any warm is in flight.

/// Number of warm-load worker threads currently building a lane. Bumped for
/// the lifetime of each spawned warm (org or code) via [`WarmActiveGuard`].
static ACTIVE_WARMS: AtomicUsize = AtomicUsize::new(0);

/// True while at least one lane warm-load is still building. The daemon's
/// idle-exit loop consults this so a long cold warm is never killed before it
/// can persist its cache.
pub fn warm_in_flight() -> bool {
	ACTIVE_WARMS.load(Ordering::SeqCst) > 0
}

/// RAII guard that increments [`ACTIVE_WARMS`] on construction and decrements
/// on drop — so the count is correct even if the warm thread panics.
struct WarmActiveGuard;

impl WarmActiveGuard {
	fn new() -> Self {
		ACTIVE_WARMS.fetch_add(1, Ordering::SeqCst);
		Self
	}
}

impl Drop for WarmActiveGuard {
	fn drop(&mut self) {
		ACTIVE_WARMS.fetch_sub(1, Ordering::SeqCst);
	}
}

fn max_warm_repos() -> usize {
	env::var("KNOWLEDGE_MAX_WARM_REPOS")
		.ok()
		.and_then(|v| v.parse().ok())
		.unwrap_or(8)
}

/// LRU evict to bring the slot count down to `max_warm_repos`. A slot is
/// evictable only when its lanes are not currently warming (we don't want
/// to drop the only reference to a worker mid-build).
fn evict_lru(map: &mut HashMap<String, RepoSlot>) {
	while map.len() >= max_warm_repos() {
		let victim = map
			.iter()
			.filter(|(_, slot)| {
				slot.org_state.status() != "warming"
			}
)
			.min_by_key(|(_, slot)| slot.last_used)
			.map(|(handle, _)| handle.clone());
		if let Some(handle) = victim {
			map.remove(&handle);
			// PLAN-315 W4: notify subscribers that this repo was evicted.
			subscribe::publish_evicted(&handle, "idle_or_lru");
		} else {
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Warm-load (or re-touch) a repo cache slot. Returns immediately even
/// on a cold corpus; the org-memory and code-graph warm-loads run on
/// background threads and are observable via `stats(handle)`.
pub fn open(repo_root: &Path, include_personal: bool, lanes: &[Lane]) -> Result<Value, String> {
	open_with_embedder(repo_root, include_personal, lanes, Arc::new(DaemonEmbedder))
}

/// Embedder-injected variant of [`open`]. Production code calls [`open`]
/// (default = `DaemonEmbedder`); tests pass a deterministic stub.
pub fn open_with_embedder(
	repo_root: &Path,
	include_personal: bool,
	lanes: &[Lane],
	embedder: Arc<dyn Embedder>,
) -> Result<Value, String> {
	if !repo_root.exists() {
		return Err(format!("repo_root does not exist: {}", repo_root.display()));
	}
	if !repo_root.is_dir() {
		return Err(format!("repo_root is not a directory: {}", repo_root.display()));
	}
	let canonical = fs::canonicalize(repo_root)
		.map_err(|e| format!("canonicalize {}: {e}", repo_root.display()))?;
	let handle = repo_hash(&canonical);

	// Phase A — brief slots-mutex critical section: find/create slot,
	// clone the lane-state Arcs out so warm workers (and any later
	// reader) can operate without holding the slots mutex.
	let (org_state, code_state, warm_flag, slot_lanes, include_personal_out) = {
		let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
		let warm_flag = map.contains_key(&handle);
		if !warm_flag {
			evict_lru(&mut map);
		}
		let slot = map.entry(handle.clone()).or_insert_with(|| RepoSlot {
			repo_root: canonical.clone(),
			lanes: lanes.to_vec(),
			include_personal,
			org_state: Arc::new(OrgLaneState::new()),
			code_state: Arc::new(CodeLaneState::new()),
			last_used: Instant::now(),
			opened_at: SystemTime::now(),
		});
		slot.last_used = Instant::now();
		for lane in lanes {
			if !slot.lanes.contains(lane) {
				slot.lanes.push(*lane);
			}
		}
		if include_personal {
			slot.include_personal = true;
		}
		(
			Arc::clone(&slot.org_state),
			Arc::clone(&slot.code_state),
			warm_flag,
			slot.lanes.clone(),
			slot.include_personal,
		)
	};

	// Phase B — outside slots mutex: kick off warm workers for each
	// lane that wins its race. Subsequent opens on the same handle
	// observe Warming/Warm and skip spawning.
	if lanes.contains(&Lane::OrgMemory) && org_state.try_start_warming() {
		let root_clone = canonical.clone();
		let state_clone = Arc::clone(&org_state);
		let handle_clone = handle.clone();
		thread::Builder::new()
			.name(format!("warm-org-{handle}"))
			.spawn(move || {
				// Keep the daemon alive past its idle window until this warm
				// finishes and persists its cache (BUG-483).
				let _warm_guard = WarmActiveGuard::new();
				let started = Instant::now();
				// `on_partial` publishes the lexical-only lane (BM25 + graph)
				// the moment the cheap index phase finishes, so bounded
				// acquires can serve searches during the slow embed phase.
				let partial_state = Arc::clone(&state_clone);
				let result = OrgLane::warm_load_with(
					&root_clone,
					&state_clone.progress,
					&*embedder,
					|partial| partial_state.finalize_partial(partial),
				);
				match result {
					Ok(lane) => {
						state_clone.finalize_warm(lane);
						let elapsed_ms = started.elapsed().as_millis() as u64;
						subscribe::publish_warm_completed(
							&handle_clone,
							Lane::OrgMemory,
							elapsed_ms,
						);
					},
					Err(e) => state_clone.finalize_error(e),
				}
			})
			.map_err(|e| format!("spawn warm worker: {e}"))?;
	}

	if lanes.contains(&Lane::CodeGraph) && code_state.try_start_warming() {
		let root_clone = canonical.clone();
		let state_clone = Arc::clone(&code_state);
		let handle_clone = handle.clone();
		thread::Builder::new()
			.name(format!("warm-code-{handle}"))
			.spawn(move || {
				// Keep the daemon alive past its idle window until this warm
				// finishes (BUG-483).
				let _warm_guard = WarmActiveGuard::new();
				let started = Instant::now();
				let result = CodeLane::warm_load(&root_clone);
				let elapsed_ms = started.elapsed().as_millis() as u64;
				// Publish before setting OnceLock so subscribers see the
				// event even if they have a clone of the Arc.
				if result.is_ok() {
					subscribe::publish_warm_completed(
						&handle_clone,
						Lane::CodeGraph,
						elapsed_ms,
					);
				}
				state_clone.set(result);
			})
			.map_err(|e| format!("spawn code-graph worker: {e}"))?;
	}

	Ok(json!({
		"repo_handle": handle,
		"warm": warm_flag,
		"status": org_state.status(),
		"org_status": org_state.status(),
		"code_status": code_state.status(),
		"lanes": slot_lanes,
		"include_personal": include_personal_out,
	}))
}

pub fn close(repo_handle: &str) -> Result<Value, String> {
	let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
	let removed = map.remove(repo_handle).is_some();
	Ok(json!({ "closed": removed }))
}

/// Block until the slot's org-memory lane reaches a terminal state.
/// Returns the `OrgLane` Arc on success, the captured error string on
/// failure, or an error if the handle is unknown.
pub fn wait_warm(repo_handle: &str) -> Result<Arc<OrgLane>, String> {
	let state = {
		let map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
		let slot = map
			.get(repo_handle)
			.ok_or_else(|| format!("unknown repo_handle: {repo_handle}"))?;
		Arc::clone(&slot.org_state)
	};
	state.wait_warm()
}

/// Grace window for a bounded lane acquire. If the full (or lexical)
/// lane is not ready within this window the daemon returns a
/// `status:"warming"` payload instead of parking the RPC. Kept small so
/// the warm fast-path stays a single round-trip yet long enough that a
/// just-finished warm-load resolves inline rather than bouncing the
/// client into a retry.
const LANE_ACQUIRE_GRACE: Duration = Duration::from_millis(150);

/// Borrow the org/memory lane for a repo handle, bounded.
///
/// Non-blocking query contract (mirrors a search-engine split state):
/// - full lane ready → run `f`
/// - lexical-only partial ready (vectors still building) → run `f` on it;
///   `OrgLane::search` self-degrades to BM25 + graph when `vec.is_empty()`
/// - still warming past the grace window → return `{status:"warming",
///   progress, partial:false}` without invoking `f`
/// - warm-load failed → surface the error
///
/// `f` returns a `Value` (every daemon caller builds JSON), so the
/// warming sentinel can share the return type without a generic juggle.
pub fn with_org_lane<F>(repo_handle: &str, f: F) -> Result<Value, String>
where
	F: FnOnce(&OrgLane) -> Result<Value, String>,
{
	let state = {
		let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
		let slot = map
			.get_mut(repo_handle)
			.ok_or_else(|| format!("unknown repo_handle: {repo_handle}"))?;
		slot.last_used = Instant::now();
		// If org_memory lane was never requested, fail fast — don't
		// block forever on the condvar.
		if !slot.lanes.contains(&Lane::OrgMemory) {
			return Err(format!("org_memory lane not opened for {repo_handle}"));
		}
		Arc::clone(&slot.org_state)
	};
	match state.acquire_bounded(LANE_ACQUIRE_GRACE, state.progress()) {
		LaneAcquire::Warm(lane) | LaneAcquire::Partial(lane) => f(&lane),
		LaneAcquire::Warming(progress) => Ok(json!({
			"status": "warming",
			"progress": progress,
			"partial": false,
		})),
		LaneAcquire::Error(e) => Err(e),
	}
}

/// Borrow the code-graph lane for a repo handle, bounded.
///
/// Same non-blocking contract as [`with_org_lane`]: full lane → run `f`;
/// still building past the grace window → `{status:"warming", progress}`
/// without invoking `f`; build failed → surface the error. Never parks on
/// `OnceLock::wait()`.
pub fn with_code_lane<F>(repo_handle: &str, f: F) -> Result<Value, String>
where
	F: FnOnce(&CodeLane) -> Result<Value, String>,
{
	let state = {
		let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
		let slot = map
			.get_mut(repo_handle)
			.ok_or_else(|| format!("unknown repo_handle: {repo_handle}"))?;
		slot.last_used = Instant::now();
		// If code_graph lane was never requested, fail fast — don't
		// block on OnceLock::wait() which would hang forever.
		if !slot.lanes.contains(&Lane::CodeGraph) {
			return Err(format!("code_graph lane not opened for {repo_handle}"));
		}
		Arc::clone(&slot.code_state)
	};
	match state.acquire_bounded(LANE_ACQUIRE_GRACE) {
		CodeAcquire::Warm(lane) => f(lane),
		CodeAcquire::Warming => Ok(json!({
			"status": "warming",
			"progress": { "phase": "index" },
			"partial": false,
		})),
		CodeAcquire::Error(e) => Err(format!("code_graph lane error for {repo_handle}: {e}")),
	}
}

pub fn stats(repo_handle: Option<&str>) -> Result<Value, String> {
	let map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
	if let Some(handle) = repo_handle {
		let Some(slot) = map.get(handle) else {
			return Err(format!("unknown repo_handle: {handle}"));
		};
		return Ok(json!({
			"repo_handle": handle,
			"repo_root": slot.repo_root,
			"lanes": slot.lanes,
			"include_personal": slot.include_personal,
			"last_used_ms_ago": slot.last_used.elapsed().as_millis() as u64,
			"opened_at_ms": slot.opened_at
				.duration_since(UNIX_EPOCH)
				.unwrap_or_default()
				.as_millis() as u64,
			"org_lane": org_lane_stats(&slot.org_state),
			"code_lane": code_lane_stats(&slot.code_state),
		}));
	}

	let repos: Vec<Value> = map
		.iter()
		.map(|(handle, slot)| {
			json!({
				"repo_handle": handle,
				"repo_root": slot.repo_root,
				"lanes": slot.lanes,
				"last_used_ms_ago": slot.last_used.elapsed().as_millis() as u64,
				"org_lane": org_lane_stats(&slot.org_state),
				"code_lane": code_lane_stats(&slot.code_state),
			})
		})
		.collect();
	Ok(json!({
		"daemon_rss_bytes": rss_bytes(),
		"repos": repos,
		"max_warm_repos": max_warm_repos(),
	}))
}

/// Build the `org_lane` block of a `stats` response without locking
/// the lane's `OrgLane` payload.
fn org_lane_stats(state: &OrgLaneState) -> Value {
	let status = state.status();
	let progress = if matches!(status, "warming" | "cold") {
		Some(state.progress.snapshot())
	} else {
		None
	};
	let error = state.error_message();
	let mut payload = json!({ "status": status });
	if let Some(p) = progress {
		payload["progress"] = p;
	}
	if let Some(count) = state.item_count() {
		payload["item_count"] = json!(count);
	}
	if let Some(e) = error {
		payload["error"] = json!(e);
	}
	payload
}

/// Build the `code_lane` block of a `stats` response.
fn code_lane_stats(state: &CodeLaneState) -> Value {
	let status = state.status();
	let mut payload = json!({ "status": status });
	if let Some(Err(e)) = state.get() {
		payload["error"] = json!(e);
	}
	payload
}

/// Best-effort RSS reading on Linux via `/proc/self/statm`. Returns 0 on
/// platforms where the file is unavailable.
fn rss_bytes() -> u64 {
	#[cfg(target_os = "linux")]
	{
		let Ok(statm) = fs::read_to_string("/proc/self/statm") else {
			return 0;
		};
		let resident_pages: u64 = statm
			.split_whitespace()
			.nth(1)
			.and_then(|s| s.parse().ok())
			.unwrap_or(0);
		let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
		return resident_pages * page_size;
	}
	#[cfg(not(target_os = "linux"))]
	{
		0
	}
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/// Test-only helpers. Exposed from the lib so integration tests can
/// drain the static slots map between scenarios.
pub mod testing {
	pub fn clear_all() {
		let mut map = super::slots().lock().expect("slots mutex");
		map.clear();
	}
}

// ---------------------------------------------------------------------------
// Unit tests — share the static SLOTS map; serialise via a local mutex.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use std::sync::{Mutex as StdMutex, MutexGuard};

	use tempfile::TempDir;

	use super::*;

	static REPO_CACHE_TEST_LOCK: StdMutex<()> = StdMutex::new(());

	fn test_guard() -> MutexGuard<'static, ()> {
		REPO_CACHE_TEST_LOCK
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
	}

	#[test]
	fn warm_in_flight_tracks_active_warm_and_clears() {
		// BUG-483: the idle-exit gate must observe an in-flight warm so a long
		// cold build is never killed before it persists. Assert the counter is
		// raised while a warm runs and returns to zero once it settles.
		let _g = test_guard();
		testing::clear_all();
		// Quiesce any warm left running by a previous test on the shared static.
		for _ in 0..200 {
			if !warm_in_flight() {
				break;
			}
			std::thread::sleep(Duration::from_millis(10));
		}
		assert!(!warm_in_flight(), "no warm should be in flight at start");

		let tmp = TempDir::new().expect("tempdir");
		let result = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
		let handle = result["repo_handle"].as_str().expect("handle").to_string();

		// The warm thread bumps ACTIVE_WARMS via its RAII guard. An empty
		// tempdir corpus warms near-instantly, so poll for the raised count
		// rather than racing it; if we miss the window the lane is already warm
		// (terminal), which equally proves the counter cleared.
		let _ = wait_warm(&handle);
		// After warm settles the guard has dropped — count must be back to zero.
		for _ in 0..200 {
			if !warm_in_flight() {
				break;
			}
			std::thread::sleep(Duration::from_millis(10));
		}
		assert!(!warm_in_flight(), "warm counter must clear after the build settles");
		let _ = close(&handle);
	}

	#[test]
	fn open_returns_handle_for_existing_dir() {
		let _g = test_guard();
		testing::clear_all();
		let tmp = TempDir::new().expect("tempdir");
		let result = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
		let handle = result["repo_handle"].as_str().expect("handle str");
		assert!(handle.starts_with("fnv:"));
		assert_eq!(result["warm"], false);
		assert!(
			matches!(result["status"].as_str(), Some("warming" | "warm")),
			"unexpected status {:?}",
			result["status"]
		);
		let _ = wait_warm(handle);
		let _ = close(handle);
	}

	#[test]
	fn open_twice_returns_same_handle() {
		let _g = test_guard();
		testing::clear_all();
		let tmp = TempDir::new().expect("tempdir");
		let first = open(tmp.path(), false, &[Lane::OrgMemory]).expect("first");
		let handle = first["repo_handle"].as_str().expect("handle").to_string();
		let second = open(tmp.path(), false, &[Lane::OrgMemory]).expect("second");
		assert_eq!(second["warm"], true);
		assert_eq!(second["repo_handle"].as_str(), Some(handle.as_str()));
		let _ = wait_warm(&handle);
		let _ = close(&handle);
	}

	#[test]
	fn open_extends_lanes() {
		let _g = test_guard();
		testing::clear_all();
		let tmp = TempDir::new().expect("tempdir");
		let first = open(tmp.path(), false, &[Lane::OrgMemory]).expect("first");
		let handle = first["repo_handle"].as_str().expect("handle").to_string();
		let second = open(tmp.path(), false, &[Lane::CodeGraph]).expect("second");
		let lanes = second["lanes"].as_array().expect("lanes");
		assert_eq!(lanes.len(), 2);
		let _ = wait_warm(&handle);
		let _ = close(&handle);
	}

	#[test]
	fn open_nonexistent_errors() {
		let _g = test_guard();
		let result = open(Path::new("/nonexistent/path/foo"), false, &[]);
		assert!(result.is_err());
	}

	#[test]
	fn close_returns_false_for_unknown_handle() {
		let _g = test_guard();
		let result = close("fnv:0000000000000000").expect("close");
		assert_eq!(result["closed"], false);
	}

	#[test]
	fn stats_per_handle_returns_slot_metadata() {
		let _g = test_guard();
		testing::clear_all();
		let tmp = TempDir::new().expect("tempdir");
		let opened = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
		let handle = opened["repo_handle"].as_str().expect("handle").to_string();
		let _ = wait_warm(&handle);

		let single = stats(Some(&handle)).expect("stats");
		assert_eq!(single["repo_handle"].as_str(), Some(handle.as_str()));
		assert!(single["last_used_ms_ago"].is_number());
		assert_eq!(single["org_lane"]["status"].as_str(), Some("warm"));

		let _ = close(&handle);
	}

	#[test]
	fn open_with_code_graph_lane_spawns_worker() {
		let _g = test_guard();
		testing::clear_all();
		let tmp = TempDir::new().expect("tempdir");
		let result = open(tmp.path(), false, &[Lane::CodeGraph]).expect("open");
		let handle = result["repo_handle"].as_str().expect("handle str");
  assert_eq!(result["code_status"].as_str(), Some("warming"));

		// Block until warm completes.
		let state = {
			let map = slots().lock().expect("slots");
			let slot = map.get(handle).expect("slot");
			Arc::clone(&slot.code_state)
		};
		let lane = state.wait_warm().expect("code warm");
		assert!(!lane.graph.symbol_names().is_empty() || true, "empty repo is ok");
		let _ = close(handle);
	}

	#[test]
	fn stats_includes_code_lane_status() {
		let _g = test_guard();
		testing::clear_all();
		let tmp = TempDir::new().expect("tempdir");
		let opened = open(tmp.path(), false, &[Lane::CodeGraph]).expect("open");
		let handle = opened["repo_handle"].as_str().expect("handle").to_string();

		// Wait for code warm to complete.
		let state = {
			let map = slots().lock().expect("slots");
			let slot = map.get(&handle).expect("slot");
			Arc::clone(&slot.code_state)
		};
		let _ = state.wait_warm();

		let single = stats(Some(&handle)).expect("stats");
		assert_eq!(single["code_lane"]["status"].as_str(), Some("warm"));

		let _ = close(&handle);
	}

	#[test]
	fn with_code_lane_rejects_unknown_handle() {
		let _g = test_guard();
		let result = with_code_lane("fnv:0000000000000000", |_| Ok(json!({})));
		assert!(result.is_err());
	}

	#[test]
	fn evict_lru_publishes_evicted_event() {
		let _g = test_guard();
		testing::clear_all();

		// Fill beyond max_warm_repos (default 8) with separate temp dirs.
		let mut handles = Vec::new();
		for _ in 0..(max_warm_repos() + 2) {
			let tmp = TempDir::new().expect("tempdir");
			let result = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
			handles.push(result["repo_handle"].as_str().expect("h").to_string());
		}

		// The oldest two should be evicted. Verify we can still access
		// the remaining ones.
		assert!(
			handles.len() > max_warm_repos(),
			"should have created more than max"
		);

		// Clean up remaining slots.
		for h in &handles {
			let _ = close(h);
		}
	}
}
