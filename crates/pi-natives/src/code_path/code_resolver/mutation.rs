//! MutationResolver implementation for CodeResolverImpl.
//!
//! Wave 2 (PLAN-304): migrated from supports+apply to try_apply with Op enum.
//! Delegates structural edits to the existing `execute_code_buffer_inner`
//! machinery in `crate::code_buffer`.

use pi_code_path::{
	ast::{
		ActionContent, CodePath, Direction, MutationOutcome, NamePayload, Occurrence, SpliceMode,
	},
	dialect::NameLexer,
	op::{Op, SymScope},
	renderer::render_code_path,
	resolver::traits::{CancellationToken, MutationResolver},
	types::{Diagnostic, DiagnosticVariant},
};
use serde_json::{Value, json};

use super::CodeResolverImpl;

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
/// surface only understands simple symbol names.
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
		// No symbol component — absolutise the whole rendered path if
		// possible.
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

impl CodeResolverImpl {
	/// Shared helper for code_buffer-based mutations.
	///
	/// Wave 2: extracted from old `apply` to enable reuse by CssResolver
	/// and HeadingResolver.
	pub(crate) fn apply_to_buffer(
		&self,
		buffer: &mut pi_code_engine::buffer::CodeBuffer,
		target: &CodePath,
		action_json: &Value,
	) -> Result<MutationOutcome, Diagnostic> {
		let target_id = build_target_id(target, self.root.as_deref())?;
		let path = buffer.path().ok_or_else(|| Diagnostic {
			variant: DiagnosticVariant::IncompatibleTargetShape,
			message: "buffer has no path".into(),
			span:    None,
		})?;
		let profile =
			crate::code_buffer::get_profile(path, buffer.language()).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::Inaccessible,
				message: e.to_string(),
				span:    None,
			})?;
		let prepared =
			crate::code_buffer::single_action(buffer, &profile, path, &target_id, action_json)
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
		let target_id = build_target_id(target, self.root.as_deref())?;
		let (file_part, _) = target_id.split_once("::").unwrap_or((&target_id, ""));
		let path = std::path::Path::new(file_part);
		let path = if path.is_absolute() {
			path.to_path_buf()
		} else {
			self
				.root
				.as_deref()
				.unwrap_or(std::path::Path::new("."))
				.join(path)
		};

		let code_paths = vec![target_id];
		let session_id = self.session_id.as_deref().unwrap_or(MUTATION_SESSION_ID);

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

impl MutationResolver for CodeResolverImpl {
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

	use super::CodeResolverImpl;

	fn ts_resolver() -> CodeResolverImpl {
		let registry = pi_code_engine::language::LanguageRegistry::with_builtins().expect("builtins");
		CodeResolverImpl::new(Arc::new(registry))
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

		let resolver = ts_resolver();
		let resolver_with_root = CodeResolverImpl { root: Some(root.clone()), ..resolver };
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
