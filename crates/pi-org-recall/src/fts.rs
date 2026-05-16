//! Tantivy BM25 full-text index keyed by org item id.

use std::{
	path::{Path, PathBuf},
	sync::Mutex,
};

use blake3::Hasher;
use tantivy::{
	Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument,
	collector::TopDocs,
	query::{BooleanQuery, Occur, QueryParser, TermQuery},
	schema::*,
	tokenizer::*,
};

use crate::error::{Error, Result};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// 12-character blake3 hex of the canonicalized repo path. Used as a stable
/// per-repo cache key so multiple checkouts don't collide.
pub fn repo_hash(root: &Path) -> Result<String> {
	let canonical = std::fs::canonicalize(root)
		.map_err(|e| Error::RepoHash(format!("{}: {e}", root.display())))?;
	let mut h = Hasher::new();
	h.update(canonical.as_os_str().as_encoded_bytes());
	Ok(h.finalize().to_hex().chars().take(12).collect())
}

/// Root of the per-machine recall cache. Resolves from `XDG_CACHE_HOME`,
/// then `$HOME/.cache/spell/recall`, then a working-directory fallback.
pub fn cache_base() -> PathBuf {
	if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
		return PathBuf::from(xdg).join("spell/recall");
	}
	if let Some(home) = std::env::var_os("HOME") {
		return PathBuf::from(home).join(".cache/spell/recall");
	}
	PathBuf::from("./.spell-cache/recall")
}

/// Per-repo cache directory: `{cache_base}/{repo_hash(root)}/`. Both the FTS
/// index (`fts/` subdirectory) and engine-level sidecars (`engine.bin`,
/// `vec.bin`) live here.
pub fn repo_cache_dir(repo_root: &Path) -> Result<PathBuf> {
	repo_cache_dir_at(repo_root, &cache_base())
}

/// Per-repo cache directory under a caller-provided base. Mainly for tests
/// that want isolation from `XDG_CACHE_HOME`.
pub fn repo_cache_dir_at(repo_root: &Path, cache_base: &Path) -> Result<PathBuf> {
	Ok(cache_base.join(repo_hash(repo_root)?))
}

fn kind_of(item: &pi_org_engine::item::OrgItem) -> &str {
	item
		.properties
		.get("KIND")
		.map(String::as_str)
		.unwrap_or("")
}

// ---------------------------------------------------------------------------
// Index struct
// ---------------------------------------------------------------------------

/// BM25 full-text index backed by Tantivy.
pub struct FtsIndex {
	index:  Index,
	schema: Schema,
	writer: Mutex<IndexWriter>,
	reader: IndexReader,
	fields: IndexedFields,
}

struct IndexedFields {
	id:    Field,
	kind:  Field,
	title: Field,
	body:  Field,
	tags:  Field,
	file:  Field,
}

impl FtsIndex {
	/// Open (or create) the FTS index at the default cache location.
	pub fn open(repo_root: &Path) -> Result<Self> {
		let cache_base = cache_base();
		Self::open_at(repo_root, &cache_base)
	}

	/// Open (or create) the FTS index at a specific cache base directory.
	///
	/// The index lives at `{cache_base}/{repo_hash}/fts/`.
	pub fn open_at(repo_root: &Path, cache_base: &Path) -> Result<Self> {
		let hash = repo_hash(repo_root)?;
		let index_dir = cache_base.join(&hash).join("fts");
		std::fs::create_dir_all(&index_dir)?;

		// --- schema ---
		let mut sb = Schema::builder();

		let title_opts = TextOptions::default().set_stored().set_indexing_options(
			TextFieldIndexing::default()
				.set_tokenizer("en_stem")
				.set_fieldnorms(true)
				.set_index_option(IndexRecordOption::WithFreqsAndPositions),
		);
		let body_opts = TextOptions::default().set_stored().set_indexing_options(
			TextFieldIndexing::default()
				.set_tokenizer("en_stem")
				.set_fieldnorms(true)
				.set_index_option(IndexRecordOption::WithFreqsAndPositions),
		);

		let id = sb.add_text_field("id", STRING | STORED);
		let kind = sb.add_text_field("kind", STRING);
		let title = sb.add_text_field("title", title_opts);
		let body = sb.add_text_field("body", body_opts);
		let tags = sb.add_text_field("tags", STRING);
		let file = sb.add_text_field("file", STORED);

		let schema = sb.build();

		// --- index ---
		let index = match Index::open_in_dir(&index_dir) {
			Ok(idx) => idx,
			Err(_) => Index::create_in_dir(&index_dir, schema.clone())?,
		};

		// Register the schema _after_ creating the index.
		// (open_or_create reads the existing schema; we need to register tokenizers on
		// it.)
		index.tokenizers().register(
			"en_stem",
			TextAnalyzer::builder(SimpleTokenizer::default())
				.filter(LowerCaser)
				.filter(AsciiFoldingFilter)
				.filter(Stemmer::new(Language::English))
				.build(),
		);

		// Validate that the on-disk schema matches ours (optional but good practice).
		let _disk_schema = index.schema();

		// --- writer ---
		let writer = index.writer(50_000_000)?;

		// --- reader ---
		let reader = index
			.reader_builder()
			.reload_policy(ReloadPolicy::OnCommitWithDelay)
			.try_into()?;

		Ok(Self {
			index,
			schema,
			writer: Mutex::new(writer),
			reader,
			fields: IndexedFields { id, kind, title, body, tags, file },
		})
	}

	/// Index (or re-index) a batch of org items.
	///
	/// For each item, any existing document with the same `id` is deleted before
	/// the new document is added. A single commit makes the batch atomically
	/// visible.
	pub fn index(&self, items: &[pi_org_engine::item::OrgItem]) -> Result<()> {
		let mut writer = self.writer.lock().unwrap();
		for item in items {
			writer.delete_term(Term::from_field_text(self.fields.id, &item.id));

			let kind_val = kind_of(item);

			// Build tags: split on whitespace/commas.
			let tags_str = item
				.properties
				.get("TAGS")
				.map(String::as_str)
				.unwrap_or("");
			let tags: Vec<&str> = tags_str
				.split(|c: char| c == ',' || c.is_whitespace())
				.map(str::trim)
				.filter(|s| !s.is_empty())
				.collect();

			let mut doc = TantivyDocument::new();
			doc.add_text(self.fields.id, &item.id);
			doc.add_text(self.fields.kind, kind_val);
			doc.add_text(self.fields.title, &item.title);
			doc.add_text(self.fields.file, &item.file);

			if let Some(ref body) = item.body {
				doc.add_text(self.fields.body, body);
			} else {
				doc.add_text(self.fields.body, "");
			}

			for tag in &tags {
				doc.add_text(self.fields.tags, tag);
			}

			writer
				.add_document(doc)
				.map_err(|e| Error::Tantivy(e.to_string()))?;
		}
		writer.commit()?;
		Ok(())
	}

	/// Search the full-text index, returning matching document ids with BM25
	/// scores.
	///
	/// * `query`  — the user's search string. Empty string → empty result.
	/// * `scope`  — optional kind filter; only items whose `kind` matches one of
	///   these are returned.
	/// * `limit`  — maximum number of results.
	pub fn search(&self, query: &str, scope: &[String], limit: usize) -> Result<Vec<(String, f32)>> {
		if query.trim().is_empty() {
			return Ok(Vec::new());
		}
		self.reader.reload()?;
		let searcher = self.reader.searcher();

		let mut query_parser =
			QueryParser::for_index(&self.index, vec![self.fields.title, self.fields.body]);
		query_parser.set_field_boost(self.fields.title, 2.0);

		let parsed = query_parser
			.parse_query(query)
			.map_err(|e| Error::Tantivy(e.to_string()))?;

		// Build the full query: optionally AND with a scope filter.
		let full_query: Box<dyn tantivy::query::Query> = if scope.is_empty() {
			parsed
		} else {
			let scope_subqueries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = scope
				.iter()
				.map(|kind| {
					let tq: Box<dyn tantivy::query::Query> = Box::new(TermQuery::new(
						Term::from_field_text(self.fields.kind, kind),
						IndexRecordOption::Basic,
					));
					(Occur::Should, tq)
				})
				.collect();

			let scope_filter = Box::new(BooleanQuery::new(scope_subqueries));

			let combined: Vec<(Occur, Box<dyn tantivy::query::Query>)> =
				vec![(Occur::Must, parsed), (Occur::Must, scope_filter)];
			Box::new(BooleanQuery::new(combined))
		};

		let collector = TopDocs::with_limit(limit).order_by_score();
		let top_docs = searcher.search(&full_query, &collector)?;

		let results: Vec<(String, f32)> = top_docs
			.into_iter()
			.map(|(score, doc_addr)| {
				let doc = searcher.doc::<TantivyDocument>(doc_addr).unwrap();
				let id_val = doc
					.get_first(self.fields.id)
					.and_then(|v| v.as_str())
					.unwrap_or("")
					.to_string();
				(id_val, score)
			})
			.collect();

		Ok(results)
	}

	/// Remove documents by their item id.
	pub fn remove(&self, ids: &[String]) -> Result<()> {
		let mut writer = self.writer.lock().unwrap();
		for id in ids {
			writer.delete_term(Term::from_field_text(self.fields.id, id));
		}
		writer.commit()?;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use tempfile::tempdir;

	use super::*;

	fn mk_item(
		id: &str,
		title: &str,
		kind: &str,
		body: Option<&str>,
	) -> pi_org_engine::item::OrgItem {
		let mut props = HashMap::new();
		props.insert("KIND".into(), kind.into());
		pi_org_engine::item::OrgItem {
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

	#[test]
	fn repo_hash_is_stable_across_calls() {
		let dir = tempdir().unwrap();
		let h1 = repo_hash(dir.path()).unwrap();
		let h2 = repo_hash(dir.path()).unwrap();
		assert_eq!(h1, h2);
		assert_eq!(h1.len(), 12);
	}

	#[test]
	fn cache_base_falls_back_to_home_when_xdg_unset() {
		let cb = cache_base();
		assert!(!cb.as_os_str().is_empty());
	}

	#[test]
	fn open_and_index_returns_results() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		let items = vec![
			mk_item("EP-1", "Authentication flow", "episode", Some("Implement login with OAuth2")),
			mk_item("EP-2", "Database schema", "episode", Some("Design the user table")),
			mk_item("CN-1", "JWT token", "concept", Some("JSON Web Token for auth")),
		];
		idx.index(&items).unwrap();

		let results = idx.search("OAuth2", &[], 10).unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].0, "EP-1");
		assert!(results[0].1 > 0.0);
	}

	#[test]
	fn scope_filter_excludes_other_kinds() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		let items = vec![
			mk_item("EP-1", "Auth flow", "episode", Some("OAuth2")),
			mk_item("EP-2", "DB design", "episode", Some("tables")),
			mk_item("CN-1", "JWT", "concept", Some("token")),
			mk_item("CN-2", "BCrypt", "concept", Some("hashing")),
		];
		idx.index(&items).unwrap();

		let results = idx.search("token", &["concept".into()], 10).unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].0, "CN-1");
	}

	#[test]
	fn stemming_matches_run_running_runs() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		let items = vec![
			mk_item("EP-1", "Running tests", "episode", Some("We run unit tests every day")),
			mk_item("EP-2", "Static analysis", "episode", Some("linter checks")),
		];
		idx.index(&items).unwrap();

		// "running" should match "run" (stemmed)
		let r1 = idx.search("running", &[], 10).unwrap();
		assert_eq!(r1.len(), 1);
		assert_eq!(r1[0].0, "EP-1");

		// "runs" should also match
		let r2 = idx.search("runs", &[], 10).unwrap();
		assert_eq!(r2.len(), 1);
		assert_eq!(r2[0].0, "EP-1");
	}

	#[test]
	fn reindex_replaces_existing_doc() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		idx.index(&[mk_item("EP-1", "Old title", "episode", Some("original content"))])
			.unwrap();
		idx.index(&[mk_item("EP-1", "New title", "episode", Some("replacement content"))])
			.unwrap();

		// search for "original" → no hit
		let r1 = idx.search("original", &[], 10).unwrap();
		assert!(r1.is_empty());

		// search for "replacement" → hit
		let r2 = idx.search("replacement", &[], 10).unwrap();
		assert_eq!(r2.len(), 1);
		assert_eq!(r2[0].0, "EP-1");
	}

	#[test]
	fn delete_doc_by_id() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		idx.index(&[
			mk_item("EP-1", "Auth", "episode", Some("OAuth2")),
			mk_item("EP-2", "DB", "episode", Some("tables")),
		])
		.unwrap();

		idx.remove(&["EP-1".into()]).unwrap();

		let results = idx.search("OAuth2", &[], 10).unwrap();
		assert!(results.is_empty());

		let results = idx.search("tables", &[], 10).unwrap();
		assert_eq!(results.len(), 1);
	}

	#[test]
	fn empty_query_returns_empty() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		idx.index(&[mk_item("EP-1", "Auth", "episode", Some("OAuth2"))])
			.unwrap();

		let results = idx.search("", &[], 10).unwrap();
		assert!(results.is_empty());

		let results = idx.search("   ", &[], 10).unwrap();
		assert!(results.is_empty());
	}

	#[test]
	fn multi_term_phrase_query() {
		let dir = tempdir().unwrap();
		let cache = tempdir().unwrap();
		let idx = FtsIndex::open_at(dir.path(), cache.path()).unwrap();

		idx.index(&[
			mk_item("EP-1", "Auth refactor", "episode", Some("Refactoring the auth module")),
			mk_item("EP-2", "Database audit", "episode", Some("Audit the auth database")),
		])
		.unwrap();

		// Phrase query: "auth refactor" should match only EP-1 (adjacent tokens)
		let results = idx.search("\"auth refactor\"", &[], 10).unwrap();
		assert_eq!(results.len(), 1);
		assert_eq!(results[0].0, "EP-1");
	}
}
