//! BUG-374: cache invalidation invariants for cross-session reads.
//!
//! Invariant: a `BufferRegistry::open()` call MUST return content that
//! matches `fs::read(path)` at the time of the call. The kernel MUST NOT
//! rely on an async watcher flag as the sole freshness signal.
//!
//! Today's `open_inner` has a fast path that returns the cached buffer when
//!   `watcher.is_stale(&key) == false`
//! WITHOUT consulting disk mtime. Any source of disk change that doesn't
//! deliver a watcher event before the next read — disabled watcher, inotify
//! drop under load, cross-process writes the watcher missed, or even another
//! same-process session whose `mark_self_write` suppressed the dirty flag
//! globally — returns a stale buffer.
//!
//! These tests fail today; the fix replaces the watcher-trust fast-path with
//! a synchronous (mtime, size) check.

use std::{path::Path, sync::Arc, thread, time::Duration};

use pi_code_engine::{BufferRegistry, LanguageRegistry};

fn registry() -> Arc<LanguageRegistry> {
	Arc::new(LanguageRegistry::with_builtins().expect("registry"))
}

/// A registry without coord (NullCoordClient) so the `latest_coord_revision`
/// reload path can't mask the watcher-trust fast-path. This isolates the
/// freshness invariant from broker-mediated edit coordination.
fn local_registry() -> BufferRegistry {
	BufferRegistry::new(registry())
}

fn write(path: &Path, source: &str) {
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent).expect("mkdir");
	}
	std::fs::write(path, source).expect("write");
}

// ───────────────────────────────────────────────────────────────────────────
// Invariant 1 — the BUG-374 core repro.
//
// Disk changes via a route that doesn't go through `edit_transaction`. This
// is the production scenario: the bug bites whenever a write reaches disk
// without bumping the BufferRegistry's coord revision — e.g. a sibling
// process, an external editor, or any kernel path that writes without
// notifying the watcher. With the watcher disabled here we simulate "event
// not yet delivered" / "event lost" deterministically.
//
// Required behavior: the second `open()` returns content that matches
// disk — not the buffer cached from the first read.
// ───────────────────────────────────────────────────────────────────────────
#[test]
fn open_returns_disk_content_when_disk_changes_without_watcher_event() {
	unsafe {
		std::env::set_var("SPELL_DISABLE_BUFFER_WATCHER", "1");
	}
	let dir = tempfile::tempdir().expect("tempdir");
	let path = dir.path().join("f.rs");
	write(&path, "fn v1() {}\n");
	let reg = local_registry();

	{
		let buf = reg.open(&path).expect("prime");
		assert!(buf.lock().source().contains("v1"));
	}

	// Beat filesystem mtime resolution so the disk change is observable.
	thread::sleep(Duration::from_millis(50));
	write(&path, "fn v2() {}\n");

	let buf = reg.open(&path).expect("re-open");
	let src = buf.lock().source();
	assert!(
		src.contains("v2"),
		"BUG-374: open() must return disk-fresh content; got {src:?}"
	);
}

// ───────────────────────────────────────────────────────────────────────────
// Invariant 2 — same-size disk write with different content (mtime-only diff).
//
// File-system stat resolution is coarse. Two writes within the same
// millisecond can share an mtime. A correct freshness check uses
// `(mtime, size)` AND, when those tie, falls back to a content hash. The
// cheapest safe implementation is to compare the recorded content version
// (e.g. a 64-bit hash kept on the buffer alongside disk_mtime).
//
// We exercise the size-equal case here; with no content hash the buffer
// will return stale.
// ───────────────────────────────────────────────────────────────────────────
#[test]
fn open_returns_disk_content_on_same_size_write_with_distinct_mtime() {
	unsafe {
		std::env::set_var("SPELL_DISABLE_BUFFER_WATCHER", "1");
	}
	let dir = tempfile::tempdir().expect("tempdir");
	let path = dir.path().join("f.rs");
	// 16 bytes both times — same size, different content.
	write(&path, "fn aaaaaaaaa() {}");
	let reg = local_registry();

	{
		let buf = reg.open(&path).expect("prime");
		assert!(buf.lock().source().contains("aaaaaaaaa"));
	}

	thread::sleep(Duration::from_millis(50));
	write(&path, "fn bbbbbbbbb() {}");

	let buf = reg.open(&path).expect("re-open");
	let src = buf.lock().source();
	assert!(
		src.contains("bbbbbbbbb"),
		"BUG-374: open() must reload on mtime change even when size is equal; got {src:?}"
	);
}

// ───────────────────────────────────────────────────────────────────────────
// Invariant 3 — the watcher is an optimization, not a source of truth.
//
// Even when the watcher IS active, an inotify event for a sibling session's
// `mark_self_write` call suppresses the dirty flag for OTHER sessions in the
// same process — because `self_writes` is a global map keyed by path, not by
// session. After a peer's atomic write our buffer can stay un-marked stale.
// The fast-path then returns it.
//
// This test reproduces that condition deterministically without coord/broker.
// ───────────────────────────────────────────────────────────────────────────
#[test]
fn open_returns_disk_content_when_watcher_dirty_flag_was_suppressed() {
	unsafe {
		std::env::remove_var("SPELL_DISABLE_BUFFER_WATCHER");
	}
	let dir = tempfile::tempdir().expect("tempdir");
	let path = dir.path().join("f.rs");
	write(&path, "fn v1() {}\n");
	let reg = local_registry();

	{
		let buf = reg.open(&path).expect("prime");
		assert!(buf.lock().source().contains("v1"));
	}

	// Simulate a peer that wrote the file and immediately registered a
	// `mark_self_write` for it — from THIS registry's perspective. With the
	// current implementation `self_writes` is global, so when the inotify
	// event arrives it will be suppressed and `dirty` stays clear.
	if let Some(watcher) = reg.watcher() {
		watcher.mark_self_write(&path, None);
		watcher.clear_stale(&path);
	}
	thread::sleep(Duration::from_millis(50));
	write(&path, "fn v2() {}\n");
	// Give the watcher thread a moment; if the dirty flag is set the
	// reload-if-stale branch will catch it. The point of the test is to
	// prove the kernel doesn't rely on it landing.
	thread::sleep(Duration::from_millis(50));

	let buf = reg.open(&path).expect("re-open");
	let src = buf.lock().source();
	assert!(
		src.contains("v2"),
		"BUG-374: open() must reload from disk even when watcher dirty flag is suppressed; got {src:?}"
	);
}
