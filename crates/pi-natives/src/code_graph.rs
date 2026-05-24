use std::{
	fmt::Write as _,
	fs::{self, File},
	io::{BufReader, BufWriter},
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_code_graph::{
	BuildGraphOptions, CacheStatus, CacheStore, CodeGraph, CodeGraphBuilder, GraphCacheEntry,
	GraphCluster, GraphContextResult, GraphDeadCodeItem, GraphDepsResult, GraphFilesResult,
	GraphFlowResult, GraphImpactResult, GraphNodeSummary, GraphSearchMatch, GraphStatus,
	GraphSymbolsResult, GraphTraversalLevel, LanguageRegistry,
};
use pi_knowledge_core::cache::{KnowledgeMeta, WorkspaceFingerprint, save_all};

use crate::{
	embedding_worker::{self, EMBEDDER_DIM, EMBEDDER_MODEL},
	task::{self, CancelToken},
};

const DEFAULT_DEPTH: u32 = 3;
const DEFAULT_LIMIT: u32 = 10;
const CACHE_NAME: &str = "workspace";
const VECTORS_BASENAME: &str = "workspace-vectors";
const VECTORS_FILE_EXT: &str = "uidx";
/// `save_all` writes `<name>.bin`; this is the basename of the meta sidecar
/// that supersedes the W2 `workspace-vectors.fp` u64 LE fingerprint sidecar.
const VECTORS_META_NAME: &str = "workspace-vectors-meta";

#[napi(object)]
pub struct CodeGraphOptions<'env> {
	pub command:    String,
	pub root:       Option<String>,
	pub file:       Option<String>,
	pub symbol:     Option<String>,
	pub query:      Option<String>,
	pub depth:      Option<u32>,
	pub limit:      Option<u32>,
	pub semantic:   Option<bool>,
	pub signal:     Option<Unknown<'env>>,
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms: Option<u32>,
}

struct CodeGraphTaskOptions {
	command:  String,
	root:     Option<String>,
	file:     Option<String>,
	symbol:   Option<String>,
	query:    Option<String>,
	depth:    Option<u32>,
	limit:    Option<u32>,
	semantic: Option<bool>,
}

impl From<CodeGraphOptions<'_>> for CodeGraphTaskOptions {
	fn from(value: CodeGraphOptions<'_>) -> Self {
		Self {
			command:  value.command,
			root:     value.root,
			file:     value.file,
			symbol:   value.symbol,
			query:    value.query,
			depth:    value.depth,
			limit:    value.limit,
			semantic: value.semantic,
		}
	}
}

#[napi(object)]
pub struct CodeGraphResult {
	pub output:          String,
	#[napi(js_name = "cacheStatus")]
	pub cache_status:    String,
	pub rebuilt:         bool,
	#[napi(js_name = "fileCount")]
	pub file_count:      u32,
	#[napi(js_name = "symbolCount")]
	pub symbol_count:    u32,
	#[napi(js_name = "edgeCount")]
	pub edge_count:      u32,
	#[napi(js_name = "semanticStatus")]
	pub semantic_status: Option<String>,
}

enum VectorCacheState {
	Missing,
	Fresh(pi_knowledge_core::vec::VectorIndex),
	Stale(pi_knowledge_core::vec::VectorIndex),
	Corrupt(String),
}

impl VectorCacheState {
	fn describe(&self) -> String {
		match self {
			Self::Missing => "missing".to_string(),
			Self::Fresh(idx) => format!("{} vectors (fresh)", idx.len()),
			Self::Stale(idx) => format!("{} vectors (stale)", idx.len()),
			Self::Corrupt(reason) => format!("corrupt ({reason})"),
		}
	}

	fn unavailable_reason(&self) -> Option<String> {
		match self {
			Self::Missing => Some("no semantic vector index exists".to_string()),
			Self::Fresh(_) => None,
			Self::Stale(_) => Some("semantic vector index is stale".to_string()),
			Self::Corrupt(reason) => Some(format!("semantic vector index is corrupt: {reason}")),
		}
	}
}

#[napi(js_name = "executeCodeGraph")]
pub fn execute_code_graph(options: CodeGraphOptions<'_>) -> task::Async<CodeGraphResult> {
	let cancel_token = CancelToken::new(options.timeout_ms, options.signal);
	let task_options = CodeGraphTaskOptions::from(options);
	task::blocking("code_graph", cancel_token, move |cancel_token| {
		run_code_graph(task_options, cancel_token)
	})
}

fn run_code_graph(
	options: CodeGraphTaskOptions,
	cancel_token: CancelToken,
) -> napi::Result<CodeGraphResult> {
	cancel_token.heartbeat()?;
	let root = resolve_root(options.root.as_deref())?;
	let cache = CacheStore::new(root.join(".spell/graph"));
	let builder = CodeGraphBuilder::new(
		LanguageRegistry::new()
			.with_defaults()
			.map_err(to_napi_error)?,
		cache.clone(),
	);

	if options.command == "status" {
		return render_status(&root, &builder);
	}

	let (graph, cache_status, rebuilt) =
		ensure_graph(&root, &cache, &builder, &cancel_token, options.command == "index")?;
	let stats = graph.graph_status();
	let mut semantic_status = None;
	let output = match options.command.as_str() {
		"index" => {
			let mut status_output = format_status(&stats, &cache_status, rebuilt);
			if options.semantic == Some(true) {
				match build_semantic_index(&graph, &cache) {
					Ok(vector_count) => {
						let status = format!("{vector_count} vectors indexed");
						let _ = write!(status_output, "\nSemantic: {status}");
						semantic_status = Some(status);
					},
					Err(error) => {
						let status = format!("failed: {error}");
						let _ = write!(status_output, "\nSemantic: {status}");
						semantic_status = Some(status);
					},
				}
			}
			status_output
		},
		"context" => {
			let symbol = options
				.symbol
				.as_deref()
				.ok_or_else(|| Error::from_reason("context requires `symbol`"))?;
			let result = graph.graph_context(symbol).ok_or_else(|| {
				Error::from_reason(format!("No symbol found for context query: {symbol}"))
			})?;
			format_context(&result, options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
		},
		"impact" => {
			let symbol = options
				.symbol
				.as_deref()
				.ok_or_else(|| Error::from_reason("impact requires `symbol`"))?;
			let result = graph
				.graph_impact(symbol, options.depth.unwrap_or(DEFAULT_DEPTH) as usize)
				.ok_or_else(|| {
					Error::from_reason(format!("No symbol or file found for impact query: {symbol}"))
				})?;
			format_impact(&result, options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
		},
		"deps" => {
			let file = options
				.file
				.as_deref()
				.ok_or_else(|| Error::from_reason("deps requires `file`"))?;
			let result = graph
				.graph_deps(file)
				.ok_or_else(|| Error::from_reason(format!("No file found for deps query: {file}")))?;
			format_deps(&result, options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
		},
		"flow" => {
			let symbol = options
				.symbol
				.as_deref()
				.ok_or_else(|| Error::from_reason("flow requires `symbol`"))?;
			let result = graph
				.graph_flow(symbol, options.depth.unwrap_or(DEFAULT_DEPTH) as usize)
				.ok_or_else(|| {
					Error::from_reason(format!("No symbol found for flow query: {symbol}"))
				})?;
			format_flow(&result, options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
		},
		"dead_code" => {
			format_dead_code(&graph.graph_dead_code(), options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
		},
		"clusters" => {
			format_clusters(&graph.graph_clusters(), options.limit.unwrap_or(DEFAULT_LIMIT) as usize)
		},
		"symbols" => {
			let query = options.query.as_deref().unwrap_or("");
			format_symbols(
				&graph.graph_symbols(query, options.limit.unwrap_or(DEFAULT_LIMIT) as usize),
			)
		},
		"files" => {
			let query = options
				.query
				.as_deref()
				.ok_or_else(|| Error::from_reason("files requires `query`"))?;
			format_files(&graph.graph_files(query, options.limit.unwrap_or(DEFAULT_LIMIT) as usize))
		},
		"search" => {
			let query = options
				.query
				.as_deref()
				.ok_or_else(|| Error::from_reason("search requires `query`"))?;
			let limit = options.limit.unwrap_or(DEFAULT_LIMIT) as usize;

			if options.semantic == Some(false) {
				format_search(&graph.graph_search(query, None, limit))
			} else {
				match load_vector_cache(
					&cache,
					current_graph_fingerprint(&cache).as_ref(),
					EMBEDDER_MODEL,
					EMBEDDER_DIM,
				) {
					VectorCacheState::Fresh(vector_index) => {
						let vector_count = vector_index.len();
						match embedding_worker::embed_query(query) {
							Ok(query_vector) => {
								semantic_status =
									Some(format!("hybrid search using {vector_count} cached vectors"));
								let search_graph =
									CodeGraph::with_vectors(graph.into_persisted(), vector_index);
								format_search(&search_graph.graph_search(query, Some(&query_vector), limit))
							},
							Err(error) => {
								let reason = format!("query embedding failed: {error}");
								if options.semantic == Some(true) {
									return Err(Error::from_reason(format!(
										"Semantic search requested but unavailable: {reason}"
									)));
								}
								semantic_status = Some(format!("unavailable: {reason}"));
								format_search_with_reason(
									format_search(&graph.graph_search(query, None, limit)),
									&reason,
								)
							},
						}
					},
					state => {
						let reason = state
							.unavailable_reason()
							.expect("non-fresh vector cache state should provide a reason");
						if options.semantic == Some(true) {
							return Err(Error::from_reason(format!(
								"Semantic search requested but unavailable: {reason}. Run `code index` \
								 with semantic: true first."
							)));
						}
						semantic_status = Some(format!("unavailable: {reason}"));
						format_search_with_reason(
							format_search(&graph.graph_search(query, None, limit)),
							&reason,
						)
					},
				}
			}
		},
		other => return Err(Error::from_reason(format!("Unsupported code graph command: {other}"))),
	};

	Ok(CodeGraphResult {
		output,
		cache_status,
		rebuilt,
		file_count: stats.file_count,
		symbol_count: stats.symbol_count,
		edge_count: stats.edge_count,
		semantic_status,
	})
}

fn ensure_graph(
	root: &Path,
	cache: &CacheStore,
	builder: &CodeGraphBuilder,
	cancel_token: &CancelToken,
	force_rebuild: bool,
) -> napi::Result<(CodeGraph, String, bool)> {
	cancel_token.heartbeat()?;
	let status = builder.cache_status(root).map_err(to_napi_error)?;
	if !force_rebuild && status == CacheStatus::Fresh {
		let entry = cache
			.load::<GraphCacheEntry>(CACHE_NAME)
			.map_err(to_napi_error)?
			.ok_or_else(|| Error::from_reason("graph cache disappeared after status check"))?;
		return Ok((CodeGraph::from(entry.graph), "fresh".into(), false));
	}

	let cache_label = match &status {
		CacheStatus::Missing => "missing".to_string(),
		CacheStatus::Fresh => "fresh".to_string(),
		CacheStatus::Stale { reason } => format!("stale ({reason})"),
	};
	let outcome = builder
		.build(&BuildGraphOptions::new(root))
		.map_err(to_napi_error)?;
	Ok((outcome.graph, cache_label, true))
}

fn render_status(root: &Path, builder: &CodeGraphBuilder) -> napi::Result<CodeGraphResult> {
	let cache = builder.cache();
	let cache_status = match builder.cache_status(root).map_err(to_napi_error)? {
		CacheStatus::Missing => "missing".to_string(),
		CacheStatus::Fresh => "fresh".to_string(),
		CacheStatus::Stale { reason } => format!("stale ({reason})"),
	};
	let status = cache
		.load::<GraphCacheEntry>(CACHE_NAME)
		.map_err(to_napi_error)?
		.map(|entry| CodeGraph::from(entry.graph).graph_status());
	let semantic_status = load_vector_cache(
		cache,
		current_graph_fingerprint(cache).as_ref(),
		EMBEDDER_MODEL,
		EMBEDDER_DIM,
	)
	.describe();
	let mut output = if let Some(status) = &status {
		format_status(status, &cache_status, false)
	} else {
		format!("Code graph cache: {cache_status}\nRoot: {}\nNo index present.", root.display())
	};
	let _ = write!(output, "\nSemantic: {semantic_status}");
	Ok(CodeGraphResult {
		output,
		cache_status,
		rebuilt: false,
		file_count: status.as_ref().map_or(0, |status| status.file_count),
		symbol_count: status.as_ref().map_or(0, |status| status.symbol_count),
		edge_count: status.as_ref().map_or(0, |status| status.edge_count),
		semantic_status: Some(semantic_status),
	})
}

/// Build the semantic vector index from the code graph.
// TODO(FUP-089): `code_graph` has no daemon RPC path yet — the semantic
// index is always built in-process via `embedding_worker::embed_batch`.
// When code-graph queries are routed through the daemon (W3 hybrid lane),
// a `WorkerMode` dispatch block similar to `recall_engine::query` must be
// added here and in the `search` branch of `run_code_graph`.
fn build_semantic_index(graph: &CodeGraph, cache: &CacheStore) -> napi::Result<usize> {
	let chunks = pi_code_graph::extract_chunks(graph.persisted(), 30)
		.map_err(|e| Error::from_reason(format!("Chunking failed: {e}")))?;
	if chunks.is_empty() {
		return Ok(0);
	}
	let texts: Vec<&str> = chunks.iter().map(|c| c.text.as_str()).collect();
	let vectors = embedding_worker::embed_batch(&texts, None)?;
	let (entries, dimensions) = validate_worker_vectors(&chunks, vectors)?;
	let count = entries.len();
	let vector_index = pi_knowledge_core::vec::VectorIndex::from_entries(&entries, dimensions)
		.map_err(|e| Error::from_reason(format!("Failed to build vector index: {e}")))?;
	let fingerprint = current_graph_fingerprint(cache).ok_or_else(|| {
		Error::from_reason(
			"Graph cache missing while persisting semantic vectors; rebuild the graph first",
		)
	})?;
	save_vector_cache(cache, &vector_index, &fingerprint, EMBEDDER_MODEL)?;
	Ok(count)
}

fn validate_worker_vectors(
	chunks: &[pi_code_graph::ChunkResult],
	vectors: Vec<Vec<f32>>,
) -> napi::Result<(Vec<pi_knowledge_core::vec::VectorEntry>, usize)> {
	if vectors.len() != chunks.len() {
		return Err(Error::from_reason(format!(
			"Embedding worker returned {} vectors for {} chunks",
			vectors.len(),
			chunks.len()
		)));
	}
	let dimensions = vectors.first().map_or(0, Vec::len);
	if dimensions == 0 {
		return Err(Error::from_reason(
			"Embedding worker returned zero-dimension vectors".to_string(),
		));
	}
	for (index, vector) in vectors.iter().enumerate() {
		if vector.len() != dimensions {
			return Err(Error::from_reason(format!(
				"Embedding worker returned inconsistent vector dimensions: expected {dimensions}, got \
				 {} at index {index}",
				vector.len()
			)));
		}
	}

	let entries = chunks
		.iter()
		.zip(vectors)
		.map(|(chunk, vector)| pi_knowledge_core::vec::VectorEntry {
			node_id: chunk.node_index as u64,
			vector,
		})
		.collect();
	Ok((entries, dimensions))
}

/// Pluck the persisted graph fingerprint without hashing — `KnowledgeMeta`
/// stores the full `WorkspaceFingerprint`, so the load-side comparison happens
/// against the same shape that was written.
fn current_graph_fingerprint(cache: &CacheStore) -> Option<WorkspaceFingerprint> {
	cache
		.load::<GraphCacheEntry>(CACHE_NAME)
		.ok()
		.flatten()
		.map(|entry| entry.fingerprint)
}

/// Persist the usearch index plus a `KnowledgeMeta` sidecar via the W1.5
/// atomic-multi-blob writer. The usearch `.uidx` is already atomic via
/// `VectorIndex::save` (tmp+rename inside the native lib); `save_all` covers
/// the meta blob. `embedder_model` is recorded so a later embedder swap (W2.5
/// bge-m3) drops the cache automatically through `status_against`.
fn save_vector_cache(
	cache: &CacheStore,
	vectors: &pi_knowledge_core::vec::VectorIndex,
	fingerprint: &WorkspaceFingerprint,
	embedder_model: &str,
) -> napi::Result<()> {
	fs::create_dir_all(cache.directory())
		.map_err(|e| Error::from_reason(format!("Failed to create cache dir: {e}")))?;
	let vectors_path = cache
		.directory()
		.join(format!("{VECTORS_BASENAME}.{VECTORS_FILE_EXT}"));
	vectors
		.save(&vectors_path)
		.map_err(|e| Error::from_reason(format!("Failed to write vector cache: {e}")))?;

	let mut meta = KnowledgeMeta::new(fingerprint.clone());
	embedder_model.clone_into(&mut meta.embedder_model);
	meta.embedder_dim = vectors.dim();

	save_all(
		cache,
		vec![(
			VECTORS_META_NAME,
			Box::new(move |w: &mut BufWriter<File>| {
				bincode::serialize_into(w, &meta).map_err(pi_knowledge_core::Error::Bincode)
			}) as Box<dyn FnOnce(&mut BufWriter<File>) -> pi_knowledge_core::Result<()>>,
		)],
	)
	.map_err(|e| Error::from_reason(format!("Failed to write vector cache meta: {e}")))
}

/// Load the vector cache and validate it against `current_fingerprint` /
/// `expected_model` / `expected_dim` via `KnowledgeMeta::status_against`.
///
/// `current_fingerprint = None` means the graph cache itself is gone; we can't
/// trust the vector cache either, so any present file is reported `Stale` and
/// the caller will rebuild.
fn load_vector_cache(
	cache: &CacheStore,
	current_fingerprint: Option<&WorkspaceFingerprint>,
	expected_model: &str,
	expected_dim: usize,
) -> VectorCacheState {
	use pi_knowledge_core::cache::CacheStatus as KnowledgeCacheStatus;

	let vectors_path = cache
		.directory()
		.join(format!("{VECTORS_BASENAME}.{VECTORS_FILE_EXT}"));
	if !vectors_path.exists() {
		return VectorCacheState::Missing;
	}
	let vectors = match pi_knowledge_core::vec::VectorIndex::load(&vectors_path) {
		Ok(v) => v,
		Err(error) => return VectorCacheState::Corrupt(error.to_string()),
	};

	let meta_path = cache.directory().join(format!("{VECTORS_META_NAME}.bin"));
	let Ok(meta_file) = File::open(&meta_path) else {
		// No meta sidecar → can't validate freshness; treat as stale rather than
		// silently serving a vector index of unknown provenance.
		return VectorCacheState::Stale(vectors);
	};
	let meta: KnowledgeMeta = match bincode::deserialize_from(BufReader::new(meta_file)) {
		Ok(meta) => meta,
		Err(_) => return VectorCacheState::Stale(vectors),
	};

	let Some(current) = current_fingerprint else {
		return VectorCacheState::Stale(vectors);
	};

	match meta.status_against(current, expected_model, expected_dim) {
		KnowledgeCacheStatus::Fresh => VectorCacheState::Fresh(vectors),
		// `status_against` only emits `Fresh` or `Stale`; `Missing` is the shared
		// enum's third variant and can't originate here, but match exhaustively.
		KnowledgeCacheStatus::Stale { .. } | KnowledgeCacheStatus::Missing => {
			VectorCacheState::Stale(vectors)
		},
	}
}

fn resolve_root(root: Option<&str>) -> napi::Result<PathBuf> {
	let root = match root {
		Some(root) if !root.trim().is_empty() => PathBuf::from(root),
		_ => std::env::current_dir().map_err(|error| Error::from_reason(error.to_string()))?,
	};
	fs::canonicalize(root).map_err(|error| Error::from_reason(error.to_string()))
}

fn to_napi_error(error: impl std::fmt::Display) -> Error {
	Error::from_reason(error.to_string())
}

fn format_status(status: &GraphStatus, cache_status: &str, rebuilt: bool) -> String {
	let languages = status
		.languages
		.iter()
		.map(|(language, count)| format!("{language}={count}"))
		.collect::<Vec<_>>()
		.join(", ");
	let rebuild_line = if rebuilt { "yes" } else { "no" };
	format!(
		"Code graph status\nRoot: {}\nCache: {cache_status} (generated \
		 .spell/graph/*.bin)\nRebuilt: {rebuild_line}\nFiles: {}\nSymbols: {}\nEdges: {}\nGit HEAD: \
		 {}\nLanguages: {}",
		status.root.display(),
		status.file_count,
		status.symbol_count,
		status.edge_count,
		status.git_head.as_deref().unwrap_or("unknown"),
		if languages.is_empty() {
			"none"
		} else {
			&languages
		},
	)
}

fn format_context(result: &GraphContextResult, limit: usize) -> String {
	let mut sections = vec![format!(
		"Context\nTarget: {}\nKind: {}\nPath: {}:{}:{}",
		result.target.label,
		result.target.kind,
		result.target.path.display(),
		result.target.line,
		result.target.column
	)];
	append_context_section(&mut sections, "Callers", &result.callers, limit);
	append_section(&mut sections, "Callees", &result.callees, limit);
	append_context_section(&mut sections, "References", &result.references, limit);
	append_context_section(&mut sections, "Referenced by", &result.referenced_by, limit);
	append_section(&mut sections, "Imports", &result.imports, limit);
	append_section(&mut sections, "Imported by", &result.imported_by, limit);
	append_section(&mut sections, "Inherits", &result.inherits, limit);
	sections.push("Next: code { command: \"impact\", symbol: \"...\" }".into());
	sections.join("\n\n")
}

fn format_impact(result: &GraphImpactResult, limit: usize) -> String {
	let mut sections = vec![format!("Impact\nTarget: {}", result.target.label)];
	append_levels(&mut sections, &result.levels, limit);
	sections.push("Next: code { command: \"context\", symbol: \"...\" }".into());
	sections.join("\n\n")
}

fn format_deps(result: &GraphDepsResult, limit: usize) -> String {
	let mut sections = vec![format!("Dependencies\nTarget: {}", result.target.label)];
	append_section(&mut sections, "Outgoing dependencies", &result.outgoing, limit);
	append_section(&mut sections, "Incoming dependencies", &result.incoming, limit);
	sections.push("Next: code { command: \"clusters\" }".into());
	sections.join("\n\n")
}

fn format_flow(result: &GraphFlowResult, limit: usize) -> String {
	let mut sections = vec![format!("Flow\nTarget: {}", result.target.label)];
	append_levels(&mut sections, &result.levels, limit);
	sections.push("Next: code { command: \"context\", symbol: \"...\" }".into());
	sections.join("\n\n")
}

fn format_dead_code(items: &[GraphDeadCodeItem], limit: usize) -> String {
	if items.is_empty() {
		return "Dead code\nNo dead symbols found.".into();
	}
	let mut lines = vec!["Dead code".to_string()];
	for item in items.iter().take(limit) {
		lines.push(format!("- {} ({})", item.symbol.label, item.reason));
	}
	if items.len() > limit {
		lines.push(format!("- ... {} more", items.len() - limit));
	}
	lines.join("\n")
}

fn format_clusters(clusters: &[GraphCluster], limit: usize) -> String {
	if clusters.is_empty() {
		return "Clusters\nNo connected file clusters found.".into();
	}
	let mut lines = vec!["Clusters".to_string()];
	for cluster in clusters.iter().take(limit) {
		let files = cluster
			.files
			.iter()
			.map(|file| file.label.clone())
			.collect::<Vec<_>>()
			.join(", ");
		lines.push(format!(
			"- cluster {}: {} files, {} symbols -> {}",
			cluster.id,
			cluster.files.len(),
			cluster.symbol_count,
			files
		));
	}
	if clusters.len() > limit {
		lines.push(format!("- ... {} more", clusters.len() - limit));
	}
	lines.join("\n")
}

fn format_symbols(result: &GraphSymbolsResult) -> String {
	let mut lines = if result.status == "summary" {
		vec![
			"Symbols summary".to_string(),
			"Query: (all symbols)".to_string(),
			"Status: summary".to_string(),
		]
	} else {
		vec![
			"Symbols".to_string(),
			format!("Query: {}", result.query),
			format!("Status: {}", result.status),
		]
	};
	append_lookup_lines(&mut lines, &result.matches);
	if result.status == "ambiguous" {
		lines.push("Next: refine the query with a qualified name or file path".into());
	} else if result.status == "summary" {
		lines.push("Next: add a symbol name or qualified path to narrow results".into());
	}
	lines.join("\n")
}

fn format_files(result: &GraphFilesResult) -> String {
	let mut lines = vec![
		"Files".to_string(),
		format!("Query: {}", result.query),
		format!("Status: {}", result.status),
	];
	append_lookup_lines(&mut lines, &result.matches);
	if result.status == "ambiguous" {
		lines.push("Next: refine the query with more of the path".into());
	}
	lines.join("\n")
}

fn append_lookup_lines(lines: &mut Vec<String>, matches: &[GraphNodeSummary]) {
	if matches.is_empty() {
		lines.push("No matches found.".into());
		return;
	}
	for entry in matches {
		if entry.kind == "file" {
			lines.push(format!("- {}", entry.label));
		} else {
			lines.push(format!(
				"- {} [{}] {}:{}:{}",
				entry.label,
				entry.kind,
				entry.path.display(),
				entry.line,
				entry.column,
			));
		}
	}
}

fn format_search(matches: &[GraphSearchMatch]) -> String {
	if matches.is_empty() {
		return "Search\nNo graph matches found.".into();
	}
	let mut lines = vec!["Search".to_string()];
	for entry in matches {
		lines.push(format!("- {:.2} {}", entry.score, entry.summary.label));
	}
	lines.join("\n")
}

fn format_search_with_reason(mut output: String, reason: &str) -> String {
	let _ = write!(output, "\n(Semantic search unavailable: {reason})");
	output
}

fn append_context_section(
	sections: &mut Vec<String>,
	title: &str,
	items: &[GraphNodeSummary],
	limit: usize,
) {
	let semantic = items
		.iter()
		.filter(|item| !item.kind.eq_ignore_ascii_case("keyword"))
		.cloned()
		.collect::<Vec<_>>();
	let keywords = items
		.iter()
		.filter(|item| item.kind.eq_ignore_ascii_case("keyword"))
		.cloned()
		.collect::<Vec<_>>();
	append_section(sections, title, &semantic, limit);
	append_section(sections, "Data keywords", &keywords, limit);
}
fn append_section(
	sections: &mut Vec<String>,
	title: &str,
	items: &[GraphNodeSummary],
	limit: usize,
) {
	if items.is_empty() {
		return;
	}
	let mut lines = vec![title.to_string()];
	for item in items.iter().take(limit) {
		lines.push(format!("- {}", item.label));
	}
	if items.len() > limit {
		lines.push(format!("- ... {} more", items.len() - limit));
	}
	sections.push(lines.join("\n"));
}

fn append_levels(sections: &mut Vec<String>, levels: &[GraphTraversalLevel], limit: usize) {
	for level in levels {
		let mut lines = vec![format!("Depth {}", level.depth)];
		for item in level.nodes.iter().take(limit) {
			lines.push(format!("- {}", item.label));
		}
		if level.nodes.len() > limit {
			lines.push(format!("- ... {} more", level.nodes.len() - limit));
		}
		sections.push(lines.join("\n"));
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		ffi::OsString,
		fs,
		path::{Path, PathBuf},
	};

	use super::*;

	fn fixture_root(name: &str) -> PathBuf {
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_nanos();
		let root = std::env::temp_dir()
			.join(format!("pi-natives-code-graph-{name}-{}-{unique}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src")).expect("fixture dir should be created");
		fs::write(
			root.join("src/rate_limit.ts"),
			"export function rateLimit(requests: number): boolean {\n\treturn requests < 10;\n}\n",
		)
		.expect("fixture file should be written");
		fs::write(
			root.join("src/throttle.ts"),
			"export function throttle(count: number): boolean {\n\treturn count < 5;\n}\n",
		)
		.expect("fixture file should be written");
		root
	}

	fn run_fixture_command(
		root: &Path,
		command: &str,
		query: Option<&str>,
		semantic: Option<bool>,
	) -> napi::Result<CodeGraphResult> {
		run_code_graph(
			CodeGraphTaskOptions {
				command: command.to_string(),
				root: Some(root.to_string_lossy().into_owned()),
				file: None,
				symbol: None,
				query: query.map(str::to_string),
				depth: None,
				limit: None,
				semantic,
			},
			CancelToken::default(),
		)
	}

	fn mock_worker_path() -> PathBuf {
		let bin_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-bin");
		#[cfg(windows)]
		{
			return bin_dir.join("mock_embedding_worker.cmd");
		}
		#[cfg(not(windows))]
		{
			bin_dir.join("mock_embedding_worker.js")
		}
	}

	fn temp_state_file(name: &str) -> PathBuf {
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("time should be monotonic")
			.as_nanos();
		env::temp_dir()
			.join(format!("pi-natives-code-graph-{name}-{unique}-{}.state", std::process::id()))
	}

	struct MockWorkerEnv {
		_guard:          std::sync::RwLockWriteGuard<'static, ()>,
		original_worker: Option<OsString>,
		original_mode:   Option<OsString>,
		original_state:  Option<OsString>,
	}

	impl MockWorkerEnv {
		fn new(mode: &str, state_file: Option<&Path>) -> Self {
			let guard = crate::embedding_worker::lock_test_env();
			let original_worker = env::var_os("PI_EMBEDDING_WORKER");
			let original_mode = env::var_os("PI_TEST_EMBEDDING_WORKER_MODE");
			let original_state = env::var_os("PI_TEST_EMBEDDING_WORKER_STATE_FILE");
			unsafe {
				env::set_var("PI_EMBEDDING_WORKER", mock_worker_path());
				env::set_var("PI_TEST_EMBEDDING_WORKER_MODE", mode);
				match state_file {
					Some(path) => env::set_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE", path),
					None => env::remove_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE"),
				}
			}
			crate::embedding_worker::reset_for_tests();
			Self { _guard: guard, original_worker, original_mode, original_state }
		}
	}

	impl Drop for MockWorkerEnv {
		fn drop(&mut self) {
			unsafe {
				match &self.original_worker {
					Some(value) => env::set_var("PI_EMBEDDING_WORKER", value),
					None => env::remove_var("PI_EMBEDDING_WORKER"),
				}
				match &self.original_mode {
					Some(value) => env::set_var("PI_TEST_EMBEDDING_WORKER_MODE", value),
					None => env::remove_var("PI_TEST_EMBEDDING_WORKER_MODE"),
				}
				match &self.original_state {
					Some(value) => env::set_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE", value),
					None => env::remove_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE"),
				}
			}
			crate::embedding_worker::reset_for_tests();
		}
	}

	#[test]
	fn symbols_lookup_reports_exact_matches() {
		let root = fixture_root("symbols");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");
		let result = run_fixture_command(&root, "symbols", Some("rateLimit"), None)
			.expect("symbols lookup should succeed");
		assert!(
			result.output.contains("Symbols"),
			"symbols output should include a heading: {}",
			result.output
		);
		assert!(
			result.output.contains("Status: exact"),
			"symbols output should report exact matches: {}",
			result.output
		);
		assert!(
			result.output.contains("rate_limit.ts::rateLimit"),
			"symbols output should list the resolved symbol: {}",
			result.output
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn files_lookup_reports_exact_matches() {
		let root = fixture_root("files");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");
		let result = run_fixture_command(&root, "files", Some("rate_limit.ts"), None)
			.expect("files lookup should succeed");
		assert!(
			result.output.contains("Files"),
			"files output should include a heading: {}",
			result.output
		);
		assert!(
			result.output.contains("Status: exact"),
			"files output should report exact matches: {}",
			result.output
		);
		assert!(
			result.output.contains("src/rate_limit.ts"),
			"files output should list the resolved path: {}",
			result.output
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn status_labels_graph_cache_as_generated_artifact() {
		let root = fixture_root("status-cache-label");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");
		let result = run_fixture_command(&root, "status", None, None).expect("status should succeed");
		assert!(
			result.output.contains("generated .spell/graph/*.bin"),
			"status should label graph cache artifacts: {}",
			result.output
		);
		assert!(
			root.join(".spell/graph/workspace.bin").exists(),
			"graph index should persist generated workspace cache"
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn context_sections_clojure_keywords_as_data_keywords() {
		let root = fixture_root("clojure-keywords");
		fs::write(
			root.join("src/events.clj"),
			"(ns app.events)\n(defn accept [candidate]\n  {:accepted true :source (:source \
			 candidate)})\n",
		)
		.expect("clojure fixture");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");
		let result = run_code_graph(
			CodeGraphTaskOptions {
				command:  "context".into(),
				root:     Some(root.to_string_lossy().into_owned()),
				file:     None,
				symbol:   Some("accept".into()),
				query:    None,
				depth:    None,
				limit:    None,
				semantic: None,
			},
			CancelToken::default(),
		)
		.expect("context should succeed");
		assert!(
			result.output.contains("Data keywords"),
			"context should section keyword references: {}",
			result.output
		);
		let _ = fs::remove_dir_all(root);
	}
	#[test]
	fn index_without_semantic_leaves_vector_cache_absent() {
		let root = fixture_root("plain-index");
		let result =
			run_fixture_command(&root, "index", None, None).expect("plain index should succeed");

		assert!(result.semantic_status.is_none());
		assert!(
			!root.join(".spell/graph/workspace-vectors.uidx").exists(),
			"plain index should not create a vector cache"
		);

		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn semantic_search_requires_vector_cache_when_requested() {
		let root = fixture_root("required-search");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");

		let error = match run_fixture_command(&root, "search", Some("limit"), Some(true)) {
			Ok(_) => panic!("semantic search should fail without vectors"),
			Err(error) => error,
		};
		assert!(
			error
				.to_string()
				.contains("Semantic search requested but unavailable: no semantic vector index exists"),
			"error should explain why semantic search failed: {error}"
		);

		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn semantic_index_reports_worker_override_errors_without_crashing() {
		let _guard = crate::embedding_worker::lock_test_env();
		let root = fixture_root("missing-worker");
		let missing_worker = root.join("pi-embedding-worker-missing");
		let original = env::var_os("PI_EMBEDDING_WORKER");
		unsafe {
			env::set_var("PI_EMBEDDING_WORKER", &missing_worker);
		}
		crate::embedding_worker::reset_for_tests();

		let result = run_fixture_command(&root, "index", None, Some(true))
			.expect("graph index should still succeed when semantic indexing fails");

		assert!(
			result.output.contains("Embedding worker unavailable:"),
			"index output should surface worker failure: {}",
			result.output
		);
		assert!(
			result.output.contains("PI_EMBEDDING_WORKER points to"),
			"index output should explain override failure: {}",
			result.output
		);
		assert!(
			!root.join(".spell/graph/workspace-vectors.uidx").exists(),
			"failed semantic indexing should not create a vector cache"
		);

		match original {
			Some(value) => unsafe {
				env::set_var("PI_EMBEDDING_WORKER", value);
			},
			None => unsafe {
				env::remove_var("PI_EMBEDDING_WORKER");
			},
		}
		crate::embedding_worker::reset_for_tests();
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn semantic_index_builds_vector_cache_with_mock_worker() {
		let root = fixture_root("mock-success");
		let _env = MockWorkerEnv::new("success", None);

		let result = run_fixture_command(&root, "index", None, Some(true))
			.expect("semantic index should succeed with mock worker");

		assert!(
			result.output.contains("vectors indexed"),
			"semantic index output should confirm vector build: {}",
			result.output
		);
		assert!(
			result
				.semantic_status
				.as_deref()
				.is_some_and(|status| status.ends_with("vectors indexed")),
			"semantic status should summarize vector indexing: {:?}",
			result.semantic_status
		);
		assert!(
			root.join(".spell/graph/workspace-vectors.uidx").exists(),
			"successful semantic indexing should persist the vector cache"
		);

		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn semantic_index_rejects_vector_count_mismatch() {
		let root = fixture_root("short-batch");
		let _env = MockWorkerEnv::new("short_batch", None);

		let result = run_fixture_command(&root, "index", None, Some(true))
			.expect("graph index should continue when semantic batch size is malformed");

		assert!(
			result.output.contains("Embedding worker returned")
				&& result.output.contains("vectors for")
				&& result.output.contains("chunks"),
			"index output should surface the vector count mismatch: {}",
			result.output
		);
		assert!(
			!root.join(".spell/graph/workspace-vectors.uidx").exists(),
			"failed semantic indexing should not write a vector cache"
		);

		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn semantic_index_rejects_inconsistent_vector_dimensions() {
		let root = fixture_root("dimension-mismatch");
		let _env = MockWorkerEnv::new("batch_dim_mismatch", None);

		let result = run_fixture_command(&root, "index", None, Some(true))
			.expect("graph index should continue when semantic batch dimensions are malformed");

		assert!(
			result.output.contains("inconsistent vector dimensions"),
			"index output should surface the dimension mismatch: {}",
			result.output
		);
		assert!(
			!root.join(".spell/graph/workspace-vectors.uidx").exists(),
			"failed semantic indexing should not write a vector cache"
		);

		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn semantic_search_falls_back_when_query_vector_dimensions_do_not_match() {
		let root = fixture_root("query-dimension-mismatch");
		{
			let _env = MockWorkerEnv::new("success", None);
			run_fixture_command(&root, "index", None, Some(true))
				.expect("semantic index should succeed with mock worker");
		}

		let _env = MockWorkerEnv::new("query_dim_mismatch", Some(&temp_state_file("query-dim")));
		let result = run_fixture_command(&root, "search", Some("rateLimit"), Some(true))
			.expect("semantic search should fall back instead of failing on query dimension mismatch");

		assert!(
			result.output.contains("rateLimit"),
			"search output should still return lexical matches when semantic vectors mismatch: {}",
			result.output
		);
		assert!(
			result
				.semantic_status
				.as_deref()
				.is_some_and(|status| status.contains("hybrid search using")),
			"semantic status should report cached vectors were available: {:?}",
			result.semantic_status
		);

		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn status_reports_vector_cache_presence_when_file_exists() {
		let root = fixture_root("status-vectors");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");
		let graph_dir = root.join(".spell/graph");
		fs::create_dir_all(&graph_dir).expect("graph dir should exist");
		fs::write(graph_dir.join("workspace-vectors.uidx"), [1_u8, 2, 3])
			.expect("fake vector cache should be written");

		let result = run_fixture_command(&root, "status", None, None).expect("status should succeed");
		assert!(
			result.output.contains("Semantic: corrupt"),
			"status output should report vector cache presence: {}",
			result.output
		);
		assert!(
			result
				.semantic_status
				.as_deref()
				.is_some_and(|status| status.starts_with("corrupt (")),
			"semantic status should surface corrupt vector cache details: {:?}",
			result.semantic_status
		);

		let _ = fs::remove_dir_all(root);
	}

	fn dummy_fingerprint() -> WorkspaceFingerprint {
		use std::collections::BTreeMap;
		WorkspaceFingerprint {
			root:     PathBuf::from("/tmp/code-graph-cache-test"),
			git_head: Some("deadbeef".into()),
			files:    BTreeMap::new(),
		}
	}

	fn tiny_vector_index(dim: usize) -> pi_knowledge_core::vec::VectorIndex {
		let entries = vec![
			pi_knowledge_core::vec::VectorEntry { node_id: 1, vector: vec![0.1_f32; dim] },
			pi_knowledge_core::vec::VectorEntry { node_id: 2, vector: vec![0.2_f32; dim] },
		];
		pi_knowledge_core::vec::VectorIndex::from_entries(&entries, dim)
			.expect("vector index should build for test")
	}

	fn test_cache_store(name: &str) -> (CacheStore, PathBuf) {
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap_or_default()
			.as_nanos();
		let dir = std::env::temp_dir().join(format!(
			"pi-natives-code-graph-meta-{name}-{}-{unique}",
			std::process::id()
		));
		let _ = fs::remove_dir_all(&dir);
		fs::create_dir_all(&dir).expect("cache dir should be created");
		(CacheStore::new(&dir), dir)
	}

	#[test]
	fn load_returns_stale_on_embedder_model_mismatch() {
		let (cache, dir) = test_cache_store("model-mismatch");
		let vectors = tiny_vector_index(8);
		let fingerprint = dummy_fingerprint();
		save_vector_cache(&cache, &vectors, &fingerprint, "model-X")
			.expect("save should succeed");

		let state = load_vector_cache(&cache, Some(&fingerprint), "model-Y", vectors.dim());
		assert!(
			matches!(state, VectorCacheState::Stale(_)),
			"model swap must invalidate the cache, got {:?}",
			state.describe()
		);

		let _ = fs::remove_dir_all(dir);
	}

	#[test]
	fn load_returns_stale_on_embedder_dim_mismatch() {
		let (cache, dir) = test_cache_store("dim-mismatch");
		let vectors = tiny_vector_index(8);
		let fingerprint = dummy_fingerprint();
		save_vector_cache(&cache, &vectors, &fingerprint, "model-X")
			.expect("save should succeed");

		let state = load_vector_cache(&cache, Some(&fingerprint), "model-X", 16);
		assert!(
			matches!(state, VectorCacheState::Stale(_)),
			"dim change must invalidate the cache, got {:?}",
			state.describe()
		);

		let _ = fs::remove_dir_all(dir);
	}

	#[test]
	fn load_returns_stale_when_meta_missing() {
		let (cache, dir) = test_cache_store("meta-missing");
		let vectors = tiny_vector_index(8);
		let fingerprint = dummy_fingerprint();
		save_vector_cache(&cache, &vectors, &fingerprint, "model-X")
			.expect("save should succeed");

		let meta_path = dir.join(format!("{VECTORS_META_NAME}.bin"));
		assert!(meta_path.exists(), "sanity: meta sidecar exists after save");
		fs::remove_file(&meta_path).expect("unlink meta");

		let state = load_vector_cache(&cache, Some(&fingerprint), "model-X", vectors.dim());
		assert!(
			matches!(state, VectorCacheState::Stale(_)),
			"missing meta must be Stale (not Fresh, not Corrupt), got {:?}",
			state.describe()
		);

		let _ = fs::remove_dir_all(dir);
	}

	#[test]
	fn load_returns_fresh_on_full_match() {
		let (cache, dir) = test_cache_store("fresh");
		let vectors = tiny_vector_index(8);
		let fingerprint = dummy_fingerprint();
		save_vector_cache(&cache, &vectors, &fingerprint, "model-X")
			.expect("save should succeed");

		let state = load_vector_cache(&cache, Some(&fingerprint), "model-X", vectors.dim());
		assert!(
			matches!(state, VectorCacheState::Fresh(_)),
			"matched model+dim+fingerprint must be Fresh, got {:?}",
			state.describe()
		);

		let _ = fs::remove_dir_all(dir);
	}

	#[test]
	fn symbols_lookup_reports_bare_summary() {
		let root = fixture_root("symbols");
		run_fixture_command(&root, "index", None, None).expect("graph index should succeed");
		let result = run_fixture_command(&root, "symbols", Some("   "), None)
			.expect("symbols summary should succeed");
		assert!(
			result.output.contains("Symbols summary"),
			"symbols summary should include a heading: {}",
			result.output
		);
		assert!(
			result.output.contains("Status: summary"),
			"symbols summary should report summary status: {}",
			result.output
		);
		assert!(
			result
				.output
				.contains("Next: add a symbol name or qualified path to narrow results"),
			"symbols summary should include a refinement hint: {}",
			result.output
		);
		let _ = fs::remove_dir_all(root);
	}
}
