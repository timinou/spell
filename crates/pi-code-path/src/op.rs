//! Typed Op surface (PLAN-304).
//! Replaces flat Action enum's stringly-typed dispatch with per-variant
//! target newtypes.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use strum::EnumIter;

use crate::{
	ast::{ActionContent, CodePath, Direction, Locator, Occurrence, SpliceMode},
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileTarget(pub(crate) CodePath);

/// Wraps a CodePath with a ::Symbol query segment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SymbolTarget(pub(crate) CodePath);

/// Wraps a CodePath for CSS-procedural mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CssTarget(pub(crate) CodePath);

/// Wraps a CodePath for markdown/org heading mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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


// ── Custom Deserialize: validate invariants via Target::new ───────

impl<'de> Deserialize<'de> for FileTarget {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		let cp = CodePath::deserialize(d)?;
		FileTarget::new(cp).map_err(|diag| de::Error::custom(diag.message))
	}
}

impl<'de> Deserialize<'de> for SymbolTarget {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		let cp = CodePath::deserialize(d)?;
		SymbolTarget::new(cp).map_err(|diag| de::Error::custom(diag.message))
	}
}

impl<'de> Deserialize<'de> for CssTarget {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		let cp = CodePath::deserialize(d)?;
		CssTarget::new(cp).map_err(|diag| de::Error::custom(diag.message))
	}
}

impl<'de> Deserialize<'de> for HeadingTarget {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {

		let cp = CodePath::deserialize(d)?;
		HeadingTarget::new(cp).map_err(|diag| de::Error::custom(diag.message))
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

}
