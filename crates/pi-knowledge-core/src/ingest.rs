//! Notify-driven ingest helpers.
//!
//! Two surfaces:
//!
//! * [`watch_and_rebuild`] — spawns a watcher thread that observes the given
//!   roots and invokes a user-supplied callback once filesystem changes have
//!   settled for `DEBOUNCE` (250 ms). Producers (W7 onward) use this to keep
//!   the knowledge cache fresh.
//! * [`purge_if_stale`] — schema-stamped cache load gate. Reads
//!   `<cache_dir>/meta.bin`, checks [`KnowledgeMeta::status_against`] against
//!   the current fingerprint + embedder, and removes `cache_dir` outright if
//!   anything has moved. Callers rebuild from scratch on `false`.

use std::{
	collections::{HashMap, HashSet},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, event};

use crate::{
	Error, Result,
	cache::{CacheStatus, KnowledgeMeta, WorkspaceFingerprint},
};

/// Debounce window. Filesystem activity within this window for a single path
/// collapses to one [`IngestEvent`].
pub const DEBOUNCE: Duration = Duration::from_millis(250);

/// Tick cadence inside the watcher thread. Bounds the latency between a
/// quiet filesystem and a callback invocation.
const TICK: Duration = Duration::from_millis(50);

/// Coarse-grained change kind.
///
/// We collapse Create / Modify lifecycle events into
/// [`IngestEventKind::Created`] vs [`IngestEventKind::Modified`] by tracking
/// which paths the watcher has previously surfaced as existing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestEventKind {
	Created,
	Modified,
	Deleted,
}

#[derive(Debug, Clone)]
pub struct IngestEvent {
	pub kind: IngestEventKind,
	pub path: PathBuf,
}

/// Returned by [`watch_and_rebuild`].
///
/// Drop the handle (or call `stop`) to terminate the watcher thread; the
/// underlying `notify` watcher releases inotify / kqueue resources on drop.
pub struct IngestHandle {
	stop_flag: Arc<AtomicBool>,
	thread:    Option<JoinHandle<()>>,
	/// Held to keep the watcher alive for the lifetime of the handle. The
	/// notify backend releases native resources on drop.
	watcher:   Option<RecommendedWatcher>,
}

impl IngestHandle {
	/// Stop the watcher thread. Blocks briefly while the thread observes the
	/// stop flag (≤ `TICK`). Idempotent.
	pub fn stop(mut self) {
		self.stop_inner();
	}

	fn stop_inner(&mut self) {
self.stop_flag.store(true, Ordering::SeqCst);
		// Dropping the watcher signals notify to release its native handle.
		self.watcher.take();
		if let Some(t) = self.thread.take() {
			let _ = t.join();
		}
	}
}

impl Drop for IngestHandle {
	fn drop(&mut self) {
		self.stop_inner();
	}
}

/// Spawn a notify watcher rooted at `roots` (recursive).
///
/// Filesystem changes debounce for [`DEBOUNCE`] before `on_change` runs;
/// multiple events on the same path within the window collapse to one
/// [`IngestEvent`].
///
/// Filesystem events whose path is rooted at `cache_dir` (or any of its
/// descendants) are **dropped** before reaching `on_change`. This prevents
/// the obvious feedback loop where writing cache files inside a watched
/// root would otherwise re-trigger the rebuild. Pass an empty path
/// (`Path::new("")`) to disable the filter.
pub fn watch_and_rebuild<F>(
	roots: &[PathBuf],
	cache_dir: &Path,
	on_change: F,
) -> Result<IngestHandle>
where
	F: Fn(IngestEvent) + Send + 'static,
{
	let pending: Arc<Mutex<HashMap<PathBuf, (EventKind, Instant)>>> =
		Arc::new(Mutex::new(HashMap::new()));
	let pending_writer = Arc::clone(&pending);

	let mut watcher: RecommendedWatcher =
		notify::recommended_watcher(move |res: notify::Result<Event>| {
			if let Ok(ev) = res {
				let now = Instant::now();
				let mut guard = match pending_writer.lock() {
					Ok(g) => g,
					Err(p) => p.into_inner(),
				};
for p in ev.paths {
					guard.insert(p, (ev.kind, now));
				}
			}
		})
		.map_err(watch_err)?;

	for root in roots {
		watcher
			.watch(root, RecursiveMode::Recursive)
			.map_err(watch_err)?;
	}

	let stop_flag = Arc::new(AtomicBool::new(false));
	let thread_stop = Arc::clone(&stop_flag);
	let pending_reader = Arc::clone(&pending);
	let known_existing: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
	// Canonicalize so a symlinked cache_dir still excludes correctly.
	let cache_prefix: Option<PathBuf> = if cache_dir.as_os_str().is_empty() {
		None
	} else {
		Some(std::fs::canonicalize(cache_dir).unwrap_or_else(|_| cache_dir.to_path_buf()))
	};

	let thread = thread::Builder::new()
		.name("pi-kc-ingest".into())
		.spawn(move || {
			while !thread_stop.load(Ordering::SeqCst) {
				thread::sleep(TICK);
				let ready = drain_settled(&pending_reader);
				if ready.is_empty() {
					continue;
				}
				let mut known = match known_existing.lock() {
					Ok(g) => g,
					Err(p) => p.into_inner(),
				};
				for (path, raw_kind) in ready {
					// Skip events on cache files — their writes are *our* writes,
					// emitted as part of the rebuild we just kicked off.
					if let Some(ref prefix) = cache_prefix
						&& path_under(&path, prefix)
					{
						continue;
					}
					let exists = path.exists();
					let Some(kind) = classify(raw_kind, exists, known.contains(&path)) else {
						continue;
					};
					match kind {
						IngestEventKind::Created | IngestEventKind::Modified => {
							known.insert(path.clone());
						},
						IngestEventKind::Deleted => {
							known.remove(&path);
						},
					}
					on_change(IngestEvent { kind, path });
				}
			}
		})
		.map_err(|e| Error::Watcher(format!("spawn watcher thread: {e}")))?;

	Ok(IngestHandle {
		stop_flag,
		thread: Some(thread),
watcher: Some(watcher),
	})
}

/// Schema-gated cache check.
///
/// Returns `true` if `<cache_dir>/meta.bin` is present and
/// [`KnowledgeMeta::status_against`] reports [`CacheStatus::Fresh`]. On any
/// staleness — schema bump, embedder swap, fingerprint divergence, or
/// missing meta — `cache_dir` is removed entirely and `false` is returned.
pub fn purge_if_stale(
	cache_dir: &Path,
	current_fp: &WorkspaceFingerprint,
	expected_model: &str,
	expected_dim: usize,
) -> Result<bool> {
	let meta_path = cache_dir.join("meta.bin");
	if !meta_path.exists() {
		return Ok(false);
	}
	let file = std::fs::File::open(&meta_path)?;
	let reader = std::io::BufReader::new(file);
let meta: KnowledgeMeta = if let Ok(m) = bincode::deserialize_from(reader) {
		m
	} else {
		let _ = std::fs::remove_dir_all(cache_dir);
		return Ok(false);
	};
match meta.status_against(current_fp, expected_model, expected_dim) {
		CacheStatus::Fresh => Ok(true),
		CacheStatus::Stale { .. } | CacheStatus::Missing => {
			std::fs::remove_dir_all(cache_dir)?;
			Ok(false)
		},
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn drain_settled(
	pending: &Mutex<HashMap<PathBuf, (EventKind, Instant)>>,
) -> Vec<(PathBuf, EventKind)> {
	let now = Instant::now();
	let mut guard = match pending.lock() {
		Ok(g) => g,
		Err(p) => p.into_inner(),
	};
let settled: Vec<PathBuf> = guard
		.iter()
		.filter(|(_, (_, last))| now.duration_since(*last) >= DEBOUNCE)
		.map(|(p, _)| p.clone())
		.collect();
	let mut out = Vec::with_capacity(settled.len());
	for p in settled {
		if let Some((k, _)) = guard.remove(&p) {
			out.push((p, k));
		}
	}
	out
}

/// Map a raw notify event into the coarse [`IngestEventKind`] we expose.
///
/// Returns `None` for events the watcher should *drop* (Access reads, the
/// `Any`/`Other` synthetic catch-alls). On macOS `FSEvents` conflates several
/// lifecycle bits into the catch-all; treating those as Modified caused
/// spurious rebuilds. We now keep classification exhaustive.
const fn classify(raw: EventKind, exists: bool, known: bool) -> Option<IngestEventKind> {
	if !exists {
		return Some(IngestEventKind::Deleted);
	}
	if matches!(raw, EventKind::Remove(_)) {
		// notify saw a remove, but the path exists now — treat as Created/Modified.
		return Some(if known { IngestEventKind::Modified } else { IngestEventKind::Created });
	}
	match raw {
		EventKind::Create(_) => Some(if known {
			IngestEventKind::Modified
		} else {
			IngestEventKind::Created
		}),
		EventKind::Modify(kind) => match kind {
			event::ModifyKind::Name(_) if !known => Some(IngestEventKind::Created),
			_ => Some(IngestEventKind::Modified),
		},
		EventKind::Remove(_) => None, // handled above; explicit for exhaustiveness
		// Linux inotify reports `IN_CLOSE_WRITE` as `Access(Close(Write))` —
		// this is a real write-completion signal, so treat it like Modify.
		// Open/Read accesses are noise and stay dropped.
		EventKind::Access(event::AccessKind::Close(event::AccessMode::Write)) => Some(if known {
			IngestEventKind::Modified
		} else {
			IngestEventKind::Created
		}),
		EventKind::Access(_) | EventKind::Other | EventKind::Any => None,
	}
}

/// True iff `path` is rooted under `prefix`. Canonicalizes `path` when it
/// exists so symlinks and `..`-relative paths agree with the canonical
/// `prefix` captured at watcher init.
fn path_under(path: &Path, prefix: &Path) -> bool {
	let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
	canonical.starts_with(prefix)
}

fn watch_err(e: notify::Error) -> Error {
	Error::Watcher(e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
	use std::{
		fs,
		sync::{Arc, Mutex},
		thread::sleep,
		time::Duration,
	};

	use tempfile::tempdir;

	use super::*;

	/// Wait for the watcher thread to flush at least one event into `events`,
	/// or until `timeout` elapses. Returns the snapshot at that point.
	fn drain_events(
		events: &Arc<Mutex<Vec<IngestEvent>>>,
		min: usize,
		timeout: Duration,
	) -> Vec<IngestEvent> {
		let deadline = Instant::now() + timeout;
		loop {
			{
				let guard = events.lock().unwrap();
				if guard.len() >= min {
					return guard.clone();
				}
			}
			if Instant::now() >= deadline {
				return events.lock().unwrap().clone();
			}
			sleep(Duration::from_millis(20));
		}
	}

	fn collector() -> (
		Arc<Mutex<Vec<IngestEvent>>>,
		impl Fn(IngestEvent) + Send + 'static + Clone,
	) {
		let events: Arc<Mutex<Vec<IngestEvent>>> = Arc::new(Mutex::new(Vec::new()));
		let sink = Arc::clone(&events);
		let cb = move |ev: IngestEvent| {
			sink.lock().unwrap().push(ev);
		};
		(events, cb)
	}

	#[test]
	fn create_triggers_event() {
		let root = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let (events, cb) = collector();
		let handle =
			watch_and_rebuild(&[root.path().to_path_buf()], cache.path(), cb).unwrap();

		// Give the watcher a moment to register.
		sleep(Duration::from_millis(50));
		fs::write(root.path().join("a.txt"), b"hello").unwrap();

		let got = drain_events(&events, 1, Duration::from_secs(2));
		assert!(
			got.iter().any(|e| e.path.ends_with("a.txt")
				&& matches!(e.kind, IngestEventKind::Created | IngestEventKind::Modified)),
			"expected event for a.txt; got {got:?}"
		);
		handle.stop();
	}

	#[test]
	fn modify_triggers_event() {
		let root = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let target = root.path().join("m.txt");
		fs::write(&target, b"v1").unwrap();

		let (events, cb) = collector();
		let handle =
			watch_and_rebuild(&[root.path().to_path_buf()], cache.path(), cb).unwrap();
		sleep(Duration::from_millis(50));
		fs::write(&target, b"v2").unwrap();

		let got = drain_events(&events, 1, Duration::from_secs(2));
		assert!(
			got.iter().any(|e| e.path.ends_with("m.txt")),
			"expected event for m.txt; got {got:?}"
		);
		handle.stop();
	}

	#[test]
	fn delete_triggers_event() {
		let root = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let target = root.path().join("d.txt");
		fs::write(&target, b"bye").unwrap();

		let (events, cb) = collector();
		let handle =
			watch_and_rebuild(&[root.path().to_path_buf()], cache.path(), cb).unwrap();
		sleep(Duration::from_millis(50));
		fs::remove_file(&target).unwrap();

		let got = drain_events(&events, 1, Duration::from_secs(2));
		assert!(
			got.iter().any(|e| e.path.ends_with("d.txt")
				&& matches!(e.kind, IngestEventKind::Deleted)),
			"expected Deleted event for d.txt; got {got:?}"
		);
		handle.stop();
	}

	#[test]
	fn multiple_changes_within_debounce_window_coalesce() {
		let root = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let target = root.path().join("burst.txt");

		let (events, cb) = collector();
		let handle =
			watch_and_rebuild(&[root.path().to_path_buf()], cache.path(), cb).unwrap();
		sleep(Duration::from_millis(50));

		// Rapid bursts — well under the 250ms debounce window.
		for i in 0..6 {
			fs::write(&target, format!("v{i}")).unwrap();
			sleep(Duration::from_millis(10));
		}

		let got = drain_events(&events, 1, Duration::from_secs(2));
		let bursts: Vec<&IngestEvent> = got.iter().filter(|e| e.path.ends_with("burst.txt")).collect();
		assert_eq!(
			bursts.len(),
			1,
			"6 writes within debounce window should coalesce to one event; got {bursts:?}"
		);
		handle.stop();
	}

	#[test]
	fn handle_drop_stops_thread() {
		let root = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let (_events, cb) = collector();
		{
			let _handle =
				watch_and_rebuild(&[root.path().to_path_buf()], cache.path(), cb).unwrap();
			sleep(Duration::from_millis(30));
		}
		// If the thread didn't shut down, the test would hang on cargo's
		// final join; surviving this point means stop_inner worked.
	}

	#[test]
	fn purge_if_stale_returns_false_when_meta_absent() {
		let cache = tempdir().unwrap();
		let fp = WorkspaceFingerprint {
			root:     std::path::PathBuf::from("/anywhere"),
			git_head: None,
			files:    Default::default(),
		};
		let fresh = purge_if_stale(cache.path(), &fp, "", 0).unwrap();
		assert!(!fresh, "missing meta must mean not fresh");
	}

	#[test]
	fn purge_if_stale_keeps_dir_when_fresh() {
		let cache = tempdir().unwrap();
		let fp = WorkspaceFingerprint {
			root:     std::path::PathBuf::from("/anywhere"),
			git_head: None,
			files:    Default::default(),
		};
		let meta = KnowledgeMeta::new(fp.clone());
		let meta_path = cache.path().join("meta.bin");
		std::fs::write(&meta_path, bincode::serialize(&meta).unwrap()).unwrap();

		let fresh = purge_if_stale(cache.path(), &fp, "", 0).unwrap();
		assert!(fresh, "fresh meta must report fresh");
		assert!(meta_path.exists(), "fresh meta must not be removed");
	}

	#[test]
	fn ingest_skips_excluded_cache_dir_events() {
		// Place cache_dir *inside* the watched root — the realistic shape
		// for a feedback-loop bug. Writing to the cache file must not fire
		// an event to the callback.
		let root = tempdir().unwrap();
		let cache = root.path().join("cache");
		fs::create_dir_all(&cache).unwrap();

		let (events, cb) = collector();
		let handle =
			watch_and_rebuild(&[root.path().to_path_buf()], &cache, cb).unwrap();
		sleep(Duration::from_millis(50));

		// Sentinel write inside the watched root but *outside* the cache.
		fs::write(root.path().join("keep.txt"), b"hi").unwrap();
		// Cache write — should be filtered.
		fs::write(cache.join("engine.bin"), b"bin").unwrap();

		let got = drain_events(&events, 1, Duration::from_secs(2));
		assert!(
			got.iter().any(|e| e.path.ends_with("keep.txt")),
			"sentinel keep.txt event missing; got {got:?}",
		);
		assert!(
			got.iter().all(|e| !e.path.ends_with("engine.bin")),
			"cache_dir/engine.bin event must be filtered; got {got:?}",
		);
		handle.stop();
	}

	#[test]
	fn classify_drops_access_and_other_events() {
		use notify::event::{AccessKind, AccessMode};
		assert_eq!(
			classify(EventKind::Access(AccessKind::Read), true, true),
			None,
			"Access events must not surface as Modified",
		);
		assert_eq!(
			classify(EventKind::Access(AccessKind::Open(AccessMode::Read)), true, false),
			None,
		);
		assert_eq!(classify(EventKind::Other, true, true), None);
		assert_eq!(classify(EventKind::Any, true, false), None);
		// Sanity: real events still classify.
		assert_eq!(
			classify(EventKind::Modify(notify::event::ModifyKind::Data(
				notify::event::DataChange::Any
			)), true, true),
			Some(IngestEventKind::Modified),
		);
	}

	#[test]
	fn purge_if_stale_removes_dir_when_fingerprint_diverges() {
		let cache = tempdir().unwrap();
		let original = WorkspaceFingerprint {
			root:     std::path::PathBuf::from("/anywhere"),
			git_head: Some("abc".into()),
			files:    Default::default(),
		};
		let meta = KnowledgeMeta::new(original);
		std::fs::write(cache.path().join("meta.bin"), bincode::serialize(&meta).unwrap()).unwrap();
		std::fs::write(cache.path().join("bm25.bin"), b"payload").unwrap();

		let diverged = WorkspaceFingerprint {
			root:     std::path::PathBuf::from("/anywhere"),
			git_head: Some("def".into()),
			files:    Default::default(),
		};
		let fresh = purge_if_stale(cache.path(), &diverged, "", 0).unwrap();
		assert!(!fresh);
		assert!(!cache.path().exists(), "stale cache dir must be removed wholesale");
	}
}
