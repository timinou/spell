//! PLAN-315 W3 — daemon-side code-graph lane.
//!
//! Wraps `pi_code_graph::CodeGraph` (full warm state: symbol table, BM25
//! search index, optional usearch vector index, call/ref graph) inside a
//! daemon-resident slot. Sessions issue `cg_search/cg_definition/
//! cg_references/cg_callers` over the socket instead of building their own
//! in-process CodeGraph.
//!
//! Warm-load semantics:
//! - First `open` with `Lane::CodeGraph` calls `CodeGraphBuilder::build`
//!   against the repo root. The cache at `<repo>/.spell/graph` is honoured;
//!   subsequent rebuilds reuse fingerprints.
//! - Vector lane is built on demand via `pi_knowledge_core::vec::VectorIndex`
//!   when the embedder is available; otherwise the lane is BM25 + graph only.

use std::{
	path::{Path, PathBuf},
	time::SystemTime,
};

use pi_code_graph::{
	BuildGraphOptions, CacheStore, CodeGraph, CodeGraphBuilder, LanguageRegistry,
};
use serde_json::{Value, json};

/// Warm state for the code-graph lane of one repo.
pub struct CodeLane {
	pub repo_root:  PathBuf,
	pub graph:      CodeGraph,
	pub last_built: SystemTime,
}

impl CodeLane {
	pub fn warm_load(repo_root: &Path) -> Result<Self, String> {
		let registry = LanguageRegistry::new()
			.with_defaults()
			.map_err(|e| format!("language registry: {e}"))?;
		let cache = CacheStore::new(repo_root.join(".spell/graph"));
		let builder = CodeGraphBuilder::new(registry, cache);
		let outcome = builder
			.build(&BuildGraphOptions::new(repo_root))
			.map_err(|e| format!("code-graph build: {e}"))?;
		Ok(Self {
			repo_root:  repo_root.to_path_buf(),
			graph:      outcome.graph,
			last_built: SystemTime::now(),
		})
	}

	/// `cg_search` — BM25 (and, when the embedder is available, vector
	/// hybrid) over the symbol corpus.
	///
	/// `kind` is reserved for future explicit dispatch (bm25 / vec /
	/// hybrid); today `graph_search` auto-picks based on whether the lane
	/// has a vector index attached. Pass `_kind: "bm25"` to disable the
	/// embedder call path.
	pub fn search(&self, query: &str, _kind: &str, limit: usize) -> Result<Value, String> {
		// No query vector → BM25-only fallback path. The daemon-side embedder
		// could be plumbed in here later, but for W3 the BM25 lane is
		// canonical and avoids the cold-load latency on every query.
		let result = self.graph.graph_search(query, None, limit);
		let hits: Vec<Value> = result
			.iter()
			.map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
			.collect();
		Ok(json!(hits))
	}

	/// `cg_definition` — resolve a symbol query (name or qualified id) to
	/// its primary location. Returns null when no symbol matches.
	pub fn definition(&self, query: &str) -> Result<Value, String> {
		match self.graph.graph_context(query) {
			Some(ctx) => Ok(serde_json::to_value(&ctx)
				.map_err(|e| format!("serialise context: {e}"))?),
			None => Ok(Value::Null),
		}
	}

	/// `cg_references` — flow query maps to "downstream references" for the
	/// matched symbol. Maps to graph_impact under the hood.
	pub fn references(&self, query: &str, max_depth: usize) -> Result<Value, String> {
		match self.graph.graph_impact(query, max_depth) {
			Some(result) => Ok(serde_json::to_value(&result)
				.map_err(|e| format!("serialise impact: {e}"))?),
			None => Ok(Value::Null),
		}
	}

	/// `cg_callers` — direct (and transitive up to depth) callers of the
	/// matched symbol via the flow query.
	pub fn callers(&self, query: &str, max_depth: usize) -> Result<Value, String> {
		match self.graph.graph_flow(query, max_depth) {
			Some(result) => Ok(serde_json::to_value(&result)
				.map_err(|e| format!("serialise flow: {e}"))?),
			None => Ok(Value::Null),
		}
	}

	/// Status snapshot (symbol count, edge count, last cache fingerprint).
	pub fn status(&self) -> Value {
		let stats = self.graph.graph_status();
		serde_json::to_value(&stats).unwrap_or(json!({}))
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Mutex};

	use tempfile::TempDir;

	use super::*;

	// Tests share /tmp inotify and a thread pool; serialise.
	static LANE_LOCK: Mutex<()> = Mutex::new(());

	fn seed_repo(root: &Path) {
		let src = root.join("src");
		fs::create_dir_all(&src).expect("mk src");
		fs::write(
			src.join("foo.ts"),
			"export function helloAlpha() { return 1; }\n\
			 export function helloBeta(x: number) { return helloAlpha() + x; }\n",
		)
		.expect("write foo");
	}

	#[test]
	fn warm_load_indexes_typescript_symbols() {
		let _g = LANE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
		let tmp = TempDir::new().expect("tmp");
		seed_repo(tmp.path());
		let lane = CodeLane::warm_load(tmp.path()).expect("warm");
		let names = lane.graph.symbol_names();
		assert!(
			names.iter().any(|n| n.contains("helloAlpha")),
			"expected helloAlpha in {names:?}",
		);
	}

	#[test]
	fn search_returns_hits_for_present_symbol() {
		let _g = LANE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
		let tmp = TempDir::new().expect("tmp");
		seed_repo(tmp.path());
		let lane = CodeLane::warm_load(tmp.path()).expect("warm");
		let result = lane.search("helloAlpha", "bm25", 5).expect("search");
		let hits = result.as_array().expect("hits array");
		assert!(!hits.is_empty(), "expected matches for helloAlpha; got {result:#?}");
		let first_summary = hits[0].get("summary").expect("summary field");
		assert!(
			first_summary["label"]
				.as_str()
				.is_some_and(|l| l.contains("helloAlpha")),
			"first hit references helloAlpha: {first_summary:#?}"
		);
	}

	#[test]
	fn definition_returns_null_for_unknown() {
		let _g = LANE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
		let tmp = TempDir::new().expect("tmp");
		seed_repo(tmp.path());
		let lane = CodeLane::warm_load(tmp.path()).expect("warm");
		let result = lane.definition("doesNotExistSym").expect("def");
		assert_eq!(result, Value::Null);
	}

	#[test]
	fn warm_load_empty_repo_returns_empty_lane() {
		let _g = LANE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
		let tmp = TempDir::new().expect("tmp");
		let lane = CodeLane::warm_load(tmp.path()).expect("warm");
		assert!(lane.graph.symbol_names().is_empty());
	}
}
