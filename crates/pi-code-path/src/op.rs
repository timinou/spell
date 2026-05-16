//! Typed Op surface (PLAN-304).
//! Replaces flat Action enum's stringly-typed dispatch with per-variant
//! target newtypes. Migration via Op::from_legacy(action, cp).

use serde::{Deserialize, Serialize};
use strum::EnumIter;

use crate::{
	ast::{Action, ActionContent, CodePath, Direction, Locator, Occurrence, SpliceMode},
	types::{Diagnostic, DiagnosticVariant},
};

// ── Target newtypes ───────────────────────────────────────────────

/// Renders a compact, human-readable path string from a [`Locator`] for use in
/// diagnostic messages. Globs are preserved as `*`/`**`/`?` so the message
/// echoes the agent's original target shape; URI locators emit `scheme://path`.
fn locator_hint(locator: &Locator) -> String {
	match locator {
		Locator::Fs(fs) => {
			let mut s = String::new();
			for seg in &fs.segments {
				match seg {
					crate::ast::FsSegment::Literal(v) => s.push_str(v),
					crate::ast::FsSegment::Star => s.push('*'),
					crate::ast::FsSegment::DoubleStar => s.push_str("**"),
					crate::ast::FsSegment::Question => s.push('?'),
					crate::ast::FsSegment::CharClass(chars) => {
						s.push('[');
						for c in chars {
							s.push(*c);
						}
						s.push(']');
					},
					crate::ast::FsSegment::Brace { items, exclusions } => {
						s.push('{');
						s.push_str(&items.join(","));
						if !exclusions.is_empty() {
							s.push('!');
							s.push_str(&exclusions.join(","));
						}
						s.push('}');
					},
				}
			}
			s
		},
		Locator::Uri(uri) => format!("{}://{}", uri.scheme, uri.path),
	}
}

/// Wraps a bare CodePath (file-level target; no query, no qualifier).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTarget(pub(crate) CodePath);

/// Wraps a CodePath with a ::Symbol query segment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolTarget(pub(crate) CodePath);

/// Wraps a CodePath for CSS-procedural mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CssTarget(pub(crate) CodePath);

/// Wraps a CodePath for markdown/org heading mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadingTarget(pub(crate) CodePath);

impl FileTarget {
	pub fn new(cp: CodePath) -> Result<Self, Diagnostic> {
		if cp.has_target_query() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::IncompatibleTargetShape,
				message: format!(
					"fileTarget rejects symbol/qualifier; got path with query; use symbol* variant"
				),
				span:    None,
			});
		}
		if !matches!(cp.locator, Locator::Fs(_)) {
			return Err(Diagnostic {
				variant: DiagnosticVariant::IncompatibleTargetShape,
				message: "fileTarget requires FsLocator (no URI)".to_string(),
				span:    None,
			});
		}
		Ok(FileTarget(cp))
	}

	pub fn into_inner(self) -> CodePath {
		self.0
	}

	pub fn as_codepath(&self) -> &CodePath {
		&self.0
	}
}

impl SymbolTarget {
	pub fn new(cp: CodePath) -> Result<Self, Diagnostic> {
		if cp.query.is_none() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::IncompatibleTargetShape,
				message: format!(
					"symbolTarget requires `::Symbol` query segment — add `::Name` to target `{}` (or use a file-scoped action kind on a bare path)",
					locator_hint(&cp.locator),
				),
				span:    None,
			});
		}
		if !matches!(cp.locator, Locator::Fs(_)) {
			return Err(Diagnostic {
				variant: DiagnosticVariant::IncompatibleTargetShape,
				message: "symbolTarget requires an FsLocator (file path) — URI targets are not editable here".to_string(),
				span:    None,
			});
		}
		Ok(SymbolTarget(cp))
	}

	pub fn into_inner(self) -> CodePath {
		self.0
	}

	pub fn as_codepath(&self) -> &CodePath {
		&self.0
	}
}

impl CssTarget {
	pub fn new(cp: CodePath) -> Result<Self, Diagnostic> {
		// Accept either bare file or symbol target; require FsLocator
		if !matches!(cp.locator, Locator::Fs(_)) {
			return Err(Diagnostic {
				variant: DiagnosticVariant::IncompatibleTargetShape,
				message: "cssTarget requires FsLocator".to_string(),
				span:    None,
			});
		}
		// TODO(Wave2): check dialect == css
		Ok(CssTarget(cp))
	}

	pub fn into_inner(self) -> CodePath {
		self.0
	}

	pub fn as_codepath(&self) -> &CodePath {
		&self.0
	}
}

impl HeadingTarget {
	pub fn new(cp: CodePath) -> Result<Self, Diagnostic> {
		// Accept either bare file or symbol target; require FsLocator
		if !matches!(cp.locator, Locator::Fs(_)) {
			return Err(Diagnostic {
				variant: DiagnosticVariant::IncompatibleTargetShape,
				message: "headingTarget requires FsLocator".to_string(),
				span:    None,
			});
		}
		// TODO(Wave2): check dialect in {md, org}
		Ok(HeadingTarget(cp))
	}

	pub fn into_inner(self) -> CodePath {
		self.0
	}

	pub fn as_codepath(&self) -> &CodePath {
		&self.0
	}
}

// ── Helper types ──────────────────────────────────────────────────

/// Scope for symbolReplace: whole declaration, body only, or signature only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SymScope {
	Whole,
	Body,
	Sig,
}

impl Default for SymScope {
	fn default() -> Self {
		SymScope::Whole
	}
}

/// LINE#ID anchor for line-based edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineAnchor {
	pub line: u32,
	pub hash: String,
}

/// A span from one LineAnchor to optionally another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineSpan {
	pub start: LineAnchor,
	pub end:   Option<LineAnchor>,
}

/// Where to insert relative to a line anchor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "side", rename_all = "lowercase")]
pub enum LineAt {
	Before { anchor: LineAnchor },
	After { anchor: LineAnchor },
}

/// A valid identifier for renaming.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identifier(pub String);

// ── Op enum ───────────────────────────────────────────────────────

/// Typed operation surface — discriminated union per ADR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Op {
	FileCreate {
		target:  FileTarget,
		content: ActionContent,
		#[serde(default)]
		force:   bool,
	},
	FileWrite {
		target:  FileTarget,
		content: ActionContent,
		#[serde(default)]
		force:   bool,
	},
	FileDelete {
		target: FileTarget,
	},
	FileAppend {
		target:  FileTarget,
		content: ActionContent,
	},
	FilePrepend {
		target:  FileTarget,
		content: ActionContent,
	},
	FilePatch {
		target: FileTarget,
		diff:   String,
	},
	FileFindReplace {
		target:     FileTarget,
		find:       ActionContent,
		content:    ActionContent,
		#[serde(default)]
		occurrence: Option<Occurrence>,
	},
	FileRawTextReplace {
		target:     FileTarget,
		find:       ActionContent,
		content:    ActionContent,
		#[serde(default)]
		occurrence: Option<Occurrence>,
	},

	LineReplace {
		target:  FileTarget,
		span:    LineSpan,
		content: ActionContent,
	},
	LineInsert {
		target:  FileTarget,
		at:      LineAt,
		content: ActionContent,
	},
	LineAppend {
		target:  FileTarget,
		at:      LineAnchor,
		content: ActionContent,
	},
	LinePrepend {
		target:  FileTarget,
		at:      LineAnchor,
		content: ActionContent,
	},

	SymbolReplace {
		target:  SymbolTarget,
		#[serde(default)]
		scope:   SymScope,
		content: ActionContent,
	},
	SymbolRename {
		target:   SymbolTarget,
		#[serde(rename = "newName")]
		new_name: Identifier,
	},
	SymbolWrap {
		target:  SymbolTarget,
		content: ActionContent,
	},
	SymbolDelete {
		target:               SymbolTarget,
		#[serde(default)]
		#[serde(rename = "allowSiblingDelete")]
		allow_sibling_delete: bool,
	},
	SymbolInsertBefore {
		target:  SymbolTarget,
		content: ActionContent,
	},
	SymbolInsertAfter {
		target:  SymbolTarget,
		content: ActionContent,
	},
	SymbolFindReplace {
		target:     SymbolTarget,
		find:       ActionContent,
		content:    ActionContent,
		#[serde(default)]
		occurrence: Option<Occurrence>,
	},
	SymbolRawTextReplace {
		target:     SymbolTarget,
		find:       ActionContent,
		content:    ActionContent,
		#[serde(default)]
		occurrence: Option<Occurrence>,
	},
	SymbolMove {
		target:    SymbolTarget,
		direction: Direction,
	},
	SymbolClone {
		target:    SymbolTarget,
		#[serde(default)]
		#[serde(rename = "renameTo")]
		rename_to: Option<Identifier>,
	},
	SymbolSplice {
		target: SymbolTarget,
		mode:   SpliceMode,
	},
	SymbolTranspose {
		target: SymbolTarget,
		column: u32,
	},

	CssRenameClassToken {
		target:  CssTarget,
		find:    String,
		replace: String,
	},
	CssRenameIdToken {
		target:  CssTarget,
		find:    String,
		replace: String,
	},
	CssRenameCustomProp {
		target:  CssTarget,
		find:    String,
		replace: String,
	},
	CssRemoveDeadStyle {
		target: CssTarget,
	},

	HeadingPromote {
		target: HeadingTarget,
	},
	HeadingDemote {
		target: HeadingTarget,
	},
	HeadingReplaceBlock {
		target:  HeadingTarget,
		content: ActionContent,
	},
}

// ── OpKind ────────────────────────────────────────────────────────

/// Payload-free discriminant for Op — used for iteration/matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
	FileCreate,
	FileWrite,
	FileDelete,
	FileAppend,
	FilePrepend,
	FilePatch,
	FileFindReplace,
	FileRawTextReplace,
	LineReplace,
	LineInsert,
	LineAppend,
	LinePrepend,
	SymbolReplace,
	SymbolRename,
	SymbolWrap,
	SymbolDelete,
	SymbolInsertBefore,
	SymbolInsertAfter,
	SymbolFindReplace,
	SymbolRawTextReplace,
	SymbolMove,
	SymbolClone,
	SymbolSplice,
	SymbolTranspose,
	CssRenameClassToken,
	CssRenameIdToken,
	CssRenameCustomProp,
	CssRemoveDeadStyle,
	HeadingPromote,
	HeadingDemote,
	HeadingReplaceBlock,
}

impl Op {
	/// Extract the OpKind discriminant from this Op.
	pub fn kind(&self) -> OpKind {
		match self {
			Op::FileCreate { .. } => OpKind::FileCreate,
			Op::FileWrite { .. } => OpKind::FileWrite,
			Op::FileDelete { .. } => OpKind::FileDelete,
			Op::FileAppend { .. } => OpKind::FileAppend,
			Op::FilePrepend { .. } => OpKind::FilePrepend,
			Op::FilePatch { .. } => OpKind::FilePatch,
			Op::FileFindReplace { .. } => OpKind::FileFindReplace,
			Op::FileRawTextReplace { .. } => OpKind::FileRawTextReplace,
			Op::LineReplace { .. } => OpKind::LineReplace,
			Op::LineInsert { .. } => OpKind::LineInsert,
			Op::LineAppend { .. } => OpKind::LineAppend,
			Op::LinePrepend { .. } => OpKind::LinePrepend,
			Op::SymbolReplace { .. } => OpKind::SymbolReplace,
			Op::SymbolRename { .. } => OpKind::SymbolRename,
			Op::SymbolWrap { .. } => OpKind::SymbolWrap,
			Op::SymbolDelete { .. } => OpKind::SymbolDelete,
			Op::SymbolInsertBefore { .. } => OpKind::SymbolInsertBefore,
			Op::SymbolInsertAfter { .. } => OpKind::SymbolInsertAfter,
			Op::SymbolFindReplace { .. } => OpKind::SymbolFindReplace,
			Op::SymbolRawTextReplace { .. } => OpKind::SymbolRawTextReplace,
			Op::SymbolMove { .. } => OpKind::SymbolMove,
			Op::SymbolClone { .. } => OpKind::SymbolClone,
			Op::SymbolSplice { .. } => OpKind::SymbolSplice,
			Op::SymbolTranspose { .. } => OpKind::SymbolTranspose,
			Op::CssRenameClassToken { .. } => OpKind::CssRenameClassToken,
			Op::CssRenameIdToken { .. } => OpKind::CssRenameIdToken,
			Op::CssRenameCustomProp { .. } => OpKind::CssRenameCustomProp,
			Op::CssRemoveDeadStyle { .. } => OpKind::CssRemoveDeadStyle,
			Op::HeadingPromote { .. } => OpKind::HeadingPromote,
			Op::HeadingDemote { .. } => OpKind::HeadingDemote,
			Op::HeadingReplaceBlock { .. } => OpKind::HeadingReplaceBlock,
		}
	}

	/// Get the target CodePath from any Op variant.
	pub fn target_codepath(&self) -> &CodePath {
		match self {
			Op::FileCreate { target, .. } => &target.0,
			Op::FileWrite { target, .. } => &target.0,
			Op::FileDelete { target } => &target.0,
			Op::FileAppend { target, .. } => &target.0,
			Op::FilePrepend { target, .. } => &target.0,
			Op::FilePatch { target, .. } => &target.0,
			Op::FileFindReplace { target, .. } => &target.0,
			Op::FileRawTextReplace { target, .. } => &target.0,
			Op::LineReplace { target, .. } => &target.0,
			Op::LineInsert { target, .. } => &target.0,
			Op::LineAppend { target, .. } => &target.0,
			Op::LinePrepend { target, .. } => &target.0,
			Op::SymbolReplace { target, .. } => &target.0,
			Op::SymbolRename { target, .. } => &target.0,
			Op::SymbolWrap { target, .. } => &target.0,
			Op::SymbolDelete { target, .. } => &target.0,
			Op::SymbolInsertBefore { target, .. } => &target.0,
			Op::SymbolInsertAfter { target, .. } => &target.0,
			Op::SymbolFindReplace { target, .. } => &target.0,
			Op::SymbolRawTextReplace { target, .. } => &target.0,
			Op::SymbolMove { target, .. } => &target.0,
			Op::SymbolClone { target, .. } => &target.0,
			Op::SymbolSplice { target, .. } => &target.0,
			Op::SymbolTranspose { target, .. } => &target.0,
			Op::CssRenameClassToken { target, .. } => &target.0,
			Op::CssRenameIdToken { target, .. } => &target.0,
			Op::CssRenameCustomProp { target, .. } => &target.0,
			Op::CssRemoveDeadStyle { target } => &target.0,
			Op::HeadingPromote { target } => &target.0,
			Op::HeadingDemote { target } => &target.0,
			Op::HeadingReplaceBlock { target, .. } => &target.0,
		}
	}

	/// Bridge from legacy Action enum (Wave 3 cutover).
	/// The legacy Action does NOT carry the target, so the bridge takes both.
	pub fn from_legacy(action: &Action, cp: &CodePath) -> Result<Self, Diagnostic> {
		let has_sym = cp.has_target_query();

		// Helper to parse LINE#ID anchor
		fn parse_anchor(pos: &str) -> LineAnchor {
			if let Some((line_str, hash)) = pos.split_once('#') {
				LineAnchor { line: line_str.parse().unwrap_or(1), hash: hash.to_string() }
			} else {
				// No hash — synthesize placeholder
				LineAnchor { line: pos.parse().unwrap_or(1), hash: "??".to_string() }
			}
		}

		match action {
			Action::Create { content, force } => {
				let target = FileTarget::new(cp.clone())?;
				Ok(Op::FileCreate { target, content: content.clone(), force: *force })
			},
			Action::Write { content, force } => {
				if has_sym {
					let target = SymbolTarget::new(cp.clone())?;
					Ok(Op::SymbolReplace { target, scope: SymScope::Whole, content: content.clone() })
				} else {
					let target = FileTarget::new(cp.clone())?;
					Ok(Op::FileWrite { target, content: content.clone(), force: *force })
				}
			},
			Action::Delete => {
				if has_sym {
					let target = SymbolTarget::new(cp.clone())?;
					Ok(Op::SymbolDelete { target, allow_sibling_delete: false })
				} else {
					let target = FileTarget::new(cp.clone())?;
					Ok(Op::FileDelete { target })
				}
			},
			Action::Append { lines } => {
				let target = FileTarget::new(cp.clone())?;
				Ok(Op::FileAppend { target, content: lines.clone() })
			},
			Action::Prepend { lines } => {
				let target = FileTarget::new(cp.clone())?;
				Ok(Op::FilePrepend { target, content: lines.clone() })
			},
			Action::Patch { diff } => {
				let target = FileTarget::new(cp.clone())?;
				Ok(Op::FilePatch { target, diff: diff.clone() })
			},
			Action::Insert { pos, line, lines } => {
				let target = FileTarget::new(cp.clone())?;
				let anchor = if let Some(p) = pos {
					parse_anchor(p)
				} else if let Some(n) = line {
					LineAnchor { line: *n, hash: "??".to_string() }
				} else {
					return Err(Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: "insert requires pos or line".to_string(),
						span:    None,
					});
				};
				// Legacy Insert is ambiguous — default to Before
				Ok(Op::LineInsert { target, at: LineAt::Before { anchor }, content: lines.clone() })
			},
			Action::Replace { pos, end, line, lines } => {
				let target = FileTarget::new(cp.clone())?;
				let start = if let Some(p) = pos {
					parse_anchor(p)
				} else if let Some(n) = line {
					LineAnchor { line: *n, hash: "??".to_string() }
				} else {
					return Err(Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: "replace requires pos or line".to_string(),
						span:    None,
					});
				};
				let end_anchor = end.as_ref().map(|e| parse_anchor(e));
				let span = LineSpan { start, end: end_anchor };
				let content = lines
					.clone()
					.unwrap_or(ActionContent::Single("".to_string()));
				Ok(Op::LineReplace { target, span, content })
			},
			Action::Rename { content } => {
				let target = SymbolTarget::new(cp.clone())?;
				Ok(Op::SymbolRename { target, new_name: Identifier(content.clone()) })
			},
			Action::Wrap { content } => {
				let target = SymbolTarget::new(cp.clone())?;
				Ok(Op::SymbolWrap { target, content: content.clone() })
			},
			Action::FindAndReplace { find, content, occurrence } => {
				if has_sym {
					let target = SymbolTarget::new(cp.clone())?;
					Ok(Op::SymbolFindReplace {
						target,
						find: find.clone(),
						content: content.clone(),
						occurrence: occurrence.clone(),
					})
				} else {
					let target = FileTarget::new(cp.clone())?;
					Ok(Op::FileFindReplace {
						target,
						find: find.clone(),
						content: content.clone(),
						occurrence: occurrence.clone(),
					})
				}
			},
			Action::RawTextReplace { find, content } => {
				if has_sym {
					let target = SymbolTarget::new(cp.clone())?;
					Ok(Op::SymbolRawTextReplace {
						target,
						find: find.clone(),
						content: content.clone(),
						occurrence: None,
					})
				} else {
					let target = FileTarget::new(cp.clone())?;
					Ok(Op::FileRawTextReplace {
						target,
						find: find.clone(),
						content: content.clone(),
						occurrence: None,
					})
				}
			},
			Action::Splice { mode } => {
				let target = SymbolTarget::new(cp.clone())?;
				Ok(Op::SymbolSplice { target, mode: mode.unwrap_or(SpliceMode::OnlySelf) })
			},
			Action::Move { direction } => {
				let target = SymbolTarget::new(cp.clone())?;
				Ok(Op::SymbolMove { target, direction: *direction })
			},
			Action::Clone { direction: _, line: _, content } => {
				let target = SymbolTarget::new(cp.clone())?;
				let rename_to = content.as_ref().and_then(|c| match c {
					ActionContent::Single(s) if !s.is_empty() => Some(Identifier(s.clone())),
					_ => None,
				});
				Ok(Op::SymbolClone { target, rename_to })
			},
			Action::Transpose { line: _, column } => {
				let target = SymbolTarget::new(cp.clone())?;
				Ok(Op::SymbolTranspose { target, column: column.unwrap_or(0) })
			},
			Action::RenameClassToken { find, content } => {
				let target = CssTarget::new(cp.clone())?;
				Ok(Op::CssRenameClassToken { target, find: find.clone(), replace: content.clone() })
			},
			Action::RenameIdToken { find, content } => {
				let target = CssTarget::new(cp.clone())?;
				Ok(Op::CssRenameIdToken { target, find: find.clone(), replace: content.clone() })
			},
			Action::RenameCustomProperty { find, content } => {
				let target = CssTarget::new(cp.clone())?;
				Ok(Op::CssRenameCustomProp { target, find: find.clone(), replace: content.clone() })
			},
			Action::RemoveDeadStyle => {
				let target = CssTarget::new(cp.clone())?;
				Ok(Op::CssRemoveDeadStyle { target })
			},
			Action::Promote => {
				let target = HeadingTarget::new(cp.clone())?;
				Ok(Op::HeadingPromote { target })
			},
			Action::Demote => {
				let target = HeadingTarget::new(cp.clone())?;
				Ok(Op::HeadingDemote { target })
			},
			Action::ReplaceCodeBlock { content } => {
				let target = HeadingTarget::new(cp.clone())?;
				Ok(Op::HeadingReplaceBlock { target, content: content.clone() })
			},
			Action::InsertBefore { pos: _, line: _, lines } => {
				let target = SymbolTarget::new(cp.clone())?;
				// Legacy semantics: InsertBefore was always symbol-scoped
				Ok(Op::SymbolInsertBefore { target, content: lines.clone() })
			},
			Action::InsertAfter { pos: _, line: _, lines } => {
				let target = SymbolTarget::new(cp.clone())?;
				Ok(Op::SymbolInsertAfter { target, content: lines.clone() })
			},
		}
	}
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use strum::IntoEnumIterator;

	use super::*;
	use crate::ast::{FsLocator, FsSegment};

	fn bare_file_path() -> CodePath {
		CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("test.rs".to_string())],
			}),
			query:     None,
			qualifier: None,
		}
	}

	fn symbol_path() -> CodePath {
		use crate::ast::{Head, NamePayload, Query, Step};
		CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("test.rs".to_string())],
			}),
			query:     Some(Query::single(Step {
				axis:       None,
				head:       Head::Name(NamePayload::Raw("Foo".to_string())),
				predicates: vec![],
			})),
			qualifier: None,
		}
	}

	fn uri_path() -> CodePath {
		use crate::ast::UriLocator;
		CodePath {
			locator:   Locator::Uri(UriLocator {
				scheme: "artifact".to_string(),
				path:   "abc123".to_string(),
			}),
			query:     None,
			qualifier: None,
		}
	}

	#[test]
	fn op_file_target_accepts_bare_path() {
		let cp = bare_file_path();
		let target = FileTarget::new(cp);
		assert!(target.is_ok());
	}

	#[test]
	fn op_file_target_rejects_symbol_query() {
		let cp = symbol_path();
		let target = FileTarget::new(cp);
		assert!(target.is_err());
		let err = target.unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
		assert!(err.message.contains("symbol"));
	}

	#[test]
	fn op_file_target_rejects_qualifier() {
		use crate::ast::Qualifier;
		let mut cp = bare_file_path();
		cp.qualifier = Some(Qualifier { name: "stat".to_string(), args: None });
		let target = FileTarget::new(cp);
		assert!(target.is_err());
	}

	#[test]
	fn op_file_target_rejects_uri_locator() {
		let cp = uri_path();
		let target = FileTarget::new(cp);
		assert!(target.is_err());
		let err = target.unwrap_err();
		assert!(err.message.contains("FsLocator"));
	}

	#[test]
	fn op_symbol_target_requires_query() {
		let cp = bare_file_path();
		let target = SymbolTarget::new(cp);
		assert!(target.is_err());
		let err = target.unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
		assert!(err.message.contains("query"));
	}

	#[test]
	fn op_symbol_target_accepts_query() {
		let cp = symbol_path();
		let target = SymbolTarget::new(cp);
		assert!(target.is_ok());
	}

	#[test]
	fn op_kind_count_31() {
		let count = OpKind::iter().count();
		assert_eq!(count, 31);
	}

	#[test]
	fn op_legacy_write_with_symbol_target_routes_to_symbol_replace() {
		let cp = symbol_path();
		let action = Action::Write {
			content: ActionContent::Single("new content".to_string()),
			force:   false,
		};
		let op = Op::from_legacy(&action, &cp).unwrap();
		assert_eq!(op.kind(), OpKind::SymbolReplace);
		match op {
			Op::SymbolReplace { scope, .. } => assert_eq!(scope, SymScope::Whole),
			_ => panic!("expected SymbolReplace"),
		}
	}

	#[test]
	fn op_legacy_write_with_bare_target_routes_to_file_write() {
		let cp = bare_file_path();
		let action = Action::Write {
			content: ActionContent::Single("new content".to_string()),
			force:   false,
		};
		let op = Op::from_legacy(&action, &cp).unwrap();
		assert_eq!(op.kind(), OpKind::FileWrite);
	}

	#[test]
	fn op_legacy_delete_branches_correctly() {
		let cp_sym = symbol_path();
		let action = Action::Delete;
		let op = Op::from_legacy(&action, &cp_sym).unwrap();
		assert_eq!(op.kind(), OpKind::SymbolDelete);

		let cp_file = bare_file_path();
		let op2 = Op::from_legacy(&action, &cp_file).unwrap();
		assert_eq!(op2.kind(), OpKind::FileDelete);
	}

	#[test]
	fn op_legacy_insert_requires_pos_or_line() {
		let cp = bare_file_path();
		let action =
			Action::Insert { pos: None, line: None, lines: ActionContent::Single("x".to_string()) };
		let op = Op::from_legacy(&action, &cp);
		assert!(op.is_err());
		let err = op.unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::ParseError);
		assert!(err.message.contains("insert requires pos or line"));
	}

	#[test]
	fn op_serde_file_create_roundtrip() {
		let cp = bare_file_path();
		let target = FileTarget::new(cp).unwrap();
		let op =
			Op::FileCreate { target, content: ActionContent::Single("test".to_string()), force: true };
		let json = serde_json::to_string(&op).unwrap();
		let back: Op = serde_json::from_str(&json).unwrap();
		assert_eq!(op, back);
	}

	#[test]
	fn op_serde_symbol_replace_whole_roundtrip() {
		let cp = symbol_path();
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolReplace {
			target,
			scope: SymScope::Whole,
			content: ActionContent::Single("test".to_string()),
		};
		let json = serde_json::to_string(&op).unwrap();
		let back: Op = serde_json::from_str(&json).unwrap();
		assert_eq!(op, back);
	}

	#[test]
	fn op_serde_symbol_replace_body_roundtrip() {
		let cp = symbol_path();
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolReplace {
			target,
			scope: SymScope::Body,
			content: ActionContent::Single("test".to_string()),
		};
		let json = serde_json::to_string(&op).unwrap();
		let back: Op = serde_json::from_str(&json).unwrap();
		assert_eq!(op, back);
	}

	#[test]
	fn op_serde_symbol_replace_sig_roundtrip() {
		let cp = symbol_path();
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolReplace {
			target,
			scope: SymScope::Sig,
			content: ActionContent::Single("test".to_string()),
		};
		let json = serde_json::to_string(&op).unwrap();
		let back: Op = serde_json::from_str(&json).unwrap();
		assert_eq!(op, back);
	}

	#[test]
	fn op_serde_line_replace_roundtrip() {
		let cp = bare_file_path();
		let target = FileTarget::new(cp).unwrap();
		let op = Op::LineReplace {
			target,
			span: LineSpan {
				start: LineAnchor { line: 5, hash: "AB".to_string() },
				end:   Some(LineAnchor { line: 10, hash: "CD".to_string() }),
			},
			content: ActionContent::Single("replacement".to_string()),
		};
		let json = serde_json::to_string(&op).unwrap();
		let back: Op = serde_json::from_str(&json).unwrap();
		assert_eq!(op, back);
	}

	#[test]
	fn op_serde_symbol_find_replace_with_occurrence_all_roundtrip() {
		let cp = symbol_path();
		let target = SymbolTarget::new(cp).unwrap();
		let op = Op::SymbolFindReplace {
			target,
			find: ActionContent::Single("old".to_string()),
			content: ActionContent::Single("new".to_string()),
			occurrence: Some(Occurrence::All),
		};
		let json = serde_json::to_string(&op).unwrap();
		let back: Op = serde_json::from_str(&json).unwrap();
		assert_eq!(op, back);
	}
}
