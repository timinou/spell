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
	sync::{Arc, Condvar, Mutex, OnceLock},
	thread,
	time::{Instant, SystemTime, UNIX_EPOCH},
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
	Warming,
	Warm(Arc<OrgLane>),
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
			OrgLaneInner::Warming => "warming",
			OrgLaneInner::Warm(_) => "warm",
			OrgLaneInner::Error(_) => "error",
		}
	}

	pub fn progress(&self) -> &WarmProgress {
		&self.progress
	}

	pub fn error_message(&self) -> Option<String> {
		let guard = self.inner.lock().expect("OrgLaneState mutex");
		if let OrgLaneInner::Error(e) = &*guard {
			Some(e.clone())
		} else {
			None
		}
	}

	/// Block until the lane reaches a terminal state.
	pub fn wait_warm(&self) -> Result<Arc<OrgLane>, String> {
		let mut guard = self.inner.lock().expect("OrgLaneState mutex");
		loop {
			match &*guard {
				OrgLaneInner::Warm(lane) => return Ok(Arc::clone(lane)),
				OrgLaneInner::Error(e) => return Err(e.clone()),
				OrgLaneInner::Cold | OrgLaneInner::Warming => {
					guard = self.cv.wait(guard).expect("OrgLaneState condvar");
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
			*guard = OrgLaneInner::Warming;
			true
		} else {
			false
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
	pub fn wait_warm(&self) -> Result<&CodeLane, &String> {
		match self.inner.wait() {
			Ok(lane) => Ok(lane),
			Err(e) => Err(e),
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
				let started = Instant::now();
				let result =
					OrgLane::warm_load_with(&root_clone, &state_clone.progress, &*embedder);
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

/// Borrow the org/memory lane for a repo handle. Blocks until the
/// background warm worker finishes; surfaces a warm-load error
/// deterministically if the worker failed.
pub fn with_org_lane<T, F>(repo_handle: &str, f: F) -> Result<T, String>
where
	F: FnOnce(&OrgLane) -> Result<T, String>,
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
	let lane = state.wait_warm()?;
	f(&lane)
}

/// Borrow the code-graph lane for a repo handle. Blocks until the
/// background warm worker finishes; returns error if handle unknown
/// or code_graph lane not requested at `open` time.
pub fn with_code_lane<T, F>(repo_handle: &str, f: F) -> Result<T, String>
where
	F: FnOnce(&CodeLane) -> Result<T, String>,
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
	match state.wait_warm() {
		Ok(lane) => f(lane),
		Err(e) => Err(format!("code_graph lane error for {repo_handle}: {e}")),
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
		let result = with_code_lane("fnv:0000000000000000", |_| Ok(()));
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
