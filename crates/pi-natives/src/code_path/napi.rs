//! NAPI exports for the CodePath kernel.
//!
//! Exposes `executeCodePath`, `parseCodePath`, and `renderCodePath`.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	sync::{Arc, OnceLock},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_code_path::{
	ast::{Axis, CodePath, FsSegment, Head, Locator, MutationOutcome},
	dialect::NameLexer,
	dialects::{fs::FsResolver, text::TextResolver},
	op::Op,
	parser::parse_code_path,
	renderer::render_code_path,
	resolver::{CancellationToken, CodeResolver, MutationResolver, Resolver},
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};
use winnow::{Parser, token::take_while};

use super::{
	code_resolver, css_resolver, dialect_registry, diff_qualifier,
	extractors::default_extractors,
	heading_resolver,
	marshal::{ARTIFACT_THRESHOLD, diagnostic_to_dto, mutation_outcome_to_dto, nodes_to_dtos},
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
pub struct CodePathOptions<'env> {
	pub command:            String,
	pub target:             Option<String>,
	#[napi(ts_type = "\"best-effort\" | \"strict\"")]
	pub transaction:        Option<String>,
	pub limit:              Option<u32>,
	pub head:               Option<u32>,
	pub tail:               Option<u32>,
	pub offset:             Option<u32>,
	pub format:             Option<String>,
	pub root:               Option<String>,
	#[napi(ts_type = "any")]
	pub actions:            Option<serde_json::Value>,
	pub manage:             Option<String>,
	pub gitignore:          Option<bool>,
	#[napi(js_name = "sessionId")]
	pub session_id:         Option<String>,
	pub abort_signal:       Option<Unknown<'env>>,
	#[napi(js_name = "timeoutMs")]
	pub timeout_ms:         Option<u32>,
	#[napi(js_name = "artifactThreshold")]
	pub artifact_threshold: Option<u32>,
}

// ── Transaction mode ─────────────────────────────────────────────

/// Atomicity mode for multi-action edit chains.
///
/// `BestEffort` (default): apply ops sequentially, abort on first failure,
/// keep prior writes on disk. Matches pre-FEAT-712 behaviour.
///
/// `Strict`: snapshot every target file before the loop. On any failure,
/// restore the snapshots before returning the diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionMode {
	BestEffort,
	Strict,
}

impl TransactionMode {
	pub fn from_str(s: &str) -> Option<Self> {
		match s {
			"best-effort" | "bestEffort" | "best_effort" => Some(Self::BestEffort),
			"strict" => Some(Self::Strict),
			_ => None,
		}
	}
}

/// FEAT-712: snapshot of a target file's pre-edit bytes (or `None` if
/// the file did not exist). Stored once per unique path so a multi-op
/// chain that touches the same file twice doesn't double-snapshot.
pub struct FileSnapshot {
	pub path:  std::path::PathBuf,
	pub prior: Option<Vec<u8>>,
}

/// FEAT-712: walk the action list and the resolved CodePath, collect
/// the absolute path of every file that could be mutated, snapshot
/// the current bytes (or mark "didn't exist"). Best-effort:
/// unresolvable paths are skipped silently — the loop will surface
/// them as runtime diagnostics.
pub fn snapshot_targets(
	ops: &[Op],
	cp: &CodePath,
	root: &std::path::Path,
) -> Vec<FileSnapshot> {
	let _ = ops;
	let mut paths: Vec<std::path::PathBuf> = Vec::new();
	if let Locator::Fs(fs) = &cp.locator {
		let mut p = root.to_path_buf();
		for seg in &fs.segments {
			if let pi_code_path::ast::FsSegment::Literal(s) = seg {
				if s == "/" {
					continue;
				}
				p.push(s);
			}
		}
		paths.push(p);
	}
	paths.sort();
	paths.dedup();
	paths
		.into_iter()
		.map(|path| {
			let prior = std::fs::read(&path).ok();
			FileSnapshot { path, prior }
		})
		.collect()
}

// ── Task options (owned, Send) ───────────────────────────────────

#[allow(dead_code)]
pub struct CodePathTaskOptions {
	pub command:            String,
	pub target:             String,
	pub transaction:        Option<TransactionMode>,
	pub limit:              Option<u32>,
	pub head:               Option<u32>,
	pub tail:               Option<u32>,
	pub offset:             Option<u32>,
	pub format:             Option<String>,
	pub root:               Option<String>,
	pub actions:            Option<serde_json::Value>,
	pub manage:             Option<String>,
	pub gitignore:          Option<bool>,
	pub session_id:         Option<String>,
	pub artifact_threshold: Option<u32>,
}

impl From<CodePathOptions<'_>> for CodePathTaskOptions {
	fn from(value: CodePathOptions<'_>) -> Self {
		Self {
			command:            value.command,
			target:             value.target.unwrap_or_default(),
			transaction:        value
				.transaction
				.as_deref()
				.and_then(TransactionMode::from_str),
			limit:              value.limit,
			head:               value.head,
			tail:               value.tail,
			offset:             value.offset,
			format:             value.format,
			root:               value.root,
			actions:            value.actions,
			manage:             value.manage,
			session_id:         value.session_id,
			gitignore:          value.gitignore,
			artifact_threshold: value.artifact_threshold,
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
			pi_code_path::ast::NamePayload::Quoted(s) => s.clone(),
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

static DOT_LEXER_ARC: OnceLock<Arc<dyn NameLexer>> = OnceLock::new();

/// Thin wrapper so `Arc<dyn NameLexer>` satisfies the `NameLexer` trait
/// bound required by `parse_code_path`.
struct NameLexerWrapper(Arc<dyn NameLexer>);

impl NameLexer for NameLexerWrapper {
	fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<pi_code_path::ast::NamePayload> {
		self.0.parse(input)
	}

	fn render(&self, n: &pi_code_path::ast::NamePayload) -> String {
		self.0.render(n)
	}

	fn matches(
		&self,
		n: &pi_code_path::ast::NamePayload,
		node: tree_sitter::Node<'_>,
		src: &str,
	) -> bool {
		self.0.matches(n, node, src)
	}
}

/// Two-phase lexer selection:
/// 1. Split `target` on the first `::`.
/// 2. Strip surrounding backticks from the FS prefix.
/// 3. If the prefix is empty, contains glob magic, or has no recognised
///    extension, fall back to the generic `DotLexer`.
/// 4. Otherwise look up the dialect by extension via `select_dialect`.
fn select_lexer(target: &str) -> (NameLexerWrapper, Vec<Diagnostic>) {
	let mut diagnostics = Vec::new();

	let Some(pos) = target.find("::") else {
		return (
			NameLexerWrapper(DOT_LEXER_ARC.get_or_init(|| Arc::new(DotLexer)).clone()),
			diagnostics,
		);
	};

	let prefix = &target[..pos];

	// Strip surrounding backticks from quoted FS literals.
	let prefix = prefix.strip_prefix('`').unwrap_or(prefix);
	let prefix = prefix.strip_suffix('`').unwrap_or(prefix);

	if prefix.is_empty() {
		return (
			NameLexerWrapper(DOT_LEXER_ARC.get_or_init(|| Arc::new(DotLexer)).clone()),
			diagnostics,
		);
	}

	if prefix.chars().any(|c| matches!(c, '*' | '?' | '[' | '{')) {
		diagnostics.push(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: "weak NamePayload parse: glob FS prefix uses generic DotLexer".to_string(),
			span:    None,
		});
		return (
			NameLexerWrapper(DOT_LEXER_ARC.get_or_init(|| Arc::new(DotLexer)).clone()),
			diagnostics,
		);
	}

	if let Some(lexer) = dialect_registry::select_dialect(Path::new(prefix)) {
		(NameLexerWrapper(lexer), diagnostics)
	} else {
		(NameLexerWrapper(DOT_LEXER_ARC.get_or_init(|| Arc::new(DotLexer)).clone()), diagnostics)
	}
}

// ── executeCodePath ──────────────────────────────────────────────

#[napi(js_name = "executeCodePath")]
pub fn execute_code_path(options: CodePathOptions<'_>) -> crate::task::Async<Vec<CodePathChunk>> {
	let cancel_token = CancelToken::new(options.timeout_ms, options.abort_signal);
	let task_options = CodePathTaskOptions::from(options);
	crate::task::blocking("code_path", cancel_token, move |cancel_token| {
		execute_code_path_inner(task_options, cancel_token)
	})
}
pub fn execute_code_path_inner(
	opts: CodePathTaskOptions,
	cancel_token: CancelToken,
) -> Result<Vec<CodePathChunk>> {
	// FEAT-704: `command:"manage"` short-circuits the CodePath parser.
	// Manage subcommands operate on workspace/buffer state, not on a
	// resolvable CodePath query. Pre-FEAT-704 this hit `parse_code_path`
	// with empty target and returned "parse failed at position 0".
	if opts.command == "manage" {
		let _ = &cancel_token;
		let root = opts
			.root
			.as_deref()
			.map(std::path::PathBuf::from)
			.unwrap_or_else(|| {
				std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
			});
		let target = opts.target.clone();
		let manage = opts.manage.as_deref().unwrap_or("");
		let session_id = opts.session_id.as_deref().unwrap_or("");
		let outcome = match manage {
			"" => Err(super::manage::handle_missing()),
			"languages" => super::manage::handle_languages(),
			"buffers" => super::manage::handle_buffers(),
			"save" => super::manage::handle_save(&target, &root),
			"undo" => super::manage::handle_undo(&target, &root, session_id),
			"redo" => super::manage::handle_redo(&target, &root, session_id),
			"diff" => super::manage::handle_diff(&target, &root, session_id),
			"context" => super::manage::handle_context(&root, session_id),
			"watcherStatus" | "watcher_status" => super::manage::handle_watcher_status(),
			"lockStatus" | "lock_status" => super::manage::handle_lock_status(&target, &root),
			"status" => super::manage::handle_status(
				if target.is_empty() {
					None
				} else {
					Some(target.as_str())
				},
				&root,
			),
			"index" => super::manage::handle_index(&root),
			other => Err(super::manage::handle_unknown(other)),
		};
		let chunk = match outcome {
			Ok(node) => {
				CodePathChunk { nodes: vec![node], diagnostics: Vec::new(), done: true }
			},
			Err(d) => {
				CodePathChunk { nodes: Vec::new(), diagnostics: vec![d], done: true }
			},
		};
		return Ok(vec![chunk]);
	}
	let (lexer, parse_diagnostics) = select_lexer(&opts.target);
	let mut cp = parse_code_path(&opts.target, &lexer).map_err(|d| Error::from_reason(d.message))?;

	// Projection is applied as post-processing on the resolver result,
	// not as query predicates. Predicates within a step are AND-ed,
	// which breaks sequential operations like "take first 3 of lines
	// 324–340" (AND of [324..340] and [0..3] is always empty).

	let root = opts
		.root
		.map(PathBuf::from)
		.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

	let pi_token = CancellationToken::new();


	// ── Edit command branch ──────────────────────────────────────
	if opts.command == "edit" {
		use pi_code_engine::buffer::TextEdit;
		use pi_code_path::ast::Locator;

		let raw_actions: Vec<serde_json::Value> = match opts.actions {
			Some(v) => serde_json::from_value(v)
				.map_err(|e| Error::from_reason(format!("invalid actions: {e}")))?,
			None => {
				return Ok(vec![CodePathChunk {
					nodes:       vec![],
					diagnostics: vec![DiagnosticDto {
						variant: "missing_actions".to_string(),
						message: "command: edit requires actions".to_string(),
						span:    None,
					}],
					done:        true,
				}]);
			},
		};

		let cp_value = serde_json::to_value(&cp).ok();
		let ops: Vec<Op> = {
			let mut parsed = Vec::with_capacity(raw_actions.len());
			for raw in &raw_actions {
				let raw_with_target = match (&cp_value, raw) {
					(Some(t), serde_json::Value::Object(obj)) if !obj.contains_key("target") => {
						let mut clone = obj.clone();
						clone.insert("target".to_string(), t.clone());
						serde_json::Value::Object(clone)
					},
					_ => raw.clone(),
				};
				match serde_json::from_value::<Op>(raw_with_target) {
					Ok(op) => parsed.push(op),
					Err(e) => {
						return Ok(vec![CodePathChunk {
							nodes: vec![],
							diagnostics: vec![DiagnosticDto {
								variant: "parse_error".to_string(),
								message: format!("invalid action JSON: {e}"),
								span:    None,
							}],
							done:    true,
						}]);
					},
				}
			}
			parsed
		};

		let _fs_resolver = FsResolver::new(root.clone());
		let extractors = default_extractors();
		let text_resolver = TextResolver::new(root.clone()).with_extractors(extractors);
		let mut code_resolver = code_resolver::new()
			.map_err(|d| Error::from_reason(d.message))?
			.with_root(root.clone());
		if let Some(ref sid) = opts.session_id {
			code_resolver = code_resolver.with_session_id(sid.clone());
		}
		let code_resolver_arc = std::sync::Arc::new(code_resolver);
		let css_resolver = css_resolver::CssResolver::new(code_resolver_arc.clone());
		let heading_resolver = heading_resolver::HeadingResolver::new(code_resolver_arc.clone());

		fn resolve_op_path(op: &Op, root: &std::path::Path) -> Option<std::path::PathBuf> {
			let cp = op.target_codepath();
			if let Locator::Fs(fs) = &cp.locator {
				let mut target = root.to_path_buf();
				for seg in &fs.segments {
					if let pi_code_path::ast::FsSegment::Literal(s) = seg {
						if s == "/" { continue; }
						target.push(s);
					}
				}
				Some(target)
			} else {
				None
			}
		}

		let strict_mode = opts.transaction == Some(TransactionMode::Strict);
		let snapshots: Vec<FileSnapshot> = if strict_mode {
			snapshot_targets(&ops, &cp, &root)
		} else {
			Vec::new()
		};
		let restore_strict = |snaps: &[FileSnapshot]| -> usize {
			let mut restored = 0_usize;
			for snap in snaps {
				match &snap.prior {
					Some(bytes) => {
						if std::fs::write(&snap.path, bytes).is_ok() {
							restored += 1;
						}
					},
					None => {
						let _ = std::fs::remove_file(&snap.path);
						restored += 1;
					},
				}
			}
			restored
		};

		use std::collections::HashMap;
		let mut file_groups: HashMap<std::path::PathBuf, Vec<&Op>> = HashMap::new();
		for op in &ops {
			let path = resolve_op_path(op, &root).ok_or_else(|| {
				Error::from_reason("edit op target must be a filesystem path".to_string())
			})?;
			file_groups.entry(path).or_default().push(op);
		}

		let mut outcomes: Vec<MutationOutcome> = Vec::new();
		for (path, group_ops) in file_groups {
			let code_paths: Vec<String> = group_ops
				.iter()
				.map(|op| {
					crate::code_path::code_resolver::mutation::build_target_id(
						op.target_codepath(),
						Some(&root),
					)
					.unwrap_or_default()
				})
				.collect();
			let result = crate::buffer_registry()
				.edit_transaction_with_delete(
					opts.session_id.as_deref(),
					&path,
					&code_paths,
					|buf| {
						let mut group_outcomes = Vec::new();
						let mut should_delete = false;
						for op in &group_ops {
							match op {
								Op::FileCreate { target: _, content, force } => {
									if path.exists() && !force {
										return Err(pi_code_engine::CodeEngineError::Edit(format!(
											"file already exists: {}",
											path.display()
										)));
									}
									let text = content.join("\n");
									let current = buf.source();
									if current != text {
										buf.edit_batch(vec![TextEdit {
											start_byte:   0,
											old_end_byte: current.len(),
											new_text:     text,
										}])?;
									}
									group_outcomes.push(MutationOutcome {
										edit_count:     1,
										diff:           None,
										created:        !path.exists(),
										target_summary: Some(path.to_string_lossy().to_string()),
									});
								},
								Op::FileWrite { target: _, content, force: _ } => {
									let text = content.join("\n");
									let current = buf.source();
									if current != text {
										buf.edit_batch(vec![TextEdit {
											start_byte:   0,
											old_end_byte: current.len(),
											new_text:     text,
										}])?;
									}
									group_outcomes.push(MutationOutcome {
										edit_count:     1,
										diff:           None,
										created:        !path.exists(),
										target_summary: Some(path.to_string_lossy().to_string()),
									});
								},
								Op::FileDelete { target: _ } => {
									if !path.exists() {
										return Err(pi_code_engine::CodeEngineError::Edit(format!(
											"file not found: {}",
											path.display()
										)));
									}
									let current = buf.source();
									if !current.is_empty() {
										buf.edit_batch(vec![TextEdit {
											start_byte:   0,
											old_end_byte: current.len(),
											new_text:     String::new(),
										}])?;
									}
									should_delete = true;
									group_outcomes.push(MutationOutcome {
										edit_count:     1,
										diff:           None,
										created:        false,
										target_summary: Some(path.to_string_lossy().to_string()),
									});
								},
								Op::FileAppend { .. }
								| Op::FilePrepend { .. }
								| Op::FilePatch { .. }
								| Op::LineReplace { .. }
								| Op::LineInsert { .. }
								| Op::LineAppend { .. }
								| Op::LinePrepend { .. } => {
									let outcome = text_resolver
										.try_apply(op, &pi_token)
										.unwrap()
										.map_err(|d| pi_code_engine::CodeEngineError::Edit(d.message))?;
									let disk = std::fs::read_to_string(&path).unwrap_or_default();
									let current = buf.source();
									if disk != current {
										buf.edit_batch(vec![TextEdit {
											start_byte:   0,
											old_end_byte: current.len(),
											new_text:     disk,
										}])?;
									}
									group_outcomes.push(outcome);
								},
								Op::CssRenameClassToken { .. }
								| Op::CssRenameIdToken { .. }
								| Op::CssRenameCustomProp { .. }
								| Op::CssRemoveDeadStyle { .. } => {
									let outcome = css_resolver
										.apply_to_buffer(buf, op)
										.map_err(|d| pi_code_engine::CodeEngineError::Edit(d.message))?;
									group_outcomes.push(outcome);
								},
								Op::HeadingPromote { .. }
								| Op::HeadingDemote { .. }
								| Op::HeadingReplaceBlock { .. } => {
									let outcome = heading_resolver
										.apply_to_buffer(buf, op)
										.map_err(|d| pi_code_engine::CodeEngineError::Edit(d.message))?;
									group_outcomes.push(outcome);
								},
								_ => {
									let action_json =
    						crate::code_path::code_resolver::mutation::op_to_code_buffer_action(op);
									let outcome = code_resolver_arc
										.apply_to_buffer(buf, op.target_codepath(), &action_json)
										.map_err(|d| pi_code_engine::CodeEngineError::Edit(d.message))?;
									group_outcomes.push(outcome);
								},
							}
						}
						Ok((group_outcomes, should_delete))
					},
				);
			match result {
				Ok((_, group_outcomes)) => outcomes.extend(group_outcomes),
				Err(e) => {
					let mut diag = diagnostic_to_dto(pi_code_path::types::Diagnostic {
						variant: pi_code_path::types::DiagnosticVariant::UnsupportedOperation,
						message: e.to_string(),
						span:    None,
					});
					if strict_mode {
						let rolled = restore_strict(&snapshots);
						diag.message = format!("{} (rolled back {rolled} file(s))", diag.message);
					}
					return Ok(vec![CodePathChunk {
						nodes:       outcomes.into_iter().map(mutation_outcome_to_dto).collect(),
						diagnostics: vec![diag],
						done:        true,
					}]);
				},
			}
		}

		let nodes: Vec<NodeRefDto> = outcomes.into_iter().map(mutation_outcome_to_dto).collect();
		let mut chunk = CodePathChunk { nodes, diagnostics: Vec::new(), done: true };
		if !parse_diagnostics.is_empty() {
			chunk
				.diagnostics
				.extend(parse_diagnostics.into_iter().map(|d| {
					DiagnosticDto {
						variant: "unsupported_operation".to_string(),
						message: d.message,
						span:    d
							.span
							.map(|s| SpanDto { start: s.start as u32, end: s.end as u32 }),
					}
				}));
		}
		return Ok(vec![chunk]);
	}

	// ── Query path (default) ─────────────────────────────────────
	let mut nodes = match &cp.locator {
		Locator::Fs(_) => {
			if is_text_qualifier_only(&cp) {
				// FEAT-689 / B2,B10: bare-file + content qualifier (#raw,
				// #bytes, #lines, #text, #match, #image) routes to the
				// TextResolver, not the FsResolver. Without this branch
				// the FsResolver claims the path and emits "unknown
				// qualifier" because it only knows listing/tree/stat.
				let extractors = default_extractors();
				let mut resolver = TextResolver::new(root.clone()).with_extractors(extractors);
				if let Some(gitignore) = opts.gitignore {
					resolver = resolver.with_gitignore(gitignore);
				}
				resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?
			} else if is_pure_text_query(&cp) {
				let extractors = default_extractors();
				let mut resolver = TextResolver::new(root).with_extractors(extractors);
				if let Some(gitignore) = opts.gitignore {
					resolver = resolver.with_gitignore(gitignore);
				}
				resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?
			} else if is_symbol_query(&cp) {
				// Code query: walk files, then apply code resolver per file.
				let qualifier = cp.qualifier.take();
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
					match code_resolver.resolve(&path, query, qualifier.as_ref(), &pi_token) {
						Ok(mut nodes) => results.append(&mut nodes),
						Err(d) => {
							let mut node = file_node;
							node.diagnostics.push(d);
							results.push(node);
						},
					}
				}
				results
			} else if is_outline_qualifier(&cp) {
				let qualifier = cp.qualifier.take();
				let fs_resolver = FsResolver::new(root.clone());
				let file_nodes = fs_resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?;
				let code_resolver = code_resolver::new().map_err(|d| Error::from_reason(d.message))?;
				let dummy_query = pi_code_path::ast::Query::single(pi_code_path::ast::Step {
					axis:       None,
					head:       pi_code_path::ast::Head::NodeKind("*".into()),
					predicates: vec![],
				});
				let mut results = Vec::new();
				for file_node in file_nodes {
					let path = if Path::new(&file_node.locator).is_absolute() {
						PathBuf::from(&file_node.locator)
					} else {
						root.join(&file_node.locator)
					};
					match code_resolver.resolve(&path, &dummy_query, qualifier.as_ref(), &pi_token) {
						Ok(mut nodes) => results.append(&mut nodes),
						Err(d) => {
							let mut node = file_node;
							node.diagnostics.push(d);
							results.push(node);
						},
					}
				}
				results
			} else if is_diff_qualifier(&cp) {
				let qualifier = cp.qualifier.as_ref().unwrap();
				let locator_str = fs_locator_to_path(&cp.locator);
				let diff_node = NodeRef {
					locator:     locator_str,
					range:       0..0,
					kind:        "§file".into(),
					content:     None,
					metadata:    HashMap::new(),
					diagnostics: Vec::new(),
				};
				diff_qualifier::resolve(&diff_node, qualifier, &root)
					.map_err(|d| Error::from_reason(d.message))?
			} else {
				let resolver = FsResolver::new(root);
				resolver
					.resolve(&cp, &pi_token)
					.map_err(|d| Error::from_reason(d.message))?
			}
		},
		Locator::Uri(uri) => {
			return Err(Error::from_reason(format!("unknown locator scheme: {}", uri.scheme)));
		},
	};

	// Apply projection as sequential post-processing on the result set.
	// Order: offset → (tail | head/limit). Tail takes precedence over
	// head/limit, matching the pre-FEAT-XXX projection.lower() semantics.
	if let Some(off) = opts.offset {
		let off = (off as usize).min(nodes.len());
		nodes = nodes.split_off(off);
	}
	if let Some(n) = opts.tail {
		let n = (n as usize).min(nodes.len());
		nodes = nodes.split_off(nodes.len() - n);
	} else if let Some(n) = opts.head.or(opts.limit) {
		let n = (n as usize).min(nodes.len());
		nodes.truncate(n);
	}

	if cancel_token.aborted() {
		return Err(Error::from_reason("Aborted: Signal"));
	}

	let threshold = opts
		.artifact_threshold
		.map(|n| n as usize)
		.unwrap_or(ARTIFACT_THRESHOLD);
	let dtos = nodes_to_dtos(nodes, threshold);
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

	// Attach any lexer-selection diagnostics to the first chunk.
	if !parse_diagnostics.is_empty() {
		let dtos: Vec<DiagnosticDto> = parse_diagnostics
			.into_iter()
			.map(|d| DiagnosticDto {
				variant: "unsupported_operation".to_string(),
				message: d.message,
				span:    d
					.span
					.map(|s| SpanDto { start: s.start as u32, end: s.end as u32 }),
			})
			.collect();
		if let Some(first) = chunks.first_mut() {
			first.diagnostics.extend(dtos);
		} else {
			chunks.push(CodePathChunk {
				nodes:       Vec::new(),
				diagnostics: dtos,
				done:        true,
			});
		}
	}

	Ok(chunks)
}

fn is_pure_text_query(cp: &CodePath) -> bool {
	let Some(query) = &cp.query else {
		return false;
	};
	let head_kind = match &query.head.head {
		Head::NodeKind(k) => k.as_str(),
		_ => return false,
	};
	matches!(head_kind, "line" | "para" | "chunk") && query.head.axis == Some(Axis::Structural)
}

/// FEAT-689: a CodePath with no query and a content-class qualifier
/// (raw/bytes/lines/text/match/image) is a TextResolver target, not an
/// FsResolver one. The FsResolver only understands listing/tree/stat
/// qualifiers, so without this routing predicate a bare `get("a.ts")`
/// (auto-qualified to `a.ts#raw`) errors out as "unknown qualifier: raw".
fn is_text_qualifier_only(cp: &CodePath) -> bool {
	if cp.query.is_some() {
		return false;
	}
	cp.qualifier.as_ref().is_some_and(|q| {
		matches!(q.name.as_str(), "raw" | "bytes" | "lines" | "text" | "match" | "image")
	})
}

/// #outline qualifier routes to the code resolver (symbol outline).
fn is_outline_qualifier(cp: &CodePath) -> bool {
	cp.query.is_none() && cp.qualifier.as_ref().is_some_and(|q| q.name == "outline")
}

/// Check if the CodePath has a `#diff` qualifier (routes to diff_qualifier).
fn is_diff_qualifier(cp: &CodePath) -> bool {
	cp.query.is_none()
		&& cp.qualifier.as_ref().is_some_and(|q| q.name == "diff")
}

/// Convert an FsLocator to a relative path string for the diff qualifier.
/// Joins literal segments, dropping separators that are just "/".
fn fs_locator_to_path(locator: &Locator) -> String {
	match locator {
		Locator::Fs(fs) => {
			let mut parts: Vec<String> = Vec::new();
			for seg in &fs.segments {
				match seg {
					FsSegment::Literal(s) if s == "/" => {},
					FsSegment::Literal(s) => parts.push(s.clone()),
					FsSegment::Star => parts.push("*".to_string()),
					FsSegment::DoubleStar => parts.push("**".to_string()),
					_ => {},
				}
			}
			if parts.is_empty() {
				".".to_string()
			} else {
				parts.join("")
			}
		},
		Locator::Uri(_) => ".".to_string(),
	}
}

fn is_symbol_query(cp: &CodePath) -> bool {
	cp.query.is_some() && !is_pure_text_query(cp)
}

// ── parseCodePath ────────────────────────────────────────────────

#[napi(js_name = "parseCodePath")]
pub fn parse_code_path_napi(target: String) -> Result<serde_json::Value> {
	let (lexer, _diagnostics) = select_lexer(&target);
	let cp = parse_code_path(&target, &lexer).map_err(|d| Error::from_reason(d.message))?;
	serde_json::to_value(&cp).map_err(|e| Error::from_reason(format!("serde error: {e}")))
}

// ── renderCodePath ───────────────────────────────────────────────

#[napi(js_name = "renderCodePath")]
pub fn render_code_path_napi(ast: serde_json::Value) -> Result<String> {
	let cp: CodePath =
		serde_json::from_value(ast).map_err(|e| Error::from_reason(format!("deser error: {e}")))?;
	Ok(render_code_path(&cp, &DotLexer))
}

// ── getRegisteredExtensions ─────────────────────────────────────

#[napi(js_name = "getRegisteredExtensions")]
pub fn get_registered_extensions() -> Result<Vec<String>> {
	let reg = pi_code_engine::language::LanguageRegistry::with_builtins()
		.map_err(|e| Error::from_reason(format!("registry error: {e}")))?;
	let mut exts = Vec::new();
	for id in reg.languages() {
		if let Some(profile) = reg.get(id) {
			if profile.capabilities.outline {
				exts.extend(profile.extensions.iter().cloned());
			}
		}
	}
	Ok(exts)
}
#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use super::*;
	fn opts(target: impl Into<String>) -> CodePathTaskOptions {
		CodePathTaskOptions {
			command:            "resolve".to_string(),
			target:             target.into(),
			transaction:        None,
			limit:              None,
			head:               None,
			tail:               None,
			offset:             None,
			format:             None,
			root:               None,
			actions:            None,
			manage:             None,
			gitignore:          None,
			artifact_threshold: None,
			session_id:         None,
		}
	}
	fn opts_with_root(target: impl Into<String>, root: PathBuf) -> CodePathTaskOptions {
		CodePathTaskOptions {
			command:            "resolve".to_string(),
			target:             target.into(),
			transaction:        None,
			limit:              None,
			head:               None,
			tail:               None,
			offset:             None,
			format:             None,
			root:               Some(root.to_string_lossy().to_string()),
			actions:            None,
			manage:             None,
			gitignore:          None,
			artifact_threshold: None,
			session_id:         None,
		}
	}
	fn opts_edit_with_root(
		target: impl Into<String>,
		root: PathBuf,
		actions: Option<serde_json::Value>,
	) -> CodePathTaskOptions {
		CodePathTaskOptions {
			command: "edit".to_string(),
			target: target.into(),
			transaction: None,
			limit: None,
			head: None,
			tail: None,
			offset: None,
			format: None,
			root: Some(root.to_string_lossy().to_string()),
			actions,
			manage: None,
			gitignore: None,
			artifact_threshold: None,
			session_id: None,
		}
	}
	#[test]
	fn bare_path_returns_file_node() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"hello").unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root("a.txt", root.clone()),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert_eq!(chunks[0].nodes.len(), 1);
		assert_eq!(chunks[0].nodes[0].kind, "§file");
	}
	#[test]
	fn glob_returns_multiple_files() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"a").unwrap();
		std::fs::write(root.join("b.txt"), b"b").unwrap();
		std::fs::write(root.join("c.rs"), b"c").unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root("*.txt", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert_eq!(nodes.len(), 2);
		assert!(nodes.iter().any(|n| n.locator.ends_with("a.txt")));
		assert!(nodes.iter().any(|n| n.locator.ends_with("b.txt")));
	}
	#[test]
	fn line_slice_returns_sliced_text() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\n").unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root("a.txt::§line[2..3]", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert_eq!(nodes.len(), 1, "FEAT-716: range slice = single body");
		assert!(nodes[0].locator.ends_with("<line 2..3>"), "{}", nodes[0].locator);
		let c = nodes[0].content.as_ref().expect("content expected");
		assert_eq!(c.value.as_deref(), Some("l2\nl3\n"));
	}
	#[test]
	fn regex_grep_over_glob() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"foo\nbar\nbaz\n").unwrap();
		std::fs::write(root.join("b.txt"), b"qux\nbar\n").unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root(r#"*.txt::§line[text~="ba."]"#, root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert_eq!(nodes.len(), 3);
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.contains("a.txt") && n.locator.contains("<line 2#"))
		);
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.contains("a.txt") && n.locator.contains("<line 3#"))
		);
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.contains("b.txt") && n.locator.contains("<line 2#"))
		);
	}

	#[test]
	fn cancellation_aborts_mid_walk() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		for i in 0..10 {
			std::fs::write(root.join(format!("{i}.txt")), b"a\n").unwrap();
		}
		let mut cancel = crate::task::CancelToken::default();
		cancel
			.emplace_abort_token()
			.abort(crate::task::AbortReason::User);
		let result = execute_code_path_inner(opts_with_root("*.txt::§line", root), cancel);
		assert!(result.is_err(), "expected cancellation error");
	}
	#[test]
	fn suffix_fallback_exact_basename() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join("src/utils")).unwrap();
		std::fs::write(root.join("src/utils/foo.ts"), b"data").unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root("foo.ts", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.ends_with("src/utils/foo.ts")),
			"expected suffix fallback to src/utils/foo.ts, got {:?}",
			nodes
		);
	}
	#[test]
	fn qualifier_stat_returns_metadata() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"hello world").unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root("a.txt#stat", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert_eq!(nodes.len(), 1);
		assert!(nodes[0].metadata.get("size").is_some());
	}
	#[test]
	fn parse_render_round_trip() {
		let target = "src/foo.ts::Bar//§call[0..5]#body";
		let ast = parse_code_path_napi(target.to_string()).unwrap();
		let rendered = render_code_path_napi(ast).unwrap();
		let ast2 = parse_code_path_napi(rendered.clone()).unwrap();
		let rendered2 = render_code_path_napi(ast2).unwrap();
		assert_eq!(rendered, rendered2, "round-trip mismatch: {} vs {}", rendered, rendered2);
	}
	#[test]
	fn chunking_sixty_four_nodes() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		for i in 0..70 {
			std::fs::write(root.join(format!("{i}.txt")), b"x\n").unwrap();
		}
		let chunks = execute_code_path_inner(
			opts_with_root("*.txt::§line", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 2, "expected 2 chunks for 70 nodes");
		assert_eq!(chunks[0].nodes.len(), 64);
		assert!(!chunks[0].done);
		assert_eq!(chunks[1].nodes.len(), 6);
		assert!(chunks[1].done);
	}
	#[test]
	#[ignore = "PLAN-302: §not-found diagnostic emission stubbed; tracked as BUG-344"]
	fn empty_result_emits_done_chunk() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let chunks = execute_code_path_inner(
			opts_with_root("*.nonexistent", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		// Zero-matches now emits a §not-found diagnostic node (BUG-344)
		assert_eq!(chunks[0].nodes.len(), 1);
		assert_eq!(chunks[0].nodes[0].kind, "§not-found");
		assert!(
			chunks[0].nodes[0]
				.diagnostics
				.iter()
				.any(|d| d.variant == "no_matches")
		);
	}
	#[test]
	fn parse_code_path_returns_json() {
		let ast = parse_code_path_napi("src/a.ts::Foo".to_string()).unwrap();
		assert!(ast.is_object());
		let locator = ast.get("locator").and_then(|l| l.as_object());
		assert!(locator.is_some());
	}
	#[test]
	fn projection_limit_truncates_results() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		for i in 0..5 {
			std::fs::write(root.join(format!("{i}.txt")), b"l1\nl2\nl3\n").unwrap();
		}
		let mut o = opts_with_root("*.txt::§line", root);
		o.limit = Some(2);
		let chunks = execute_code_path_inner(o, crate::task::CancelToken::default()).unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert_eq!(
			nodes.len(),
			2,
			"expected 2 lines total (limit applied as result-level truncation)"
		);
	}
	#[test]
	fn artifact_threshold_default_externalises_large_content() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "x".repeat(256 * 1024 + 1)).unwrap();
		let chunks = execute_code_path_inner(
			opts_with_root("a.txt::§line", root),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert!(!nodes.is_empty());
		let c = nodes[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_some(), "expected artifact_uri for content > 256 KiB");
		assert!(c.value.is_none(), "expected no inline value");
	}
	#[test]
	fn artifact_threshold_low_externalises_text() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "x".repeat(1025)).unwrap();
		let mut o = opts_with_root("a.txt::§line", root);
		o.artifact_threshold = Some(1024);
		let chunks = execute_code_path_inner(o, crate::task::CancelToken::default()).unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert!(!nodes.is_empty());
		let c = nodes[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_some(), "expected artifact_uri for content > 1 KiB");
		assert!(c.value.is_none());
	}
	#[test]
	fn artifact_threshold_zero_externalises_everything() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "xx".to_string()).unwrap();
		let mut o = opts_with_root("a.txt::§line", root);
		o.artifact_threshold = Some(0);
		let chunks = execute_code_path_inner(o, crate::task::CancelToken::default()).unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert!(!nodes.is_empty());
		let c = nodes[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_some(), "expected artifact_uri for zero threshold");
		assert!(c.value.is_none());
	}
	#[test]
	fn artifact_threshold_max_inlines_everything() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "x".repeat(256 * 1024 + 1)).unwrap();
		let mut o = opts_with_root("a.txt::§line", root);
		o.artifact_threshold = Some(u32::MAX);
		let chunks = execute_code_path_inner(o, crate::task::CancelToken::default()).unwrap();
		let nodes: Vec<_> = chunks.iter().flat_map(|c| c.nodes.iter()).collect();
		assert!(!nodes.is_empty());
		let c = nodes[0].content.as_ref().expect("content expected");
		assert!(c.artifact_uri.is_none(), "expected no artifact_uri for huge threshold");
		assert!(c.value.is_some(), "expected inline value");
	}

	#[test]
	fn edit_create_writes_file_via_fs_resolver() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let actions = Some(serde_json::json!([
			{"kind": "create", "content": "hi"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("new.txt", root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert_eq!(chunks[0].nodes.len(), 1);
		assert_eq!(chunks[0].nodes[0].kind, "§edit-result");
		assert_eq!(chunks[0].nodes[0].metadata.get("editCount").unwrap(), &1);
		assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "hi");
	}

	#[test]
	fn edit_rename_symbol_via_code_resolver() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let file = root.join("foo.ts");
		std::fs::write(&file, "function oldName() {}\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "rename", "content": "newName"}
		]));
		let target = format!("{}::oldName", file.display());
		let chunks = execute_code_path_inner(
			opts_edit_with_root(target, root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert_eq!(chunks[0].nodes.len(), 1);
		assert_eq!(chunks[0].nodes[0].kind, "§edit-result");
		assert!(
			chunks[0].nodes[0]
				.metadata
				.get("editCount")
				.unwrap()
				.as_u64()
				.unwrap()
				>= 1
		);
		let text = std::fs::read_to_string(root.join("foo.ts")).unwrap();
		assert!(text.contains("newName"), "expected rename to newName, got: {}", text);
	}

	#[test]
	fn edit_sequential_append_applies_both() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "first\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "append", "lines": "second"},
			{"kind": "append", "lines": "third"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("a.txt", root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert_eq!(chunks[0].nodes.len(), 2, "expected two edit-result nodes");
		let text = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert!(text.contains("first"));
		assert!(text.contains("second"));
		assert!(text.contains("third"));
	}

	#[test]
	fn edit_first_failure_aborts_rest() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "exists\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "create", "content": "x"},
			{"kind": "append", "lines": "y"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("a.txt", root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert_eq!(chunks[0].nodes.len(), 0, "prior outcomes empty since first action failed");
		assert_eq!(chunks[0].diagnostics.len(), 1);
		assert_eq!(
			chunks[0].diagnostics[0].variant, "file_exists",
			"expected file_exists from first create failure"
		);
		let text = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert!(!text.contains("y"), "second append should have been skipped");
	}

	#[test]
	fn edit_missing_actions_returns_diagnostic() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let chunks = execute_code_path_inner(
			opts_edit_with_root("a.txt", root, None),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert!(chunks[0].nodes.is_empty());
		assert_eq!(chunks[0].diagnostics.len(), 1);
		assert_eq!(chunks[0].diagnostics[0].variant, "missing_actions");
	}

	#[test]
	fn edit_unsupported_action_returns_diagnostic() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("foo.ts"), "function a() {}\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "promote"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("foo.ts::a", root, actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert!(chunks[0].nodes.is_empty());
		assert_eq!(chunks[0].diagnostics.len(), 1);
		assert_eq!(
			chunks[0].diagnostics[0].variant, "unsupported_operation",
			"expected unsupported_operation for unimplemented code action"
		);
	}

	#[test]
	fn edit_get_preserves_query_behaviour() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), b"hello").unwrap();
		let mut o = opts_with_root("a.txt", root);
		o.command = "get".to_string();
		let chunks = execute_code_path_inner(o, crate::task::CancelToken::default()).unwrap();
		assert_eq!(chunks.len(), 1);
		assert!(chunks[0].done);
		assert_eq!(chunks[0].nodes.len(), 1);
		assert_eq!(chunks[0].nodes[0].kind, "§file");
	}
}
