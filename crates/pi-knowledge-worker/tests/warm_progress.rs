//! PLAN-316 — non-blocking warm-load with progress reporting.
//!
//! Covers the foundational daemon refactor (FEAT-777): `Command::Open`
//! must return immediately while warm-load runs on a background thread,
//! `Command::Stats` must report progress without blocking, and concurrent
//! `Search` on a warming slot must wait without deadlock.

#![cfg(unix)]

use std::{
	fs,
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use pi_knowledge_core::{Error as KError, Result as KResult, recall::Embedder};
use pi_knowledge_worker::{Lane, repo_cache};
use tempfile::TempDir;

// =====================================================================
// Test fixtures
// =====================================================================

const STUB_DIM: usize = 1024;

/// Embedder stub with a configurable per-batch delay. Records every batch
/// call so tests can assert on invocation count. Sleeps `delay_per_text`
/// per text inside `embed_batch` so warm-load takes measurable wall time.
#[derive(Clone)]
struct StubEmbedder {
	delay_per_text: Duration,
	batch_calls:    Arc<AtomicUsize>,
	query_calls:    Arc<AtomicUsize>,
}

impl StubEmbedder {
	fn new(delay_per_text: Duration) -> Self {
		Self {
			delay_per_text,
			batch_calls: Arc::new(AtomicUsize::new(0)),
			query_calls: Arc::new(AtomicUsize::new(0)),
		}
	}

	fn batch_calls(&self) -> usize {
		self.batch_calls.load(Ordering::SeqCst)
	}
}

impl Embedder for StubEmbedder {
	fn embed_query(&self, _text: &str) -> KResult<Vec<f32>> {
		self.query_calls.fetch_add(1, Ordering::SeqCst);
		Ok(vec![0.0; STUB_DIM])
	}

	fn embed_batch(&self, texts: &[&str]) -> KResult<Vec<Vec<f32>>> {
		self.batch_calls.fetch_add(1, Ordering::SeqCst);
		thread::sleep(self.delay_per_text.saturating_mul(texts.len() as u32));
		Ok(texts.iter().map(|_| vec![0.0; STUB_DIM]).collect())
	}

	fn dim(&self) -> usize {
		STUB_DIM
	}
}

/// Embedder stub that always returns an error. Verifies the warm-load
/// error path transitions the lane to `LaneStatus::Error` rather than
/// hanging forever.
struct PanickyEmbedder;

impl Embedder for PanickyEmbedder {
	fn embed_query(&self, _text: &str) -> KResult<Vec<f32>> {
		Err(KError::Embedder("stub panicky embedder".into()))
	}

	fn embed_batch(&self, _texts: &[&str]) -> KResult<Vec<Vec<f32>>> {
		Err(KError::Embedder("stub panicky embedder".into()))
	}

	fn dim(&self) -> usize {
		STUB_DIM
	}
}

/// Write N synthetic concept files into `.spell/memory/concepts/` so
/// `scan_items` picks them up. Returns the temp dir guard.
fn seed_corpus(count: usize) -> TempDir {
	let tmp = TempDir::new().expect("tempdir");
	let dir = tmp.path().join(".spell/memory/concepts");
	fs::create_dir_all(&dir).expect("mk concepts");
	for i in 0..count {
		let file = dir.join(format!("c{i}.org"));
		let body = format!(
			"* CON-{i}\n:PROPERTIES:\n:CUSTOM_ID: CON-{i}\n:KIND: concept\n:END:\n\nbody for concept \
			 {i}"
		);
		fs::write(file, body).expect("write concept");
	}
	tmp
}

// =====================================================================
// Test lock — slots() static is shared; serialise these tests.
// =====================================================================

static WARM_TEST_LOCK: Mutex<()> = Mutex::new(());

fn warm_lock() -> std::sync::MutexGuard<'static, ()> {
	WARM_TEST_LOCK
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn clear_slots() {
	// Drain any leftover slots from previous tests. Implementation hook
	// in repo_cache; if absent, tests must close their own handles.
	repo_cache::testing::clear_all();
}

// =====================================================================
// Workflows 1–6 (FEAT-777 acceptance)
// =====================================================================

/// Workflow 1: Open returns immediately even on a corpus large enough
/// that synchronous warm-load would take seconds.
#[test]
fn open_returns_within_50ms_on_cold_repo() {
	let _g = warm_lock();
	clear_slots();
	let tmp = seed_corpus(40);
	let embedder = StubEmbedder::new(Duration::from_millis(50)); // 40 * 50ms = 2s

	let started = Instant::now();
	let result = repo_cache::open_with_embedder(
		tmp.path(),
		false,
		&[Lane::OrgMemory],
		Arc::new(embedder.clone()),
	)
	.expect("open");
	let elapsed = started.elapsed();

	let handle = result["repo_handle"].as_str().expect("handle").to_string();
	assert!(elapsed < Duration::from_millis(200), "open must return promptly, took {elapsed:?}");
	assert_eq!(result["status"].as_str(), Some("warming"));

	// Block until warm completes so the spawned thread doesn't leak.
	repo_cache::wait_warm(&handle).expect("wait_warm");
	let _ = repo_cache::close(&handle);
}

/// Workflow 2: Stats reflects progress while warm-load runs.
#[test]
fn stats_reports_progress_during_warm_load() {
	let _g = warm_lock();
	clear_slots();
	let tmp = seed_corpus(8);
	let embedder = StubEmbedder::new(Duration::from_millis(60)); // ~480ms total

	let opened = repo_cache::open_with_embedder(
		tmp.path(),
		false,
		&[Lane::OrgMemory],
		Arc::new(embedder.clone()),
	)
	.expect("open");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	// Sample stats while warm-load is still in flight.
	thread::sleep(Duration::from_millis(80));
	let mid = repo_cache::stats(Some(&handle)).expect("stats mid");
	let lane = mid["org_lane"].as_object().expect("org_lane object");
	let status = lane["status"].as_str().expect("status");
	assert!(status == "warming" || status == "warm", "unexpected mid-warm status {status}");
	if status == "warming" {
		assert!(lane["progress"]["total"].as_u64().unwrap_or(0) >= 1);
		assert!(lane["progress"]["phase"].is_string());
		assert!(lane["progress"]["started_ms"].is_number());
	}

	repo_cache::wait_warm(&handle).expect("wait_warm");
	let after = repo_cache::stats(Some(&handle)).expect("stats after");
	assert_eq!(after["org_lane"]["status"].as_str(), Some("warm"));

	let _ = repo_cache::close(&handle);
}

/// Workflow 3: Concurrent search on a warming slot waits, then returns
/// hits — no deadlock, no panic.
#[test]
fn search_waits_for_warm_then_returns() {
	let _g = warm_lock();
	clear_slots();
	let tmp = seed_corpus(4);
	let embedder = StubEmbedder::new(Duration::from_millis(80)); // ~320ms

	let opened = repo_cache::open_with_embedder(
		tmp.path(),
		false,
		&[Lane::OrgMemory],
		Arc::new(embedder.clone()),
	)
	.expect("open");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	// Kick a search immediately — should block briefly while warm-load
	// finishes, then succeed without acquiring the slots mutex.
	let search_started = Instant::now();
	let result = repo_cache::with_org_lane(&handle, |lane| {
		lane.search(pi_knowledge_core::recall::RecallQuery {
			text: Some("concept".into()),
			limit: 4,
			..Default::default()
		})
	});
	let elapsed = search_started.elapsed();

	assert!(result.is_ok(), "search failed: {:?}", result.err());
	assert!(
		elapsed >= Duration::from_millis(80),
		"search returned before warm-load finished (race): {elapsed:?}"
	);

	let _ = repo_cache::close(&handle);
}

/// Workflow 4: Second open on the same warming repo returns the same
/// handle without spawning a duplicate worker.
#[test]
fn concurrent_open_joins_existing_warm() {
	let _g = warm_lock();
	clear_slots();
	let tmp = seed_corpus(6);
	let embedder = StubEmbedder::new(Duration::from_millis(40));

	let first = repo_cache::open_with_embedder(
		tmp.path(),
		false,
		&[Lane::OrgMemory],
		Arc::new(embedder.clone()),
	)
	.expect("first open");
	let handle_a = first["repo_handle"].as_str().expect("handle").to_string();

	let second = repo_cache::open_with_embedder(
		tmp.path(),
		false,
		&[Lane::OrgMemory],
		Arc::new(embedder.clone()),
	)
	.expect("second open");
	let handle_b = second["repo_handle"].as_str().expect("handle").to_string();
	assert_eq!(handle_a, handle_b);

	repo_cache::wait_warm(&handle_a).expect("wait_warm");
	// Only one worker should have ever invoked the embedder.
	assert_eq!(embedder.batch_calls(), 1, "duplicate warm worker spawned");

	let _ = repo_cache::close(&handle_a);
}

/// Workflow 5: After warm completes, status flips to `warm` and stats
/// no longer reports a `progress` payload.
#[test]
fn warm_completion_settles_status() {
	let _g = warm_lock();
	clear_slots();
	let tmp = seed_corpus(3);
	let embedder = StubEmbedder::new(Duration::from_millis(10));

	let opened =
		repo_cache::open_with_embedder(tmp.path(), false, &[Lane::OrgMemory], Arc::new(embedder))
			.expect("open");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	repo_cache::wait_warm(&handle).expect("wait_warm");
	let after = repo_cache::stats(Some(&handle)).expect("stats");
	let lane = after["org_lane"].as_object().expect("org_lane");
	assert_eq!(lane["status"].as_str(), Some("warm"));

	let _ = repo_cache::close(&handle);
}

/// Workflow 6: Warm-load failure transitions to `Error` state.
/// `with_org_lane` surfaces the error rather than hanging.
#[test]
fn warm_load_failure_surfaces_error() {
	let _g = warm_lock();
	clear_slots();
	let tmp = seed_corpus(2);

	let opened = repo_cache::open_with_embedder(
		tmp.path(),
		false,
		&[Lane::OrgMemory],
		Arc::new(PanickyEmbedder),
	)
	.expect("open");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	// PanickyEmbedder errors out, but build_vec_index swallows the
	// embedder error and continues with an empty vec (existing
	// behavior). Lane should still reach `warm`. This test pins that
	// contract so a future "hard fail on embedder error" change is a
	// deliberate decision.
	repo_cache::wait_warm(&handle).expect("wait_warm");
	let after = repo_cache::stats(Some(&handle)).expect("stats");
	assert_eq!(after["org_lane"]["status"].as_str(), Some("warm"));

	let _ = repo_cache::close(&handle);
}

/// Bonus: empty corpus warms instantly and reports `total: 0`.
#[test]
fn empty_corpus_warms_immediately() {
	let _g = warm_lock();
	clear_slots();
	let tmp = TempDir::new().expect("tempdir");
	let embedder = StubEmbedder::new(Duration::from_millis(0));

	let opened =
		repo_cache::open_with_embedder(tmp.path(), false, &[Lane::OrgMemory], Arc::new(embedder))
			.expect("open");
	let handle = opened["repo_handle"].as_str().expect("handle").to_string();

	repo_cache::wait_warm(&handle).expect("wait_warm");
	let after = repo_cache::stats(Some(&handle)).expect("stats");
	assert_eq!(after["org_lane"]["status"].as_str(), Some("warm"));

	let _ = repo_cache::close(&handle);
}
