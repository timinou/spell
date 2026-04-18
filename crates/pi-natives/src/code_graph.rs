use std::{
	collections::hash_map::DefaultHasher,
	fmt::Write as _,
	fs,
	hash::{Hash, Hasher},
	io::{BufReader, BufWriter},
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_code_graph::{
	BuildGraphOptions, CacheStatus, CacheStore, CodeGraph, CodeGraphBuilder, GraphCluster,
	GraphContextResult, GraphDeadCodeItem, GraphDepsResult, GraphFilesResult, GraphFlowResult,
	GraphImpactResult, GraphNodeSummary, GraphSearchMatch, GraphStatus, GraphSymbolsResult,
	GraphTraversalLevel, LanguageRegistry,
};

use crate::{
	embedding_worker,
	task::{self, CancelToken},
};

const DEFAULT_DEPTH: u32 = 3;
const DEFAULT_LIMIT: u32 = 10;
const CACHE_NAME: &str = "workspace";
const VECTORS_CACHE_NAME: &str = "workspace-vectors";

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
	Fresh(pi_code_vectors::PersistedVectorIndex),
	Stale(pi_code_vectors::PersistedVectorIndex),
	Corrupt(String),
}

impl VectorCacheState {
	fn describe(&self) -> String {
		match self {
			Self::Missing => "missing".to_string(),
			Self::Fresh(persisted) => format!("{} vectors (fresh)", persisted.entries.len()),
			Self::Stale(persisted) => format!("{} vectors (stale)", persisted.entries.len()),
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
				match load_vector_cache(&cache, graph_fingerprint_hash(&cache)) {
					VectorCacheState::Fresh(persisted) => {
						let vector_count = persisted.entries.len();
						match embedding_worker::embed_query(query) {
							Ok(query_vector) => {
								semantic_status =
									Some(format!("hybrid search using {vector_count} cached vectors"));
								let search_graph = CodeGraph::with_vectors(
									graph.into_persisted(),
									pi_code_vectors::VectorIndex::from_persisted(persisted),
								);
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
			.load(CACHE_NAME)
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
		.load(CACHE_NAME)
		.map_err(to_napi_error)?
		.map(|entry| CodeGraph::from(entry.graph).graph_status());
	let semantic_status = load_vector_cache(cache, graph_fingerprint_hash(cache)).describe();
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
	let vector_index = pi_code_vectors::VectorIndex::new(entries, dimensions);
	let fingerprint_hash = compute_fingerprint_hash(cache);
	let persisted = vector_index.to_persisted("jina-embeddings-v2-base-code", fingerprint_hash);
	save_vector_cache(cache, &persisted)?;
	Ok(count)
}

fn validate_worker_vectors(
	chunks: &[pi_code_graph::ChunkResult],
	vectors: Vec<Vec<f32>>,
) -> napi::Result<(Vec<pi_code_vectors::VectorEntry>, usize)> {
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
		.map(|(chunk, vector)| pi_code_vectors::VectorEntry { node_index: chunk.node_index, vector })
		.collect();
	Ok((entries, dimensions))
}

fn graph_fingerprint_hash(cache: &CacheStore) -> Option<u64> {
	let entry = cache.load(CACHE_NAME).ok().flatten()?;
	let mut hasher = DefaultHasher::new();
	entry.fingerprint.hash(&mut hasher);
	Some(hasher.finish())
}

/// Compute a deterministic hash of the graph fingerprint for vector cache
/// validation.
fn compute_fingerprint_hash(cache: &CacheStore) -> u64 {
	graph_fingerprint_hash(cache).unwrap_or(0)
}

fn save_vector_cache(
	cache: &CacheStore,
	vectors: &pi_code_vectors::PersistedVectorIndex,
) -> napi::Result<()> {
	fs::create_dir_all(cache.directory())
		.map_err(|e| Error::from_reason(format!("Failed to create cache dir: {e}")))?;
	let temp_path = cache
		.directory()
		.join(format!("{VECTORS_CACHE_NAME}.bin.tmp"));
	let final_path = cache.directory().join(format!("{VECTORS_CACHE_NAME}.bin"));
	let file = fs::File::create(&temp_path)
		.map_err(|e| Error::from_reason(format!("Failed to create temp vector cache: {e}")))?;
	{
		let writer = BufWriter::new(file);
		pi_code_vectors::serialize_index(writer, vectors)
			.map_err(|e| Error::from_reason(format!("Failed to write temp vector cache: {e}")))?;
	}
	fs::rename(&temp_path, &final_path)
		.map_err(|e| Error::from_reason(format!("Failed to rename temp vector cache: {e}")))
}

fn load_vector_cache(cache: &CacheStore, expected_hash: Option<u64>) -> VectorCacheState {
	let path = cache.directory().join(format!("{VECTORS_CACHE_NAME}.bin"));
	let file = match fs::File::open(&path) {
		Ok(file) => file,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
			return VectorCacheState::Missing;
		},
		Err(error) => {
			return VectorCacheState::Corrupt(format!("failed to open {}: {error}", path.display()));
		},
	};
	let persisted = match pi_code_vectors::deserialize_index(BufReader::new(file)) {
		Ok(persisted) => persisted,
		Err(error) => return VectorCacheState::Corrupt(error.to_string()),
	};
	let Some(expected_hash) = expected_hash else {
		return VectorCacheState::Stale(persisted);
	};
	if persisted.graph_fingerprint_hash != expected_hash {
		return VectorCacheState::Stale(persisted);
	}
	VectorCacheState::Fresh(persisted)
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
		"Code graph status\nRoot: {}\nCache: {cache_status}\nRebuilt: {rebuild_line}\nFiles: \
		 {}\nSymbols: {}\nEdges: {}\nGit HEAD: {}\nLanguages: {}",
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
	append_section(&mut sections, "Callers", &result.callers, limit);
	append_section(&mut sections, "Callees", &result.callees, limit);
	append_section(&mut sections, "References", &result.references, limit);
	append_section(&mut sections, "Referenced by", &result.referenced_by, limit);
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
	append_section(&mut sections, "Outgoing imports", &result.outgoing, limit);
	append_section(&mut sections, "Incoming imports", &result.incoming, limit);
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
		sync::MutexGuard,
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
		_guard:          MutexGuard<'static, ()>,
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
	fn index_without_semantic_leaves_vector_cache_absent() {
		let root = fixture_root("plain-index");
		let result =
			run_fixture_command(&root, "index", None, None).expect("plain index should succeed");

		assert!(result.semantic_status.is_none());
		assert!(
			!root.join(".spell/graph/workspace-vectors.bin").exists(),
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
			!root.join(".spell/graph/workspace-vectors.bin").exists(),
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
			root.join(".spell/graph/workspace-vectors.bin").exists(),
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
			!root.join(".spell/graph/workspace-vectors.bin").exists(),
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
			!root.join(".spell/graph/workspace-vectors.bin").exists(),
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
		fs::write(graph_dir.join("workspace-vectors.bin"), [1_u8, 2, 3])
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
