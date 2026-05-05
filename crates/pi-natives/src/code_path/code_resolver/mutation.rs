//! MutationResolver implementation for CodeResolverImpl.
//!
//! Delegates structural edits to the existing `execute_code_buffer_inner`
//! machinery in `crate::code_buffer`.

use pi_code_path::{
	ast::{Action, ActionKind, CodePath, MutationOutcome, NamePayload},
	dialect::NameLexer,
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
fn build_target_id(path: &CodePath, root: Option<&std::path::Path>) -> Result<String, Diagnostic> {
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

/// Convert an `Action` into the JSON shape expected by
/// `execute_code_buffer_inner`.
fn action_to_value(action: &Action) -> Value {
	let mut value = serde_json::to_value(action).expect("Action serializes to JSON");
	// The kernel Action enum uses `lines` for insertBefore/insertAfter,
	// but the code_buffer surface expects `content`.
	if let Some(obj) = value.as_object_mut() {
		if let Some(lines) = obj.remove("lines") {
			obj.insert("content".into(), lines);
		}
		// FEAT-689 / FEAT-702: code_buffer's `action_content` calls
		// `required_str`, but the kernel ActionContent allows arrays.
		// Flatten array content to a newline-joined string here so the
		// legacy surface accepts wrap/findAndReplace/etc.
		flatten_string_array(obj, "content");
		flatten_string_array(obj, "find");
	}
	value
}

fn flatten_string_array(obj: &mut serde_json::Map<String, Value>, key: &str) {
	if let Some(Value::Array(arr)) = obj.get(key)
		&& arr.iter().all(|v| v.is_string())
	{
		let joined: String = arr
			.iter()
			.filter_map(|v| v.as_str())
			.collect::<Vec<_>>()
			.join(
				"
",
			);
		obj.insert(key.to_string(), Value::String(joined));
	}
}

// ── MutationResolver impl ────────────────────────────────────────

impl MutationResolver for CodeResolverImpl {
	fn supports(&self, path: &CodePath, kind: ActionKind) -> bool {
		if !matches!(
			kind,
			ActionKind::Rename
				| ActionKind::Wrap
				| ActionKind::FindAndReplace
				| ActionKind::RawTextReplace
				| ActionKind::Splice
				| ActionKind::Move
				| ActionKind::Clone
				| ActionKind::Transpose
				| ActionKind::Promote
				| ActionKind::Demote
				| ActionKind::ReplaceCodeBlock
				| ActionKind::RenameClassToken
				| ActionKind::RenameIdToken
				| ActionKind::RenameCustomProperty
				| ActionKind::RemoveDeadStyle
				| ActionKind::InsertBefore
				| ActionKind::InsertAfter
				| ActionKind::Delete
		) {
			return false;
		}
		path.has_target_query()
	}

	fn apply(
		&self,
		target: &CodePath,
		action: &Action,
		_cancel: &CancellationToken,
	) -> Result<MutationOutcome, Diagnostic> {
		let kind = action.kind();

		// Actions that have no direct mapping in the code_buffer surface;
		// they rely on language-profile procedures that may or may not exist.
		// We surface them as unsupported for now.
		if matches!(
			kind,
			ActionKind::Promote
				| ActionKind::Demote
				| ActionKind::ReplaceCodeBlock
				| ActionKind::RenameClassToken
				| ActionKind::RenameIdToken
				| ActionKind::RenameCustomProperty
				| ActionKind::RemoveDeadStyle
		) {
			return Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: format!(
					"action {:?} not implemented in CodeResolver mutation surface yet",
					kind
				),
				span:    None,
			});
		}

		let target_id = build_target_id(target, self.root.as_deref())?;
		let action_json = action_to_value(action);

		let request = json!({
			"command": "edit",
			"sessionId": self.session_id.as_deref().unwrap_or(MUTATION_SESSION_ID),
			"operations": [{
				"targetId": target_id,
				"actions": [action_json]
			}]
		});

		let result =
			crate::code_buffer::execute_code_buffer_inner(&request).map_err(|e| Diagnostic {
				variant: DiagnosticVariant::Inaccessible,
				message: format!("code buffer execution failed: {e}"),
				span:    None,
			})?;

		// Top-level wrapper: { error: bool, output: {...} }
		if result.get("error").and_then(Value::as_bool).unwrap_or(true) {
			let msg = result
				.get("output")
				.and_then(|o| o.get("message"))
				.and_then(Value::as_str)
				.unwrap_or("unknown code buffer error");
			return Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: msg.to_string(),
				span:    None,
			});
		}

		let output = result.get("output").cloned().unwrap_or_default();
		let status = output
			.get("status")
			.and_then(Value::as_str)
			.unwrap_or("unknown");

		let file_results = output
			.get("fileResults")
			.and_then(Value::as_array)
			.and_then(|arr| arr.first())
			.cloned()
			.unwrap_or_default();

		if status == "failed" {
			let msg = file_results
				.get("error")
				.and_then(|e| e.get("message"))
				.and_then(Value::as_str)
				.unwrap_or("edit failed");
			return Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: msg.to_string(),
				span:    None,
			});
		}

		let edit_count = file_results
			.get("editCount")
			.and_then(Value::as_u64)
			.map(|n| n as u32)
			.unwrap_or(0);
		let diff = file_results
			.get("diff")
			.and_then(Value::as_str)
			.map(String::from);
		let created = file_results
			.get("created")
			.and_then(Value::as_bool)
			.unwrap_or(false);

		Ok(MutationOutcome { edit_count, diff, created, target_summary: Some(target_id) })
	}
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use std::{io::Write, sync::Arc};

	use pi_code_path::{
		ast::{
			Action, ActionContent, ActionKind, CodePath, FsLocator, FsSegment, Head, Locator,
			NamePayload, Occurrence, Query, Step,
		},
		resolver::traits::{CancellationToken, MutationResolver},
		types::DiagnosticVariant,
	};

	use super::CodeResolverImpl;

	fn ts_resolver() -> CodeResolverImpl {
		let registry = pi_code_engine::language::LanguageRegistry::with_builtins().expect("builtins");
		CodeResolverImpl::new(Arc::new(registry))
	}

	fn ts_path(file: &std::path::Path) -> CodePath {
		CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal(file.display().to_string())],
			}),
			query:     None,
			qualifier: None,
		}
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
		let target = ts_symbol_path(&path, "oldName");
		let action = Action::Rename { content: "newName".into() };

		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(src.contains("newName"), "expected rename: {src}");
	}

	#[test]
	fn find_and_replace_occurrence_all() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		{
			let mut f = std::fs::File::create(&path).unwrap();
			write!(f, "function main() {{\n  return oldApi();\n}}\nconst x = oldApi();\n").unwrap();
		}

		let resolver = ts_resolver();
		let target = ts_path(&path);
		let action = Action::FindAndReplace {
			find:       ActionContent::Single("oldApi".into()),
			content:    ActionContent::Single("newApi".into()),
			occurrence: Some(Occurrence::All),
		};

		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert!(outcome.edit_count >= 1, "expected at least one edit");
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(!src.contains("oldApi"), "all occurrences should be replaced: {src}");
		assert!(src.contains("newApi"), "expected newApi: {src}");
	}

	#[test]
	fn splice_mode_self_deletes_target() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		{
			let mut f = std::fs::File::create(&path).unwrap();
			write!(
				f,
				"function oldName() {{\n  return 1;\n}}\n\nfunction other() {{\n  return 2;\n}}\n"
			)
			.unwrap();
		}

		let resolver = ts_resolver();
		let target = ts_symbol_path(&path, "oldName");
		let action = Action::Splice { mode: Some(pi_code_path::ast::SpliceMode::OnlySelf) };

		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(
			!src.contains("function other"),
			"splice self should remove sibling declarations: {src}"
		);
	}

	#[test]
	fn insert_before_adds_comment() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		{
			let mut f = std::fs::File::create(&path).unwrap();
			write!(f, "function main() {{\n  return 1;\n}}\n").unwrap();
		}

		let resolver = ts_resolver();
		let target = ts_symbol_path(&path, "main");
		let action = Action::InsertBefore { lines: ActionContent::Single("// before main".into()) };

		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(src.contains("// before main"), "expected inserted comment: {src}");
	}

	#[test]
	fn delete_removes_target() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		{
			let mut f = std::fs::File::create(&path).unwrap();
			write!(f, "function oldName() {{\n  return 1;\n}}\n").unwrap();
		}

		let resolver = ts_resolver();
		let target = ts_symbol_path(&path, "oldName");
		let action = Action::Delete;

		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let src = std::fs::read_to_string(&path).unwrap();
		assert!(!src.contains("oldName"), "expected deletion: {src}");
	}

	#[test]
	fn unsupported_action_returns_error() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("foo.ts");
		std::fs::write(&path, "function main() {}\n").unwrap();

		let resolver = ts_resolver();
		let target = ts_symbol_path(&path, "main");
		let action = Action::Promote;

		let err = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::UnsupportedOperation));
		assert!(err.message.contains("Promote"));
	}

	#[test]
	fn code_resolver_rejects_bare_path_delete() {
		let cp = ts_path(std::path::Path::new("foo.ts"));
		let resolver = ts_resolver();
		assert!(!resolver.supports(&cp, ActionKind::Delete));
	}

	#[test]
	fn code_resolver_accepts_qualified_delete() {
		let cp = ts_symbol_path(std::path::Path::new("foo.ts"), "Foo");
		let resolver = ts_resolver();
		assert!(resolver.supports(&cp, ActionKind::Delete));
	}

	#[test]
	fn code_resolver_rejects_bare_path_for_all_symbol_kinds() {
		let cp = ts_path(std::path::Path::new("foo.ts"));
		let resolver = ts_resolver();
		for k in [
			ActionKind::Rename,
			ActionKind::Wrap,
			ActionKind::Splice,
			ActionKind::Clone,
			ActionKind::InsertBefore,
			ActionKind::InsertAfter,
			ActionKind::FindAndReplace,
			ActionKind::RawTextReplace,
			ActionKind::Move,
			ActionKind::Transpose,
			ActionKind::Promote,
			ActionKind::Demote,
			ActionKind::ReplaceCodeBlock,
			ActionKind::RenameClassToken,
			ActionKind::RenameIdToken,
			ActionKind::RenameCustomProperty,
			ActionKind::RemoveDeadStyle,
		] {
			assert!(!resolver.supports(&cp, k), "rejects {k:?} on bare path");
		}
	}
}
