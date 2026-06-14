//! BUG-474/476 end-to-end: verify the org-lane vector cache actually skips
//! re-embedding on a warm corpus, re-embeds only changed items, and bumps
//! progress incrementally — exercised against a COPY of the live repo corpus
//! in an isolated tempdir (safe subpath; never touches the real cache).

use std::{
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
};

use pi_knowledge_core::recall::Embedder;
use pi_knowledge_worker::lane_org::{OrgLane, WarmProgress};

/// Deterministic embedder that counts how many texts it embedded. Vector is a
/// cheap hash-derived unit-ish vector; recall quality irrelevant here — we test
/// the cache control flow, not embedding fidelity.
struct CountingEmbedder {
	embedded: AtomicUsize,
	calls:    AtomicUsize,
}

impl CountingEmbedder {
	fn new() -> Self {
		Self { embedded: AtomicUsize::new(0), calls: AtomicUsize::new(0) }
	}
}

fn fake_vector(text: &str) -> Vec<f32> {
	let mut v = vec![0.0f32; 1024];
	let mut h: u64 = 0xcbf2_9ce4_8422_2325;
	for b in text.bytes() {
		h ^= u64::from(b);
		h = h.wrapping_mul(0x0000_0100_0000_01b3);
	}
	// Scatter a few non-zero components deterministically.
	for i in 0..8 {
		let idx = ((h >> (i * 5)) as usize) % 1024;
		v[idx] = 1.0;
	}
	v
}

impl Embedder for CountingEmbedder {
	fn embed_query(&self, text: &str) -> pi_knowledge_core::Result<Vec<f32>> {
		Ok(fake_vector(text))
	}

	fn embed_batch(&self, texts: &[&str]) -> pi_knowledge_core::Result<Vec<Vec<f32>>> {
		self.calls.fetch_add(1, Ordering::SeqCst);
		self.embedded.fetch_add(texts.len(), Ordering::SeqCst);
		Ok(texts.iter().map(|t| fake_vector(t)).collect())
	}

	fn dim(&self) -> usize {
		1024
	}
}

/// Recursively copy `src` into `dst` (files + dirs). Small helper so the test
/// runs against a real corpus copy without depending on a crate.
fn copy_dir(src: &Path, dst: &Path) {
	std::fs::create_dir_all(dst).expect("mkdir dst");
	for entry in std::fs::read_dir(src).expect("read_dir") {
		let entry = entry.expect("entry");
		let path = entry.path();
		let target = dst.join(entry.file_name());
		if path.is_dir() {
			copy_dir(&path, &target);
		} else if path.is_file() {
			std::fs::copy(&path, &target).expect("copy file");
		}
	}
}

/// Seed a small synthetic corpus when the live repo corpus isn't reachable
/// from the test's CWD (e.g. packaged/CI checkout). Keeps the test hermetic.
fn seed_synthetic(root: &Path) {
	let dir = root.join("!tasks/bugs");
	std::fs::create_dir_all(&dir).expect("mk tasks");
	for i in 0..40 {
		let body = format!(
			"* BUG-{i:03} synthetic item number {i}\n\
			 :PROPERTIES:\n:CUSTOM_ID: BUG-{i:03}-synthetic\n:KIND: bug\n:END:\n\n\
			 Body text for synthetic item {i} with enough words to embed.\n"
		);
		std::fs::write(dir.join(format!("BUG-{i:03}-synthetic.org")), body).expect("write");
	}
}

fn setup_corpus(root: &Path) {
	// Prefer a copy of the live repo's !tasks/.spell-memory so the test
	// reflects real corpus shape; fall back to synthetic if not present.
	let live_tasks = Path::new("!tasks");
	if live_tasks.is_dir() {
		copy_dir(live_tasks, &root.join("!tasks"));
		let mem = Path::new(".spell/memory");
		if mem.is_dir() {
			copy_dir(mem, &root.join(".spell/memory"));
		}
	} else {
		seed_synthetic(root);
	}
}

#[test]
fn warm_corpus_embeds_zero_on_second_load() {
	// Isolate the cache base so we never touch the real ~/.cache/spell.
	let cache_home = tempfile::TempDir::new().expect("cache home");
	// SAFETY: single-threaded test setup; this test owns the env for its body.
	unsafe { std::env::set_var("XDG_CACHE_HOME", cache_home.path()) };

	let repo = tempfile::TempDir::new().expect("repo");
	setup_corpus(repo.path());

	let embedder = Arc::new(CountingEmbedder::new());

	// --- Cold warm: embeds the whole corpus once. ---
	let p1 = WarmProgress::new();
	let lane1 = OrgLane::warm_load_with(repo.path(), &p1, &*embedder, |_| {}).expect("cold warm");
	let cold_embedded = embedder.embedded.load(Ordering::SeqCst);
	let item_count = lane1.items.len();
	assert!(item_count > 0, "corpus should have items");
	assert_eq!(cold_embedded, item_count, "cold warm embeds every item once");
	// Progress reached the total.
	assert_eq!(p1.done(), item_count, "progress.done reaches total after cold");

	// --- Warm warm: identical corpus → cache hit → ZERO embeds. ---
	let embedder2 = Arc::new(CountingEmbedder::new());
	let p2 = WarmProgress::new();
	let lane2 = OrgLane::warm_load_with(repo.path(), &p2, &*embedder2, |_| {}).expect("warm warm");
	let warm_embedded = embedder2.embedded.load(Ordering::SeqCst);
	assert_eq!(lane2.items.len(), item_count, "same corpus, same item count");
	assert_eq!(warm_embedded, 0, "warm warm re-embeds nothing (full cache hit)");
	assert!(!lane2.vec.is_empty(), "vector lane reloaded from cache, not empty");
	assert_eq!(p2.done(), item_count, "progress still completes on cache-hit warm");

	unsafe { std::env::remove_var("XDG_CACHE_HOME") };
}

#[test]
fn editing_one_file_reembeds_only_its_items() {
	let cache_home = tempfile::TempDir::new().expect("cache home");
	// SAFETY: test owns env for its body.
	unsafe { std::env::set_var("XDG_CACHE_HOME", cache_home.path()) };

	let repo = tempfile::TempDir::new().expect("repo");
	// Use synthetic so we control exactly one file's mutation.
	seed_synthetic(repo.path());

	let embedder = Arc::new(CountingEmbedder::new());
	let p1 = WarmProgress::new();
	let lane1 = OrgLane::warm_load_with(repo.path(), &p1, &*embedder, |_| {}).expect("cold");
	let total = lane1.items.len();
	assert_eq!(embedder.embedded.load(Ordering::SeqCst), total);

	// Edit exactly one item's file (changes its embed text → content hash).
	let edited = repo.path().join("!tasks/bugs/BUG-007-synthetic.org");
	std::fs::write(
		&edited,
		"* BUG-007 synthetic item number 7 EDITED COMPLETELY\n\
		 :PROPERTIES:\n:CUSTOM_ID: BUG-007-synthetic\n:KIND: bug\n:END:\n\n\
		 New body content entirely different now.\n",
	)
	.expect("edit");

	let embedder2 = Arc::new(CountingEmbedder::new());
	let p2 = WarmProgress::new();
	let _lane2 = OrgLane::warm_load_with(repo.path(), &p2, &*embedder2, |_| {}).expect("warm");
	let reembedded = embedder2.embedded.load(Ordering::SeqCst);
	assert_eq!(reembedded, 1, "only the one edited item re-embeds; got {reembedded}");

	unsafe { std::env::remove_var("XDG_CACHE_HOME") };
}
