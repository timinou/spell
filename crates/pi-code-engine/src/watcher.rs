use std::{
	collections::{HashMap, HashSet},
	fs,
	path::{Path, PathBuf},
	sync::{Arc, mpsc},
	thread::{self, JoinHandle},
	time::{Duration, Instant, SystemTime},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::{Mutex, RwLock};

use crate::error::{CodeEngineError, Result};

const SELF_WRITE_TTL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
struct SelfWriteMarker {
	expected_mtime: Option<SystemTime>,
	recorded_at:    Instant,
}

fn canonicalize_path(path: &Path) -> PathBuf {
	fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub struct FileWatcher {
	inner:       Mutex<RecommendedWatcher>,
	_join:       JoinHandle<()>,
	dirty:       Arc<RwLock<HashSet<PathBuf>>>,
	self_writes: Arc<Mutex<HashMap<PathBuf, SelfWriteMarker>>>,
	watched:     Arc<RwLock<HashSet<PathBuf>>>,
	subscribers: Arc<RwLock<Vec<Box<dyn Fn(&Path) + Send + Sync>>>>,
}

impl FileWatcher {
	pub fn new() -> Result<Self> {
		if std::env::var_os("SPELL_DISABLE_BUFFER_WATCHER").is_some() {
			return Err(CodeEngineError::Buffer("buffer watcher disabled by env".into()));
		}

		let dirty = Arc::new(RwLock::new(HashSet::new()));
		let self_writes = Arc::new(Mutex::new(HashMap::new()));
		let watched = Arc::new(RwLock::new(HashSet::new()));
		let subscribers: Arc<RwLock<Vec<Box<dyn Fn(&Path) + Send + Sync>>>> =
			Arc::new(RwLock::new(Vec::new()));
		let (tx, rx) = mpsc::channel();
		let watcher = notify::recommended_watcher(move |event| {
			let _ = tx.send(event);
		})
		.map_err(|error| CodeEngineError::Buffer(format!("watcher init failed: {error}")))?;

		let dirty_loop = Arc::clone(&dirty);
		let self_writes_loop = Arc::clone(&self_writes);
		let subscribers_loop = Arc::clone(&subscribers);
		let join = thread::spawn(move || {
			while let Ok(event) = rx.recv() {
				let Ok(event) = event else {
					continue;
				};
				handle_event(&dirty_loop, &self_writes_loop, &subscribers_loop, event.paths);
			}
		});

		Ok(Self { inner: Mutex::new(watcher), _join: join, dirty, self_writes, watched, subscribers })
	}

	pub fn mark_self_write(&self, path: &Path, expected_mtime: Option<SystemTime>) {
		let path = canonicalize_path(path);
		self
			.self_writes
			.lock()
			.insert(path, SelfWriteMarker { expected_mtime, recorded_at: Instant::now() });
	}

	pub fn is_stale(&self, path: &Path) -> bool {
		self.dirty.read().contains(&canonicalize_path(path))
	}

	pub fn clear_stale(&self, path: &Path) {
		self.dirty.write().remove(&canonicalize_path(path));
	}

	pub fn watch(&self, path: &Path) -> Result<()> {
		let path = canonicalize_path(path);
		if self.watched.read().contains(&path) {
			return Ok(());
		}
		self
			.inner
			.lock()
			.watch(&path, RecursiveMode::NonRecursive)
			.map_err(|error| {
				CodeEngineError::Buffer(format!("watch failed for {}: {error}", path.display()))
			})?;
		self.watched.write().insert(path);
		Ok(())
	}

	pub fn unwatch(&self, path: &Path) -> Result<()> {
		let path = canonicalize_path(path);
		if !self.watched.write().remove(&path) {
			self.clear_stale(&path);
			self.self_writes.lock().remove(&path);
			return Ok(());
		}
		self.inner.lock().unwatch(&path).map_err(|error| {
			CodeEngineError::Buffer(format!("unwatch failed for {}: {error}", path.display()))
		})?;
		self.clear_stale(&path);
		self.self_writes.lock().remove(&path);
		Ok(())
	}

	/// Register a callback invoked on every non-self-write filesystem change.
	///
	/// Called from the watcher's background thread. Subscribers must not block;
	/// panics are caught and discarded to avoid taking down the event loop.
	pub fn on_change(&self, cb: Box<dyn Fn(&Path) + Send + Sync>) {
		self.subscribers.write().push(cb);
	}

	pub fn watched_count(&self) -> usize {
		self.watched.read().len()
	}

	pub const fn active(&self) -> bool {
		true
	}
}

impl std::fmt::Debug for FileWatcher {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("FileWatcher")
			.field("dirty", &self.dirty)
			.field("watched", &self.watched)
			.field("subscriber_count", &self.subscribers.read().len())
			.finish()
	}
}

fn handle_event(
	dirty: &Arc<RwLock<HashSet<PathBuf>>>,
	self_writes: &Arc<Mutex<HashMap<PathBuf, SelfWriteMarker>>>,
	subscribers: &Arc<RwLock<Vec<Box<dyn Fn(&Path) + Send + Sync>>>>,
	paths: Vec<PathBuf>,
) {
	for raw_path in paths {
		let path = canonicalize_path(&raw_path);
		if should_suppress(&path, self_writes) {
			continue;
		}
		dirty.write().insert(path.clone());
		// Fan out to downstream subscribers. catch_unwind so one
		// panicking callback doesn't kill the watcher thread.
		let subs = subscribers.read();
		for cb in subs.iter() {
			let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(&path)));
		}
	}
}

fn should_suppress(
	path: &Path,
	self_writes: &Arc<Mutex<HashMap<PathBuf, SelfWriteMarker>>>,
) -> bool {
	let mut self_writes = self_writes.lock();
	self_writes.retain(|_, marker| marker.recorded_at.elapsed() <= SELF_WRITE_TTL);
	let Some(marker) = self_writes.get(path).cloned() else {
		return false;
	};
	let disk_mtime = fs::metadata(path)
		.ok()
		.and_then(|metadata| metadata.modified().ok());
	let suppress = match (marker.expected_mtime, disk_mtime) {
		(None, _) => true,
		(Some(expected), Some(current)) => current <= expected,
		(Some(_), None) => true,
	};
	if let Some(expected) = marker.expected_mtime
		&& (suppress || disk_mtime.is_some_and(|current| current > expected))
	{
		self_writes.remove(path);
	}
	suppress
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::atomic::{AtomicBool, Ordering};

	#[test]
	fn on_change_callback_fires_on_handle_event() {
		let dirty = Arc::new(RwLock::new(HashSet::new()));
		let self_writes = Arc::new(Mutex::new(HashMap::new()));
		let subscribers: Arc<RwLock<Vec<Box<dyn Fn(&Path) + Send + Sync>>>> =
			Arc::new(RwLock::new(Vec::new()));

		let called = Arc::new(AtomicBool::new(false));
		let called_clone = Arc::clone(&called);
		subscribers.write().push(Box::new(move |_path| {
			called_clone.store(true, Ordering::SeqCst);
		}));

		// Create a temp file so canonicalize_path succeeds
		let dir = tempfile::tempdir().unwrap();
		let file = dir.path().join("test.txt");
		std::fs::write(&file, b"hello").unwrap();

		handle_event(&dirty, &self_writes, &subscribers, vec![file.clone()]);

		assert!(called.load(Ordering::SeqCst), "subscriber callback must fire");
		assert!(dirty.read().contains(&canonicalize_path(&file)), "dirty set must contain path");
	}

	#[test]
	fn on_change_panicking_subscriber_does_not_kill_dispatch() {
		let dirty = Arc::new(RwLock::new(HashSet::new()));
		let self_writes = Arc::new(Mutex::new(HashMap::new()));
		let subscribers: Arc<RwLock<Vec<Box<dyn Fn(&Path) + Send + Sync>>>> =
			Arc::new(RwLock::new(Vec::new()));

		let called = Arc::new(AtomicBool::new(false));
		let called_clone = Arc::clone(&called);

		// First subscriber panics
		subscribers.write().push(Box::new(move |_path| {
			panic!("boom");
		}));
		// Second subscriber should still fire
		subscribers.write().push(Box::new(move |_path| {
			called_clone.store(true, Ordering::SeqCst);
		}));

		let dir = tempfile::tempdir().unwrap();
		let file = dir.path().join("test.txt");
		std::fs::write(&file, b"hello").unwrap();

		handle_event(&dirty, &self_writes, &subscribers, vec![file]);

		assert!(called.load(Ordering::SeqCst), "second subscriber must fire after first panics");
	}
}

