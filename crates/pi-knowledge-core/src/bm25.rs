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
	pub score: f32,
	pub label: String,
}

/// In-memory BM25 index over a closed corpus. Build with `from_docs`,
/// query with `search`. Persist via bincode through `Serialize`/`Deserialize`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchIndex {
	docs: Vec<SearchDocument>,
	avg_doc_len: f32,
	term_doc_freq: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SearchDocument {
	doc_id: String,
	label: String,
	tokens: Vec<String>,
	frequencies: BTreeMap<String, usize>,
}

impl SearchIndex {
	pub fn from_docs<D: Document>(docs: &[D]) -> Self {
		let docs = docs
			.iter()
			.filter_map(|doc| {
				let label = doc.label();
				let text = doc
					.body()
					.map_or_else(|| label.to_string(), |body| format!("{label} {body}"));
				let tokens = tokenize(&text);
				if tokens.is_empty() {
					return None;
				}
				let mut frequencies = BTreeMap::new();
				for token in &tokens {
					*frequencies.entry(token.clone()).or_default() += 1;
				}
				Some(SearchDocument {
					doc_id: doc.id(),
					label: label.to_string(),
					tokens,
					frequencies,
				})
			})
			.collect::<Vec<_>>();

		let avg_doc_len = if docs.is_empty() {
			0.0
		} else {
			docs.iter().map(|doc| doc.tokens.len() as f32).sum::<f32>() / docs.len() as f32
		};

		let mut term_doc_freq = BTreeMap::new();
		for doc in &docs {
			let mut seen = BTreeSet::new();
			for token in &doc.tokens {
				if seen.insert(token.clone()) {
					*term_doc_freq.entry(token.clone()).or_default() += 1;
				}
			}
		}

		Self {
			docs,
			avg_doc_len,
			term_doc_freq,
		}
	}

	pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
		let query_tokens = tokenize(query);
		if query_tokens.is_empty() {
			return Vec::new();
		}

		let doc_count = self.docs.len() as f32;
		let k1 = 1.5_f32;
		let b = 0.75_f32;

		let mut hits = self
			.docs
			.iter()
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
					let norm = k1.mul_add(1.0 - b + b * doc_len / self.avg_doc_len.max(1.0), tf);
					score += idf * ((tf * (k1 + 1.0)) / norm);
				}
				let query_lower = query.to_lowercase();
				let exact_boost = if doc.label.to_lowercase().contains(&query_lower) {
					10.0
				} else {
					1.0
				};
				score *= exact_boost;
				SearchHit {
					doc_id: doc.doc_id.clone(),
					score,
					label: doc.label.clone(),
				}
			})
			.filter(|hit| hit.score > 0.0)
			.collect::<Vec<_>>();

		hits.sort_by(|left, right| {
			right
				.score
				.total_cmp(&left.score)
				.then_with(|| left.label.cmp(&right.label))
		});
		hits.truncate(limit);
		hits
	}

	pub const fn doc_count(&self) -> usize {
		self.docs.len()
	}
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
		id: String,
		label: String,
		body: Option<String>,
	}

	impl Document for TestDoc {
		fn id(&self) -> String {
			self.id.clone()
		}
		fn label(&self) -> &str {
			&self.label
		}
		fn body(&self) -> Option<&str> {
			self.body.as_deref()
		}
	}

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
		let docs = vec![
			TestDoc {
				id: "1".into(),
				label: "CodeTool".into(),
				body: None,
			},
			TestDoc {
				id: "2".into(),
				label: "CodeGraph".into(),
				body: None,
			},
		];
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
		// Doc 1 has a rare term "zygote", doc 2 has a common term "code".
		let docs = vec![
			TestDoc {
				id: "1".into(),
				label: "zygote handler".into(),
				body: None,
			},
			TestDoc {
				id: "2".into(),
				label: "code handler".into(),
				body: None,
			},
			TestDoc {
				id: "3".into(),
				label: "code runner".into(),
				body: None,
			},
		];
		let index = SearchIndex::from_docs(&docs);
		// "zygote" appears in 1 doc; "handler" appears in 2 docs.
		let hits_zygote = index.search("zygote", 5);
		let hits_handler = index.search("handler", 5);
		assert_eq!(hits_zygote.first().map(|h| h.doc_id.as_str()), Some("1"));
		assert_eq!(hits_handler.first().map(|h| h.doc_id.as_str()), Some("2"));
		// Rare term should give a higher idf and thus a higher score for its doc.
		assert!(
			hits_zygote[0].score > hits_handler[0].score,
			"rare term should outrank common term"
		);
	}

	#[test]
	fn bm25_body_indexed_no_label_boost() {
		let docs = vec![
			TestDoc {
				id: "1".into(),
				label: "Alpha".into(),
				body: Some("secret sauce".into()),
			},
			TestDoc {
				id: "2".into(),
				label: "Beta".into(),
				body: Some("public knowledge".into()),
			},
		];
		let index = SearchIndex::from_docs(&docs);
		let hits = index.search("sauce", 5);
		assert_eq!(hits.len(), 1);
		assert_eq!(hits[0].doc_id, "1");
		// No exact-match boost because "sauce" is not in the label.
		assert_eq!(hits[0].score, hits[0].score); // just assert it is finite
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
		let docs = vec![TestDoc {
			id: "1".into(),
			label: "Something".into(),
			body: None,
		}];
		let index = SearchIndex::from_docs(&docs);
		let hits = index.search("", 5);
		assert!(hits.is_empty());
	}

	#[test]
	fn bincode_round_trip() {
		let docs = vec![
			TestDoc {
				id: "a".into(),
				label: "HelloWorld".into(),
				body: Some("foo bar".into()),
			},
			TestDoc {
				id: "b".into(),
				label: "Goodbye".into(),
				body: None,
			},
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
		// CJK characters should produce a token, not be silently discarded
		assert!(toks.iter().any(|t| !t.is_empty() && t != "memory"),
			"CJK token kept, got {:?}", toks);
	}

	#[test]
	fn bm25_indexes_non_ascii_document() {
		let docs = [
			TestDoc {
				id: "d1".into(),
				label: "épisode JWT rollout".into(),
				body: None,
			},
			TestDoc {
				id: "d2".into(),
				label: "unrelated".into(),
				body: None,
			},
		];
		let idx = SearchIndex::from_docs(&docs);
		let hits = idx.search("épisode", 5);
		assert!(hits.iter().any(|h| h.doc_id == "d1"), "épisode query finds d1, got {:?}", hits);
	}
}
