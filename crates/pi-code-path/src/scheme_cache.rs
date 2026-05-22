//! Per-session cache for `SchemeRegistry::resolve` results.
//!
//! Three strategies (see `CacheStrategy`):
//! - `None`             — always re-resolve
//! - `UntilMtimeChange` — keep entry while source_path mtime is unchanged (fs-backed schemes)
//! - `Ttl(Duration)`    — keep entry for fixed wall-clock duration (callback schemes)

use std::{
	collections::HashMap,
	sync::{Arc, RwLock},
	time::{Duration, Instant, SystemTime},
};

use crate::{
	scheme::{CacheKey, CacheStrategy, ResolvedContent},
	types::Diagnostic,
};

struct FsEntry {
	content: Arc<ResolvedContent>,
	mtime:   SystemTime,
}

struct TtlEntry {
	content:    Arc<ResolvedContent>,
	expires_at: Instant,
}

/// Per-session resolution cache.
///
/// Instantiated once per `SchemeRegistry`; cleared at session-end implicitly
/// by dropping the registry. No global state.
#[derive(Default)]
pub struct SchemeCache {
	fs:  RwLock<HashMap<CacheKey, FsEntry>>,
	ttl: RwLock<HashMap<CacheKey, TtlEntry>>,
}

impl SchemeCache {
	pub fn new() -> Self {
		Self::default()
	}

	/// Returns cached content if valid; otherwise calls `resolve`, stores, returns.
	///
	/// For `UntilMtimeChange`: the resolver must populate `ResolvedContent.source_mtime`
	/// at read time. Invalidated when the current on-disk mtime differs.
	pub fn get_or_resolve<F>(
		&self,
		key: CacheKey,
		strategy: &CacheStrategy,
		resolve: F,
	) -> Result<Arc<ResolvedContent>, Diagnostic>
	where
		F: FnOnce() -> Result<ResolvedContent, Diagnostic>,
	{
		match strategy {
			CacheStrategy::None => Ok(Arc::new(resolve()?)),
			CacheStrategy::UntilMtimeChange => self.fs_cached(key, resolve),
			CacheStrategy::Ttl(d) => self.ttl_cached(key, *d, resolve),
		}
	}

	fn fs_cached<F>(
		&self,
		key: CacheKey,
		resolve: F,
	) -> Result<Arc<ResolvedContent>, Diagnostic>
	where
		F: FnOnce() -> Result<ResolvedContent, Diagnostic>,
	{
		// Fast-path read
		if let Some(entry) = self.fs.read().unwrap().get(&key) {
			if let Some(path) = entry.content.source_path.as_ref() {
				if let Ok(meta) = std::fs::metadata(path) {
					if meta.modified().ok() == Some(entry.mtime) {
						return Ok(entry.content.clone());
					}
				}
			}
		}
		// Slow-path: resolve + store
		let resolved = resolve()?;
		let mtime = resolved.source_mtime.unwrap_or(SystemTime::UNIX_EPOCH);
		let arc = Arc::new(resolved);
		self.fs
			.write()
			.unwrap()
			.insert(key, FsEntry { content: arc.clone(), mtime });
		Ok(arc)
	}

	fn ttl_cached<F>(
		&self,
		key: CacheKey,
		ttl: Duration,
		resolve: F,
	) -> Result<Arc<ResolvedContent>, Diagnostic>
	where
		F: FnOnce() -> Result<ResolvedContent, Diagnostic>,
	{
		// Fast-path
		if let Some(entry) = self.ttl.read().unwrap().get(&key) {
			if Instant::now() < entry.expires_at {
				return Ok(entry.content.clone());
			}
		}
		// Slow-path
		let resolved = resolve()?;
		let arc = Arc::new(resolved);
		self.ttl.write().unwrap().insert(
			key,
			TtlEntry { content: arc.clone(), expires_at: Instant::now() + ttl },
		);
		Ok(arc)
	}

	/// Drop all cached entries. Used at session-end or on explicit refresh.
	pub fn clear(&self) {
		self.fs.write().unwrap().clear();
		self.ttl.write().unwrap().clear();
	}
}

#[cfg(test)]
mod tests {
	use std::{
		path::PathBuf,
		sync::atomic::{AtomicUsize, Ordering},
		thread::sleep,
	};

	use tempfile::TempDir;

	use super::*;
	use crate::types::Content;

	fn rc(value: &str, path: Option<PathBuf>, mtime: Option<SystemTime>) -> ResolvedContent {
		ResolvedContent {
			url:          "test://x".into(),
			source_path:  path,
			content:      Content::Text { value: value.into() },
			mime:         None,
			notes:        vec![],
			source_mtime: mtime,
		}
	}

	#[test]
	fn none_strategy_never_caches() {
		let cache = SchemeCache::new();
		let calls = AtomicUsize::new(0);
		let key = CacheKey { scheme: "test".into(), body: "x".into() };

		for _ in 0..3 {
			cache
				.get_or_resolve(key.clone(), &CacheStrategy::None, || {
					calls.fetch_add(1, Ordering::SeqCst);
					Ok(rc("hello", None, None))
				})
				.unwrap();
		}
		assert_eq!(calls.load(Ordering::SeqCst), 3);
	}

	#[test]
	fn ttl_strategy_caches_within_window() {
		let cache = SchemeCache::new();
		let calls = AtomicUsize::new(0);
		let key = CacheKey { scheme: "test".into(), body: "x".into() };
		let ttl = Duration::from_millis(200);

		for _ in 0..3 {
			cache
				.get_or_resolve(key.clone(), &CacheStrategy::Ttl(ttl), || {
					calls.fetch_add(1, Ordering::SeqCst);
					Ok(rc("hello", None, None))
				})
				.unwrap();
		}
		assert_eq!(calls.load(Ordering::SeqCst), 1, "first call only");
	}

	#[test]
	fn ttl_strategy_re_resolves_after_expiry() {
		let cache = SchemeCache::new();
		let calls = AtomicUsize::new(0);
		let key = CacheKey { scheme: "test".into(), body: "x".into() };

		let resolve = || {
			calls.fetch_add(1, Ordering::SeqCst);
			Ok(rc("hello", None, None))
		};

		cache
			.get_or_resolve(key.clone(), &CacheStrategy::Ttl(Duration::from_millis(20)), resolve)
			.unwrap();
		sleep(Duration::from_millis(40));
		cache
			.get_or_resolve(key, &CacheStrategy::Ttl(Duration::from_millis(20)), || {
				calls.fetch_add(1, Ordering::SeqCst);
				Ok(rc("hello", None, None))
			})
			.unwrap();
		assert_eq!(calls.load(Ordering::SeqCst), 2);
	}

	#[test]
	fn mtime_strategy_caches_while_unchanged() {
		let dir = TempDir::new().unwrap();
		let file = dir.path().join("a.txt");
		std::fs::write(&file, "v1").unwrap();
		let mtime = std::fs::metadata(&file).unwrap().modified().unwrap();

		let cache = SchemeCache::new();
		let calls = AtomicUsize::new(0);
		let key = CacheKey { scheme: "test".into(), body: "a".into() };

		for _ in 0..3 {
			cache
				.get_or_resolve(key.clone(), &CacheStrategy::UntilMtimeChange, || {
					calls.fetch_add(1, Ordering::SeqCst);
					Ok(rc("v1", Some(file.clone()), Some(mtime)))
				})
				.unwrap();
		}
		assert_eq!(calls.load(Ordering::SeqCst), 1);
	}

	#[test]
	fn mtime_strategy_invalidates_on_change() {
		let dir = TempDir::new().unwrap();
		let file = dir.path().join("a.txt");
		std::fs::write(&file, "v1").unwrap();
		let mtime1 = std::fs::metadata(&file).unwrap().modified().unwrap();

		let cache = SchemeCache::new();
		let calls = AtomicUsize::new(0);
		let key = CacheKey { scheme: "test".into(), body: "a".into() };

		cache
			.get_or_resolve(key.clone(), &CacheStrategy::UntilMtimeChange, || {
				calls.fetch_add(1, Ordering::SeqCst);
				Ok(rc("v1", Some(file.clone()), Some(mtime1)))
			})
			.unwrap();

		// Wait + bump mtime
		sleep(Duration::from_millis(15));
		std::fs::write(&file, "v2").unwrap();
		let mtime2 = std::fs::metadata(&file).unwrap().modified().unwrap();
		assert_ne!(mtime1, mtime2, "fs mtime should differ");

		cache
			.get_or_resolve(key, &CacheStrategy::UntilMtimeChange, || {
				calls.fetch_add(1, Ordering::SeqCst);
				Ok(rc("v2", Some(file.clone()), Some(mtime2)))
			})
			.unwrap();
		assert_eq!(calls.load(Ordering::SeqCst), 2);
	}

	#[test]
	fn clear_drops_everything() {
		let cache = SchemeCache::new();
		let key = CacheKey { scheme: "t".into(), body: "x".into() };
		cache
			.get_or_resolve(key, &CacheStrategy::Ttl(Duration::from_secs(60)), || {
				Ok(rc("hi", None, None))
			})
			.unwrap();
		cache.clear();
		assert!(cache.fs.read().unwrap().is_empty());
		assert!(cache.ttl.read().unwrap().is_empty());
	}
}
