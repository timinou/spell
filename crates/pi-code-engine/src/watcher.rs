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

#[derive(Debug)]
pub struct FileWatcher {
	inner:       Mutex<RecommendedWatcher>,
	_join:       JoinHandle<()>,
	dirty:       Arc<RwLock<HashSet<PathBuf>>>,
	self_writes: Arc<Mutex<HashMap<PathBuf, SelfWriteMarker>>>,
	watched:     Arc<RwLock<HashSet<PathBuf>>>,
}

impl FileWatcher {
	pub fn new() -> Result<Self> {
		if std::env::var_os("SPELL_DISABLE_BUFFER_WATCHER").is_some() {
			return Err(CodeEngineError::Buffer("buffer watcher disabled by env".into()));
		}

		let dirty = Arc::new(RwLock::new(HashSet::new()));
		let self_writes = Arc::new(Mutex::new(HashMap::new()));
		let watched = Arc::new(RwLock::new(HashSet::new()));
		let (tx, rx) = mpsc::channel();
		let watcher = notify::recommended_watcher(move |event| {
			let _ = tx.send(event);
		})
		.map_err(|error| CodeEngineError::Buffer(format!("watcher init failed: {error}")))?;

		let dirty_loop = Arc::clone(&dirty);
		let self_writes_loop = Arc::clone(&self_writes);
		let join = thread::spawn(move || {
			while let Ok(event) = rx.recv() {
				let Ok(event) = event else {
					continue;
				};
				handle_event(&dirty_loop, &self_writes_loop, event.paths);
			}
		});

		Ok(Self { inner: Mutex::new(watcher), _join: join, dirty, self_writes, watched })
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

	pub fn watched_count(&self) -> usize {
		self.watched.read().len()
	}

	pub const fn active(&self) -> bool {
		true
	}
}

fn handle_event(
	dirty: &Arc<RwLock<HashSet<PathBuf>>>,
	self_writes: &Arc<Mutex<HashMap<PathBuf, SelfWriteMarker>>>,
	paths: Vec<PathBuf>,
) {
	for raw_path in paths {
		let path = canonicalize_path(&raw_path);
		if should_suppress(&path, self_writes) {
			continue;
		}
		dirty.write().insert(path);
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
