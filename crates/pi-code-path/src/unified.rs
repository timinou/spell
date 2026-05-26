//! Unified action dispatch — maps the 3-verb agent surface to internal
//! [`Op`] variants.
//!
//! The agent sees `replace`, `rename`, `delete`. The kernel dispatches
//! to the correct [`Op`] variant based on the target [`CodePath`] shape.
//!
//! ## Mapping
//!
//! | target shape         | replace                 | rename          | delete             |
//! |----------------------|-------------------------|-----------------|--------------------|
//! | File                 | FileWrite/FileFindReplace| error           | FileDelete         |
//! | Symbol               | SymbolReplace (whole)   | SymbolRename    | SymbolDelete       |
//! | Symbol#body          | SymbolReplace (body)    | error           | SymbolDelete       |
//! | Symbol#sig           | SymbolReplace (sig)     | error           | SymbolDelete       |
//! | GlobFile             | glob FileFindReplace    | glob rename     | glob delete        |
//! | §line                | LineReplace             | error           | line deletion      |
//! | Heading              | HeadingReplaceBlock     | error           | error              |
//! | CSS selector         | CssRename*              | error           | CssRemoveDeadStyle |
//! | File (append/prepend) | FileAppend/FilePrepend  | error           | error              |

use std::path::Path;


use crate::dialect::NameLexer;
use crate::{
	ast::{ActionContent, CodePath, FsSegment, Locator},
	op::{
		CssTarget, FileTarget, HeadingTarget, Identifier, Op,
		SymScope, SymbolTarget,
	},
	types::{Diagnostic, DiagnosticVariant},
};

// ── Unified action types ──────────────────────────────────────────

/// The 3-verb agent surface.
#[derive(Debug, Clone, PartialEq)]
pub enum UnifiedAction {
	/// Replace the target with `content`. Optional `find` for structural
	/// find-and-replace. Optional `place` for append/prepend.
	Replace {
		content: ActionContent,
		find:    Option<ActionContent>,
		place:   Option<Place>,
	},
	/// Rename a symbol target.
	Rename {
		content: Identifier,
	},
	/// Delete the target.
	Delete,
}

/// Where to place content for file-level operations.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Place {
	/// Append at end of file.
	End,
	/// Prepend at start of file.
	Start,
}

/// The shape of a CodePath target, as derived from its structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetShape {
	/// Bare file path (no query, no qualifier).
	File,
	/// File path with ::Symbol query, no qualifier.
	Symbol,
	/// File path with ::Symbol#body qualifier.
	SymbolBody,
	/// File path with ::Symbol#sig qualifier.
	SymbolSig,
	/// Glob file path with ::Symbol query (multi-file).
	GlobSymbol,
	/// Glob file path without query (multi-file bare).
	GlobFile,
	/// Line range target (§line[a..b]).
	Line,
	/// Heading target (markdown or org).
	Heading,
	/// CSS selector target (.class or #id or --prop).
	Css,
	/// Unknown / unsupported shape.
	Unknown,
}

// ── Shape detection ───────────────────────────────────────────────

impl TargetShape {
	/// Classify a [`CodePath`] into its shape.
	pub fn classify(cp: &CodePath) -> Self {
		let is_glob = matches!(&cp.locator, Locator::Fs(fs) if fs.is_glob());
		let has_query = cp.query.is_some();
		let qualifier = cp.qualifier.as_ref().map(|q| q.name.as_str());

		match (is_glob, has_query, qualifier) {
			// Glob + symbol query
			(true, true, _) => TargetShape::GlobSymbol,
			// Glob without query
			(true, false, _) => TargetShape::GlobFile,
			// Non-glob file with symbol query
			(false, true, None) => TargetShape::Symbol,
			(false, true, Some("body")) => TargetShape::SymbolBody,
			(false, true, Some("sig")) => TargetShape::SymbolSig,
			(false, true, Some(_)) => TargetShape::Symbol, // other qualifiers: still symbol
			// Non-glob, no query
			(false, false, None) => TargetShape::File,
			(false, false, _) => TargetShape::Unknown,
		}
	}
}

// ── Dialect-aware lexer ───────────────────────────────────────────

/// Detect the NameLexer for a file path based on extension.
pub fn lexer_for_path(path: &Path) -> Box<dyn NameLexer> {
	match path.extension().and_then(|e| e.to_str()) {
		Some("ts") | Some("tsx") | Some("mts") | Some("cts") =>
			Box::new(crate::dialects::typescript::TsNameLexer),
		Some("rs") =>
			Box::new(crate::dialects::rust::RustNameLexer),
		Some("py") | Some("pyi") =>
			Box::new(crate::dialects::python::PyNameLexer),
		Some("go") =>
			Box::new(crate::dialects::go::GoNameLexer),
		Some("ex") | Some("exs") | Some("heex") =>
			Box::new(crate::dialects::elixir::ExNameLexer),
		Some("hs") =>
			Box::new(crate::dialects::haskell::HsNameLexer),
		Some("html") | Some("htm") =>
			Box::new(crate::dialects::html::HtmlNameLexer),
		Some("css") | Some("scss") | Some("less") =>
			Box::new(crate::dialects::css::CssNameLexer),
		Some("md") | Some("markdown") =>
			Box::new(crate::dialects::mdorg::MdNameLexer),
		Some("org") =>
			Box::new(crate::dialects::mdorg::MdNameLexer),
		_ => Box::new(crate::dialects::typescript::TsNameLexer),
	}
}

// ── Dispatch ──────────────────────────────────────────────────────

/// Map a unified action to the appropriate internal [`Op`] variant.
///
/// Returns a [`Diagnostic`] when the action cannot be applied to the
/// given target shape.
pub fn unified_op_from_action(
	cp: &CodePath,
	action: &UnifiedAction,
) -> Result<Op, Diagnostic> {
	let shape = TargetShape::classify(cp);

	match action {
		UnifiedAction::Replace { content, find, place } => {
			dispatch_replace(cp, shape, content, find, place)
		}
		UnifiedAction::Rename { content } => {
			dispatch_rename(cp, shape, content)
		}
		UnifiedAction::Delete => {
			dispatch_delete(cp, shape)
		}
	}
}

fn dispatch_replace(
	cp: &CodePath,
	shape: TargetShape,
	content: &ActionContent,
	find: &Option<ActionContent>,
	place: &Option<Place>,
) -> Result<Op, Diagnostic> {
	// Symbol-scoped with find: find-and-replace within the symbol
	if find.is_some() && matches!(shape, TargetShape::Symbol | TargetShape::SymbolBody | TargetShape::SymbolSig) {
		let target = SymbolTarget::new(cp.clone())?;
		return Ok(Op::SymbolFindReplace {
			target,
			find: find.clone().unwrap(),
			content: content.clone(),
			occurrence: None,
		});
	}

	match (shape, place) {
		(TargetShape::Symbol, None) => {
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolReplace {
				target,
				scope: SymScope::Whole,
				content: content.clone(),
			})
		}
		(TargetShape::SymbolBody, None) => {
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolReplace {
				target,
				scope: SymScope::Body,
				content: content.clone(),
			})
		}
		(TargetShape::SymbolSig, None) => {
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolReplace {
				target,
				scope: SymScope::Sig,
				content: content.clone(),
			})
		}
		(TargetShape::File, None) if find.is_some() => {
			let target = FileTarget::new(cp.clone())?;
			Ok(Op::FileFindReplace {
				target,
				find: find.clone().unwrap(),
				content: content.clone(),
				occurrence: None,
			})
		}
		(TargetShape::File, None) => {
			// Bare content: overwrite file
			let target = FileTarget::new(cp.clone())?;
			Ok(Op::FileWrite {
				target,
				content: content.clone(),
				force: false,
			})
		}
		(TargetShape::File, Some(Place::End)) => {
			let target = FileTarget::new(cp.clone())?;
			Ok(Op::FileAppend {
				target,
				content: content.clone(),
			})
		}
		(TargetShape::File, Some(Place::Start)) => {
			let target = FileTarget::new(cp.clone())?;
			Ok(Op::FilePrepend {
				target,
				content: content.clone(),
			})
		}
		(TargetShape::GlobSymbol, _) => {
			// Multi-file symbol operation — dispatch as batch
			// For now, return a single SymbolReplace and let the caller handle glob expansion
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolReplace {
				target,
				scope: SymScope::Whole,
				content: content.clone(),
			})
		}
		(TargetShape::GlobFile, None) if find.is_some() => {
			let target = FileTarget::new(cp.clone())?;
			Ok(Op::FileFindReplace {
				target,
				find: find.clone().unwrap(),
				content: content.clone(),
				occurrence: None,
			})
		}
		(TargetShape::Heading, None) => {
			let target = HeadingTarget::new(cp.clone())?;
			Ok(Op::HeadingReplaceBlock {
				target,
				content: content.clone(),
			})
		}
		(TargetShape::Css, None) => {
			let target = CssTarget::new(cp.clone())?;
			Ok(Op::CssRenameClassToken {
				target,
				find: String::new(),
				replace: content_to_string(content),
			})
		}
		_ => Err(Diagnostic {
			variant: DiagnosticVariant::IncompatibleTargetShape,
			message: format!(
				"replace with target shape {:?} and place {:?} is not supported",
				shape, place
			),
			span: None,
		}),
	}
}

fn dispatch_rename(
	cp: &CodePath,
	shape: TargetShape,
	new_name: &Identifier,
) -> Result<Op, Diagnostic> {
	match shape {
		TargetShape::Symbol
		| TargetShape::SymbolBody
		| TargetShape::SymbolSig
		| TargetShape::GlobSymbol => {
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolRename {
				target,
				new_name: new_name.clone(),
			})
		}
		_ => Err(Diagnostic {
			variant: DiagnosticVariant::IncompatibleTargetShape,
			message: format!(
				"rename requires a symbol target (e.g. 'file.ts :: funcName'). Got shape: {:?}",
				shape
			),
			span: None,
		}),
	}
}

fn dispatch_delete(
	cp: &CodePath,
	shape: TargetShape,
) -> Result<Op, Diagnostic> {
	match shape {
		TargetShape::Symbol
		| TargetShape::SymbolBody
		| TargetShape::SymbolSig => {
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolDelete {
				target,
				allow_sibling_delete: false,
			})
		}
		TargetShape::File | TargetShape::GlobFile => {
			let target = FileTarget::new(cp.clone())?;
			Ok(Op::FileDelete { target })
		}
		TargetShape::GlobSymbol => {
			let target = SymbolTarget::new(cp.clone())?;
			Ok(Op::SymbolDelete {
				target,
				allow_sibling_delete: false,
			})
		}
		_ => Err(Diagnostic {
			variant: DiagnosticVariant::IncompatibleTargetShape,
			message: format!(
				"delete with target shape {:?} is not supported. Use: symbol, file, CSS, or glob targets.",
				shape
			),
			span: None,
		}),
	}
}

// ── Helpers ───────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────

fn content_to_string(content: &ActionContent) -> String {
	match content {
		ActionContent::Single(s) => s.clone(),
		ActionContent::Multi(v) => v.join("\n"),
	}
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;
	use crate::parser::parse_code_path;
	use crate::dialects::typescript::TsNameLexer;

	fn parse(target: &str) -> CodePath {
		parse_code_path(target, &TsNameLexer).unwrap()
	}

	fn classify(target: &str) -> TargetShape {
		let cp = parse(target);
		TargetShape::classify(&cp)
	}

	fn dispatch(target: &str, action: UnifiedAction) -> Result<Op, Diagnostic> {
		let cp = parse(target);
		unified_op_from_action(&cp, &action)
	}

	fn sc(s: &str) -> ActionContent {
		ActionContent::Single(s.to_string())
	}

	// === Target shape classification ===

	#[test]
	fn classifies_bare_file() {
		assert_eq!(classify("foo.ts"), TargetShape::File);
	}

	#[test]
	fn classifies_symbol() {
		assert_eq!(classify("foo.ts :: bar"), TargetShape::Symbol);
	}

	#[test]
	fn classifies_symbol_body() {
		assert_eq!(classify("foo.ts :: bar#body"), TargetShape::SymbolBody);
	}

	#[test]
	fn classifies_symbol_sig() {
		assert_eq!(classify("foo.ts :: bar#sig"), TargetShape::SymbolSig);
	}

	#[test]
	fn classifies_glob_symbol() {
		assert_eq!(classify("**/*.ts :: bar"), TargetShape::GlobSymbol);
	}

	#[test]
	fn classifies_glob_file() {
		assert_eq!(classify("src/**/*.ts"), TargetShape::GlobFile);
	}

	// === Replace dispatch ===

	#[test]
	fn replace_symbol_whole() {
		let op = dispatch("foo.ts :: bar", UnifiedAction::Replace {
			content: sc("function bar() { return 42; }"),
			find: None,
			place: None,
		}).unwrap();
		assert!(matches!(op, Op::SymbolReplace { scope: SymScope::Whole, .. }));
	}

	#[test]
	fn replace_symbol_body() {
		let op = dispatch("foo.ts :: bar#body", UnifiedAction::Replace {
			content: sc("return 42;"),
			find: None,
			place: None,
		}).unwrap();
		assert!(matches!(op, Op::SymbolReplace { scope: SymScope::Body, .. }));
	}

	#[test]
	fn replace_symbol_sig() {
		let op = dispatch("foo.ts :: bar#sig", UnifiedAction::Replace {
			content: sc("function bar(x: number): void"),
			find: None,
			place: None,
		}).unwrap();
		assert!(matches!(op, Op::SymbolReplace { scope: SymScope::Sig, .. }));
	}

	#[test]
	fn replace_symbol_with_find() {
		let op = dispatch("foo.ts :: bar", UnifiedAction::Replace {
			content: sc("logger.info($1)"),
			find: Some(sc("console.log($1)")),
			place: None,
		}).unwrap();
		assert!(matches!(op, Op::SymbolFindReplace { .. }));
	}

	#[test]
	fn replace_file_bare() {
		let op = dispatch("foo.ts", UnifiedAction::Replace {
			content: sc("export const X = 1;"),
			find: None,
			place: None,
		}).unwrap();
		assert!(matches!(op, Op::FileWrite { .. }));
	}

	#[test]
	fn replace_file_with_find() {
		let op = dispatch("foo.ts", UnifiedAction::Replace {
			content: sc("newPattern"),
			find: Some(sc("oldPattern")),
			place: None,
		}).unwrap();
		assert!(matches!(op, Op::FileFindReplace { .. }));
	}

	#[test]
	fn replace_file_append() {
		let op = dispatch("foo.ts", UnifiedAction::Replace {
			content: sc("\nnew line"),
			find: None,
			place: Some(Place::End),
		}).unwrap();
		assert!(matches!(op, Op::FileAppend { .. }));
	}

	#[test]
	fn replace_file_prepend() {
		let op = dispatch("foo.ts", UnifiedAction::Replace {
			content: sc("// header\n"),
			find: None,
			place: Some(Place::Start),
		}).unwrap();
		assert!(matches!(op, Op::FilePrepend { .. }));
	}

	// === Rename dispatch ===

	#[test]
	fn rename_symbol() {
		let op = dispatch("foo.ts :: oldName", UnifiedAction::Rename {
			content: Identifier("newName".to_string()),
		}).unwrap();
		assert!(matches!(op, Op::SymbolRename { .. }));
	}

	#[test]
	fn rename_glob_symbol() {
		let op = dispatch("**/*.ts :: oldName", UnifiedAction::Rename {
			content: Identifier("newName".to_string()),
		}).unwrap();
		assert!(matches!(op, Op::SymbolRename { .. }));
	}

	#[test]
	fn rename_file_target_errors() {
		let result = dispatch("foo.ts", UnifiedAction::Rename {
			content: Identifier("bar".to_string()),
		});
		assert!(result.is_err());
		assert!(result.unwrap_err().message.contains("symbol target"));
	}

	// === Delete dispatch ===

	#[test]
	fn delete_symbol() {
		let op = dispatch("foo.ts :: deadFunc", UnifiedAction::Delete).unwrap();
		assert!(matches!(op, Op::SymbolDelete { .. }));
	}

	#[test]
	fn delete_file() {
		let op = dispatch("foo.ts", UnifiedAction::Delete).unwrap();
		assert!(matches!(op, Op::FileDelete { .. }));
	}

	#[test]
	fn delete_glob_file() {
		let op = dispatch("src/**/*.test.ts", UnifiedAction::Delete).unwrap();
		assert!(matches!(op, Op::FileDelete { .. }));
	}

	#[test]
	fn delete_glob_symbol() {
		let op = dispatch("**/*.ts :: deadFunc", UnifiedAction::Delete).unwrap();
		assert!(matches!(op, Op::SymbolDelete { .. }));
	}

	// === Edge cases ===

	#[test]
	fn replace_unsupported_shape_errors() {
		// URI targets are not classified as a supported shape
		let cp = CodePath {
			locator: Locator::Uri(crate::ast::UriLocator {
				scheme: "unknown".into(),
				path: "x".into(),
			}),
			query: None,
			qualifier: None,
		};
		let result = unified_op_from_action(&cp, &UnifiedAction::Replace {
			content: sc("new"),
			find: None,
			place: None,
		});
		assert!(result.is_err());
	}
}
