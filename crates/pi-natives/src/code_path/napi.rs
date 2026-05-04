//! NAPI exports for the CodePath kernel.
//!
//! Exposes `executeCodePath`, `parseCodePath`, and `renderCodePath`.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_code_path::{
	ast::{Axis, CodePath, Head, Locator},
	dialect::NameLexer,
	dialects::{fs::FsResolver, text::TextResolver},
	parser::parse_code_path,
	renderer::render_code_path,
	resolver::{CancellationToken, ProjectionOpts, Resolver, CodeResolver as _CodeResolverTrait},
	types::{Diagnostic, NodeRef},
};
use winnow::{Parser, token::take_while};

use super::{
	code_resolver,
	extractors::default_extractors,
	marshal::{self, ARTIFACT_THRESHOLD, nodes_to_dtos},
	uri::default_registry,
};
use crate::task::CancelToken;

// ── DTOs ─────────────────────────────────────────────────────────

#[napi(object)]
#[derive(Default, Clone, Debug)]
pub struct SpanDto {
	pub start: u32,
	pub end:   u32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DiagnosticDto {
	pub variant: String,
	pub message: String,
	pub span:    Option<SpanDto>,
}

#[napi(object)]
#[derive(Default, Clone, Debug)]
pub struct ContentDto {
	pub kind:         String,
	pub value:        Option<String>,
	pub artifact_uri: Option<String>,
	pub size:         Option<i64>,
	pub handle:       Option<String>,
	pub mime_type:    Option<String>,
	pub width:        Option<u32>,
	pub height:       Option<u32>,
	pub source_kind:  Option<String>,
	pub text:         Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct NodeRefDto {
	pub locator:     String,
	pub range_start: u32,
	pub range_end:   u32,
	pub kind:        String,
	pub content:     Option<ContentDto>,
	pub metadata:    serde_json::Value,
	pub diagnostics: Vec<DiagnosticDto>,
}

#[napi(object)]
pub struct CodePathChunk {
	pub nodes:       Vec<NodeRefDto>,
	pub diagnostics: Vec<DiagnosticDto>,
	pub done:        bool,
}

#[napi(object)]
pub struct CodePathOptions {
	pub command:      String,
	pub target:       String,
	pub limit:        Option<u32>,
	pub head:         Option<u32>,
	pub tail:         Option<u32>,
	pub offset:       Option<u32>,
	pub format:       Option<String>,
	pub root:         Option<String>,
	#[napi(ts_type = "any")]
	pub actions:      Option<serde_json::Value>,
	pub manage:       Option<String>,
	pub abort_signal: Option<Unknown<'static>>,
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms:   Option<u32>,
}

// ── Task options (owned, Send) ───────────────────────────────────

pub(crate) struct CodePathTaskOptions {
	pub(crate) command: String,
	pub(crate) target:  String,
	pub(crate) limit:   Option<u32>,
	pub(crate) head:    Option<u32>,
	pub(crate) tail:    Option<u32>,
	pub(crate) offset:  Option<u32>,
	pub(crate) format:  Option<String>,
	pub(crate) root:    Option<String>,
	pub(crate) actions: Option<serde_json::Value>,
	pub(crate) manage:  Option<String>,
}

impl From<CodePathOptions> for CodePathTaskOptions {
	fn from(value: CodePathOptions) -> Self {
		Self {
			command: value.command,
			target:  value.target,
			limit:   value.limit,
			head:    value.head,
			tail:    value.tail,
			offset:  value.offset,
			format:  value.format,
			root:    value.root,
			actions: value.actions,
			manage:  value.manage,
		}
	}
}

// ── Generic DotLexer ─────────────────────────────────────────────

struct DotLexer;

impl NameLexer for DotLexer {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<pi_code_path::ast::NamePayload> {
		let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.')
			.parse_next(input)?;
		Ok(pi_code_path::ast::NamePayload::Raw(s.to_string()))
	}

	fn render(&self, n: &pi_code_path::ast::NamePayload) -> String {
		match n {
			pi_code_path::ast::NamePayload::Raw(s) => s.clone(),
		}
	}

	fn matches(
		&self,
		_n: &pi_code_path::ast::NamePayload,
		_node: tree_sitter::Node<'_>,
		_src: &str,
	) -> bool {
		false
	}
}

// ── executeCodePath ──────────────────────────────────────────────

#[napi(js_name = "executeCodePath")]
pub fn execute_code_path(options: CodePathOptions) -> crate::task::Async<Vec<CodePathChunk>> {
	let cancel_token = CancelToken::new(options.timeout_ms, options.abort_signal);
	let task_options = CodePathTaskOptions::from(options);
	crate::task::blocking("code_path", cancel_token, move |cancel_token| {
		execute_code_path_inner(task_options, cancel_token)
	})
}

pub(crate) fn execute_code_path_inner(
	opts: CodePathTaskOptions,
	cancel_token: CancelToken,
) -> Result<Vec<CodePathChunk>> {
	let dot_lexer = DotLexer;
	let mut cp =
		parse_code_path(&opts.target, &dot_lexer).map_err(|d| Error::from_reason(d.message))?;

	// Apply projection opts.
	if let Some(query) = cp.query.take() {
		let proj = ProjectionOpts {
			limit:   opts.limit.map(|n| n as usize),
			head:    opts.head.map(|n| n as usize),
			tail:    opts.tail.map(|n| n as usize),
			offset:  opts.offset.map(|n| n as usize),
			context: None,
		};
		cp.query = Some(pi_code_path::resolver::lower(proj, query));
	}

	let root = opts
		.root
		.map(PathBuf::from)
		.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

	let pi_token = CancellationToken::new();

	let nodes = match &cp.locator {
		Locator::Fs(_) => {
			if is_text_query(&cp) {
				let extractors = default_extractors();
				let resolver = TextResolver::new(root).with_extractors(extractors);
				resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?
			} else if cp.query.is_some() {
				// Code query: walk files, then apply code resolver per file.
				let fs_resolver = FsResolver::new(root.clone());
				let file_nodes = fs_resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?;

				let code_resolver = code_resolver::new().map_err(|d| Error::from_reason(d.message))?;
				let query = cp.query.as_ref().unwrap();
				let mut results = Vec::new();
				for file_node in file_nodes {
					if cancel_token.aborted() || pi_token.is_cancelled() {
						break;
					}
					let path = if Path::new(&file_node.locator).is_absolute() {
						PathBuf::from(&file_node.locator)
					} else {
						root.join(&file_node.locator)
					};
					match code_resolver.resolve(&path, query, &pi_token) {
						Ok(mut nodes) => results.append(&mut nodes),
						Err(d) => {
							let mut node = file_node;
							node.diagnostics.push(d);
							results.push(node);
						},
					}
				}
				results
			} else {
				let resolver = FsResolver::new(root);
				resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?
			}
		},
		Locator::Uri(uri) => {
			let scheme_registry =
				default_registry(root.clone(), root.clone(), root.join(".spell/agent/blobs"));
			if let Some(handler) = scheme_registry.lookup(&uri.scheme) {
				vec![
					handler
						.handle(&uri.path, &pi_token)
						.map_err(|d| Error::from_reason(d.message))?,
				]
			} else {
				return Err(Error::from_reason(format!("unknown locator scheme: {}", uri.scheme)));
			}
		},
	};

	if cancel_token.aborted() {
		return Err(Error::from_reason("Aborted: Signal"));
	}

	let dtos = nodes_to_dtos(nodes, ARTIFACT_THRESHOLD);
	let mut chunks: Vec<CodePathChunk> = Vec::new();
	for chunk in dtos.chunks(64) {
		chunks.push(CodePathChunk {
			nodes:       chunk.to_vec(),
			diagnostics: Vec::new(),
			done:        false,
		});
	}
	if let Some(last) = chunks.last_mut() {
		last.done = true;
	} else {
		chunks.push(CodePathChunk {
			nodes:       Vec::new(),
			diagnostics: Vec::new(),
			done:        true,
		});
	}

	Ok(chunks)
}

fn is_text_query(cp: &CodePath) -> bool {
	let Some(query) = &cp.query else {
		return false;
	};
	let head_kind = match &query.head.head {
		Head::NodeKind(k) => k.as_str(),
		_ => return false,
	};
	matches!(head_kind, "line" | "para" | "chunk") && query.head.axis == Some(Axis::Structural)
}

// ── parseCodePath ────────────────────────────────────────────────

#[napi(js_name = "parseCodePath")]
pub fn parse_code_path_napi(target: String) -> Result<serde_json::Value> {
	let dot_lexer = DotLexer;
	let cp = parse_code_path(&target, &dot_lexer).map_err(|d| Error::from_reason(d.message))?;
	serde_json::to_value(&cp).map_err(|e| Error::from_reason(format!("serde error: {e}")))
}

// ── renderCodePath ───────────────────────────────────────────────

#[napi(js_name = "renderCodePath")]
pub fn render_code_path_napi(ast: serde_json::Value) -> Result<String> {
	let cp: CodePath =
		serde_json::from_value(ast).map_err(|e| Error::from_reason(format!("deser error: {e}")))?;
	Ok(render_code_path(&cp, &DotLexer))
}
