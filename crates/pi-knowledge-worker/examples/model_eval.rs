//! BUG-479 — embed-model eval: bge-m3 vs bge-small-en-v1.5 vs all-MiniLM-L6-v2.
//!
//! Hypothesis: bge-m3 (560M params, 1024-dim, multilingual) is oversized for
//! short English org titles/bodies; a small model may hold most of the recall
//! at a fraction of the embed cost.
//!
//! Run on demand (downloads models from HF on first use):
//!   cargo run -p pi-knowledge-worker --example `model_eval` --release
//!
//! Builds a synthetic query→expected-id set from a sample of the live corpus:
//! for each sampled item, the QUERY is its title (lightly perturbed) and the
//! EXPECTED hit is that item's id. Corpus docs are embedded as
//! "{title} {body[..512]}" (the same text the worker embeds). We measure
//! recall@5, MRR, embed wall-time, and dim for each model.

use std::{
	path::{Path, PathBuf},
	time::Instant,
};

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use pi_org_engine::OrgItem;

struct Doc {
	id:   String,
	text: String,
}

struct Query {
	text:        String,
	expected_id: String,
}

fn embed_text(item: &OrgItem) -> String {
	match item.body.as_ref() {
		Some(body) => format!("{} {}", item.title, body.chars().take(512).collect::<String>()),
		None => item.title.clone(),
	}
}

fn walk_org(dir: &Path, out: &mut Vec<PathBuf>) {
	let Ok(rd) = std::fs::read_dir(dir) else { return };
	for e in rd.flatten() {
		let p = e.path();
		if p.is_dir() {
			walk_org(&p, out);
		} else if p.extension().is_some_and(|x| x == "org") {
			out.push(p);
		}
	}
}

fn load_corpus(repo: &Path, cap: usize) -> Vec<OrgItem> {
	let mut files = Vec::new();
	for sub in ["!tasks", ".spell/memory"] {
		let d = repo.join(sub);
		if d.is_dir() {
			walk_org(&d, &mut files);
		}
	}
	let mut items = Vec::new();
	for f in files {
		let Ok(src) = std::fs::read_to_string(&f) else { continue };
		let path = f.to_string_lossy();
		// include_body=true so body-snippet queries have content. (NB: the
		// worker's scan_items currently passes false — it embeds title-only;
		// see the eval writeup for that separate finding.)
		if let Ok(parsed) =
			pi_org_engine::extract_items_from_source(&src, &[], "", "", &path, true)
		{
			items.extend(parsed);
		}
		if items.len() >= cap {
			break;
		}
	}
	items.truncate(cap);
	items
}

/// Lightly perturb a title into a query: drop the leading ID token + lowercase,
/// keep the descriptive words. Mimics how a human searches by topic, not id.
fn title_to_query(title: &str) -> String {
	let without_id = title
		.split_whitespace()
		.filter(|w| !w.chars().all(|c| c.is_ascii_uppercase() || c == '-' || c.is_ascii_digit()))
		.collect::<Vec<_>>()
		.join(" ");
	let q = if without_id.trim().is_empty() { title.to_string() } else { without_id };
	q.to_lowercase()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
	let mut dot = 0.0;
	let mut na = 0.0;
	let mut nb = 0.0;
	for i in 0..a.len().min(b.len()) {
		dot = a[i].mul_add(b[i], dot);
		na = a[i].mul_add(a[i], na);
		nb = b[i].mul_add(b[i], nb);
	}
	if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}

struct Metrics {
	model:        String,
	dim:          usize,
	recall_at_5:  f64,
	mrr:          f64,
	embed_ms:     u128,
	n_docs:       usize,
	n_queries:    usize,
}

fn eval_model(model: EmbeddingModel, label: &str, docs: &[Doc], queries: &[Query]) -> Metrics {
	let mut embedder = TextEmbedding::try_new(
		TextInitOptions::new(model).with_show_download_progress(true),
	)
	.expect("init model");

	let doc_texts: Vec<String> = docs.iter().map(|d| d.text.clone()).collect();
	let started = Instant::now();
	let doc_vecs = embedder.embed(doc_texts, Some(256)).expect("embed docs");
	let embed_ms = started.elapsed().as_millis();
	let dim = doc_vecs.first().map_or(0, Vec::len);

	let q_texts: Vec<String> = queries.iter().map(|q| q.text.clone()).collect();
	let q_vecs = embedder.embed(q_texts, Some(256)).expect("embed queries");

	let mut hits_at_5 = 0usize;
	let mut mrr_sum = 0.0f64;
	for (q, qv) in queries.iter().zip(q_vecs.iter()) {
		let mut scored: Vec<(usize, f32)> = doc_vecs
			.iter()
			.enumerate()
			.map(|(i, dv)| (i, cosine(qv, dv)))
			.collect();
		scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
		let rank = scored
			.iter()
			.position(|(i, _)| docs[*i].id == q.expected_id);
		if let Some(r) = rank {
			if r < 5 {
				hits_at_5 += 1;
			}
			mrr_sum += 1.0 / (r as f64 + 1.0);
		}
	}
	let n = queries.len().max(1) as f64;
	Metrics {
		model: label.to_string(),
		dim,
		recall_at_5: hits_at_5 as f64 / n,
		mrr: mrr_sum / n,
		embed_ms,
		n_docs: docs.len(),
		n_queries: queries.len(),
	}
}

fn main() {
	// Repo root = CWD (run from the workspace root).
	let repo = std::env::current_dir().expect("cwd");
	let sample: usize = std::env::var("EVAL_SAMPLE")
		.ok()
		.and_then(|v| v.parse().ok())
		.unwrap_or(200);

	let items = load_corpus(&repo, sample);
	eprintln!("loaded {} corpus items from {}", items.len(), repo.display());
	assert!(items.len() >= 20, "need a non-trivial corpus; got {}", items.len());

	let docs: Vec<Doc> = items
		.iter()
		.map(|it| Doc { id: it.id.clone(), text: embed_text(it) })
		.collect();

	// Build queries. Two modes:
	//  - EVAL_QUERY=title (default): perturbed title → expected id (easy).
	//  - EVAL_QUERY=body: a mid-body snippet (words 8..24) → expected id. Harder
	//    and more realistic ("I remember roughly what it was about"), and it does
	//    NOT contain the title verbatim, so it discriminates models.
	let mode = std::env::var("EVAL_QUERY").unwrap_or_else(|_| "title".into());
	let step = (items.len() / 40).max(1);
	let queries: Vec<Query> = items
		.iter()
		.step_by(step)
		.filter_map(|it| {
			let text = if mode == "body" {
				let body = it.body.as_deref().unwrap_or("");
				let words: Vec<&str> = body.split_whitespace().collect();
				if words.len() < 12 {
					return None; // too short to form a non-trivial body query
				}
				let end = words.len().min(24);
				words[8..end].join(" ").to_lowercase()
			} else {
				if it.title.trim().is_empty() {
					return None;
				}
				title_to_query(&it.title)
			};
			Some(Query { text, expected_id: it.id.clone() })
		})
		.collect();
	eprintln!("built {} queries (mode={mode})\n", queries.len());

	let models = [
		(EmbeddingModel::BGEM3, "bge-m3 (1024d, 560M, multilingual)"),
		(EmbeddingModel::BGESmallENV15, "bge-small-en-v1.5 (384d, 33M)"),
		(EmbeddingModel::AllMiniLML6V2, "all-MiniLM-L6-v2 (384d, 22M)"),
	];

	let mut results = Vec::new();
	for (m, label) in models {
		eprintln!("=== evaluating {label} ===");
		results.push(eval_model(m, label, &docs, &queries));
	}

	println!("\n# BUG-479 embed-model eval");
	println!("corpus sample: {} docs, {} queries\n", results[0].n_docs, results[0].n_queries);
	println!(
		"| model | dim | recall@5 | MRR | embed_ms ({} docs) |",
		results[0].n_docs
	);
	println!("|---|---|---|---|---|");
	for r in &results {
		println!(
			"| {} | {} | {:.3} | {:.3} | {} |",
			r.model, r.dim, r.recall_at_5, r.mrr, r.embed_ms
		);
	}
}
