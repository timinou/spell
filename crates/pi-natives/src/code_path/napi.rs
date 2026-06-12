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
	ast::{CodePath, FsSegment, Head, Locator, MutationOutcome},
	dialect::NameLexer,
	op::Op,
	parser::parse_code_path,
	renderer::render_code_path,
	resolver::CancellationToken,
	types::{Diagnostic, DiagnosticVariant, NodeRef},
};
use winnow::{Parser, token::take_while};

use super::{
	code_resolver, css_resolver, dialect_registry, diff_qualifier, edge_dispatch,
	extractors::default_extractors,
	heading_resolver,
	marshal::{ARTIFACT_THRESHOLD, diagnostic_to_dto, mutation_outcome_to_dto, nodes_to_dtos},
	semantic_dispatch,
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
	// PLAN-310 W1: SessionContext threading.
	pub home:               Option<String>,
	#[napi(js_name = "sessionDir")]
	pub session_dir:        Option<String>,
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

/// Convert a CodePath with an FsLocator to an absolute filesystem path.
fn code_path_to_fs_path(cp: &CodePath, root: &std::path::Path) -> Option<std::path::PathBuf> {
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
		Some(p)
	} else {
		None
	}
}

/// Map an edit-transaction error to a DiagnosticDto.
/// PeerConflict is surfaced as its own variant so callers can distinguish
/// concurrent-edit errors from genuine unsupported ops.
fn map_edit_error_to_diagnostic(e: pi_code_engine::CodeEngineError) -> DiagnosticDto {
	let variant = if let pi_code_engine::CodeEngineError::PeerConflict { .. } = e {
		pi_code_path::types::DiagnosticVariant::PeerConflict
	} else {
		pi_code_path::types::DiagnosticVariant::UnsupportedOperation
	};
	diagnostic_to_dto(pi_code_path::types::Diagnostic {
		variant,
		message: e.to_string(),
		span: None,
	})
}

/// FEAT-712: walk the action list and the resolved CodePath, collect
/// the absolute path of every file that could be mutated, snapshot
/// the current bytes (or mark "didn't exist"). Best-effort:
/// unresolvable paths are skipped silently — the loop will surface
/// them as runtime diagnostics.
pub fn snapshot_targets(ops: &[Op], cp: &CodePath, root: &std::path::Path) -> Vec<FileSnapshot> {
	let mut paths: std::collections::BTreeSet<std::path::PathBuf> =
		std::collections::BTreeSet::new();

	if let Some(p) = code_path_to_fs_path(cp, root) {
		paths.insert(p);
	}
	for op in ops {
		if let Some(p) = code_path_to_fs_path(op.target_codepath(), root) {
			paths.insert(p);
		}
	}

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
#[derive(Default)]
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
	// PLAN-310 W1: SessionContext threading.
	pub home:               Option<String>,
	pub session_dir:        Option<String>,
}

impl CodePathTaskOptions {
	/// Build a `SessionContext` from `root` + `home` + `session_dir`. Returns
	/// `None` when `root` is unset (anonymous mode).
	/// Per PLAN-310: threaded through every URI resolution path.
	pub fn session_context(&self) -> Option<pi_code_path::SessionContext> {
		let root = self.root.as_deref()?;
		let home = self
			.home
			.clone()
			.or_else(|| std::env::var("HOME").ok())
			.unwrap_or_default();
		let mut ctx = pi_code_path::SessionContext::new(root, home);
		if let Some(dir) = &self.session_dir {
			ctx = ctx.with_session_dir(dir);
		}
		Some(ctx)
	}
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
			home:               value.home,
			session_dir:        value.session_dir,
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

/// The warm language registry for the read lane (P3.7 cutover). Built once and
/// shared with `pi_kernel::resolve_target`; the old per-call `code_resolver::new()`
/// rebuilt it each time — this caches it (same builtins, read-only after init).
fn code_resolver_registry() -> Arc<pi_code_engine::language::LanguageRegistry> {
	static REGISTRY: OnceLock<Arc<pi_code_engine::language::LanguageRegistry>> = OnceLock::new();
	REGISTRY
		.get_or_init(|| {
			Arc::new(
				pi_code_engine::language::LanguageRegistry::with_builtins()
					.expect("kernel language registry init failed"),
			)
		})
		.clone()
}

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
		// BUG-411 (PLAN-318 W0): informational — a glob prefix means the kernel
		// cannot pick a language-specific name lexer (it doesn't know which
		// extension the query will land on). Symbol-name matching falls back
		// to a generic lexer. NodeKind / FieldName / AnchorName heads are
		// unaffected; we filter this diagnostic out for non-Name heads in
		// `execute_code_path_inner` (post-parse).
		diagnostics.push(Diagnostic {
			variant: DiagnosticVariant::Informational,
			message: "glob path prefix means language-specific symbol-name matching is disabled for \
			          this query; this only affects `::SymbolName` style heads, not `::§kind` / \
			          `::¶anchor` / `::field:` axes"
				.to_string(),
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
	mut opts: CodePathTaskOptions,
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
	// PLAN-310 Block C: rewrite agent path-form into kernel #json: qualifier.
	//   agent://X/foo/0  →  agent://X#json:.foo[0]
	// Preserves jq parity with the legacy TS agent-protocol.ts which mapped
	// the URL path segments to jq via pathToQuery() + applyQuery().
	rewrite_agent_path_form(&mut opts.target);

	let (lexer, parse_diagnostics) = select_lexer(&opts.target);
	let mut cp = parse_code_path(&opts.target, &lexer).map_err(|d| Error::from_reason(d.message))?;

	// BUG-411 (PLAN-318 W0): suppress the glob-prefix informational diagnostic
	// when the query head isn't `Head::Name` — the name lexer choice doesn't
	// affect NodeKind / FieldName / AnchorName resolution.
	let parse_diagnostics: Vec<_> = {
		use pi_code_path::ast::Head;
		let head_is_name = cp
			.query
			.as_ref()
			.map(|q| matches!(q.head.head, Head::Name(_)))
			.unwrap_or(false);
		parse_diagnostics
			.into_iter()
			.filter(|d| {
				let is_glob_lexer_hint = matches!(d.variant, DiagnosticVariant::Informational)
					&& d.message.contains("glob path prefix");
				if is_glob_lexer_hint {
					head_is_name
				} else {
					true
				}
			})
			.collect()
	};

	// Projection is applied as post-processing on the resolver result,
	// not as query predicates. Predicates within a step are AND-ed,
	// which breaks sequential operations like "take first 3 of lines
	// 324–340" (AND of [324..340] and [0..3] is always empty).

	// PLAN-310: compute SessionContext before opts.root is consumed below.
	let session_ctx = opts.session_context();

	let root = opts
		.root
		.as_deref()
		.map(PathBuf::from)
		.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

	let pi_token = CancellationToken::new();

	// ── Edit command branch ──────────────────────────────────────
	if opts.command == "edit" {
		use pi_code_engine::buffer::TextEdit;

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
		// PLAN-321: the external action surface is the 6-verb `Verb` enum, which
		// lowers to a precise kernel `Op` using the *target* shape (family is
		// never named by the model). Legacy callers (e.g. `create.ts` emitting
		// `fileCreate`, or any pre-cutover Op kind) still deserialize directly as
		// `Op` — we try `Verb` first, fall back to `Op`. One compatibility seam,
		// no flag-day break.
		let ops: Vec<Op> = {
			let mut parsed = Vec::with_capacity(raw_actions.len());
			for raw in &raw_actions {
				let kind = raw.get("kind").and_then(|k| k.as_str()).unwrap_or("");
				let is_verb = matches!(kind, "replace" | "rename" | "delete" | "patch" | "restructure");
				let parse_result: std::result::Result<Op, String> = if is_verb {
					// Verbs carry no `target`; they lower against the parsed `cp`.
					serde_json::from_value::<pi_code_path::Verb>(raw.clone())
						.map_err(|e| format!("invalid verb action: {e}"))
						.and_then(|verb| verb.lower(&cp).map_err(|d| d.message))
				} else {
					let raw_with_target = match (&cp_value, raw) {
						(Some(t), serde_json::Value::Object(obj)) if !obj.contains_key("target") => {
							let mut clone = obj.clone();
							clone.insert("target".to_string(), t.clone());
							serde_json::Value::Object(clone)
						},
						_ => raw.clone(),
					};
					serde_json::from_value::<Op>(raw_with_target)
						.map_err(|e| format!("invalid action JSON: {e}"))
				};
				match parse_result {
					Ok(op) => parsed.push(op),
					Err(msg) => {
						return Ok(vec![CodePathChunk {
							nodes:       vec![],
							diagnostics: vec![DiagnosticDto {
								variant: "parse_error".to_string(),
								message: msg,
								span:    None,
							}],
							done:        true,
						}]);
					},
				}
			}
			parsed
		};

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
			code_path_to_fs_path(op.target_codepath(), root)
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
					// Tolerate body/sig qualifiers here: this string is only a
					// registry/lock key, and a `foo#body` target is valid for
					// scoped writes. The strict variant rejects qualifiers, which
					// would yield an empty key via unwrap_or_default.
					crate::code_path::code_resolver::mutation::build_target_id_lenient(
						op.target_codepath(),
						Some(&root),
					)
				})
				.collect();
			let result = crate::buffer_registry().edit_transaction_with_delete(
				opts.session_id.as_deref(),
				&path,
				&code_paths,
				|buf| {
					let mut group_outcomes = Vec::new();
					let mut should_delete = false;
					for op in &group_ops {
						// Snapshot before each op so we can backfill a unified diff for
						// any resolver that leaves `MutationOutcome.diff = None` (symbol /
						// css / heading paths). Text/line ops already populate `diff`; the
						// backfill below is a no-op for them (it only fills `None`). This
						// gives the TUI a real diff for structural edits instead of a flat
						// "Updated X (N edit(s))" summary.
						let before_op = buf.source();
						let outcomes_before = group_outcomes.len();
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
								let current = buf.source();
								let (new_text, mut outcome) =
									match pi_code_path::dialects::text::mutation::apply_to_text(op, &current)
									{
										Some(Ok(r)) => r,
										Some(Err(d)) => {
											return Err(pi_code_engine::CodeEngineError::Edit(d.message));
										},
										None => {
											return Err(pi_code_engine::CodeEngineError::Edit(
												"text resolver does not support this op".to_string(),
											));
										},
									};
								if current != new_text {
									buf.edit_batch(vec![TextEdit {
										start_byte: 0,
										old_end_byte: current.len(),
										new_text,
									}])?;
								}
								outcome.target_summary = Some(path.to_string_lossy().to_string());
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
						// Backfill a unified diff for any outcome this op produced that
						// lacks one (symbol/css/heading resolvers return `diff: None`).
						let after_op = buf.source();
						if after_op != before_op && !should_delete {
							for outcome in group_outcomes.iter_mut().skip(outcomes_before) {
								// `created` keeps its dedicated "Created X" render; delete is
								// a whole-file removal where a diff is pure noise.
								if outcome.diff.is_none() && !outcome.created {
									outcome.diff =
										Some(diffy::create_patch(&before_op, &after_op).to_string());
								}
							}
						}
					}
					Ok((group_outcomes, should_delete))
				},
			);
			match result {
				Ok((_, group_outcomes)) => outcomes.extend(group_outcomes),
				Err(e) => {
					let mut diag = map_edit_error_to_diagnostic(e);
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
			chunk.diagnostics.extend(
				parse_diagnostics
					.into_iter()
					.map(crate::code_path::marshal::diagnostic_to_dto),
			);
		}
		return Ok(vec![chunk]);
	}

	// ── Edge dispatch (PLAN-318 W1) ──────────────────────────────
	// When the query chain contains an Edge combinator (ref→/def→/call→/
	// import→/bind→), resolve the prefix as a normal symbol query, then
	// walk the cached pi-code-graph to produce the edge's neighbours.
	if let Some(edge_pos) = cp.query.as_ref().and_then(|q| {
		q.chain
			.iter()
			.position(|(c, _)| matches!(c, pi_code_path::ast::Combinator::Edge(_)))
	}) {
		if let Locator::Fs(_) = &cp.locator {
			return edge_dispatch::resolve(
				cp,
				edge_pos,
				root,
				opts.gitignore,
				opts.artifact_threshold,
				opts.head,
				opts.tail,
				opts.offset,
				opts.limit,
				parse_diagnostics,
				&pi_token,
				&cancel_token,
			);
		}
	}

	// ── Query path (default) ─────────────────────────────────────
	let mut nodes = match &cp.locator {
		Locator::Fs(_) => {
			if semantic_dispatch::is_semantic_dispatch(&cp) {
				// FUP-099 (FUP-LIVE): #hover / #signature / #type_definition /
				// #inlay / #diagnostics (and the deprecated #hover_inferred)
				// dispatch via the per-workspace CompositeSemanticBackend. This
				// is HOST-ONLY (LSP backend) — the kernel read lane excludes it,
				// so it is handled here before delegating to resolve_target.
				semantic_dispatch::resolve(&cp, &root, &pi_token, &cancel_token)?
			} else if is_diff_qualifier(&cp) {
				// #diff is HOST-ONLY (git subprocess); also excluded from the kernel
				// read lane and handled here before delegating.
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
				// P3.7 CUTOVER: every remaining read shape (text-qualifier, pure-text,
				// symbol, outline, fs) is served by the SAME host-agnostic kernel entry
				// the rustler skin calls — single source of truth, no duplicate dispatch.
				// The kernel resolves nodes + query-level diagnostics; the diagnostics
				// fold into parse_diagnostics so the chunk-level emission is unchanged.
				// out.diagnostics is the lexer-selection set — IDENTICAL to napi's own
				// filtered `parse_diagnostics` (both are pure fns of opts.target), which
				// is already emitted at the chunk level below. Discard the kernel's copy
				// to avoid double-counting (e.g. the glob-prefix hint).
				//
				// Host-abort bridge: the kernel's mid-walk guard checks `pi_token` (host-
				// agnostic). Propagate an already-fired host abort (AbortSignal/timeout)
				// into it so an aborted request skips the walk entirely. Full mid-walk
				// responsiveness for a long in-flight symbol walk is FUP-tracked; the
				// post-match guard below returns Err on abort either way.
				if cancel_token.aborted() {
					pi_token.cancel();
				}
				let out = pi_kernel::resolve_target(
					&code_resolver_registry(),
					&opts.target,
					&root,
					&default_extractors(),
					opts.gitignore,
					&pi_token,
				)
				.map_err(|d| Error::from_reason(d.message))?;
				out.nodes
			}
		},
		Locator::Uri(uri) => {
			// PLAN-310: dispatch via kernel SchemeRegistry.
			let registry =
				crate::code_path::runtime_schemes::scheme_registry_for_session(session_ctx.as_ref());
			let cancel_tok = pi_code_path::resolver::traits::CancellationToken::new();

			// PLAN-310 BUG-395 fix: callback-loader schemes can opt into having the
			// kernel fold non-special qualifiers (anything other than #json/#stat/
			// #tree/#raw/#listing/#diff) back into the URI body as `#<name>[:<args>]`
			// so the callback sees the full RFC-3986 fragment. Static fs-backed
			// profiles get the unmodified URI — their qualifiers are codepath ops
			// to apply post-resolution, not part of the identifier.
			let resolve_uri = match &cp.qualifier {
				Some(q)
					if registry.scheme_uses_callback_loader(&uri.scheme)
						&& !matches!(
							q.name.as_str(),
							"json" | "stat" | "tree" | "raw" | "listing" | "diff"
						) =>
				{
					let mut p = uri.path.clone();
					p.push('#');
					p.push_str(&q.name);
					if let Some(args) = &q.args {
						p.push(':');
						p.push_str(args);
					}
					pi_code_path::ast::UriLocator { scheme: uri.scheme.clone(), path: p }
				},
				_ => uri.clone(),
			};

			match registry.resolve(&resolve_uri, session_ctx.as_ref(), &cancel_tok) {
				Ok(resolved) => {
					// PLAN-310 Block C: `#json:<jq-expr>` qualifier applies a jq subset
					// to the resolved content (works on both fs-backed and virtual
					// schemes; doesn't need source_path forwarding).
					if let Some(q) = &cp.qualifier {
						if q.name == "json" {
							let expr = q.args.as_deref().unwrap_or(".");
							let text = match &resolved.content {
								pi_code_path::types::Content::Text { value } => value.clone(),
								pi_code_path::types::Content::ExtractedText { text, .. } => text.clone(),
								_ => {
									return Err(Error::from_reason(format!(
										"#json: requires text content; got binary for {}://{}",
										uri.scheme, uri.path
									)));
								},
							};
							let extracted = match pi_code_path::jq_subset::eval(&text, expr) {
								Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_default(),
								Err(e) => {
									return Err(Error::from_reason(format!(
										"#json: failed for {}://{}: {e}",
										uri.scheme, uri.path
									)));
								},
							};
							let mut metadata = HashMap::new();
							metadata.insert(
								"mime".into(),
								serde_json::Value::String("application/json".into()),
							);
							let mut notes = resolved.notes.clone();
							notes.push(format!("Extracted: {expr}"));
							metadata.insert(
								"notes".into(),
								serde_json::Value::Array(
									notes.into_iter().map(serde_json::Value::String).collect(),
								),
							);
							let node = pi_code_path::types::NodeRef {
								locator: resolved.url.clone(),
								range: 0..0,
								kind: format!("§{}", uri.scheme),
								content: Some(pi_code_path::types::Content::Text { value: extracted }),
								metadata,
								diagnostics: vec![],
							};
							return Ok(single_node_chunks(node));
						}
					}

					// Codepath forwarding: when the URI has a query/qualifier AND the
					// resolved scheme is fs-backed with a real source_path, re-dispatch
					// against that path so the kernel evaluates the suffix natively.
					// (e.g. `memory://root::§line[2..2]` → evaluate §line on the resolved
					// `.spell/memory/memory_summary.md`).
					let has_suffix = cp.query.is_some() || cp.qualifier.is_some();
					if has_suffix && resolved.source_path.is_some() {
						let sp = resolved.source_path.as_ref().unwrap().clone();
						let rel = sp
							.strip_prefix(&root)
							.map(|p| p.to_path_buf())
							.unwrap_or_else(|_| sp.clone());
						// Extract the suffix from the original target string. The
						// parser only consumes up to `::` for URIs, so the rest of
						// the input — starting with `::` or `#` — is the suffix.
						let original = &opts.target;
						let uri_prefix_end = original
							.find("::")
							.or_else(|| original.find('#'))
							.unwrap_or(original.len());
						let suffix = &original[uri_prefix_end..];
						let forwarded_target = format!("{}{}", rel.display(), suffix);
						let forwarded_opts = CodePathTaskOptions {
							command:            opts.command.clone(),
							target:             forwarded_target,
							transaction:        opts.transaction,
							limit:              opts.limit,
							head:               opts.head,
							tail:               opts.tail,
							offset:             opts.offset,
							format:             opts.format.clone(),
							root:               opts.root.clone(),
							actions:            opts.actions.clone(),
							manage:             opts.manage.clone(),
							gitignore:          opts.gitignore,
							session_id:         opts.session_id.clone(),
							artifact_threshold: opts.artifact_threshold,
							home:               opts.home.clone(),
							session_dir:        opts.session_dir.clone(),
						};
						return execute_code_path_inner(forwarded_opts, cancel_token);
					} else {
						let mut metadata = HashMap::new();
						if let Some(mime) = &resolved.mime {
							metadata.insert("mime".into(), serde_json::Value::String(mime.clone()));
						}
						if !resolved.notes.is_empty() {
							metadata.insert(
								"notes".into(),
								serde_json::Value::Array(
									resolved
										.notes
										.iter()
										.map(|n| serde_json::Value::String(n.clone()))
										.collect(),
								),
							);
						}
						if let Some(p) = &resolved.source_path {
							metadata.insert(
								"source_path".into(),
								serde_json::Value::String(p.display().to_string()),
							);
						}
						// If suffix present but scheme is virtual (no source_path),
						// emit a note that the qualifier was ignored.
						if has_suffix {
							metadata
								.entry("notes".into())
								.or_insert_with(|| serde_json::Value::Array(vec![]));
							if let Some(serde_json::Value::Array(arr)) = metadata.get_mut("notes") {
								arr.push(serde_json::Value::String(format!(
									"codepath qualifier ignored (resource '{}://' is not filesystem-backed)",
									uri.scheme
								)));
							}
						}
						let kind = format!("§{}", uri.scheme);
						let node = pi_code_path::types::NodeRef {
							locator: resolved.url.clone(),
							range: 0..0,
							kind,
							content: Some(resolved.content.clone()),
							metadata,
							diagnostics: vec![],
						};
						vec![node]
					}
				},
				Err(d) => {
					return Err(Error::from_reason(d.message));
				},
			}
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
			.map(crate::code_path::marshal::diagnostic_to_dto)
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

/// Check if the CodePath has a `#diff` qualifier (routes to diff_qualifier).
/// The remaining read-shape predicates (text-qualifier / pure-text / symbol /
/// outline) moved to `pi_kernel::parse` with the P3.7 cutover — napi delegates
/// those branches to `pi_kernel::resolve_target`, keeping only the host-only
/// `#diff` check here.
fn is_diff_qualifier(cp: &CodePath) -> bool {
	cp.query.is_none() && cp.qualifier.as_ref().is_some_and(|q| q.name == "diff")
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

	use pi_code_path::{ActionContent, ast::CodePath};

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
			home:               None,
			session_dir:        None,
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
			home:               None,
			session_dir:        None,
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
			home: None,
			session_dir: None,
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
				.any(|n| n.locator.contains("a.txt") && n.locator.contains("<line 2>"))
		);
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.contains("a.txt") && n.locator.contains("<line 3>"))
		);
		assert!(
			nodes
				.iter()
				.any(|n| n.locator.contains("b.txt") && n.locator.contains("<line 2>"))
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
			{"kind": "fileCreate", "content": "hi"}
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
			{"kind": "symbolRename", "newName": "newName"}
		]));
		let target = "foo.ts::oldName".to_string();
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

	/// Regression (adversarial test-drive): `rename` MUST rewrite every in-file
	/// reference, not just the declaration. The builder path
	/// (resolve_mutation_edit) only rewrote the declaration name field,
	/// silently leaving call sites dangling; rename now routes to the legacy
	/// `single_action` → `rename_symbol` path which renames the declaration AND
	/// all references.
	#[test]
	fn edit_rename_symbol_updates_all_references() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let file = root.join("refs.ts");
		std::fs::write(
			&file,
			"function helper(x: number) { return x; }\nconst a = helper(1);\nconst b = helper(2);\n",
		)
		.unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "symbolRename", "newName": "doubler"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("refs.ts::helper".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "rename diagnostics: {:?}", chunks[0].diagnostics);
		let text = std::fs::read_to_string(root.join("refs.ts")).unwrap();
		assert!(!text.contains("helper"), "all `helper` occurrences must be renamed, got: {text}");
		assert_eq!(text.matches("doubler").count(), 3, "decl + 2 call sites must be renamed: {text}");
	}

	/// Structural (symbol/css/heading) edits must carry a unified `diff` in the
	/// edit-result metadata so the TUI renders a real diff rather than a flat
	/// "Updated X (N edit(s))" line. Backfilled at the napi chokepoint for any
	/// resolver that leaves `MutationOutcome.diff = None`.
	#[test]
	fn edit_result_backfills_diff_for_structural_ops() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let cases: &[(&str, &str, serde_json::Value)] = &[
			(
				"s.ts",
				"function oldName() {}\n",
				serde_json::json!([{ "kind": "rename", "to": "newName" }]),
			),
			(
				"s.css",
				":root { --accent: blue; }\n.x { color: var(--accent); }\n",
				serde_json::json!([{ "kind": "rename", "to": "--brand" }]),
			),
		];
		let targets = ["s.ts::oldName", "s.css::--accent"];
		for ((file, src, actions), target) in cases.iter().zip(targets) {
			std::fs::write(root.join(file), src).unwrap();
			let chunks = execute_code_path_inner(
				opts_edit_with_root(target.to_string(), root.clone(), Some(actions.clone())),
				crate::task::CancelToken::default(),
			)
			.unwrap();
			let diff = chunks[0].nodes[0].metadata.get("diff");
			assert!(
				diff.and_then(|d| d.as_str()).is_some_and(|s| !s.is_empty()),
				"expected backfilled diff for `{target}`, metadata: {:?}",
				chunks[0].nodes[0].metadata
			);
		}
	}

	// ── PLAN-321: verb surface end-to-end through the real edit branch ──

	#[test]
	fn verb_replace_rewrites_symbol() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("foo.ts"), "function foo() { return 1; }\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "replace", "content": "function foo() { return 42; }"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("foo.ts::foo".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		assert_eq!(chunks[0].nodes[0].kind, "§edit-result");
		let text = std::fs::read_to_string(root.join("foo.ts")).unwrap();
		assert!(text.contains("return 42"), "got: {text}");
	}

	#[test]
	fn edit_md_structural_recipe_preserves_arguments() {
		// BUG-454: the marquee edit.md cheat-sheet recipe
		//   "§call[name=console.log]"  →  replace · content:"logger.info$2"
		// must (a) resolve the call via the callee `function` field and
		// (b) preserve the call's arguments ($2 = the arguments node).
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("svc.ts"), "function f() {\n  console.log(\"hi\", x);\n}\n")
			.unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "replace", "content": "logger.info$2"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("svc.ts::§call[name=console.log]".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		let text = std::fs::read_to_string(root.join("svc.ts")).unwrap();
		assert!(text.contains("logger.info(\"hi\", x)"), "args must be preserved, got: {text}");
		assert!(!text.contains("console.log"), "callee must be replaced, got: {text}");
	}

	#[test]
	fn verb_rename_symbol_lowers_and_applies() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("foo.ts"), "function oldName() {}\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "rename", "to": "newName"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("foo.ts::oldName".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		let text = std::fs::read_to_string(root.join("foo.ts")).unwrap();
		assert!(text.contains("newName"), "got: {text}");
	}

	#[test]
	fn verb_delete_symbol_lowers_and_applies() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("foo.ts"), "function keep() {}\nfunction dead() {}\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "delete"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("foo.ts::dead".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		let text = std::fs::read_to_string(root.join("foo.ts")).unwrap();
		assert!(!text.contains("dead"), "dead symbol should be gone, got: {text}");
		assert!(text.contains("keep"), "keep should remain, got: {text}");
	}

	/// BUG-433: delete must remove the WHOLE statement including any enclosing
	/// `export` / `const`/`let` wrapper, not just the inner declarator. A name
	/// query yields the nested wrapper chain; selecting the narrow node orphans
	/// the wrapper (`export const ;`) → invalid syntax. Covers exported const,
	/// exported fn, and plain const.
	#[test]
	fn verb_delete_removes_enclosing_declaration_wrapper() {
		let cases = [
			("export const X = 1;\nexport const Y = 2;\n", "X", "X = 1", "Y = 2"),
			("export function X(){}\nexport function Y(){}\n", "X", "function X", "function Y"),
			("const A = 1;\nconst B = 2;\n", "A", "A = 1", "B = 2"),
		];
		for (src, sym, gone, kept) in cases {
			let dir = tempfile::tempdir().unwrap();
			let root = dir.path().to_path_buf();
			std::fs::write(root.join("d.ts"), src).unwrap();
			let actions = Some(serde_json::json!([{ "kind": "delete" }]));
			let chunks = execute_code_path_inner(
				opts_edit_with_root(format!("d.ts::{sym}"), root.clone(), actions),
				crate::task::CancelToken::default(),
			)
			.unwrap();
			assert!(
				chunks[0].diagnostics.is_empty(),
				"delete `{sym}` in `{src}` errored: {:?}",
				chunks[0].diagnostics
			);
			let text = std::fs::read_to_string(root.join("d.ts")).unwrap();
			assert!(!text.contains(gone), "`{gone}` should be gone, got: {text:?}");
			assert!(text.contains(kept), "`{kept}` should remain, got: {text:?}");
			// No orphaned wrapper keyword left dangling.
			assert!(
				!text.contains("export const ;") && !text.contains("export ;"),
				"orphaned wrapper in: {text:?}"
			);
		}
	}

	// ── Property test (BUG-433/434): edit must never corrupt the buffer ──
	//
	// Invariant under test: for ANY TS declaration wrapped in arbitrary
	// modifiers (`export`, `default`, `async`) and any declaration kind
	// (fn/const/let/class), both `delete` and whole-symbol `replace` (with
	// content that is itself a complete declaration) must:
	//   (a) succeed without diagnostics, and
	//   (b) leave the file parseable (no tree-sitter ERROR node).
	// This is the generative generalization of the wrapper-selection bug: the
	// narrow-node selection used to orphan the `export`/`const` wrapper.

	/// Parse TS source and report whether it contains any ERROR / MISSING node.
	fn ts_has_error(src: &str) -> bool {
		let mut p = tree_sitter::Parser::new();
		p.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
			.unwrap();
		let tree = p.parse(src, None).unwrap();
		tree.root_node().has_error()
	}

	proptest::proptest! {
		#![proptest_config(proptest::prelude::ProptestConfig::with_cases(96))]

		/// `delete` on a wrapped declaration never corrupts the file and removes
		/// the target while keeping the sibling.
		#[test]
		fn prop_delete_never_corrupts(
			export in proptest::bool::ANY,
			kind_ix in 0usize..4,
		) {
			let prefix = if export { "export " } else { "" };
			let (decl_tgt, decl_sib) = match kind_ix {
				0 => ("function Tgt(){ return 1; }", "function Sib(){ return 2; }"),
				1 => ("const Tgt = 1;", "const Sib = 2;"),
				2 => ("let Tgt = 1;", "let Sib = 2;"),
				_ => ("class Tgt {}", "class Sib {}"),
			};
			let src = format!("{prefix}{decl_tgt}\n{prefix}{decl_sib}\n");
			let dir = tempfile::tempdir().unwrap();
			let root = dir.path().to_path_buf();
			std::fs::write(root.join("p.ts"), &src).unwrap();
			let actions = Some(serde_json::json!([{ "kind": "delete" }]));
			let chunks = execute_code_path_inner(
				opts_edit_with_root("p.ts::Tgt".to_string(), root.clone(), actions),
				crate::task::CancelToken::default(),
			)
			.unwrap();
			proptest::prop_assert!(
				chunks[0].diagnostics.is_empty(),
				"delete errored on `{src}`: {:?}", chunks[0].diagnostics
			);
			let out = std::fs::read_to_string(root.join("p.ts")).unwrap();
			proptest::prop_assert!(!ts_has_error(&out), "delete corrupted `{src}` -> `{out}`");
			proptest::prop_assert!(!out.contains("Tgt"), "target survived: `{out}`");
			proptest::prop_assert!(out.contains("Sib"), "sibling lost: `{out}`");
		}

		/// Whole-symbol `replace` with full-declaration content (which may itself
		/// carry the `export` wrapper) never corrupts the file — the regression
		/// that motivated BUG-434.
		#[test]
		fn prop_whole_replace_never_corrupts(
			src_export in proptest::bool::ANY,
			content_export in proptest::bool::ANY,
			kind_ix in 0usize..4,
		) {
			let sp = if src_export { "export " } else { "" };
			let cp = if content_export { "export " } else { "" };
			let (decl, repl) = match kind_ix {
				0 => ("function Tgt(){ return 1; }", "function Tgt(){ return 42; }"),
				1 => ("const Tgt = 1;", "const Tgt = 42;"),
				2 => ("let Tgt = 1;", "let Tgt = 42;"),
				_ => ("class Tgt { x = 1; }", "class Tgt { x = 42; }"),
			};
			let src = format!("{sp}{decl}\nconst Keep = 0;\n");
			let content = format!("{cp}{repl}");
			let dir = tempfile::tempdir().unwrap();
			let root = dir.path().to_path_buf();
			std::fs::write(root.join("p.ts"), &src).unwrap();
			let actions = Some(serde_json::json!([{ "kind": "replace", "content": content }]));
			let chunks = execute_code_path_inner(
				opts_edit_with_root("p.ts::Tgt".to_string(), root.clone(), actions),
				crate::task::CancelToken::default(),
			)
			.unwrap();
			proptest::prop_assert!(
				chunks[0].diagnostics.is_empty(),
				"replace errored: src=`{src}` content=`{content}`: {:?}",
				chunks[0].diagnostics
			);
			let out = std::fs::read_to_string(root.join("p.ts")).unwrap();
			proptest::prop_assert!(
				!ts_has_error(&out),
				"replace corrupted: src=`{src}` content=`{content}` -> `{out}`"
			);
			proptest::prop_assert!(out.contains("42"), "replacement not applied: `{out}`");
			proptest::prop_assert!(out.contains("Keep"), "sibling lost: `{out}`");
		}

		/// BUG-435: CSS custom-property rename via selector-in-target must (a)
		/// succeed and (b) update BOTH the `:root` declaration and every `var()`
		/// reference — across generated names and reference counts. This is the
		/// case the bug broke (custom props were invisible to symbol resolution).
		///
		/// Scope note: class/id token rename is exercised by the example-based
		/// tests (single-rule). Multi-rule *class* rename resolves a single
		/// declaration and refuses ambiguity by design — a separate semantic from
		/// this fix — so this property focuses on custom properties, where multiple
		/// `var()` references for one declaration is the natural, supported model.
		#[test]
		fn prop_css_custom_prop_rename_updates_decl_and_all_refs(
			name in "[a-z][a-z0-9]{0,7}",
			newname in "[a-z][a-z0-9]{0,7}",
			refs in 0usize..5,
		) {
			// Prefix-disjoint so plain substring assertions are sound (`--a0` would
			// otherwise contain `--a`). Orthogonal to the fix.
			proptest::prop_assume!(name != newname);
			proptest::prop_assume!(!newname.starts_with(&name) && !name.starts_with(&newname));
			let mut src = format!(":root {{ --{name}: blue; }}\n");
			for i in 0..refs {
				src.push_str(&format!(".r{i} {{ color: var(--{name}); }}\n"));
			}
			let dir = tempfile::tempdir().unwrap();
			let root = dir.path().to_path_buf();
			std::fs::write(root.join("p.css"), &src).unwrap();
			let to = format!("--{newname}");
			let actions = Some(serde_json::json!([{ "kind": "rename", "to": to }]));
			let chunks = execute_code_path_inner(
				opts_edit_with_root(format!("p.css::--{name}"), root.clone(), actions),
				crate::task::CancelToken::default(),
			)
			.unwrap();
			proptest::prop_assert!(
				chunks[0].diagnostics.is_empty(),
				"custom-prop rename `--{name}`->`{to}` errored on `{src}`: {:?}",
				chunks[0].diagnostics
			);
			let out = std::fs::read_to_string(root.join("p.css")).unwrap();
			proptest::prop_assert!(
				!out.contains(&format!("--{name}")),
				"old custom-prop `--{name}` survived: `{out}`"
			);
			// Declaration + every var() reference must carry the new name: expect
			// 1 (decl) + refs occurrences of `--newname`.
			let got = out.matches(&format!("--{newname}")).count();
			proptest::prop_assert_eq!(
				got, 1 + refs,
				"expected {} occurrences of `--{}`, got {} in `{}`",
				1 + refs, newname, got, out
			);
		}
	}

	/// BUG-435 example coverage: custom-prop rename updates declaration + var()
	/// references; single-rule class / id rename update the selector token.
	#[test]
	fn verb_css_token_renames() {
		let cases = [
			(
				":root { --accent: blue; }\n.x { color: var(--accent); }\n",
				"--accent",
				"--brand",
				"--accent",
				"--brand",
			),
			(".btn { color: red; }\n", ".btn", ".button", ".btn", ".button"),
			("#hdr { height: 1px; }\n", "#hdr", "#top", "#hdr", "#top"),
		];
		for (src, tgt, to, gone, present) in cases {
			let dir = tempfile::tempdir().unwrap();
			let root = dir.path().to_path_buf();
			std::fs::write(root.join("p.css"), src).unwrap();
			let actions = Some(serde_json::json!([{ "kind": "rename", "to": to }]));
			let chunks = execute_code_path_inner(
				opts_edit_with_root(format!("p.css::{tgt}"), root.clone(), actions),
				crate::task::CancelToken::default(),
			)
			.unwrap();
			assert!(
				chunks[0].diagnostics.is_empty(),
				"css rename {tgt}->{to} errored: {:?}",
				chunks[0].diagnostics
			);
			let out = std::fs::read_to_string(root.join("p.css")).unwrap();
			assert!(!out.contains(gone), "`{gone}` survived: {out:?}");
			assert!(out.contains(present), "`{present}` missing: {out:?}");
		}
	}

	#[test]
	fn verb_replace_line_range() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "l1\nl2\nl3\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "replace", "content": "X2"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("a.txt:2-2".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		let text = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(text, "l1\nX2\nl3\n", "got: {text}");
	}

	#[test]
	fn verb_patch_applies_diff() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let diff = "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n foo\n-bar\n+qux\n baz\n";
		let actions = Some(serde_json::json!([
			{"kind": "patch", "diff": diff}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("a.txt".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		let text = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(text, "foo\nqux\nbaz\n", "got: {text}");
	}

	#[test]
	fn legacy_filecreate_op_still_works_post_cutover() {
		// create.ts emits {kind:fileCreate}; the Op fallback must keep working.
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let actions = Some(serde_json::json!([
			{"kind": "fileCreate", "content": "hi"}
		]));
		let chunks = execute_code_path_inner(
			opts_edit_with_root("new.txt".to_string(), root.clone(), actions),
			crate::task::CancelToken::default(),
		)
		.unwrap();
		assert!(chunks[0].diagnostics.is_empty(), "{:?}", chunks[0].diagnostics);
		assert_eq!(std::fs::read_to_string(root.join("new.txt")).unwrap(), "hi");
	}

	#[test]
	fn edit_sequential_append_applies_both() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "first\n").unwrap();
		let actions = Some(serde_json::json!([
			{"kind": "fileAppend", "content": "second"},
			{"kind": "fileAppend", "content": "third"}
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
			{"kind": "fileCreate", "content": "x"},
			{"kind": "fileAppend", "content": "y"}
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
			chunks[0].diagnostics[0].variant, "unsupported_operation",
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
			chunks[0].diagnostics[0].variant, "parse_error",
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

	#[test]
	fn peer_conflict_produces_peer_conflict_diagnostic_variant() {
		let diag = map_edit_error_to_diagnostic(pi_code_engine::CodeEngineError::PeerConflict {
			session:        "peer".to_string(),
			path:           std::path::PathBuf::from("/tmp/test"),
			code_path:      "test".to_string(),
			peer_revision:  1,
			peer_commit_ts: 0,
		});
		assert_eq!(diag.variant, "peer_conflict", "PeerConflict must map to peer_conflict variant");
	}

	#[test]
	fn snapshot_targets_includes_all_op_paths() {
		use pi_code_path::{
			ast::{FsLocator, FsSegment, Locator},
			op::FileTarget,
		};

		let dir = tempfile::tempdir().unwrap();
		let root = dir.path();
		std::fs::write(root.join("a.txt"), "a").unwrap();
		std::fs::write(root.join("b.txt"), "b").unwrap();

		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let ops = vec![
			Op::FileWrite {
				target:  FileTarget::new(CodePath {
					locator:   Locator::Fs(FsLocator {
						segments: vec![FsSegment::Literal("a.txt".to_string())],
					}),
					query:     None,
					qualifier: None,
				})
				.unwrap(),
				content: ActionContent::Single("x".to_string()),
				force:   false,
			},
			Op::FileWrite {
				target:  FileTarget::new(CodePath {
					locator:   Locator::Fs(FsLocator {
						segments: vec![FsSegment::Literal("b.txt".to_string())],
					}),
					query:     None,
					qualifier: None,
				})
				.unwrap(),
				content: ActionContent::Single("y".to_string()),
				force:   false,
			},
		];

		let snaps = snapshot_targets(&ops, &cp, root);
		let paths: Vec<_> = snaps
			.iter()
			.map(|s| s.path.file_name().unwrap().to_str().unwrap())
			.collect();
		assert!(paths.contains(&"a.txt"));
		assert!(paths.contains(&"b.txt"));
	}
}

/// Wrap a single NodeRef into the standard CodePathChunk[] shape with
/// done=true. Used by special-case branches that bypass the main
/// projection/limit pipeline.
fn single_node_chunks(node: pi_code_path::types::NodeRef) -> Vec<CodePathChunk> {
	let dtos = nodes_to_dtos(vec![node], ARTIFACT_THRESHOLD);
	vec![CodePathChunk { nodes: dtos, diagnostics: vec![], done: true }]
}

/// PLAN-310: agent:// URL path-form sugar.
///
/// `agent://<id>/seg1/seg2/0` is rewritten to `agent://<id>#json:.seg1.seg2[0]`
/// in place when the path has at least one segment AND the URI has no existing
/// `#` qualifier. Mirrors the TS pathToQuery() + applyQuery() pattern, but
/// expressed as the kernel-native #json: qualifier (Block C).
///
/// Numeric segments become `[N]`; identifier-ish segments become `.<name>`;
/// other segments become `["<name>"]` with quotes escaped.
fn rewrite_agent_path_form(target: &mut String) {
	let Some(rest) = target.strip_prefix("agent://") else {
		return;
	};
	if rest.contains('#') {
		return; // already has qualifier; user-controlled
	}
	let (path, suffix) = match rest.find("::") {
		Some(idx) => (&rest[..idx], &rest[idx..]),
		None => (rest, ""),
	};
	let mut parts = path.splitn(2, '/');
	let id = parts.next().unwrap_or("");
	let Some(json_path) = parts.next() else {
		return;
	};
	if id.is_empty() || json_path.is_empty() {
		return;
	}
	let jq_expr = path_segments_to_jq(json_path);
	*target = format!("agent://{id}#json:{jq_expr}{suffix}");
}

fn path_segments_to_jq(path: &str) -> String {
	let mut out = String::new();
	for segment in path.split('/').filter(|s| !s.is_empty()) {
		// Best-effort URL-decode; non-UTF-8 percent-escapes fall through verbatim.
		let decoded = percent_decode_str(segment);
		if decoded.bytes().all(|b| b.is_ascii_digit()) {
			out.push('[');
			out.push_str(&decoded);
			out.push(']');
		} else if decoded
			.bytes()
			.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
		{
			out.push('.');
			out.push_str(&decoded);
		} else {
			let esc = decoded.replace('\\', "\\\\").replace('"', "\\\"");
			out.push('[');
			out.push('"');
			out.push_str(&esc);
			out.push('"');
			out.push(']');
		}
	}
	out
}

/// Best-effort percent-decoding (URL-encoded segments). Returns the raw
/// segment when the bytes don't form a valid UTF-8 string after decoding.
fn percent_decode_str(s: &str) -> String {
	let bytes = s.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' && i + 2 < bytes.len() {
			if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
				out.push((hi << 4) | lo);
				i += 3;
				continue;
			}
		}
		out.push(bytes[i]);
		i += 1;
	}
	String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn hex_digit(b: u8) -> Option<u8> {
	match b {
		b'0'..=b'9' => Some(b - b'0'),
		b'a'..=b'f' => Some(10 + b - b'a'),
		b'A'..=b'F' => Some(10 + b - b'A'),
		_ => None,
	}
}
