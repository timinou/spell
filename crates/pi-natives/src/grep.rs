//! Ripgrep-backed search exported via N-API.
//!
//! The search engine lives in `pi-text-search` so CodePath `find` and the
//! native grep tool share one implementation.

use std::path::PathBuf;

use napi::{
	JsString,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use pi_text_search::{
	CollectedMatch, OutputMode, SearchConfig, SearchError, SearchParams, SearchResult as CoreGrepResult,
	parse_output_mode, parse_type_filter, resolve_context, search_content,
};

use crate::task;

/// Options for searching file content.
#[napi(object)]
pub struct SearchOptions {
	/// Regex pattern to search for.
	pub pattern:        String,
	/// Case-insensitive search.
	#[napi(js_name = "ignoreCase")]
	pub ignore_case:    Option<bool>,
	/// Enable multiline matching.
	pub multiline:      Option<bool>,
	/// Maximum number of matches to return.
	#[napi(js_name = "maxCount")]
	pub max_count:      Option<u32>,
	/// Skip first N matches.
	pub offset:         Option<u32>,
	/// Lines of context before matches.
	#[napi(js_name = "contextBefore")]
	pub context_before: Option<u32>,
	/// Lines of context after matches.
	#[napi(js_name = "contextAfter")]
	pub context_after:  Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context:        Option<u32>,
	/// Truncate lines longer than this (characters).
	#[napi(js_name = "maxColumns")]
	pub max_columns:    Option<u32>,
	/// Output mode (content or count).
	pub mode:           Option<String>,
}

/// Options for searching files on disk.
#[napi(object)]
pub struct GrepOptions<'env> {
	/// Regex pattern to search for.
	pub pattern:        String,
	/// Directory or file to search.
	pub path:           String,
	/// Glob filter for filenames (e.g., "*.ts").
	pub glob:           Option<String>,
	/// Filter by file type (e.g., "js", "py", "rust").
	#[napi(js_name = "type")]
	pub type_filter:    Option<String>,
	/// Case-insensitive search.
	#[napi(js_name = "ignoreCase")]
	pub ignore_case:    Option<bool>,
	/// Enable multiline matching.
	pub multiline:      Option<bool>,
	/// Include hidden files (default: true).
	pub hidden:         Option<bool>,
	/// Respect .gitignore files (default: true).
	pub gitignore:      Option<bool>,
	/// Enable shared filesystem scan cache (accepted for API compatibility; the
	/// shared search core owns walking/caching policy).
	pub cache:          Option<bool>,
	/// Maximum number of matches to return.
	#[napi(js_name = "maxCount")]
	pub max_count:      Option<u32>,
	/// Skip first N matches.
	pub offset:         Option<u32>,
	/// Lines of context before matches.
	#[napi(js_name = "contextBefore")]
	pub context_before: Option<u32>,
	/// Lines of context after matches.
	#[napi(js_name = "contextAfter")]
	pub context_after:  Option<u32>,
	/// Lines of context before/after matches (legacy).
	pub context:        Option<u32>,
	/// Truncate lines longer than this (characters).
	#[napi(js_name = "maxColumns")]
	pub max_columns:    Option<u32>,
	/// Output mode (content, filesWithMatches, or count).
	pub mode:           Option<String>,
	/// Abort signal for cancelling the operation.
	pub signal:         Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms:     Option<u32>,
}

/// A context line (before or after a match).
#[derive(Clone)]
#[napi(object)]
pub struct ContextLine {
	#[napi(js_name = "lineNumber")]
	pub line_number: u32,
	/// Raw line content (trimmed line ending).
	pub line:        String,
}

/// A single match in the content.
#[napi(object)]
pub struct Match {
	/// 1-indexed line number.
	#[napi(js_name = "lineNumber")]
	pub line_number:    u32,
	/// The matched line content.
	pub line:           String,
	/// Context lines before the match.
	#[napi(js_name = "contextBefore")]
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	#[napi(js_name = "contextAfter")]
	pub context_after:  Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated:      Option<bool>,
}

/// Result of searching content.
#[napi(object)]
pub struct SearchResult {
	/// All matches found.
	pub matches:       Vec<Match>,
	/// Total number of matches (may exceed `matches.len()` due to offset/limit).
	#[napi(js_name = "matchCount")]
	pub match_count:   u32,
	/// Whether the limit was reached.
	#[napi(js_name = "limitReached")]
	pub limit_reached: bool,
	/// Error message, if any.
	pub error:         Option<String>,
}

/// A single match in a grep result.
#[derive(Clone)]
#[napi(object)]
pub struct GrepMatch {
	/// File path for the match (relative for directory searches).
	pub path:           String,
	/// 1-indexed line number (0 for count-only entries).
	#[napi(js_name = "lineNumber")]
	pub line_number:    u32,
	/// The matched line content (empty for count-only entries).
	pub line:           String,
	/// Context lines before the match.
	#[napi(js_name = "contextBefore")]
	pub context_before: Option<Vec<ContextLine>>,
	/// Context lines after the match.
	#[napi(js_name = "contextAfter")]
	pub context_after:  Option<Vec<ContextLine>>,
	/// Whether the line was truncated.
	pub truncated:      Option<bool>,
	/// Per-file match count (count mode only).
	#[napi(js_name = "matchCount")]
	pub match_count:    Option<u32>,
}

/// Result of searching files.
#[napi(object)]
pub struct GrepResult {
	/// Matches or per-file counts, depending on output mode.
	pub matches:            Vec<GrepMatch>,
	/// Total matches across all files.
	#[napi(js_name = "totalMatches")]
	pub total_matches:      u32,
	/// Number of files with at least one match.
	#[napi(js_name = "filesWithMatches")]
	pub files_with_matches: u32,
	/// Number of files searched.
	#[napi(js_name = "filesSearched")]
	pub files_searched:     u32,
	/// Whether the limit/offset stopped the search early.
	#[napi(js_name = "limitReached")]
	pub limit_reached:      Option<bool>,
}

struct GrepConfig {
	pattern:        String,
	path:           String,
	glob:           Option<String>,
	type_filter:    Option<String>,
	ignore_case:    Option<bool>,
	multiline:      Option<bool>,
	hidden:         Option<bool>,
	gitignore:      Option<bool>,
	cache:          Option<bool>,
	max_count:      Option<u32>,
	offset:         Option<u32>,
	context_before: Option<u32>,
	context_after:  Option<u32>,
	context:        Option<u32>,
	max_columns:    Option<u32>,
	mode:           Option<String>,
}

fn clamp_u32(value: u64) -> u32 {
	value.min(u32::MAX as u64) as u32
}

fn convert_error(err: SearchError) -> Error {
	Error::from_reason(err.to_string())
}

fn resolve_search_path(path: &str) -> Result<PathBuf> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute() {
		return Ok(candidate);
	}
	let cwd = std::env::current_dir()
		.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
	Ok(cwd.join(candidate))
}

fn to_context(lines: Vec<pi_text_search::ContextLine>) -> Option<Vec<ContextLine>> {
	if lines.is_empty() {
		return None;
	}
	Some(
		lines
			.into_iter()
			.map(|line| ContextLine { line_number: clamp_u32(line.line_number), line: line.line })
			.collect(),
	)
}

fn to_public_match(matched: CollectedMatch) -> Match {
	Match {
		line_number:    clamp_u32(matched.line_number),
		line:           matched.line,
		context_before: to_context(matched.context_before),
		context_after:  to_context(matched.context_after),
		truncated:      if matched.truncated { Some(true) } else { None },
	}
}

fn to_grep_match(matched: pi_text_search::SearchMatch) -> GrepMatch {
	GrepMatch {
		path:           matched.path,
		line_number:    clamp_u32(matched.line_number),
		line:           matched.line,
		context_before: to_context(matched.context_before),
		context_after:  to_context(matched.context_after),
		truncated:      if matched.truncated { Some(true) } else { None },
		match_count:    matched.match_count.map(clamp_u32),
	}
}

const fn empty_search_result(error: Option<String>) -> SearchResult {
	SearchResult { matches: Vec::new(), match_count: 0, limit_reached: false, error }
}

fn search_sync(content: &[u8], options: SearchOptions) -> SearchResult {
	let mode = parse_output_mode(options.mode.as_deref());
	let (context_before, context_after) =
		resolve_context(options.context, options.context_before, options.context_after);
	let params = SearchParams {
		context_before,
		context_after,
		max_columns: options.max_columns,
		mode,
		max_count: options.max_count.map(u64::from),
		offset: options.offset.unwrap_or(0) as u64,
	};
	let result = match search_content(
		content,
		&options.pattern,
		options.ignore_case.unwrap_or(false),
		options.multiline.unwrap_or(false),
		params,
	) {
		Ok(result) => result,
		Err(err) => return empty_search_result(Some(err.to_string())),
	};
	SearchResult {
		matches:       result.matches.into_iter().map(to_public_match).collect(),
		match_count:   clamp_u32(result.match_count),
		limit_reached: result.limit_reached,
		error:         None,
	}
}

fn grep_sync(
	options: GrepConfig,
	on_match: Option<&ThreadsafeFunction<GrepMatch>>,
	ct: task::CancelToken,
) -> Result<GrepResult> {
	let search_path = resolve_search_path(&options.path)?;
	let output_mode = parse_output_mode(options.mode.as_deref());
	let (mut context_before, mut context_after) =
		resolve_context(options.context, options.context_before, options.context_after);
	if output_mode != OutputMode::Content {
		context_before = 0;
		context_after = 0;
	}
	let config = SearchConfig {
		pattern: options.pattern,
		path: search_path,
		glob: options.glob,
		type_filter: parse_type_filter(options.type_filter.as_deref()),
		ignore_case: options.ignore_case.unwrap_or(false),
		multiline: options.multiline.unwrap_or(false),
		hidden: options.hidden.unwrap_or(true),
		gitignore: options.gitignore.unwrap_or(true),
		max_count: options.max_count.map(u64::from),
		offset: options.offset.unwrap_or(0) as u64,
		context_before,
		context_after,
		max_columns: options.max_columns,
		mode: output_mode,
		..SearchConfig::new("", "")
	};
	let _ = options.cache;
	ct.heartbeat()?;
	let result = pi_text_search::search_files(&config).map_err(convert_error)?;
	ct.heartbeat()?;
	Ok(to_grep_result(result, on_match))
}

fn to_grep_result(
	result: CoreGrepResult,
	on_match: Option<&ThreadsafeFunction<GrepMatch>>,
) -> GrepResult {
	let matches: Vec<GrepMatch> = result.matches.into_iter().map(to_grep_match).collect();
	if let Some(callback) = on_match {
		for grep_match in &matches {
			callback.call(Ok(grep_match.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}
	GrepResult {
		matches,
		total_matches:      clamp_u32(result.total_matches),
		files_with_matches: clamp_u32(result.files_with_matches),
		files_searched:     clamp_u32(result.files_searched),
		limit_reached:      if result.limit_reached { Some(true) } else { None },
	}
}

/// Search content for a pattern (one-shot, compiles pattern each time).
#[napi(js_name = "search")]
pub fn search(content: Either<JsString, Uint8Array>, options: SearchOptions) -> SearchResult {
	match &content {
		Either::A(js_str) => {
			let utf8 = match js_str.into_utf8() {
				Ok(utf8) => utf8,
				Err(err) => return empty_search_result(Some(err.to_string())),
			};
			search_sync(utf8.as_slice(), options)
		},
		Either::B(buf) => search_sync(buf.as_ref(), options),
	}
}

/// Quick check if content matches a pattern.
#[napi(js_name = "hasMatch")]
pub fn has_match(
	content: Either<JsString, Uint8Array>,
	pattern: Either<JsString, Uint8Array>,
	ignore_case: bool,
	multiline: bool,
) -> Result<bool> {
	let content_utf8;
	let content_slice: &[u8] = match &content {
		Either::A(js_str) => {
			content_utf8 = js_str.into_utf8()?;
			content_utf8.as_slice()
		},
		Either::B(buf) => buf.as_ref(),
	};

	let pattern_utf8;
	let pattern_string;
	let pattern_ref: &str = match &pattern {
		Either::A(js_str) => {
			pattern_utf8 = js_str.into_utf8()?;
			pattern_utf8.as_str()?
		},
		Either::B(buf) => {
			pattern_string = std::str::from_utf8(buf.as_ref())
				.map_err(|err| Error::from_reason(format!("Invalid UTF-8 in pattern: {err}")))?
				.to_owned();
			&pattern_string
		},
	};

	pi_text_search::has_match(content_slice, pattern_ref, ignore_case, multiline).map_err(convert_error)
}

/// Search files for a regex pattern.
#[napi(js_name = "grep")]
pub fn grep(
	options: GrepOptions<'_>,
	#[napi(ts_arg_type = "((match: GrepMatch) => void) | undefined | null")] on_match: Option<
		ThreadsafeFunction<GrepMatch>,
	>,
) -> task::Async<GrepResult> {
	let GrepOptions {
		pattern,
		path,
		glob,
		type_filter,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		cache,
		max_count,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
		timeout_ms,
		signal,
	} = options;

	let config = GrepConfig {
		pattern,
		path,
		glob,
		type_filter,
		ignore_case,
		multiline,
		hidden,
		gitignore,
		cache,
		max_count,
		offset,
		context_before,
		context_after,
		context,
		max_columns,
		mode,
	};

	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("grep", ct, move |ct| grep_sync(config, on_match.as_ref(), ct))
}
