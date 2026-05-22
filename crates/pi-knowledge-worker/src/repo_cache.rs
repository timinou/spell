//! PLAN-315 W1 — RepoCache scaffold.
//!
//! Daemon-side per-repo state cache. W1 ships a minimal skeleton:
//! `open` registers a repo handle (FNV-1a hash of canonicalised root)
//! and remembers which lanes were requested. W2 wires the org/memory
//! `LaneState`; W3 wires code-graph; W4 adds the broadcast channel.
//!
//! Eviction policy: LRU by `last_used` with a daemon-wide cap
//! (`KNOWLEDGE_MAX_WARM_REPOS`, default 8) and per-slot idle TTL
//! (`KNOWLEDGE_IDLE_TTL_SECS`, default 1800).

use std::{
	collections::HashMap,
	env, fs,
	path::{Path, PathBuf},
	sync::{Mutex, OnceLock},
	time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{Lane, lane_org::OrgLane};

/// FNV-1a 64-bit hash. Stable, no_std-compatible, no crypto guarantees.
/// Matches PLAN-310 W1.5 F6 `pi_knowledge_core::cache::repo_hash`.
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
	let canonical = repo_root.canonicalize().unwrap_or_else(|_| repo_root.to_path_buf());
	let key = canonical.to_string_lossy();
	format!("fnv:{:016x}", fnv1a_64(key.as_bytes()))
}

/// Per-repo cache slot. W2 populates the org/memory lane on first `open`.
/// W3 will add code-graph lane state alongside.
struct RepoSlot {
	repo_root:        PathBuf,
	lanes:            Vec<Lane>,
	include_personal: bool,
	org_lane:         Option<OrgLane>,
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

/// LRU evict to bring the slot count down to `max_warm_repos`.
fn evict_lru(map: &mut HashMap<String, RepoSlot>) {
	while map.len() >= max_warm_repos() {
		let victim = map
			.iter()
			.min_by_key(|(_, slot)| slot.last_used)
			.map(|(handle, _)| handle.clone());
		if let Some(handle) = victim {
			map.remove(&handle);
		} else {
			break;
		}
	}
}

/// Warm-load (or re-touch) a repo cache slot. W1 only registers the
/// handle; W2 populates the org/memory lane; W3 populates code-graph.
pub fn open(
	repo_root: &Path,
	include_personal: bool,
	lanes: &[Lane],
) -> Result<Value, String> {
	if !repo_root.exists() {
		return Err(format!("repo_root does not exist: {}", repo_root.display()));
	}
	if !repo_root.is_dir() {
		return Err(format!("repo_root is not a directory: {}", repo_root.display()));
	}
	let canonical =
		fs::canonicalize(repo_root).map_err(|e| format!("canonicalize {}: {e}", repo_root.display()))?;
	let handle = repo_hash(&canonical);

	let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
	let warm = map.contains_key(&handle);
	if !warm {
		evict_lru(&mut map);
	}
	let slot = map.entry(handle.clone()).or_insert_with(|| RepoSlot {
		repo_root: canonical.clone(),
		lanes: lanes.to_vec(),
		include_personal,
		org_lane: None,
		last_used: Instant::now(),
		opened_at: SystemTime::now(),
	});
	slot.last_used = Instant::now();
	// Extend the lane set if a later `open` adds lanes.
	for lane in lanes {
		if !slot.lanes.contains(lane) {
			slot.lanes.push(*lane);
		}
	}
	if include_personal {
		slot.include_personal = true;
	}

	// Warm-load lanes that were requested but not yet populated.
	// Best-effort: a failure on one lane returns the per-lane error but
	// leaves the slot registered so a retry doesn't have to re-establish.
	if slot.lanes.contains(&Lane::OrgMemory) && slot.org_lane.is_none() {
		match OrgLane::warm_load(&canonical) {
			Ok(lane) => slot.org_lane = Some(lane),
			Err(e) => return Err(format!("warm-load org_memory lane: {e}")),
		}
	}

	Ok(json!({
		"repo_handle": handle,
		"warm": warm,
		"lanes": slot.lanes,
		"include_personal": slot.include_personal,
	}))
}

pub fn close(repo_handle: &str) -> Result<Value, String> {
	let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
	let removed = map.remove(repo_handle).is_some();
	Ok(json!({ "closed": removed }))
}

/// Borrow the org/memory lane for a repo handle. Returns `Err` if the handle
/// is unknown or if the lane wasn't requested at `open` time.
pub fn with_org_lane<T, F>(repo_handle: &str, f: F) -> Result<T, String>
where
	F: FnOnce(&OrgLane) -> Result<T, String>,
{
	let mut map = slots().lock().map_err(|e| format!("slots mutex: {e}"))?;
	let slot = map
		.get_mut(repo_handle)
		.ok_or_else(|| format!("unknown repo_handle: {repo_handle}"))?;
	slot.last_used = Instant::now();
	let lane = slot
		.org_lane
		.as_ref()
		.ok_or_else(|| format!("org_memory lane not opened for {repo_handle}"))?;
	f(lane)
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
			})
		})
		.collect();
	Ok(json!({
		"daemon_rss_bytes": rss_bytes(),
		"repos": repos,
		"max_warm_repos": max_warm_repos(),
	}))
}

/// Best-effort RSS reading on Linux via `/proc/self/statm`. Returns 0 on
/// platforms where the file is unavailable (macOS, Windows). Sized in bytes.
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

#[cfg(test)]
mod tests {
	use std::sync::{Mutex, MutexGuard};

	use tempfile::TempDir;

	use super::*;

	// Tests share the static SLOTS map; serialise them.
	static REPO_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

	fn test_guard() -> MutexGuard<'static, ()> {
		REPO_CACHE_TEST_LOCK
			.lock()
			.unwrap_or_else(std::sync::PoisonError::into_inner)
	}

	#[test]
	fn open_returns_handle_for_existing_dir() {
		let _g = test_guard();
		let tmp = TempDir::new().expect("tempdir");
		let result = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
		let handle = result["repo_handle"].as_str().expect("handle str");
		assert!(handle.starts_with("fnv:"));
		assert_eq!(result["warm"], false);
		let _ = close(handle);
	}

	#[test]
	fn open_twice_marks_warm() {
		let _g = test_guard();
		let tmp = TempDir::new().expect("tempdir");
		let first = open(tmp.path(), false, &[Lane::OrgMemory]).expect("first");
		let handle = first["repo_handle"].as_str().expect("handle").to_string();
		let second = open(tmp.path(), false, &[Lane::OrgMemory]).expect("second");
		assert_eq!(second["warm"], true);
		assert_eq!(second["repo_handle"].as_str(), Some(handle.as_str()));
		let _ = close(&handle);
	}

	#[test]
	fn open_extends_lanes() {
		let _g = test_guard();
		let tmp = TempDir::new().expect("tempdir");
		let first = open(tmp.path(), false, &[Lane::OrgMemory]).expect("first");
		let handle = first["repo_handle"].as_str().expect("handle").to_string();
		let second = open(tmp.path(), false, &[Lane::CodeGraph]).expect("second");
		let lanes = second["lanes"].as_array().expect("lanes");
		assert_eq!(lanes.len(), 2);
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
	fn stats_daemon_wide_lists_open_repos() {
		let _g = test_guard();
		// Clear from previous tests in this binary.
		slots().lock().unwrap().clear();

		let tmp = TempDir::new().expect("tempdir");
		let opened = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
		let handle = opened["repo_handle"].as_str().expect("handle").to_string();

		let stats = stats(None).expect("stats");
		let repos = stats["repos"].as_array().expect("repos");
		assert!(!repos.is_empty());
		assert!(repos.iter().any(|r| r["repo_handle"] == handle.as_str()));
		assert!(stats["max_warm_repos"].as_u64().unwrap_or(0) > 0);

		let _ = close(&handle);
	}

	#[test]
	fn stats_per_handle_returns_slot_metadata() {
		let _g = test_guard();
		let tmp = TempDir::new().expect("tempdir");
		let opened = open(tmp.path(), false, &[Lane::OrgMemory]).expect("open");
		let handle = opened["repo_handle"].as_str().expect("handle").to_string();

		let single = stats(Some(&handle)).expect("stats");
		assert_eq!(single["repo_handle"].as_str(), Some(handle.as_str()));
		assert!(single["last_used_ms_ago"].is_number());

		let _ = close(&handle);
	}
}
