use std::{
	fs,
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_code_graph::{
	BuildGraphOptions, CacheStatus, CacheStore, CodeGraph, CodeGraphBuilder, GraphCluster,
	GraphContextResult, GraphDeadCodeItem, GraphDepsResult, GraphFlowResult, GraphImpactResult,
	GraphNodeSummary, GraphSearchMatch, GraphStatus, GraphTraversalLevel, LanguageRegistry,
};

use crate::task::{self, CancelToken};

const DEFAULT_DEPTH: u32 = 3;
const DEFAULT_LIMIT: u32 = 10;
const CACHE_NAME: &str = "workspace";

#[napi(object)]
pub struct CodeGraphOptions<'env> {
	pub command:    String,
	pub root:       Option<String>,
	pub file:       Option<String>,
	pub symbol:     Option<String>,
	pub query:      Option<String>,
	pub depth:      Option<u32>,
	pub limit:      Option<u32>,
	pub signal:     Option<Unknown<'env>>,
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms: Option<u32>,
}

struct CodeGraphTaskOptions {
	command: String,
	root:    Option<String>,
	file:    Option<String>,
	symbol:  Option<String>,
	query:   Option<String>,
	depth:   Option<u32>,
	limit:   Option<u32>,
}

impl From<CodeGraphOptions<'_>> for CodeGraphTaskOptions {
	fn from(value: CodeGraphOptions<'_>) -> Self {
		Self {
			command: value.command,
			root:    value.root,
			file:    value.file,
			symbol:  value.symbol,
			query:   value.query,
			depth:   value.depth,
			limit:   value.limit,
		}
	}
}

#[napi(object)]
pub struct CodeGraphResult {
	pub output:       String,
	#[napi(js_name = "cacheStatus")]
	pub cache_status: String,
	pub rebuilt:      bool,
	#[napi(js_name = "fileCount")]
	pub file_count:   u32,
	#[napi(js_name = "symbolCount")]
	pub symbol_count: u32,
	#[napi(js_name = "edgeCount")]
	pub edge_count:   u32,
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
		return render_status(&root, &cache);
	}

	let (graph, cache_status, rebuilt) =
		ensure_graph(&root, &cache, &builder, &cancel_token, options.command == "index")?;
	let output = match options.command.as_str() {
		"index" => format_status(&graph.graph_status(), &cache_status, rebuilt),
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
		"search" => {
			let query = options
				.query
				.as_deref()
				.ok_or_else(|| Error::from_reason("search requires `query`"))?;
			format_search(&graph.graph_search(query, options.limit.unwrap_or(DEFAULT_LIMIT) as usize))
		},
		other => return Err(Error::from_reason(format!("Unsupported code graph command: {other}"))),
	};

	let status = graph.graph_status();
	Ok(CodeGraphResult {
		output,
		cache_status,
		rebuilt,
		file_count: status.file_count,
		symbol_count: status.symbol_count,
		edge_count: status.edge_count,
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
	let status = cache.status(CACHE_NAME, root).map_err(to_napi_error)?;
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

fn render_status(root: &Path, cache: &CacheStore) -> napi::Result<CodeGraphResult> {
	let cache_status = match cache.status(CACHE_NAME, root).map_err(to_napi_error)? {
		CacheStatus::Missing => "missing".to_string(),
		CacheStatus::Fresh => "fresh".to_string(),
		CacheStatus::Stale { reason } => format!("stale ({reason})"),
	};
	let status = cache
		.load(CACHE_NAME)
		.map_err(to_napi_error)?
		.map(|entry| CodeGraph::from(entry.graph).graph_status());
	let output = if let Some(status) = &status {
		format_status(status, &cache_status, false)
	} else {
		format!("Code graph cache: {cache_status}\nRoot: {}\nNo index present.", root.display())
	};
	Ok(CodeGraphResult {
		output,
		cache_status,
		rebuilt: false,
		file_count: status.as_ref().map_or(0, |status| status.file_count),
		symbol_count: status.as_ref().map_or(0, |status| status.symbol_count),
		edge_count: status.as_ref().map_or(0, |status| status.edge_count),
	})
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
