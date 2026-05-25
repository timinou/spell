use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// A document indexable by BM25. Implementors expose the strings that
/// make up the searchable surface.
pub trait Document {
	/// Stable identifier carried through into `SearchHit::doc_id`.
	fn id(&self) -> String;
	/// Primary searchable text (label / title). Receives the 10× exact-match
	/// boost when the query lowercase is a substring.
	fn label(&self) -> &str;
	/// Optional secondary text indexed at lower weight (body). Tokens go into
	/// the same inverted index but exact-match boost is label-only.
	fn body(&self) -> Option<&str> { None }
}

/// A search hit, generic over the document id type the consumer maps back to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchHit {
	pub doc_id: String,
	pub score:  f32,
	pub label:  String,
}

/// Errors returned by mutating operations on [`SearchIndex`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexError {
	/// `add_doc` called with an id already present. Caller should use
	/// `upsert_doc` if replacement was intended.
	DuplicateId(String),
	/// Document text tokenized to an empty set; cannot be indexed. Same
	/// policy as `from_docs`, which silently skips such docs.
	EmptyDocument(String),
}

impl std::fmt::Display for IndexError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::DuplicateId(id) => write!(f, "document id already indexed: {id}"),
			Self::EmptyDocument(id) => write!(f, "document {id} has no indexable tokens"),
		}
	}
}

impl std::error::Error for IndexError {}

/// In-memory BM25 index over a mutable corpus. Build with `from_docs` for
/// bulk construction, then mutate via [`add_doc`](Self::add_doc) /
/// [`remove_doc`](Self::remove_doc) / [`upsert_doc`](Self::upsert_doc) /
/// [`upsert_batch`](Self::upsert_batch). Persist via bincode through
/// `Serialize` / `Deserialize`.
///
/// ### Invariants (held by every mutating op)
///
/// - `total_tokens == Σ doc.tokens.len()` over live docs.
/// - `live_count == |{i : docs[i] = Some(_)}|`.
/// - `id_to_index[id] == i  ⇒  docs[i] = Some(d) ∧ d.doc_id == id`.
/// - `term_doc_freq[t] == |{d live : t ∈ d.frequencies.keys()}|` for every
///   live term; absent terms imply zero (no zero-valued entries kept).
///
/// ### Tombstones
///
/// `remove_doc` leaves `None` slots in `docs`. Positions are stable across
/// removals so existing `id_to_index` mappings stay valid. Run
/// [`compact`](Self::compact) when the tombstone ratio matters; semantics
/// are invariant under compaction.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchIndex {
	/// Live + tombstoned slots. Iterate via `filter_map(Option::as_ref)`.
	docs:          Vec<Option<SearchDocument>>,
	/// O(log n) doc_id → docs-index lookup.
	id_to_index:   BTreeMap<String, usize>,
	/// Running sum of live doc token counts; drives `avg_doc_len`.
	total_tokens:  u64,
	/// Live doc count (excludes tombstoned slots).
	live_count:    u32,
	/// Document frequency per term across live docs.
	term_doc_freq: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchDocument {
	doc_id:      String,
	label:       String,
	tokens:      Vec<String>,
	frequencies: BTreeMap<String, usize>,
}

impl SearchIndex {
	// ── Bulk construction ──────────────────────────────────────────────────

	/// Build a fresh index from a closed corpus. Documents whose tokenized
	/// text is empty are silently skipped (same policy as the pre-incremental
	/// API). For incremental construction starting from empty, prefer
	/// `SearchIndex::default()` + `upsert_batch`.
	pub fn from_docs<D: Document>(docs: &[D]) -> Self {
		let mut index = Self::default();
		for doc in docs {
			if let Ok(sd) = SearchDocument::build(doc) {
				index.insert_validated(sd);
			}
		}
		index
	}

	// ── Incremental mutations ──────────────────────────────────────────────

	/// Insert a new document. Errors if the id is already present
	/// ([`IndexError::DuplicateId`]) or the document tokenizes to empty
	/// ([`IndexError::EmptyDocument`]). Use [`upsert_doc`](Self::upsert_doc)
	/// to replace existing entries.
	pub fn add_doc<D: Document>(&mut self, doc: D) -> Result<(), IndexError> {
		let id = doc.id();
		if self.id_to_index.contains_key(&id) {
			return Err(IndexError::DuplicateId(id));
		}
		let sd = SearchDocument::build(&doc)?;
		self.insert_validated(sd);
		Ok(())
	}

	/// Remove the document with `id`. Returns whether anything was removed.
	/// Decrements `term_doc_freq` for every term unique to the removed doc;
	/// entries that hit zero are pruned so the no-zero invariant holds.
	pub fn remove_doc(&mut self, id: &str) -> bool {
		let Some(idx) = self.id_to_index.remove(id) else {
			return false;
		};
		let Some(slot) = self.docs.get_mut(idx) else {
			return false;
		};
		let Some(doc) = slot.take() else {
			return false;
		};
		self.total_tokens = self.total_tokens.saturating_sub(doc.tokens.len() as u64);
		self.live_count = self.live_count.saturating_sub(1);
		for term in unique_terms(&doc.frequencies) {
			let should_prune = match self.term_doc_freq.get_mut(&term) {
				Some(count) => {
					*count = count.saturating_sub(1);
					*count == 0
				},
				None => false,
			};
			if should_prune {
				self.term_doc_freq.remove(&term);
			}
		}
		true
	}

	/// Replace-or-insert by id. The new document is validated _before_ any
	/// removal of the existing entry; on `IndexError::EmptyDocument` the old
	/// state is preserved unchanged. Idempotent across repeated calls with
	/// equal input.
	pub fn upsert_doc<D: Document>(&mut self, doc: D) -> Result<(), IndexError> {
		let sd = SearchDocument::build(&doc)?;
		let id = sd.doc_id.clone();
		if self.id_to_index.contains_key(&id) {
			self.remove_doc(&id);
		}
		self.insert_validated(sd);
		Ok(())
	}

	/// Bulk upsert. Empty documents are silently skipped (matches `from_docs`
	/// policy). Duplicate ids within `docs` cause the **last non-empty**
	/// occurrence to win — an empty trailing entry for an id does NOT
	/// remove a preceding non-empty one (consistent with `upsert_doc`
	/// returning `Err(EmptyDocument)` without mutating existing state).
	pub fn upsert_batch<I, D>(&mut self, docs: I)
	where
		I: IntoIterator<Item = D>,
		D: Document,
	{
		for doc in docs {
			let _ = self.upsert_doc(doc);
		}
	}

	// ── Maintenance ────────────────────────────────────────────────────────

	/// Reclaim tombstoned slots. Live docs keep their relative order but
	/// move to consecutive positions; `id_to_index` is rebuilt to match.
	/// Search results are invariant under compaction modulo tie-order
	/// (which depends on iteration position for equal-score-equal-label docs).
	pub fn compact(&mut self) {
		let compacted: Vec<Option<SearchDocument>> =
			self.docs.drain(..).filter(Option::is_some).collect();
		let mut id_to_index = BTreeMap::new();
		for (idx, slot) in compacted.iter().enumerate() {
			if let Some(doc) = slot {
				id_to_index.insert(doc.doc_id.clone(), idx);
			}
		}
		self.docs = compacted;
		self.id_to_index = id_to_index;
	}

	/// Live document count (tombstones excluded).
	pub const fn doc_count(&self) -> usize {
		self.live_count as usize
	}

	/// Live document count; alias for [`doc_count`](Self::doc_count).
	pub const fn len(&self) -> usize {
		self.doc_count()
	}

	/// Whether the index has any live documents.
	pub const fn is_empty(&self) -> bool {
		self.live_count == 0
	}

	/// Total slot count including tombstones. Diagnostic only.
	pub fn capacity(&self) -> usize {
		self.docs.len()
	}

	/// Average live-doc token length. Returns 0.0 on an empty index.
	pub fn avg_doc_len(&self) -> f32 {
		if self.live_count == 0 {
			0.0
		} else {
			self.total_tokens as f32 / self.live_count as f32
		}
	}

	// ── Search ─────────────────────────────────────────────────────────────

	pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let query_tokens = tokenize(query);
		if query_tokens.is_empty() || self.live_count == 0 {
			return Vec::new();
		}

		let doc_count = self.live_count as f32;
		let avg_doc_len = self.avg_doc_len().max(1.0);
		let k1 = 1.5_f32;
		let b = 0.75_f32;
		let query_lower = query.to_lowercase();

		let mut hits = self
			.docs
			.iter()
			.filter_map(Option::as_ref)
			.map(|doc| {
				let doc_len = doc.tokens.len() as f32;
				let mut score = 0.0_f32;
				for token in &query_tokens {
					let tf = *doc.frequencies.get(token).unwrap_or(&0) as f32;
					if tf == 0.0 {
						continue;
					}
					let df = *self.term_doc_freq.get(token).unwrap_or(&0) as f32;
					let idf = ((doc_count - df + 0.5) / (df + 0.5)).ln_1p();
					let norm = k1.mul_add(1.0 - b + b * doc_len / avg_doc_len, tf);
					score += idf * ((tf * (k1 + 1.0)) / norm);
				}
				let exact_boost = if doc.label.to_lowercase().contains(&query_lower) {
					10.0
				} else {
					1.0
				};
				score *= exact_boost;
				SearchHit {
					doc_id: doc.doc_id.clone(),
					score,
					label:  doc.label.clone(),
				}
			})
			.filter(|hit| hit.score > 0.0)
			.collect::<Vec<_>>();

		hits.sort_by(|left, right| {
			right
				.score
				.total_cmp(&left.score)
				.then_with(|| left.label.cmp(&right.label))
				.then_with(|| left.doc_id.cmp(&right.doc_id))
		});
		hits.truncate(limit);
		hits
	}

	// ── Private helpers ────────────────────────────────────────────────────

	/// Insert a pre-validated SearchDocument. Reuses a tombstoned slot if
	/// any; otherwise appends. Caller has already validated id-uniqueness.
	fn insert_validated(&mut self, doc: SearchDocument) {
		let idx = self.allocate_slot();
		self.total_tokens += doc.tokens.len() as u64;
		self.live_count += 1;
		for term in unique_terms(&doc.frequencies) {
			*self.term_doc_freq.entry(term).or_insert(0) += 1;
		}
		self.id_to_index.insert(doc.doc_id.clone(), idx);
		self.docs[idx] = Some(doc);
	}

	/// Find a free slot (None) or append; returns the slot index.
	fn allocate_slot(&mut self) -> usize {
		for (idx, slot) in self.docs.iter().enumerate() {
			if slot.is_none() {
				return idx;
			}
		}
		self.docs.push(None);
		self.docs.len() - 1
	}
}

impl SearchDocument {
	fn build<D: Document>(doc: &D) -> Result<Self, IndexError> {
		let id = doc.id();
		let label = doc.label();
		let text = doc
			.body()
			.map_or_else(|| label.to_string(), |body| format!("{label} {body}"));
		let tokens = tokenize(&text);
		if tokens.is_empty() {
			return Err(IndexError::EmptyDocument(id));
		}
		let mut frequencies = BTreeMap::new();
		for token in &tokens {
			*frequencies.entry(token.clone()).or_default() += 1;
		}
		Ok(Self {
			doc_id: id,
			label: label.to_string(),
			tokens,
			frequencies,
		})
	}
}

fn unique_terms(frequencies: &BTreeMap<String, usize>) -> BTreeSet<String> {
	frequencies.keys().cloned().collect()
}

fn tokenize(text: &str) -> Vec<String> {
	let mut tokens = Vec::new();
	for part in text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
		if part.is_empty() {
			continue;
		}
		let lower = part.to_lowercase();
		tokens.push(lower.clone());

		let camel = split_camel_case(part);
		if camel.len() > 1 {
			for seg in &camel {
				let seg_lower = seg.to_lowercase();
				if seg_lower != lower {
					tokens.push(seg_lower);
				}
			}
		}

		if lower.contains('_') {
			for seg in lower.split('_').filter(|s| !s.is_empty()) {
				tokens.push(seg.to_string());
			}
		}
	}
	tokens.sort();
	tokens.dedup();
	tokens
}

fn split_camel_case(s: &str) -> Vec<String> {
	let mut parts = Vec::new();
	let mut current = String::new();
	let chars: Vec<char> = s.chars().collect();
	for i in 0..chars.len() {
		if chars[i].is_uppercase() && !current.is_empty() {
			let prev_lower = i > 0 && chars[i - 1].is_lowercase();
			let next_lower = i + 1 < chars.len() && chars[i + 1].is_lowercase();
			if prev_lower || (next_lower && current.len() > 1) {
				parts.push(std::mem::take(&mut current));
			}
		}
		current.push(chars[i]);
	}
	if !current.is_empty() {
		parts.push(current);
	}
	parts
}

#[cfg(test)]
mod tests {
	use super::*;

	#[derive(Debug, Clone)]
	struct TestDoc {
		id:    String,
		label: String,
		body:  Option<String>,
	}

	impl Document for TestDoc {
		fn id(&self) -> String { self.id.clone() }
		fn label(&self) -> &str { &self.label }
		fn body(&self) -> Option<&str> { self.body.as_deref() }
	}

	fn doc(id: &str, label: &str) -> TestDoc {
		TestDoc { id: id.into(), label: label.into(), body: None }
	}

	fn doc_with_body(id: &str, label: &str, body: &str) -> TestDoc {
		TestDoc { id: id.into(), label: label.into(), body: Some(body.into()) }
	}

	// ── Existing coverage (preserved unchanged) ────────────────────────

	#[test]
	fn tokenize_camel_case() {
		let tokens = tokenize("FluidOrchestrator");
		assert!(tokens.contains(&"fluid".to_string()));
		assert!(tokens.contains(&"orchestrator".to_string()));
		assert!(tokens.contains(&"fluidorchestrator".to_string()));
	}

	#[test]
	fn tokenize_snake_case() {
		let tokens = tokenize("build_system_prompt");
		assert!(tokens.contains(&"build".to_string()));
		assert!(tokens.contains(&"system".to_string()));
		assert!(tokens.contains(&"prompt".to_string()));
	}

	#[test]
	fn tokenize_mixed() {
		let tokens = tokenize("getHTTPResponse");
		assert!(tokens.contains(&"get".to_string()));
		assert!(tokens.contains(&"http".to_string()));
		assert!(tokens.contains(&"response".to_string()));
	}

	#[test]
	fn bm25_prefers_exact_match() {
		let docs = vec![doc("1", "CodeTool"), doc("2", "CodeGraph")];
		let index = SearchIndex::from_docs(&docs);
		let hits = index.search("CodeTool", 5);
		assert_eq!(hits.first().map(|h| h.doc_id.as_str()), Some("1"));
		assert!(
			hits[0].score > hits[1].score * 10.0,
			"exact match should be >10× boosted"
		);
	}

	#[test]
	fn bm25_ranks_by_idf() {
		let docs = vec![
			doc("1", "zygote handler"),
			doc("2", "code handler"),
			doc("3", "code runner"),
		];
		let index = SearchIndex::from_docs(&docs);
		let hits_zygote = index.search("zygote", 5);
		let hits_handler = index.search("handler", 5);
		assert_eq!(hits_zygote.first().map(|h| h.doc_id.as_str()), Some("1"));
		assert_eq!(hits_handler.first().map(|h| h.doc_id.as_str()), Some("2"));
		assert!(
			hits_zygote[0].score > hits_handler[0].score,
			"rare term should outrank common term"
		);
	}

	#[test]
	fn bm25_body_indexed_no_label_boost() {
		let docs = vec![
			doc_with_body("1", "Alpha", "secret sauce"),
			doc_with_body("2", "Beta", "public knowledge"),
		];
		let index = SearchIndex::from_docs(&docs);
		let hits = index.search("sauce", 5);
		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].doc_id, "1");
		assert!(hits[0].score > 0.0);
	}

	#[test]
	fn empty_corpus_returns_empty() {
		let index: SearchIndex = SearchIndex::default();
		let hits = index.search("anything", 5);
		assert!(hits.is_empty());
	}

	#[test]
	fn empty_query_returns_empty() {
		let docs = vec![doc("1", "Something")];
		let index = SearchIndex::from_docs(&docs);
		let hits = index.search("", 5);
		assert!(hits.is_empty());
	}

	#[test]
	fn bincode_round_trip() {
		let docs = vec![
			doc_with_body("a", "HelloWorld", "foo bar"),
			doc("b", "Goodbye"),
		];
		let index = SearchIndex::from_docs(&docs);
		let before = index.search("hello", 5);

		let encoded = bincode::serialize(&index).unwrap();
		let decoded: SearchIndex = bincode::deserialize(&encoded).unwrap();
		let after = decoded.search("hello", 5);

		assert_eq!(before, after);
	}

	#[test]
	fn tokenize_keeps_non_ascii() {
		let toks = tokenize("Cadrage de l'épisode");
		assert!(toks.iter().any(|t| t == "épisode"), "épisode token kept, got {:?}", toks);
		assert!(toks.iter().any(|t| t == "cadrage"));
	}

	#[test]
	fn tokenize_cjk_corpus_indexable() {
		let toks = tokenize("記憶 memory");
		assert!(toks.iter().any(|t| !t.is_empty() && t != "memory"),
			"CJK token kept, got {:?}", toks);
	}

	#[test]
	fn bm25_indexes_non_ascii_document() {
		let docs = [doc("d1", "épisode JWT rollout"), doc("d2", "unrelated")];
		let idx = SearchIndex::from_docs(&docs);
		let hits = idx.search("épisode", 5);
		assert!(hits.iter().any(|h| h.doc_id == "d1"), "épisode query finds d1, got {:?}", hits);
	}

	// ── Incremental API: I1-I10 invariant suite ────────────────────────

	/// I1 — `add(D) + remove(D.id)` returns the index to its pre-state.
	#[test]
	fn i1_add_then_remove_is_no_op() {
		let seed = vec![doc("a", "alpha"), doc("b", "beta gamma")];
		let base = SearchIndex::from_docs(&seed);
		let base_hits = base.search("beta", 10);

		let mut idx = SearchIndex::from_docs(&seed);
		idx.add_doc(doc("c", "ephemeral")).expect("add succeeds");
		assert!(idx.remove_doc("c"), "removal must succeed");

		assert_eq!(idx.doc_count(), base.doc_count());
		assert_eq!(idx.total_tokens, base.total_tokens);
		assert_eq!(idx.search("beta", 10), base_hits);
		assert_eq!(idx.search("ephemeral", 10), Vec::<SearchHit>::new());
	}

	/// I2 — `remove(id)` purges id-unique terms from the inverted index.
	#[test]
	fn i2_remove_purges_terms() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "unique_term_xyz123")).unwrap();
		idx.add_doc(doc("b", "shared")).unwrap();
		assert!(idx.term_doc_freq.contains_key("unique_term_xyz123"));

		idx.remove_doc("a");
		assert!(
			!idx.term_doc_freq.contains_key("unique_term_xyz123"),
			"id-unique term must be pruned, term_doc_freq={:?}",
			idx.term_doc_freq,
		);
		assert!(
			idx.term_doc_freq.contains_key("shared"),
			"still-referenced term must remain",
		);
	}

	/// I3 — `from_docs(corpus)` is observationally equivalent to
	/// `empty.upsert_batch(corpus)` (same hits, same scores per query).
	#[test]
	fn i3_bulk_equals_iterative_upsert() {
		let corpus = vec![
			doc("a", "alpha gamma"),
			doc("b", "beta gamma delta"),
			doc("c", "epsilon delta"),
			doc_with_body("d", "zeta", "alpha gamma beta"),
		];
		let bulk = SearchIndex::from_docs(&corpus);

		let mut iter = SearchIndex::default();
		for d in &corpus {
			iter.upsert_doc(d.clone()).expect("upsert succeeds");
		}

		for q in ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "nomatch"] {
			assert_eq!(
				bulk.search(q, 10),
				iter.search(q, 10),
				"query {q} differs between bulk and iterative",
			);
		}
	}

	/// I4 — `upsert_batch(xs)` is equivalent to a loop of `upsert_doc`.
	#[test]
	fn i4_batch_equals_loop() {
		let corpus = vec![
			doc("a", "alpha"),
			doc("b", "beta"),
			doc("c", "gamma"),
		];

		let mut batched = SearchIndex::default();
		batched.upsert_batch(corpus.clone());

		let mut looped = SearchIndex::default();
		for d in &corpus {
			looped.upsert_doc(d.clone()).unwrap();
		}

		for q in ["alpha", "beta", "gamma"] {
			assert_eq!(batched.search(q, 10), looped.search(q, 10));
		}
	}

	/// I5 — running counters stay consistent across all mutating ops.
	#[test]
	fn i5_running_avg_correctness() {
		let mut idx = SearchIndex::default();
		assert_eq!(idx.avg_doc_len(), 0.0);

		idx.add_doc(doc("a", "alpha")).unwrap();
		idx.add_doc(doc("b", "beta gamma")).unwrap();
		idx.add_doc(doc("c", "delta epsilon zeta")).unwrap();

		let expected_total: u64 = idx
			.docs
			.iter()
			.filter_map(Option::as_ref)
			.map(|d| d.tokens.len() as u64)
			.sum();
		assert_eq!(idx.total_tokens, expected_total);
		assert_eq!(idx.live_count, 3);
		assert!((idx.avg_doc_len() - expected_total as f32 / 3.0).abs() < 1e-6);

		idx.remove_doc("b");
		let expected_total: u64 = idx
			.docs
			.iter()
			.filter_map(Option::as_ref)
			.map(|d| d.tokens.len() as u64)
			.sum();
		assert_eq!(idx.total_tokens, expected_total);
		assert_eq!(idx.live_count, 2);
	}

	/// W0g (P2): upsert_doc must preserve term_doc_freq invariant when
	/// replacing a doc whose old token set overlaps the new one.
	#[test]
	fn i6_upsert_preserves_term_freq_when_tokens_overlap() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "alpha beta gamma")).unwrap();
		idx.add_doc(doc("b", "alpha delta")).unwrap();
		// Pre-state: alpha:2, beta:1, gamma:1, delta:1.
		assert_eq!(idx.term_doc_freq.get("alpha"), Some(&2));
		assert_eq!(idx.term_doc_freq.get("beta"), Some(&1));

		// Replace 'a' with text dropping 'beta' and 'gamma', keeping 'alpha', adding 'epsilon'.
		idx.upsert_doc(doc("a", "alpha epsilon")).unwrap();

		// 'alpha' df unchanged (still in both docs).
		// 'beta', 'gamma' purged (were id-unique to 'a').
		// 'epsilon' added (df=1).
		// 'delta' unchanged.
		assert_eq!(idx.term_doc_freq.get("alpha"), Some(&2));
		assert!(!idx.term_doc_freq.contains_key("beta"));
		assert!(!idx.term_doc_freq.contains_key("gamma"));
		assert_eq!(idx.term_doc_freq.get("epsilon"), Some(&1));
		assert_eq!(idx.term_doc_freq.get("delta"), Some(&1));

		// Cross-check: rebuild from scratch and compare.
		let expected = SearchIndex::from_docs(&[
			doc("a", "alpha epsilon"),
			doc("b", "alpha delta"),
		]);
		assert_eq!(idx.term_doc_freq, expected.term_doc_freq);
	}

	/// W0g (P2): compact() leaves term_doc_freq, total_tokens, live_count
	/// untouched (it only rearranges slots in `docs`).
	#[test]
	fn i6_compact_preserves_term_freq_and_counters() {
		let mut idx = SearchIndex::default();
		for i in 0..5 {
			idx.add_doc(doc(&format!("d{i}"), &format!("label{i} shared"))).unwrap();
		}
		idx.remove_doc("d1");
		idx.remove_doc("d3");
		let df_before = idx.term_doc_freq.clone();
		let tokens_before = idx.total_tokens;
		let live_before = idx.live_count;

		idx.compact();

		assert_eq!(idx.term_doc_freq, df_before);
		assert_eq!(idx.total_tokens, tokens_before);
		assert_eq!(idx.live_count, live_before);
	}

	/// W0g (P2): upsert_batch's documented "last non-empty wins" contract.
	/// An empty final occurrence for an id MUST preserve the prior non-empty
	/// value (does NOT silently remove the existing doc).
	#[test]
	fn upsert_batch_empty_trailing_preserves_prior_non_empty() {
		let mut idx = SearchIndex::default();
		idx.upsert_batch(vec![
			doc("a", "first version"),
			doc("a", "   "),  // empty after tokenize — should not remove 'a'
		]);
		let hits = idx.search("first", 5);
		assert_eq!(hits.first().map(|h| h.doc_id.as_str()), Some("a"));
		assert_eq!(idx.doc_count(), 1);
	}

	/// I6 — `term_doc_freq[t] == |{d live : t ∈ d.tokens}|` after mass ops.
	#[test]
	fn i6_term_freq_invariant_after_mass_ops() {
		let mut idx = SearchIndex::default();
		for i in 0..20 {
			let label = if i % 2 == 0 { "even shared" } else { "odd shared" };
			idx.add_doc(doc(&format!("d{i}"), label)).unwrap();
		}
		// Remove odd-numbered docs.
		for i in (1..20).step_by(2) {
			assert!(idx.remove_doc(&format!("d{i}")));
		}
		// Recompute term_doc_freq from scratch over the surviving docs.
		let mut expected: BTreeMap<String, u32> = BTreeMap::new();
		for doc in idx.docs.iter().filter_map(Option::as_ref) {
			for term in doc.frequencies.keys() {
				*expected.entry(term.clone()).or_default() += 1;
			}
		}
		assert_eq!(idx.term_doc_freq, expected);
		assert!(
			!idx.term_doc_freq.contains_key("odd"),
			"orphan 'odd' must be pruned, got {:?}",
			idx.term_doc_freq,
		);
	}

	/// I7 — bincode roundtrip preserves tombstones, id_to_index, and
	/// running counters.
	#[test]
	fn i7_bincode_round_trip_preserves_incremental_state() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "alpha")).unwrap();
		idx.add_doc(doc("b", "beta")).unwrap();
		idx.add_doc(doc("c", "gamma")).unwrap();
		idx.remove_doc("b"); // tombstone in the middle
		idx.add_doc(doc("d", "delta")).unwrap(); // should reuse b's slot

		let encoded = bincode::serialize(&idx).expect("encode");
		let decoded: SearchIndex = bincode::deserialize(&encoded).expect("decode");

		assert_eq!(decoded.doc_count(), idx.doc_count());
		assert_eq!(decoded.total_tokens, idx.total_tokens);
		assert_eq!(decoded.id_to_index, idx.id_to_index);
		assert_eq!(decoded.term_doc_freq, idx.term_doc_freq);
		assert_eq!(decoded.capacity(), idx.capacity());

		for q in ["alpha", "beta", "gamma", "delta"] {
			assert_eq!(idx.search(q, 10), decoded.search(q, 10));
		}
	}

	/// I8 — `compact()` preserves observable search results.
	#[test]
	fn i8_compact_preserves_search_results() {
		let mut idx = SearchIndex::default();
		for i in 0..10 {
			idx.add_doc(doc(&format!("d{i}"), &format!("label{i} shared"))).unwrap();
		}
		for i in [1, 3, 5, 7] {
			idx.remove_doc(&format!("d{i}"));
		}
		let before = idx.search("shared", 100);
		let cap_before = idx.capacity();
		idx.compact();
		let after = idx.search("shared", 100);

		assert_eq!(before.len(), after.len());
		let before_ids: BTreeSet<_> = before.iter().map(|h| h.doc_id.as_str()).collect();
		let after_ids: BTreeSet<_> = after.iter().map(|h| h.doc_id.as_str()).collect();
		assert_eq!(before_ids, after_ids);
		assert!(idx.capacity() < cap_before, "compaction must shrink capacity");
		assert_eq!(idx.capacity(), idx.doc_count(), "no tombstones remain");
	}

	/// I9 — incremental construction produces the same hits as bulk
	/// construction. Distinct labels avoid tie-order ambiguity so we
	/// can assert exact list equality.
	#[test]
	fn i9_incremental_score_parity_vs_rebuild() {
		let corpus: Vec<TestDoc> = (0..30)
			.map(|i| {
				doc(
					&format!("d{i:02}"),
					&format!("label{i:02} kw{} kw{}", i % 5, i % 7),
				)
			})
			.collect();

		let bulk = SearchIndex::from_docs(&corpus);

		// Build incrementally with a churn pattern to exercise tombstone reuse.
		let mut inc = SearchIndex::default();
		for d in &corpus {
			inc.add_doc(d.clone()).unwrap();
		}
		// Churn: remove half, re-add, ensure final state matches bulk.
		for i in (0..30).step_by(2) {
			inc.remove_doc(&format!("d{i:02}"));
		}
		for i in (0..30).step_by(2) {
			inc.upsert_doc(corpus[i].clone()).unwrap();
		}

		for q in ["kw0", "kw1", "kw2", "kw3", "kw4", "label15"] {
			let a = bulk.search(q, 50);
			let b = inc.search(q, 50);
			assert_eq!(
				a.len(),
				b.len(),
				"query {q}: hit counts differ ({} vs {})", a.len(), b.len(),
			);
			// Compare as sets of (doc_id, score) to avoid tie-order false-positives.
			let set_a: BTreeMap<&str, f32> = a.iter().map(|h| (h.doc_id.as_str(), h.score)).collect();
			let set_b: BTreeMap<&str, f32> = b.iter().map(|h| (h.doc_id.as_str(), h.score)).collect();
			for (id, score_a) in &set_a {
				let score_b = set_b.get(id).copied().unwrap_or(f32::NAN);
				assert!(
					(score_a - score_b).abs() < 1e-5,
					"query {q} doc {id}: bulk {score_a} ≠ inc {score_b}",
				);
			}
		}
	}

	/// I10 — `add_doc` on duplicate id is a hard error; existing data
	/// is preserved.
	#[test]
	fn i10_add_doc_rejects_duplicate() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "original")).unwrap();
		let err = idx.add_doc(doc("a", "replacement")).unwrap_err();
		assert!(matches!(err, IndexError::DuplicateId(ref id) if id == "a"));
		// Original survives.
		let hits = idx.search("original", 5);
		assert_eq!(hits.first().map(|h| h.doc_id.as_str()), Some("a"));
		assert!(idx.search("replacement", 5).is_empty());
	}

	// ── Additional edge cases ──────────────────────────────────────────

	#[test]
	fn add_doc_rejects_empty_document() {
		let mut idx = SearchIndex::default();
		let err = idx.add_doc(doc("empty", "   ::!!")).unwrap_err();
		assert!(matches!(err, IndexError::EmptyDocument(ref id) if id == "empty"));
		assert_eq!(idx.doc_count(), 0);
	}

	#[test]
	fn upsert_doc_validates_before_mutating() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "keep this")).unwrap();
		// upsert with empty doc must error AND preserve original.
		let err = idx.upsert_doc(doc("a", "   ")).unwrap_err();
		assert!(matches!(err, IndexError::EmptyDocument(ref id) if id == "a"));
		let hits = idx.search("keep", 5);
		assert_eq!(hits.first().map(|h| h.doc_id.as_str()), Some("a"));
	}

	#[test]
	fn remove_doc_returns_false_when_absent() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "alpha")).unwrap();
		assert!(!idx.remove_doc("nonexistent"));
		assert_eq!(idx.doc_count(), 1);
	}

	#[test]
	fn tombstone_slot_reused_on_next_add() {
		let mut idx = SearchIndex::default();
		idx.add_doc(doc("a", "alpha")).unwrap();
		idx.add_doc(doc("b", "beta")).unwrap();
		let cap_before = idx.capacity();
		idx.remove_doc("a");
		assert_eq!(idx.capacity(), cap_before, "removal must not shrink");
		idx.add_doc(doc("c", "gamma")).unwrap();
		assert_eq!(idx.capacity(), cap_before, "add must reuse tombstoned slot");
	}

	#[test]
	fn upsert_on_missing_id_acts_as_add() {
		let mut idx = SearchIndex::default();
		idx.upsert_doc(doc("new", "freshly inserted")).unwrap();
		assert_eq!(idx.doc_count(), 1);
		let hits = idx.search("freshly", 5);
		assert_eq!(hits.first().map(|h| h.doc_id.as_str()), Some("new"));
	}

	#[test]
	fn doc_count_excludes_tombstones() {
		let mut idx = SearchIndex::default();
		for i in 0..5 {
			idx.add_doc(doc(&format!("d{i}"), &format!("label{i}"))).unwrap();
		}
		assert_eq!(idx.doc_count(), 5);
		assert_eq!(idx.len(), 5);
		assert!(!idx.is_empty());
		idx.remove_doc("d2");
		idx.remove_doc("d4");
		assert_eq!(idx.doc_count(), 3);
		assert_eq!(idx.capacity(), 5);
	}
}
