//! BUG-478 — verify the chunked warm embed releases the embedder lock between
//! chunks so an interactive query embed interleaves instead of queueing behind
//! the whole (multi-minute, in production) warm batch.
//!
//! The production engine is a single `Mutex<TextEmbedding>`; the warm path and
//! query path both go through it. Pre-fix the warm embed was ONE giant
//! `embed_batch` holding the lock for the whole corpus. Post-fix it is chunked,
//! so the lock is free between chunks. This test models that shared lock with a
//! `Mutex`-guarded slow embedder and asserts a concurrent query acquires it
//! mid-warm.

use std::{
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use pi_knowledge_core::recall::Embedder;
use pi_knowledge_worker::lane_org::{OrgLane, WarmProgress};

/// Embedder whose every `embed_batch` call takes the shared lock, sleeps a
/// little (simulating model latency), and releases. Counts how many distinct
/// batch calls happened — chunking ⇒ many calls ⇒ many lock release points.
struct SlowLockedEmbedder {
	lock:        Mutex<()>,
	per_call_ms: u64,
	calls:       AtomicUsize,
}

impl SlowLockedEmbedder {
	fn new(per_call_ms: u64) -> Self {
		Self { lock: Mutex::new(()), per_call_ms, calls: AtomicUsize::new(0) }
	}

	/// Simulates the query path: acquire the same lock the warm path uses.
	/// Returns how long it waited to acquire.
	fn query_acquire_latency(&self) -> Duration {
		let start = Instant::now();
		let _guard = self.lock.lock().unwrap();
		start.elapsed()
	}
}

fn fake_vec(text: &str) -> Vec<f32> {
	let mut v = vec![0.0f32; 1024];
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	for b in text.bytes() {
		h ^= u64::from(b);
		h = h.wrapping_mul(0x0000_0100_0000_01b3);
	}
	v[(h as usize) % 1024] = 1.0;
	v
}

impl Embedder for SlowLockedEmbedder {
	fn embed_query(&self, text: &str) -> pi_knowledge_core::Result<Vec<f32>> {
		let _guard = self.lock.lock().unwrap();
		Ok(fake_vec(text))
	}

	fn embed_batch(&self, texts: &[&str]) -> pi_knowledge_core::Result<Vec<Vec<f32>>> {
		let _guard = self.lock.lock().unwrap();
		self.calls.fetch_add(1, Ordering::SeqCst);
		thread::sleep(Duration::from_millis(self.per_call_ms));
		Ok(texts.iter().map(|t| fake_vec(t)).collect())
	}

	fn dim(&self) -> usize {
		1024
	}
}

fn seed(root: &std::path::Path, n: usize) {
	let dir = root.join("!tasks/bugs");
	std::fs::create_dir_all(&dir).unwrap();
	for i in 0..n {
		std::fs::write(
			dir.join(format!("BUG-{i:04}.org")),
			format!(
				"* BUG-{i:04} item {i}\n:PROPERTIES:\n:CUSTOM_ID: BUG-{i:04}\n:KIND: \
				 bug\n:END:\n\nbody {i}\n"
			),
		)
		.unwrap();
	}
}

#[test]
fn chunked_warm_embed_releases_lock_between_chunks() {
	let cache_home = tempfile::TempDir::new().unwrap();
	// SAFETY: test owns env for its body.
	unsafe { std::env::set_var("XDG_CACHE_HOME", cache_home.path()) };
	// Small chunks → many lock-release points across the warm embed.
	unsafe { std::env::set_var("KNOWLEDGE_EMBED_CHUNK", "16") };

	let repo = tempfile::TempDir::new().unwrap();
	seed(repo.path(), 320); // 320 / 16 = 20 chunks.

	let embedder = Arc::new(SlowLockedEmbedder::new(15)); // 20 chunks * 15ms ≈ 300ms warm.

	// Warm-load on a background thread.
	let emb_warm = Arc::clone(&embedder);
	let repo_path = repo.path().to_path_buf();
	let warm = thread::spawn(move || {
		let p = WarmProgress::new();
		let started = Instant::now();
		let lane = OrgLane::warm_load_with(&repo_path, &p, &*emb_warm, |_| {}).expect("warm");
		(lane.items.len(), started.elapsed())
	});

	// Give the warm a moment to enter the embed phase, then fire a query embed
	// against the SAME lock. With chunking it should acquire within ~one chunk
	// (≤ a few * per_call_ms); pre-fix (one giant batch) it would block for the
	// whole warm (~300ms).
	thread::sleep(Duration::from_millis(40));
	let q_start = Instant::now();
	let latency = embedder.query_acquire_latency();
	let total_q = q_start.elapsed();

	let (item_count, warm_elapsed) = warm.join().unwrap();
	assert!(item_count >= 320, "corpus seeded");

	// The query must NOT have waited for the whole warm batch. Allow generous
	// slack for scheduling, but require it to be a fraction of the warm time.
	assert!(total_q < warm_elapsed, "query acquired mid-warm: q={total_q:?} warm={warm_elapsed:?}");
	assert!(
		latency < Duration::from_millis(150),
		"query lock-acquire latency {latency:?} should be ~one chunk, not the whole warm batch \
		 ({warm_elapsed:?})"
	);
	// Sanity: the warm actually chunked (many batch calls, not one).
	assert!(
		embedder.calls.load(Ordering::SeqCst) >= 16,
		"warm embed should have chunked into many batches; got {} calls",
		embedder.calls.load(Ordering::SeqCst)
	);

	unsafe { std::env::remove_var("KNOWLEDGE_EMBED_CHUNK") };
	unsafe { std::env::remove_var("XDG_CACHE_HOME") };
}
