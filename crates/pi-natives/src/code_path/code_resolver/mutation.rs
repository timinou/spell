//! MutationResolver implementation for CodeResolverImpl.
//!
//! Wave 2 (PLAN-304): migrated from supports+apply to try_apply with Op enum.
//! Delegates structural edits to the existing `execute_code_buffer_inner`
//! machinery in `crate::code_buffer`.

use std::path::PathBuf;

use pi_code_engine::buffer::TextEdit;
use pi_code_path::{
	ast::{
		ActionContent, CodePath, Direction, MutationOutcome, NamePayload, Occurrence, Qualifier,
		SpliceMode,
	},
	dialect::NameLexer,
	op::{Op, SymScope},
	renderer::render_code_path,
	resolver::traits::{CancellationToken, MutationResolver},
	template::expand_template,
	types::{Diagnostic, DiagnosticVariant},
};
use serde_json::{Value, json};

use super::NativeResolver;

const MUTATION_SESSION_ID: &str = "pi-code-path-mutation";

// ── Helpers ──────────────────────────────────────────────────────

/// Minimal NameLexer that only supports rendering `NamePayload::Raw`.
/// Used to turn a `CodePath` back into a targetId string.
struct DummyLexer;

impl NameLexer for DummyLexer {
	fn parse<'s>(&self, _input: &mut &'s str) -> winnow::Result<NamePayload> {
		unreachable!()
	}

	fn render(&self, n: &NamePayload) -> String {
		match n {
			NamePayload::Raw(s) => s.clone(),
			NamePayload::Quoted(s) => s.clone(),
		}
	}

	fn matches(&self, _n: &NamePayload, _node: tree_sitter::Node<'_>, _src: &str) -> bool {
		false
	}
}

/// Build a code_buffer-style `targetId` from a `CodePath`.
///
/// Format: `<file>` or `<file>::<symbol>`. When `root` is provided, the
/// file portion is absolutised so the legacy `code_buffer::execute` can
/// open it without depending on cwd. FEAT-689.
/// Qualifiers are rejected because the code_buffer `resolve_symbol`
pub(crate) fn build_target_id(
	path: &CodePath,
	root: Option<&std::path::Path>,
) -> Result<String, Diagnostic> {
	if path.qualifier.is_some() {
		return Err(Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: "qualifiers not yet supported for mutation targetId".into(),
			span:    None,
		});
	}
	let rendered = render_code_path(path, &DummyLexer).replace(" :: ", "::");
	let Some((file_part, sym_part)) = rendered.split_once("::") else {
		return Ok(absolutise(&rendered, root));
	};
	let abs_file = absolutise(file_part, root);
	Ok(format!("{abs_file}::{sym_part}"))
}

/// Like `build_target_id` but tolerates a body/sig qualifier on the path.
///
/// The qualifier (`foo#body`) is *dropped* from the rendered target_id: the
/// scope it names is extracted separately and threaded into the action's
/// `scope` field, so `resolve_symbol` must see the bare `file::Symbol` to
/// match the declaration. Rendering `foo#body` verbatim would make the symbol
/// lookup fail with "Symbol 'foo#body' not found".
pub(crate) fn build_target_id_lenient(path: &CodePath, root: Option<&std::path::Path>) -> String {
	build_target_id_allow_qualifiers(path, root).unwrap_or_default()
}

fn build_target_id_allow_qualifiers(
	path: &CodePath,
	root: Option<&std::path::Path>,
) -> Result<String, Diagnostic> {
	let bare = CodePath { qualifier: None, ..path.clone() };
	let rendered = render_code_path(&bare, &DummyLexer).replace(" :: ", "::");
	let Some((file_part, sym_part)) = rendered.split_once("::") else {
		return Ok(absolutise(&rendered, root));
	};
	let abs_file = absolutise(file_part, root);
	Ok(format!("{abs_file}::{sym_part}"))
}

fn absolutise(file_part: &str, root: Option<&std::path::Path>) -> String {
	let candidate = std::path::Path::new(file_part);
	if candidate.is_absolute() {
		return file_part.to_string();
	}
	match root {
		Some(r) => r.join(candidate).to_string_lossy().to_string(),
		None => file_part.to_string(),
	}
}

fn flatten_string_array(obj: &mut serde_json::Map<String, Value>, key: &str) {
	if let Some(Value::Array(arr)) = obj.get(key) {
		if arr.iter().all(|v| v.is_string()) {
			let joined: String = arr
				.iter()
				.filter_map(|v| v.as_str())
				.collect::<Vec<_>>()
				.join("\n");
			obj.insert(key.to_string(), Value::String(joined));
		}
	}
}

/// Convert an Op variant into the JSON shape expected by
/// `execute_code_buffer_inner`.
pub(crate) fn op_to_code_buffer_action(op: &Op) -> Value {
	let mut value = match op {
		Op::SymbolReplace { scope, content, .. } => {
			let scope_str = match scope {
				SymScope::Whole => "target",
				SymScope::Body => "body",
				SymScope::Sig => "sig", /* May not be supported yet; code_buffer will return error if
				                         * not */
			};
			json!({
				"kind": "write",
				"scope": scope_str,
				"content": content_to_string(content)
			})
		},
		Op::SymbolRename { new_name, .. } => json!({
			"kind": "rename",
			"content": new_name.0
		}),
		Op::SymbolWrap { content, .. } => json!({
			"kind": "wrap",
			"content": content_to_string(content)
		}),
		Op::SymbolDelete { allow_sibling_delete, .. } => json!({
			"kind": "delete",
			"allowSiblingDelete": allow_sibling_delete
		}),
		Op::SymbolInsertBefore { content, .. } => json!({
			"kind": "insertBefore",
			"content": content_to_string(content)
		}),
		Op::SymbolInsertAfter { content, .. } => json!({
			"kind": "insertAfter",
			"content": content_to_string(content)
		}),
		Op::SymbolFindReplace { find, content, occurrence, .. } => {
			let mut obj = json!({
				"kind": "findAndReplace",
				"find": content_to_string(find),
				"content": content_to_string(content)
			});
			if let Some(occ) = occurrence {
				let occ_str = match occ {
					Occurrence::First => "first",
					Occurrence::Last => "last",
					Occurrence::All => "all",
					Occurrence::Index(n) => {
						obj.as_object_mut()
							.unwrap()
							.insert("occurrence".to_string(), json!(n));
						return obj;
					},
				};
				obj.as_object_mut()
					.unwrap()
					.insert("occurrence".to_string(), json!(occ_str));
			}
			obj
		},
		Op::SymbolRawTextReplace { find, content, occurrence, .. } => {
			let mut obj = json!({
				"kind": "rawTextReplace",
				"find": content_to_string(find),
				"content": content_to_string(content)
			});
			if let Some(occ) = occurrence {
				let occ_str = match occ {
					Occurrence::First => "first",
					Occurrence::Last => "last",
					Occurrence::All => "all",
					Occurrence::Index(n) => {
						obj.as_object_mut()
							.unwrap()
							.insert("occurrence".to_string(), json!(n));
						return obj;
					},
				};
				obj.as_object_mut()
					.unwrap()
					.insert("occurrence".to_string(), json!(occ_str));
			}
			obj
		},
		Op::FileFindReplace { find, content, occurrence, .. } => {
			let mut obj = json!({
				"kind": "findAndReplace",
				"find": content_to_string(find),
				"content": content_to_string(content)
			});
			if let Some(occ) = occurrence {
				let occ_str = match occ {
					Occurrence::First => "first",
					Occurrence::Last => "last",
					Occurrence::All => "all",
					Occurrence::Index(n) => {
						obj.as_object_mut()
							.unwrap()
							.insert("occurrence".to_string(), json!(n));
						return obj;
					},
				};
				obj.as_object_mut()
					.unwrap()
					.insert("occurrence".to_string(), json!(occ_str));
			}
			obj
		},
		Op::FileRawTextReplace { find, content, occurrence, .. } => {
			let mut obj = json!({
				"kind": "rawTextReplace",
				"find": content_to_string(find),
				"content": content_to_string(content)
			});
			if let Some(occ) = occurrence {
				let occ_str = match occ {
					Occurrence::First => "first",
					Occurrence::Last => "last",
					Occurrence::All => "all",
					Occurrence::Index(n) => {
						obj.as_object_mut()
							.unwrap()
							.insert("occurrence".to_string(), json!(n));
						return obj;
					},
				};
				obj.as_object_mut()
					.unwrap()
					.insert("occurrence".to_string(), json!(occ_str));
			}
			obj
		},
		Op::SymbolMove { direction, .. } => {
			let dir_str = match direction {
				Direction::Up => "up",
				Direction::Down => "down",
			};
			json!({
				"kind": "move",
				"direction": dir_str
			})
		},
		Op::SymbolClone { rename_to, .. } => {
			let mut obj = json!({ "kind": "clone" });
			if let Some(name) = rename_to {
				obj.as_object_mut()
					.unwrap()
					.insert("content".to_string(), json!(name.0));
			}
			obj
		},
		Op::SymbolSplice { mode, .. } => {
			let mode_str = match mode {
				SpliceMode::OnlySelf => "self",
				SpliceMode::Up => "up",
				SpliceMode::Down => "down",
			};
			json!({
				"kind": "splice",
				"mode": mode_str
			})
		},
		Op::SymbolTranspose { column, .. } => json!({
			"kind": "transpose",
			"column": column
		}),
		_ => unreachable!("op_to_code_buffer_action called with non-Symbol Op"),
	};

	if let Some(obj) = value.as_object_mut() {
		flatten_string_array(obj, "content");
		flatten_string_array(obj, "find");
	}
	value
}

fn content_to_string(content: &ActionContent) -> String {
	match content {
		ActionContent::Single(s) => s.clone(),
		ActionContent::Multi(v) => v.join("\n"),
	}
}

// ── CodeResolverImpl methods ─────────────────────────────────────

/// BUG-410 (PLAN-318 W0): unwrap `CodeEngineError::Edit(s)` to its raw
/// inner string, avoiding the `edit error: ` prefix that Display would
/// add. When the inner Diagnostic gets re-wrapped into another
/// `CodeEngineError::Edit` higher up the stack, Display prepends the
/// prefix exactly once. Without this, the prefix is added twice.
fn edit_err_message(e: &pi_code_engine::CodeEngineError) -> String {
	match e {
		pi_code_engine::CodeEngineError::Edit(s) => s.clone(),
		other => other.to_string(),
	}
}

impl NativeResolver {
	/// Resolve a CodePath target to a scoped TextEdit, bypassing the legacy
	/// `build_target_id → resolve_symbol → single_action` chain.
	///
	/// Supports qualifiers (#body, #sig) for scoped edits and template
	/// expansion ($BODY, $NAME, $MATCH) in content strings.
	pub(crate) fn resolve_mutation_edit(
		&self,
		target: &CodePath,
		action_json: &Value,
	) -> Result<(PathBuf, TextEdit, String), Diagnostic> {
		let file_path = self.codepath_fs_path(target)?;
		let profile = self
			.registry()
			.match_path(&file_path)
			.ok_or_else(|| Diagnostic {
				variant: DiagnosticVariant::NoMatches,
				message: format!("no language profile for: {}", file_path.display()),
				span:    None,
			})?;

		let source = std::fs::read_to_string(&file_path).map_err(|e| {
			let message = if e.kind() == std::io::ErrorKind::NotFound {
				format!("file not found: {} (create it before a symbol edit)", file_path.display())
			} else {
				format!("read error: {e}")
			};
			Diagnostic { variant: DiagnosticVariant::Inaccessible, message, span: None }
		})?;

		let mut parser = tree_sitter::Parser::new();
		parser
			.set_language(&profile.ts_language)
			.map_err(|e| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: format!("tree-sitter error: {e}"),
				span:    None,
			})?;
		let tree = parser.parse(&source, None).ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: "parse failed".into(),
			span:    None,
		})?;

		// Resolve the CodePath query to a tree-sitter node
		let query = target.query.as_ref().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::NoMatches,
			message: "edit target must have a symbol query (e.g. `::Name`)".into(),
			span:    None,
		})?;

		let dialect = profile.dialect.as_ref().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: "no dialect for language".into(),
			span:    None,
		})?;
		let cancel = CancellationToken::new();
		let root = tree.root_node();
		let nodes = pi_kernel::walker::evaluate_query(query, vec![root], &source, dialect, &cancel);
		// Selection must be deterministic and target the *specific* declaration.
		// A name query can match both an inner declaration and an enclosing
		// wrapper (e.g. TS `export function foo` yields both `function_declaration`
		// and `export_statement`). `nodes.first()` ordered by tree-sitter node id
		// (a pointer) is nondeterministic and may pick the wrapper, which has no
		// `name` field (rename fails) and a span that includes the `export`
		// keyword (whole-replace double-prefixes). Prefer the narrowest span; for
		// equal spans, the earliest start.
		let node = nodes
			.iter()
			.min_by_key(|n| (n.end_byte() - n.start_byte(), n.start_byte()))
			.ok_or_else(|| Diagnostic {
				variant: DiagnosticVariant::NoMatches,
				message: "symbol not found".into(),
				span:    None,
			})?;

		// BUG-433 / BUG-434: a name query yields the declaration's whole *wrapper
		// chain* (e.g. `variable_declarator ⊂ lexical_declaration ⊂
		// export_statement`). The narrowest match is correct only for RENAME (which
		// climbs to the `name` field anyway). Operations that act on the whole
		// statement — DELETE and whole-symbol REPLACE — must target the WIDEST match
		// containing the anchor, else they orphan the wrapper:
		//   delete  narrow → `export const ;`        (invalid syntax)
		//   replace narrow → inner `function_decl` only; content that legitimately
		//           begins with `export …` then double-prefixes / orphans the kw,
		//           and the parse gate rejects the agent's *natural* full-decl input.
		// Re-anchoring to the wrapper makes `::sym` whole-replace authoritative over
		// the entire declaration (content replaces the statement verbatim), while
		// `#body` / `#sig` keep the narrow node via the scoped legacy path upstream.
		// Language-agnostic: the matched set is exactly this declaration's chain.
		let op_kind = action_json
			.get("kind")
			.and_then(|v| v.as_str())
			.unwrap_or("");
		let whole_statement_op = matches!(op_kind, "delete" | "write");
		let node: &tree_sitter::Node = if whole_statement_op {
			nodes
				.iter()
				.filter(|n| n.start_byte() <= node.start_byte() && n.end_byte() >= node.end_byte())
				.max_by_key(|n| (n.end_byte() - n.start_byte()))
				.unwrap_or(node)
		} else {
			node
		};

		// This builder path handles only whole-declaration writes, renames, and
		// deletes. Body/sig-scoped writes are intercepted upstream in
		// `apply_to_buffer` and routed to the legacy `single_action` path, which
		// resolves the declaration node and applies the proven `replace_body`.
		let kind = action_json
			.get("kind")
			.and_then(|v| v.as_str())
			.unwrap_or("");

		// For rename: only replace the name field, not the whole symbol
		let (byte_range, content) = if kind == "rename" {
			let name_node = node
				.child_by_field_name("name")
				.or_else(|| node.child_by_field_name("declarator"))
				.ok_or_else(|| Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: format!("node '{}' has no name field for rename", node.kind()),
					span:    None,
				})?;
			// op_to_code_buffer_action puts the new name in "content" for rename
			let new_name = action_json
				.get("content")
				.and_then(|v| v.as_str())
				.or_else(|| action_json.get("newName").and_then(|v| v.as_str()))
				.unwrap_or("");
			(name_node.start_byte()..name_node.end_byte(), new_name.to_string())
		} else if kind == "delete" {
			(node.start_byte()..node.end_byte(), String::new())
		} else {
			let content = self.resolve_content(action_json, kind, *node, &source)?;
			(node.start_byte()..node.end_byte(), content)
		};

		let edit = TextEdit {
			start_byte:   byte_range.start,
			old_end_byte: byte_range.end,
			new_text:     content,
		};

		let target_id = format!(
			"{}::{}",
			file_path.display(),
			render_code_path(target, &DummyLexer).replace(" :: ", "::")
		);
		Ok((file_path, edit, target_id))
	}

	/// Build the content string for the edit, expanding template variables
	/// if the content contains $VARS placeholders.
	fn resolve_content(
		&self,
		action_json: &Value,
		kind: &str,
		node: tree_sitter::Node<'_>,
		source: &str,
	) -> Result<String, Diagnostic> {
		let raw_content = action_json.get("content").and_then(|v| v.as_str());
		match raw_content {
			Some(c) if c.contains('$') => expand_template(c, node, source).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: e.message,
				span:    None,
			}),
			Some(c) => Ok(c.to_string()),
			None if kind == "rename" => Ok(action_json
				.get("newName")
				.and_then(|v| v.as_str())
				.unwrap_or("")
				.to_string()),
			None if kind == "delete" => Ok(String::new()),
			None => Err(Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: "edit action requires content or newName".into(),
				span:    None,
			}),
		}
	}

	/// Derive the filesystem path from a CodePath's FsLocator.
	fn codepath_fs_path(&self, target: &CodePath) -> Result<PathBuf, Diagnostic> {
		let target_id = build_target_id(target, self.root())?;
		let (file_part, _) = target_id.split_once("::").unwrap_or((&target_id, ""));
		let path = std::path::Path::new(file_part);
		Ok(if path.is_absolute() {
			path.to_path_buf()
		} else {
			self.root().unwrap_or(std::path::Path::new(".")).join(path)
		})
	}

	/// Shared helper for code_buffer-based mutations.
	///
	/// Uses the new CodePath resolver path (resolve_mutation_edit) for
	/// symbol-scoped ops; falls back to the legacy single_action path
	/// for ops that don't have a query.
	pub(crate) fn apply_to_buffer(
		&self,
		buffer: &mut pi_code_engine::buffer::CodeBuffer,
		target: &CodePath,
		action_json: &Value,
	) -> Result<MutationOutcome, Diagnostic> {
		// Symbol-scoped ops with a query: use the new resolver path
		// for the core 3 verbs (replace, rename, delete) when the file
		// has a code dialect. Languages without a dialect (HTML, CSS,
		// Markdown) and ops other than these 3 stay on the legacy path.
		let kind = action_json
			.get("kind")
			.and_then(|v| v.as_str())
			.unwrap_or("");
		// Body/sig-scoped writes route to the legacy `single_action` path, which
		// resolves the *declaration* node via `resolve_symbol` and applies the
		// proven `replace_body` (brace/do-end precondition + re-indent +
		// sibling-deletion guard). The builder path's `nodes.first()` selection is
		// unsafe for scoped writes: a name like Elixir `::fix` matches the inner
		// identifier *and* the enclosing `def` call, and a TS `export function foo`
		// matches the `export_statement` wrapper — picking the wrong node silently
		// corrupts the file (BUG: body spliced inline, delimiters orphaned).
		// Scope may arrive via the action `scope` field (`{scope:"body"}`) or the
		// CodePath qualifier (`foo#body`); normalise to one source of truth.
		let scope = action_json
			.get("scope")
			.and_then(|v| v.as_str())
			.filter(|s| matches!(*s, "body" | "sig"))
			.or_else(|| {
				target
					.qualifier
					.as_ref()
					.map(|q| q.name.as_str())
					.filter(|s| matches!(*s, "body" | "sig"))
			});
		let scoped_write = kind == "write" && scope.is_some();
		// `rename` MUST take the legacy `single_action` path: it delegates to
		// `rename_symbol`, which renames the declaration AND every in-file
		// reference. The builder path (`resolve_mutation_edit`) only rewrites the
		// declaration's name field, silently leaving call sites dangling — a
		// correctness bug that breaks the renamed code. Only `write`/`delete`
		// (whole-node single-edit ops) are safe on the builder path.
		let use_builder = matches!(kind, "write" | "delete") && !scoped_write;
		// Check if the file is a code language (has a dialect).
		// Non-code languages (HTML/CSS/MD/Org) use the legacy path.
		let is_code_lang = match &target.locator {
			pi_code_path::ast::Locator::Fs(fs) => fs
				.segments
				.last()
				.and_then(|seg| {
					if let pi_code_path::ast::FsSegment::Literal(s) = seg {
						let ext = std::path::Path::new(s).extension()?.to_str()?;
						Some(!matches!(
							ext,
							"html" | "htm" | "css" | "scss" | "less" | "md" | "markdown" | "org"
						))
					} else {
						None
					}
				})
				.unwrap_or(true),
			_ => true,
		};
		if target.query.is_some() && use_builder && is_code_lang {
			let (_path, edit, target_id) = self.resolve_mutation_edit(target, action_json)?;
			buffer.edit_batch(vec![edit]).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: edit_err_message(&e),
				span:    None,
			})?;
			return Ok(MutationOutcome {
				edit_count:     1,
				diff:           None,
				created:        false,
				target_summary: Some(target_id),
			});
		}

		// Legacy path for non-symbol ops (FileCreate, FileWrite, etc.) and for
		// body/sig-scoped writes. The qualifier (if any) was consumed into `scope`
		// above; render the target_id without it and inject `scope` into the
		// action so `single_action` resolves the declaration and applies
		// `replace_body`.
		let target_id = build_target_id_allow_qualifiers(target, self.root())?;
		let scoped_action = scoped_write.then(|| {
			let mut obj = action_json.as_object().cloned().unwrap_or_default();
			obj.insert("scope".to_string(), Value::String(scope.unwrap().to_string()));
			Value::Object(obj)
		});
		let action_json = scoped_action.as_ref().unwrap_or(action_json);
		let path = buffer.path().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::IncompatibleTargetShape,
			message: "buffer has no path".into(),
			span:    None,
		})?;
		// P5.B: edit-prep now lives in pi_kernel::edit_ops (host-agnostic).
		// language_registry() yields Arc<LanguageRegistry>; deref to &LanguageRegistry.
		let registry = crate::language_registry();
		let profile =
			pi_kernel::edit_ops::get_profile(&registry, path, buffer.language()).map_err(|e| {
				Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: e.to_string(),
					span:    None,
				}
			})?;
		let prepared =
			pi_kernel::edit_ops::single_action(buffer, &profile, path, &target_id, action_json)
				.map_err(|e| Diagnostic {
					variant: DiagnosticVariant::UnsupportedOperation,
					message: edit_err_message(&e),
					span:    None,
				})?;
		buffer.edit_batch(prepared.edits).map_err(|e| Diagnostic {
			variant: DiagnosticVariant::UnsupportedOperation,
			message: edit_err_message(&e),
			span:    None,
		})?;
		Ok(MutationOutcome {
			edit_count:     1,
			diff:           None,
			created:        false,
			target_summary: Some(target_id),
		})
	}

	/// Wraps `apply_to_buffer` in an `edit_transaction` so callers that
	/// don't have a `CodeBuffer` handle (e.g. matrix tests) can still
	/// dispatch symbol/CSS/heading ops through the canonical path.
	pub(crate) fn apply_via_code_buffer(
		&self,
		target: &CodePath,
		action_json: &Value,
	) -> Result<MutationOutcome, Diagnostic> {
		// Build target_id but skip qualifier rejection — apply_to_buffer
		// handles qualifiers in the builder path when applicable.
		let target_id = build_target_id_allow_qualifiers(target, self.root())?;
		let (file_part, _) = target_id.split_once("::").unwrap_or((&target_id, ""));
		let path = std::path::Path::new(file_part);
		let path = if path.is_absolute() {
			path.to_path_buf()
		} else {
			self.root().unwrap_or(std::path::Path::new(".")).join(path)
		};

		let code_paths = vec![target_id];
		let session_id = self.session_id().unwrap_or(MUTATION_SESSION_ID);

		let (_, outcome) = crate::buffer_registry()
			.edit_transaction(Some(session_id), &path, &code_paths, |buffer| {
				self
					.apply_to_buffer(buffer, target, action_json)
					.map_err(|d| pi_code_engine::CodeEngineError::Edit(d.message))
			})
			.map_err(|e| Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: format!("code buffer execution failed: {e}"),
				span:    None,
			})?;

		Ok(outcome)
	}
}

impl MutationResolver for NativeResolver {
	fn try_apply(
		&self,
		op: &Op,
		_cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>> {
		match op {
			Op::SymbolReplace { target, .. }
			| Op::SymbolRename { target, .. }
			| Op::SymbolWrap { target, .. }
			| Op::SymbolDelete { target, .. }
			| Op::SymbolInsertBefore { target, .. }
			| Op::SymbolInsertAfter { target, .. }
			| Op::SymbolFindReplace { target, .. }
			| Op::SymbolRawTextReplace { target, .. }
			| Op::SymbolMove { target, .. }
			| Op::SymbolClone { target, .. }
			| Op::SymbolSplice { target, .. }
			| Op::SymbolTranspose { target, .. } => {
				let action_json = op_to_code_buffer_action(op);
				Some(self.apply_via_code_buffer(target.as_codepath(), &action_json))
			},
			Op::FileFindReplace { target, .. } | Op::FileRawTextReplace { target, .. } => {
				let action_json = op_to_code_buffer_action(op);
				Some(self.apply_via_code_buffer(target.as_codepath(), &action_json))
			},
			_ => None,
		}
	}
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use std::{io::Write, sync::Arc};

	use pi_code_path::{
		ast::{
			ActionContent, CodePath, FsLocator, FsSegment, Head, Locator, NamePayload, Query, Step,
		},
		op::{Identifier, Op, SymScope, SymbolTarget},
		resolver::traits::{CancellationToken, MutationResolver},
	};

	use super::NativeResolver;

	fn ts_resolver() -> NativeResolver {
		let registry = pi_code_engine::language::LanguageRegistry::with_builtins().expect("builtins");
		NativeResolver::new(Arc::new(registry))
	}

	fn ts_symbol_path(file: &std::path::Path, symbol: &str) -> CodePath {
		CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal(file.display().to_string())],
			}),
			query:     Some(Query::single(Step {
				axis:       None,
				head:       Head::Name(NamePayload::Raw(symbol.into())),
				predicates: vec![],
			})),
			qualifier: None,
		}
	}

	fn elixir_resolver() -> NativeResolver {
		ts_resolver()
	}

	fn symbol_path_ext(file: &std::path::Path, symbol: &str) -> CodePath {
		CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal(file.display().to_string())],
			}),
			query:     Some(Query::single(Step {
				axis:       None,
				head:       Head::Name(NamePayload::Raw(symbol.into())),
				predicates: vec![],
			})),
			qualifier: None,
		}
	}

	#[test]
	fn replace_body_ts_scoped_keeps_signature() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("a.ts");
		std::fs::write(&path, "export function foo(x) {\n  return x + 1;\n}\n").unwrap();
		let cp = symbol_path_ext(&path, "foo");
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolReplace {
			target,
			scope: SymScope::Body,
			content: ActionContent::Single("{\n  return x * 2;\n}".into()),
		};
		let resolver = ts_resolver().with_root(dir.path().to_path_buf());
		let result = resolver.try_apply(&op, &CancellationToken::new());
		assert!(matches!(result, Some(Ok(_))), "body replace failed: {result:?}");
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(src.contains("export function foo(x)"), "signature preserved: {src}");
		assert!(src.contains("return x * 2"), "body replaced: {src}");
	}

	#[test]
	fn replace_body_elixir_do_block_keeps_signature() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("e.ex");
		std::fs::write(
			&path,
			"defmodule M do\n  def fix(ast, _opts) do\n    a = ast\n    a\n  end\nend\n",
		)
		.unwrap();
		let cp = symbol_path_ext(&path, "M.fix");
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolReplace {
			target,
			scope: SymScope::Body,
			content: ActionContent::Single("do\n    result = compute(ast)\n    result\n  end".into()),
		};
		let resolver = elixir_resolver().with_root(dir.path().to_path_buf());
		let result = resolver.try_apply(&op, &CancellationToken::new());
		assert!(matches!(result, Some(Ok(_))), "elixir body replace failed: {result:?}");
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(src.contains("def fix(ast, _opts) do"), "signature + do preserved: {src}");
		assert!(src.contains("compute(ast)"), "body replaced: {src}");
		assert!(!src.contains("a = ast"), "old body gone: {src}");
	}

	#[test]
	fn rename_symbol_succeeds() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		{
			let mut f = std::fs::File::create(&path).unwrap();
			write!(f, "function oldName() {{}}\n").unwrap();
		}

		let resolver = ts_resolver();
		let cp = ts_symbol_path(&path, "oldName");
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolRename { target, new_name: Identifier("newName".to_string()) };

		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(src.contains("newName"), "expected rename: {src}");
	}

	#[test]
	fn op_symbol_replace_whole_routes_through_code_resolver() {
		// The original PLAN-304 motivating bug: edit { target: "a.ts::Foo", kind:
		// "write" } returned "no resolver supports action Write". With Op enum +
		// typed dispatch this must now succeed.
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.ts"), "function oldName() { return 1; }\n").unwrap();

		let cp = ts_symbol_path(&root.join("a.ts"), "oldName");
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolReplace {
			target,
			scope: SymScope::Whole,
			content: ActionContent::Single("function newName() { return 2; }".into()),
		};

		let resolver_with_root = ts_resolver().with_root(root.clone());
		let result = resolver_with_root.try_apply(&op, &CancellationToken::new());
		assert!(matches!(result, Some(Ok(_))), "expected Some(Ok(_)), got {:?}", result);
		let src = std::fs::read_to_string(root.join("a.ts")).unwrap();
		assert!(src.contains("newName") && src.contains("return 2"), "expected replacement: {src}");
	}

	#[test]
	fn wrap_symbol_succeeds() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		std::fs::write(&path, "function main() { return 1; }\n").unwrap();

		let resolver = ts_resolver();
		let cp = ts_symbol_path(&path, "main");
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolWrap {
			target,
			content: ActionContent::Multi(vec![
				"try {".to_string(),
				"  $BODY".to_string(),
				"} catch (e) { throw e; }".to_string(),
			]),
		};

		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(src.contains("try {"), "expected wrap: {src}");
	}

	#[test]
	fn delete_removes_target() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		std::fs::write(&path, "function oldName() { return 1; }\n").unwrap();

		let resolver = ts_resolver();
		let cp = ts_symbol_path(&path, "oldName");
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolDelete { target, allow_sibling_delete: false };

		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(!src.contains("oldName"), "expected deletion: {src}");
	}

	#[test]
	fn non_symbol_op_returns_none() {
		let resolver = ts_resolver();
		let cp = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("test.ts".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let target = pi_code_path::op::FileTarget::new(cp).unwrap();
		let op = Op::FileDelete { target };
		let result = resolver.try_apply(&op, &CancellationToken::new());
		assert!(result.is_none(), "CodeResolverImpl should return None for FileDelete");
	}
}
