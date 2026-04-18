use std::{
	fs::{File, OpenOptions},
	io,
	path::{Path, PathBuf},
	thread,
	time::{Duration, Instant},
};

use fd_lock::RwLock;

use crate::error::{CodeEngineError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockStatus {
	pub path:      PathBuf,
	pub exclusive: bool,
	pub shared:    bool,
}

fn open_lock_file(path: &Path) -> Result<File> {
	OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.open(path)
		.map_err(CodeEngineError::from)
}

fn should_retry(error: &io::Error) -> bool {
	matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)
}

pub fn with_exclusive_lock<T>(
	path: &Path,
	budget: Duration,
	f: impl FnOnce() -> Result<T>,
) -> Result<T> {
	let file = open_lock_file(path)?;
	let mut lock = RwLock::new(file);
	let start = Instant::now();
	loop {
		match lock.try_write() {
			Ok(guard) => {
				let result = f();
				drop(guard);
				return result;
			},
			Err(error) if should_retry(&error) => {
				if start.elapsed() >= budget {
					return Err(CodeEngineError::LockTimeout {
						path:      path.to_path_buf(),
						budget_ms: budget.as_millis() as u64,
					});
				}
				thread::sleep(Duration::from_millis(10));
			},
			Err(error) => {
				return Err(CodeEngineError::LockAcquireFailed {
					path:   path.to_path_buf(),
					reason: error.to_string(),
				});
			},
		}
	}
}

pub fn with_shared_lock<T>(
	path: &Path,
	budget: Duration,
	f: impl FnOnce() -> Result<T>,
) -> Result<T> {
	let file = open_lock_file(path)?;
	let lock = RwLock::new(file);
	let start = Instant::now();
	loop {
		match lock.try_read() {
			Ok(guard) => {
				let result = f();
				drop(guard);
				return result;
			},
			Err(error) if should_retry(&error) => {
				if start.elapsed() >= budget {
					return Err(CodeEngineError::LockTimeout {
						path:      path.to_path_buf(),
						budget_ms: budget.as_millis() as u64,
					});
				}
				thread::sleep(Duration::from_millis(10));
			},
			Err(error) => {
				return Err(CodeEngineError::LockAcquireFailed {
					path:   path.to_path_buf(),
					reason: error.to_string(),
				});
			},
		}
	}
}

pub fn lock_status(path: &Path) -> Result<LockStatus> {
	let file = open_lock_file(path)?;
	let mut exclusive_lock = RwLock::new(file);
	let exclusive = exclusive_lock.try_write().is_ok();
	let file = open_lock_file(path)?;
	let shared_lock = RwLock::new(file);
	let shared = shared_lock.try_read().is_ok();
	Ok(LockStatus { path: path.to_path_buf(), exclusive, shared })
}
