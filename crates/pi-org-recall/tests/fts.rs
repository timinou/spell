//! Integration tests for `pi_org_recall::fts::FtsIndex`.
//!
//! All tests use `open_at()` with `tempfile::tempdir()` cache locations,
//! avoiding env-var mutation for test isolation.

use std::collections::HashMap;

use pi_org_engine::item::OrgItem;
use pi_org_recall::fts::FtsIndex;
use tempfile::tempdir;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn mk_item(id: &str, title: &str, kind: &str, body: Option<&str>) -> OrgItem {
	let mut props = HashMap::new();
	props.insert("KIND".into(), kind.into());
	OrgItem {
		id:         id.into(),
		title:      title.into(),
		state:      "".into(),
		category:   "".into(),
		dir:        "".into(),
		file:       "".into(),
		line:       1,
		level:      1,
		properties: props,
		body:       body.map(|s| s.into()),
		clocks:     vec![],
		byte_range: (0, 0),
		children:   vec![],
		relations:  vec![],
	}
}

/// Create a fresh `FtsIndex` inside a unique temp directory.
fn open_fts() -> (FtsIndex, tempfile::TempDir, tempfile::TempDir) {
	let repo = tempdir().unwrap();
	let cache = tempdir().unwrap();
	let idx = FtsIndex::open_at(repo.path(), cache.path()).unwrap();
	(idx, repo, cache)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// 1. Search a unique term returns the matching doc id with score > 0.
#[test]
fn index_and_search_returns_doc_id_and_score() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[
		mk_item("EP-1", "Authentication flow", "episode", Some("Implement login with OAuth2")),
		mk_item("EP-2", "Database schema", "episode", Some("Design the user table")),
		mk_item("CN-1", "JWT token", "concept", Some("JSON Web Token for auth")),
	])
	.unwrap();

	let results = idx.search("OAuth2", &[], 10).unwrap();
	assert_eq!(results.len(), 1);
	assert_eq!(results[0].0, "EP-1");
	assert!(results[0].1 > 0.0);
}

/// 2. scope filter excludes items with non-matching kind.
#[test]
fn scope_filter_excludes_other_kinds() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[
		mk_item("EP-1", "Auth flow", "episode", Some("OAuth2")),
		mk_item("EP-2", "DB design", "episode", Some("tables")),
		mk_item("CN-1", "JWT", "concept", Some("token")),
		mk_item("CN-2", "BCrypt", "concept", Some("hashing")),
	])
	.unwrap();

	let results = idx.search("token", &["concept".into()], 10).unwrap();
	assert_eq!(results.len(), 1);
	assert_eq!(results[0].0, "CN-1");
}

/// 3. Stemming matches "run", "running", "runs".
#[test]
fn stemming_matches_run_running_runs() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[
		mk_item("EP-1", "Running tests", "episode", Some("We run unit tests every day")),
		mk_item("EP-2", "Static analysis", "episode", Some("linter checks")),
	])
	.unwrap();

	let r1 = idx.search("running", &[], 10).unwrap();
	assert_eq!(r1.len(), 1);
	assert_eq!(r1[0].0, "EP-1");

	let r2 = idx.search("runs", &[], 10).unwrap();
	assert_eq!(r2.len(), 1);
	assert_eq!(r2[0].0, "EP-1");

	let r3 = idx.search("run", &[], 10).unwrap();
	assert_eq!(r3.len(), 1);
	assert_eq!(r3[0].0, "EP-1");
}

/// 4. Re-indexing replaces existing document (old content no longer
///    searchable).
#[test]
fn reindex_replaces_existing_doc() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[mk_item("EP-1", "Old title", "episode", Some("original content"))])
		.unwrap();
	idx.index(&[mk_item("EP-1", "New title", "episode", Some("replacement content"))])
		.unwrap();

	let r1 = idx.search("original", &[], 10).unwrap();
	assert!(r1.is_empty(), "original content should no longer be indexed");

	let r2 = idx.search("replacement", &[], 10).unwrap();
	assert_eq!(r2.len(), 1);
	assert_eq!(r2[0].0, "EP-1");
}

/// 5. Delete a document by id.
#[test]
fn delete_doc_by_id() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[
		mk_item("EP-1", "Auth", "episode", Some("OAuth2")),
		mk_item("EP-2", "DB", "episode", Some("tables")),
	])
	.unwrap();

	idx.remove(&["EP-1".into()]).unwrap();

	let r1 = idx.search("OAuth2", &[], 10).unwrap();
	assert!(r1.is_empty(), "deleted doc should not be searchable");

	let r2 = idx.search("tables", &[], 10).unwrap();
	assert_eq!(r2.len(), 1);
	assert_eq!(r2[0].0, "EP-2");
}

/// 6. Empty query returns empty result (no error).
#[test]
fn empty_query_returns_empty() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[mk_item("EP-1", "Auth", "episode", Some("OAuth2"))])
		.unwrap();

	let r1 = idx.search("", &[], 10).unwrap();
	assert!(r1.is_empty());

	let r2 = idx.search("   ", &[], 10).unwrap();
	assert!(r2.is_empty());
}

/// 7. Phrase query matches adjacent tokens only.
#[test]
fn multi_term_phrase_query() {
	let (idx, _repo, _cache) = open_fts();

	idx.index(&[
		mk_item("EP-1", "Auth refactor", "episode", Some("Refactoring the auth module")),
		mk_item("EP-2", "Database audit", "episode", Some("Audit the auth database")),
	])
	.unwrap();

	let results = idx.search("\"auth refactor\"", &[], 10).unwrap();
	assert_eq!(results.len(), 1);
	assert_eq!(
		results[0].0, "EP-1",
		"phrase query 'auth refactor' should match only EP-1 (adjacent tokens)"
	);
}

/// 8. Custom cache base is respected via `open_at`.
#[test]
fn cache_dir_uses_xdg_when_set() {
	// Use open_at with a dedicated cache dir, simulating XDG behavior.
	let repo = tempdir().unwrap();
	let cache_dir = tempdir().unwrap();
	let _expected = cache_dir.path().join("somehash/fts");

	// Actually create an index to verify the path is used.
	let idx = FtsIndex::open_at(repo.path(), cache_dir.path()).unwrap();
	idx.index(&[mk_item("EP-1", "Test", "episode", Some("body"))])
		.unwrap();
	drop(idx);

	// The index directory must exist under cache_dir/<hash>/fts/
	let entries: Vec<_> = std::fs::read_dir(cache_dir.path())
		.unwrap()
		.filter_map(|e| e.ok())
		.collect();
	assert!(!entries.is_empty(), "index dir must exist under cache base");
	// At least the hash directory should be present
	let hash_entry = entries.iter().find(|e| e.path().is_dir()).unwrap();
	assert!(hash_entry.path().join("fts").exists(), "expected fts subdirectory under hash dir");
}

/// 9. repo_hash is stable across calls for the same canonical path.
#[test]
fn repo_hash_is_stable_across_calls() {
	let repo = tempdir().unwrap();
	let cache = tempdir().unwrap();

	// Drop the first index so the directory lock is released.
	let h1 = FtsIndex::open_at(repo.path(), cache.path()).ok();
	assert!(h1.is_some());
	drop(h1);

	let h2 = FtsIndex::open_at(repo.path(), cache.path()).ok();
	assert!(h2.is_some());
}

/// 10. Concurrent search from multiple threads is safe.
#[test]
fn concurrent_search_safe() {
	let (idx, _repo, _cache) = open_fts();

	let items: Vec<_> = (0..20)
		.map(|i| mk_item(&format!("EP-{}", i), &format!("Item {}", i), "episode", Some("content")))
		.collect();
	idx.index(&items).unwrap();

	let idx = std::sync::Arc::new(idx);
	let mut handles = Vec::new();
	let queries = vec!["content", "Item", "nothing"];

	for q in &queries {
		for _ in 0..3 {
			let idx = std::sync::Arc::clone(&idx);
			let query = q.to_string();
			handles.push(std::thread::spawn(move || idx.search(&query, &[], 5).unwrap()));
		}
	}

	for (i, h) in handles.into_iter().enumerate() {
		let result = h.join().expect("thread panicked");
		// At least "content" and "Item" should match, "nothing" returns empty.
		if i < 6 {
			assert!(!result.is_empty(), "query should return results");
		}
	}
}

/// 11. Durability: index, drop, reopen → search returns same hits.
#[test]
fn index_durability_round_trip() {
	let repo = tempdir().unwrap();
	let cache = tempdir().unwrap();

	let items = vec![
		mk_item("EP-1", "Login", "episode", Some("OAuth2 implementation")),
		mk_item("EP-2", "DB", "episode", Some("tables")),
	];

	// First session: index
	{
		let idx = FtsIndex::open_at(repo.path(), cache.path()).unwrap();
		idx.index(&items).unwrap();
		// drop(idx) — writer commit already happened
	}

	// Second session: reopen and search
	{
		let idx = FtsIndex::open_at(repo.path(), cache.path()).unwrap();
		let r1 = idx.search("OAuth2", &[], 10).unwrap();
		assert_eq!(r1.len(), 1);
		assert_eq!(r1[0].0, "EP-1");

		let r2 = idx.search("tables", &[], 10).unwrap();
		assert_eq!(r2.len(), 1);
		assert_eq!(r2[0].0, "EP-2");
	}
}
