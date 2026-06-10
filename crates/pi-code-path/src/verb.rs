//! Unified verb surface (PLAN-321) — the 6-verb external Op surface.
//!
//! # Why this exists
//! The kernel [`Op`] enum has 31 variants whose *prefix* (`file*`, `symbol*`,
//! `line*`, `css*`, `heading*`) re-encodes the target **family** — a fact the
//! [`CodePath`] target already carries in its *shape*. Surfacing 31 kinds to
//! the model forces it to pick a family that the kernel can derive on its own,
//! and lets the two disagree (→ `IncompatibleTargetShape`).
//!
//! [`Verb`] is the orthogonal surface: **6 verbs + undo/redo**, none of which
//! name a family. [`Verb::lower`] reads the target shape and selects the
//! precise internal [`Op`]. The kernel keeps its exhaustive per-family match
//! (one resolver each); only the *surface* collapses.
//!
//! ```text
//! Verb (6, model-facing)  ──lower(target)──▶  Op (31, kernel mechanism)
//! ```
//!
//! Lowering is **total over valid target shapes** and returns a
//! [`Diagnostic`] (not a panic) for shape/verb mismatches, so the napi
//! boundary can surface a helpful error. `undo`/`redo` never lower — they are
//! intercepted as workspace history ops before lowering.

use serde::{Deserialize, Serialize};

use crate::{
	ast::{
		ActionContent, CodePath, Direction, Head, Locator, NamePayload, Occurrence, Predicate,
		SpliceMode,
	},
	op::{
		CssTarget, FileTarget, HeadingTarget, Identifier, LineAnchor, LineAt, LineSpan, Op,
		SymScope, SymbolTarget,
	},
	types::{Diagnostic, DiagnosticVariant},
};

// ── Verb-local helper enums ──────────────────────────────────────

/// Match strategy for `replace { find, … }`. `structural` (default) is
/// tree-sitter / word-boundary aware; `raw` is byte-literal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Matching {
	#[default]
	Structural,
	Raw,
}

/// Insertion placement for `replace { place, … }`. Absent ⇒ in-place
/// replacement (not insertion).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Place {
	Start,
	End,
	Before,
	After,
}

/// AST-surgery operation for the `restructure` verb. The genuinely-distinct
/// structural verbs that have no `replace`-as-content encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum RestructureOp {
	/// Reorder among siblings by one slot.
	Move { direction: Direction },
	/// Reorder to an explicit 1-indexed sibling slot.
	Transpose { column: u32 },
	/// Unwrap a node, promoting/absorbing its children.
	Splice { mode: SpliceMode },
	/// Duplicate a declaration, optionally under a new name.
	Clone {
		#[serde(default, rename = "renameTo")]
		rename_to: Option<Identifier>,
	},
	/// Heading level up (## → #).
	Promote,
	/// Heading level down (# → ##).
	Demote,
}

// ── Verb enum ────────────────────────────────────────────────────

/// The 6-verb external surface (+ undo/redo). Deserialized from the
/// `action` object at the napi edit boundary, then lowered to an [`Op`]
/// using the operation's target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Verb {
	/// The workhorse: overwrite / body / sig / find-replace / structural /
	/// line-range / insert / heading-block — selected by target shape + fields.
	Replace {
		content:    ActionContent,
		#[serde(default)]
		find:       Option<ActionContent>,
		#[serde(default)]
		matching:   Matching,
		#[serde(default)]
		place:      Option<Place>,
		/// 1-indexed line anchor for `place: before|after` on a file target.
		#[serde(default)]
		at:         Option<u32>,
		#[serde(default)]
		occurrence: Option<Occurrence>,
	},
	/// Identifier-aware rename: symbol (+ in-file refs) or CSS token. The CSS
	/// namespace is read from the selector sigil in the target.
	Rename { to: String },
	/// Remove: file / symbol / dead CSS rule — by target shape.
	Delete {
		#[serde(default, rename = "allowSiblingDelete")]
		allow_sibling_delete: bool,
	},
	/// Raw unified-diff escape hatch (file target).
	Patch { diff: String },
	/// AST surgery (move / transpose / splice / clone / heading promote-demote).
	Restructure {
		#[serde(flatten)]
		op: RestructureOp,
	},
	/// Undo the last edit transaction. Never lowers — intercepted as a
	/// workspace history op. Listed here so the surface is exhaustive.
	Undo,
	/// Redo the most recently undone transaction. Never lowers.
	Redo,
}

// ── Target-shape predicates ──────────────────────────────────────

/// Is the target a bare file (no query, no qualifier)?
fn is_bare_file(cp: &CodePath) -> bool {
	cp.is_standalone_locator() && matches!(cp.locator, Locator::Fs(_))
}

/// Extract the leading `Head::Name` raw string from the query head, if any.
/// Used to detect CSS selector sigils and heading markers.
fn head_name(cp: &CodePath) -> Option<&str> {
	match cp.query.as_ref()?.head.head {
		Head::Name(NamePayload::Raw(ref s)) | Head::Name(NamePayload::Quoted(ref s)) => {
			Some(s.as_str())
		},
		_ => None,
	}
}

/// CSS namespace inferred from a selector-in-target head (`.x` / `#x` / `--x`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CssNs {
	Class,
	Id,
	CustomProp,
}

/// Detect a CSS selector target by its head sigil. Returns the namespace and
/// the selector token (sigil included). Only meaningful for `.css` dialects;
/// the resolver re-validates the dialect, so a `.foo` symbol in a non-CSS file
/// will fall through to symbol lowering and be rejected there if invalid.
/// Filesystem extension of the target locator, lowercased, if any.
fn fs_extension(cp: &CodePath) -> Option<String> {
	let Locator::Fs(fs) = &cp.locator else { return None };
	let last = fs.segments.iter().rev().find_map(|seg| match seg {
		crate::ast::FsSegment::Literal(s) if s != "/" => Some(s),
		_ => None,
	})?;
	last.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())
}

/// True when the target is a CSS-family file (`.css`).
fn is_css_file(cp: &CodePath) -> bool {
	fs_extension(cp).as_deref() == Some("css")
}

/// True when the target is a markdown/org-family file (`.md` / `.mdx` / `.org`).
fn is_mdorg_file(cp: &CodePath) -> bool {
	matches!(fs_extension(cp).as_deref(), Some("md" | "mdx" | "org"))
}

/// Detect a CSS selector target by its head sigil, gated to `.css` files so a
/// stray leading `.`/`#` in another dialect can't be mistaken for a selector.
/// Returns the namespace and the selector token (sigil included), which the
/// web-refactor resolver expects verbatim (it strips the sigil internally).
fn css_selector(cp: &CodePath) -> Option<(CssNs, &str)> {
	if !is_css_file(cp) {
		return None;
	}
	let name = head_name(cp)?;
	if let Some(stripped) = name.strip_prefix("--") {
		return (!stripped.is_empty()).then_some((CssNs::CustomProp, name));
	}
	if let Some(stripped) = name.strip_prefix('.') {
		return (!stripped.is_empty()).then_some((CssNs::Class, name));
	}
	if let Some(stripped) = name.strip_prefix('#') {
		return (!stripped.is_empty()).then_some((CssNs::Id, name));
	}
	None
}

/// Detect a line-range target (`foo.ts:10-20` → §line[Range]). Returns the
/// 1-indexed inclusive span when present.
fn line_span(cp: &CodePath) -> Option<LineSpan> {
	let q = cp.query.as_ref()?;
	if !matches!(q.head.head, Head::NodeKind(ref k) if k == "line") {
		return None;
	}
	for pred in &q.head.predicates {
		if let Predicate::Range { start, end } = pred {
			// Shorthand line slices are 1-indexed positive; negatives are a
			// tail-form we don't lower (the model uses explicit ranges to edit).
			let start = LineAnchor((*start)?.max(1) as u32);
			let end = end.map(|e| LineAnchor(e.max(1) as u32));
			return Some(LineSpan { start, end });
		}
	}
	None
}

/// Is the target a heading query (`doc.md::# Title`)? Heading markers begin
/// with `#` (markdown) but NOT `#id` CSS form — disambiguated by a following
/// space, e.g. `# Title`. Org `*` headings are handled by the mdorg dialect
/// upstream; here we accept any name head containing a space after a `#` run.
/// Is the target a heading query on a markdown/org file (`doc.md::Section`)?
/// Heading vs symbol is decided by the file *dialect* (extension), mirroring
/// the kernel's `select_dialect` fork — the heading text is the query name, so
/// there is no sigil to inspect.
fn is_heading(cp: &CodePath) -> bool {
	is_mdorg_file(cp) && cp.query.is_some()
}

/// `#body` / `#sig` qualifier → SymScope. Absent ⇒ whole.
fn sym_scope(cp: &CodePath) -> SymScope {
	match cp.qualifier.as_ref().map(|q| q.name.as_str()) {
		Some("body") => SymScope::Body,
		Some("sig") => SymScope::Sig,
		_ => SymScope::Whole,
	}
}

fn incompatible(detail: impl Into<String>) -> Diagnostic {
	Diagnostic {
		variant: DiagnosticVariant::IncompatibleTargetShape,
		message: detail.into(),
		span:    None,
	}
}

// ── Lowering ─────────────────────────────────────────────────────

impl Verb {
	/// Lower this verb to the precise kernel [`Op`] for `target`'s shape.
	///
	/// Returns an `IncompatibleTargetShape` diagnostic when the verb cannot
	/// apply to the given target (e.g. `patch` on a symbol target, `rename`
	/// on a bare file). `undo`/`redo` are intercepted upstream and return an
	/// error here as a guard.
	pub fn lower(self, target: &CodePath) -> Result<Op, Diagnostic> {
		match self {
			Verb::Undo | Verb::Redo => Err(incompatible(
				"undo/redo are workspace history ops; they must be dispatched alone and are not \
				 lowered to a target op",
			)),

			Verb::Patch { diff } => {
				Ok(Op::FilePatch { target: FileTarget::new(target.clone())?, diff })
			},

			Verb::Rename { to } => Self::lower_rename(target, to),

			Verb::Delete { allow_sibling_delete } => {
				Self::lower_delete(target, allow_sibling_delete)
			},

			Verb::Restructure { op } => Self::lower_restructure(target, op),

			Verb::Replace { content, find, matching, place, at, occurrence } => {
				Self::lower_replace(target, content, find, matching, place, at, occurrence)
			},
		}
	}

	fn lower_rename(target: &CodePath, to: String) -> Result<Op, Diagnostic> {
		if let Some((ns, token)) = css_selector(target) {
			let tgt = CssTarget::new(target.clone())?;
			let find = token.to_string();
			return Ok(match ns {
				CssNs::Class => Op::CssRenameClassToken { target: tgt, find, replace: to },
				CssNs::Id => Op::CssRenameIdToken { target: tgt, find, replace: to },
				CssNs::CustomProp => Op::CssRenameCustomProp { target: tgt, find, replace: to },
			});
		}
		if is_bare_file(target) {
			return Err(incompatible(
				"rename needs a symbol or CSS-selector target (e.g. `file.ts::oldName`, \
				 `style.css::.cls`); a bare file path has nothing to rename — use `replace` to \
				 overwrite or move the file on disk",
			));
		}
		Ok(Op::SymbolRename {
			target:   SymbolTarget::new(target.clone())?,
			new_name: Identifier(to),
		})
	}

	fn lower_delete(target: &CodePath, allow_sibling_delete: bool) -> Result<Op, Diagnostic> {
		if css_selector(target).is_some() {
			return Ok(Op::CssRemoveDeadStyle { target: CssTarget::new(target.clone())? });
		}
		if is_bare_file(target) {
			return Ok(Op::FileDelete { target: FileTarget::new(target.clone())? });
		}
		Ok(Op::SymbolDelete {
			target: SymbolTarget::new(target.clone())?,
			allow_sibling_delete,
		})
	}

	fn lower_restructure(target: &CodePath, op: RestructureOp) -> Result<Op, Diagnostic> {
		match op {
			RestructureOp::Promote => {
				Ok(Op::HeadingPromote { target: HeadingTarget::new(target.clone())? })
			},
			RestructureOp::Demote => {
				Ok(Op::HeadingDemote { target: HeadingTarget::new(target.clone())? })
			},
			RestructureOp::Move { direction } => Ok(Op::SymbolMove {
				target: SymbolTarget::new(target.clone())?,
				direction,
			}),
			RestructureOp::Transpose { column } => Ok(Op::SymbolTranspose {
				target: SymbolTarget::new(target.clone())?,
				column,
			}),
			RestructureOp::Splice { mode } => {
				Ok(Op::SymbolSplice { target: SymbolTarget::new(target.clone())?, mode })
			},
			RestructureOp::Clone { rename_to } => Ok(Op::SymbolClone {
				target: SymbolTarget::new(target.clone())?,
				rename_to,
			}),
		}
	}

	fn lower_replace(
		target: &CodePath,
		content: ActionContent,
		find: Option<ActionContent>,
		matching: Matching,
		place: Option<Place>,
		at: Option<u32>,
		occurrence: Option<Occurrence>,
	) -> Result<Op, Diagnostic> {
		// 1. find-and-replace within scope — symbol vs file by target shape.
		if let Some(find) = find {
			if place.is_some() {
				return Err(incompatible("replace cannot combine `find` with `place`"));
			}
			let is_symbol = target.has_target_query() && css_selector(target).is_none();
			return Ok(match (is_symbol, matching) {
				(true, Matching::Structural) => Op::SymbolFindReplace {
					target: SymbolTarget::new(target.clone())?,
					find,
					content,
					occurrence,
				},
				(true, Matching::Raw) => Op::SymbolRawTextReplace {
					target: SymbolTarget::new(target.clone())?,
					find,
					content,
					occurrence,
				},
				(false, Matching::Structural) => Op::FileFindReplace {
					target: FileTarget::new(target.clone())?,
					find,
					content,
					occurrence,
				},
				(false, Matching::Raw) => Op::FileRawTextReplace {
					target: FileTarget::new(target.clone())?,
					find,
					content,
					occurrence,
				},
			});
		}

		// 2. insertion — placement relative to an anchor.
		if let Some(place) = place {
			let symbol_target = target.has_target_query() && css_selector(target).is_none();
			return match (place, symbol_target) {
				(Place::Start, false) => {
					Ok(Op::FilePrepend { target: FileTarget::new(target.clone())?, content })
				},
				(Place::End, false) => {
					Ok(Op::FileAppend { target: FileTarget::new(target.clone())?, content })
				},
				(Place::Before, true) => Ok(Op::SymbolInsertBefore {
					target: SymbolTarget::new(target.clone())?,
					content,
				}),
				(Place::After, true) => Ok(Op::SymbolInsertAfter {
					target: SymbolTarget::new(target.clone())?,
					content,
				}),
				(Place::Before | Place::After, false) => {
					let line = at.ok_or_else(|| {
						incompatible(
							"replace with place:before|after on a file target requires `at` (1-indexed \
							 line)",
						)
					})?;
					let anchor = LineAnchor(line.max(1));
					let line_at = match place {
						Place::Before => LineAt::Before { line: anchor },
						_ => LineAt::After { line: anchor },
					};
					Ok(Op::LineInsert {
						target: FileTarget::new(target.clone())?,
						at:     line_at,
						content,
					})
				},
				(Place::Start | Place::End, true) => Err(incompatible(
					"place:start|end applies to file targets (prepend/append); for a symbol use \
					 place:before|after",
				)),
			};
		}

		// 3. line-range replace (`foo.ts:10-20`).
		if let Some(span) = line_span(target) {
			return Ok(Op::LineReplace {
				target: FileTarget::new(strip_query(target))?,
				span,
				content,
			});
		}

		// 4. heading block replace (`doc.md::# Heading`).
		if is_heading(target) {
			return Ok(Op::HeadingReplaceBlock {
				target: HeadingTarget::new(target.clone())?,
				content,
			});
		}

		// 5. symbol replace (whole / #body / #sig) — any remaining query target.
		if target.has_target_query() {
			return Ok(Op::SymbolReplace {
				target: SymbolTarget::new(strip_body_sig(target))?,
				scope: sym_scope(target),
				content,
			});
		}

		// 6. bare file overwrite.
		Ok(Op::FileWrite { target: FileTarget::new(target.clone())?, content, force: false })
	}
}

/// Drop the query (and qualifier) from a CodePath, yielding a bare-file
/// CodePath. Used when lowering a line-range target to a `FileTarget` (the
/// span is carried by the Op, not the path).
fn strip_query(cp: &CodePath) -> CodePath {
	CodePath { locator: cp.locator.clone(), query: None, qualifier: None }
}

/// Drop only the `#body` / `#sig` qualifier, keeping the `::Symbol` query, so
/// the resulting CodePath satisfies `SymbolTarget::new` (which rejects the
/// qualifier shape). The scope is carried by the Op's `scope` field.
fn strip_body_sig(cp: &CodePath) -> CodePath {
	let drop = matches!(
		cp.qualifier.as_ref().map(|q| q.name.as_str()),
		Some("body") | Some("sig")
	);
	CodePath {
		locator:   cp.locator.clone(),
		query:     cp.query.clone(),
		qualifier: if drop { None } else { cp.qualifier.clone() },
	}
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;
	use crate::parser::parse_code_path;

	/// Parse a target with the dialect lexer selected by file extension,
	/// mirroring the kernel's `select_dialect`. This keeps tests faithful to
	/// how the napi boundary actually parses targets (CSS sigils, md headings).
	fn cp(target: &str) -> CodePath {
		use crate::dialects::{CssNameLexer, MdNameLexer, TsNameLexer};
		let ext = target
			.split("::")
			.next()
			.and_then(|p| p.rsplit_once('.'))
			.map(|(_, e)| e);
		match ext {
			Some("css") => parse_code_path(target, &CssNameLexer),
			Some("md") | Some("mdx") | Some("org") => parse_code_path(target, &MdNameLexer),
			_ => parse_code_path(target, &TsNameLexer),
		}
		.expect("parse")
	}

	fn single(s: &str) -> ActionContent {
		ActionContent::Single(s.to_string())
	}

	// ── replace ──

	#[test]
	fn replace_bare_file_is_filewrite() {
		let op = Verb::Replace {
			content:    single("x"),
			find:       None,
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap();
		assert!(matches!(op, Op::FileWrite { .. }), "{op:?}");
	}

	#[test]
	fn replace_symbol_is_symbolreplace_whole() {
		let op = Verb::Replace {
			content:    single("fn"),
			find:       None,
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts::bar"))
		.unwrap();
		match op {
			Op::SymbolReplace { scope, .. } => assert_eq!(scope, SymScope::Whole),
			other => panic!("{other:?}"),
		}
	}

	#[test]
	fn replace_body_qualifier_sets_scope_and_strips_qualifier() {
		let op = Verb::Replace {
			content:    single("{ return 1; }"),
			find:       None,
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts::bar#body"))
		.unwrap();
		match op {
			Op::SymbolReplace { scope, target, .. } => {
				assert_eq!(scope, SymScope::Body);
				// SymbolTarget::new rejects a qualifier shape — proves we stripped it.
				assert!(target.as_codepath().qualifier.is_none());
			},
			other => panic!("{other:?}"),
		}
	}

	#[test]
	fn replace_sig_qualifier_sets_scope() {
		let op = Verb::Replace {
			content:    single("function bar(x: number) "),
			find:       None,
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts::bar#sig"))
		.unwrap();
		assert!(matches!(op, Op::SymbolReplace { scope: SymScope::Sig, .. }), "{op:?}");
	}

	#[test]
	fn replace_with_find_on_file_is_filefindreplace() {
		let op = Verb::Replace {
			content:    single("new"),
			find:       Some(single("old")),
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap();
		assert!(matches!(op, Op::FileFindReplace { .. }), "{op:?}");
	}

	#[test]
	fn replace_with_find_raw_on_symbol_is_symbolrawtextreplace() {
		let op = Verb::Replace {
			content:    single("new"),
			find:       Some(single("old")),
			matching:   Matching::Raw,
			place:      None,
			at:         None,
			occurrence: Some(Occurrence::All),
		}
		.lower(&cp("foo.ts::bar"))
		.unwrap();
		assert!(matches!(op, Op::SymbolRawTextReplace { .. }), "{op:?}");
	}

	#[test]
	fn replace_place_end_is_fileappend() {
		let op = Verb::Replace {
			content:    single("// footer"),
			find:       None,
			matching:   Matching::Structural,
			place:      Some(Place::End),
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap();
		assert!(matches!(op, Op::FileAppend { .. }), "{op:?}");
	}

	#[test]
	fn replace_place_start_is_fileprepend() {
		let op = Verb::Replace {
			content:    single("// @ts-check"),
			find:       None,
			matching:   Matching::Structural,
			place:      Some(Place::Start),
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap();
		assert!(matches!(op, Op::FilePrepend { .. }), "{op:?}");
	}

	#[test]
	fn replace_place_after_symbol_is_insertafter() {
		let op = Verb::Replace {
			content:    single("more"),
			find:       None,
			matching:   Matching::Structural,
			place:      Some(Place::After),
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts::bar"))
		.unwrap();
		assert!(matches!(op, Op::SymbolInsertAfter { .. }), "{op:?}");
	}

	#[test]
	fn replace_place_after_file_with_at_is_lineinsert() {
		let op = Verb::Replace {
			content:    single("inserted"),
			find:       None,
			matching:   Matching::Structural,
			place:      Some(Place::After),
			at:         Some(40),
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap();
		match op {
			Op::LineInsert { at: LineAt::After { line }, .. } => assert_eq!(line.line(), 40),
			other => panic!("{other:?}"),
		}
	}

	#[test]
	fn replace_place_before_file_without_at_errors() {
		let err = Verb::Replace {
			content:    single("x"),
			find:       None,
			matching:   Matching::Structural,
			place:      Some(Place::Before),
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
	}

	#[test]
	fn replace_line_range_is_linereplace() {
		let op = Verb::Replace {
			content:    single("qux"),
			find:       None,
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts:10-20"))
		.unwrap();
		match op {
			Op::LineReplace { span, target, .. } => {
				assert_eq!(span.start.line(), 10);
				assert_eq!(span.end.unwrap().line(), 20);
				// span lives on the Op; the FileTarget must be a bare path.
				assert!(target.as_codepath().query.is_none());
			},
			other => panic!("{other:?}"),
		}
	}

	#[test]
	fn replace_heading_block() {
		let op = Verb::Replace {
			content:    single("new block"),
			find:       None,
			matching:   Matching::Structural,
			place:      None,
			at:         None,
			occurrence: None,
		}
		.lower(&cp("doc.md::Intro"))
		.unwrap();
		assert!(matches!(op, Op::HeadingReplaceBlock { .. }), "{op:?}");
	}

	#[test]
	fn replace_find_with_place_is_rejected() {
		let err = Verb::Replace {
			content:    single("x"),
			find:       Some(single("y")),
			matching:   Matching::Structural,
			place:      Some(Place::End),
			at:         None,
			occurrence: None,
		}
		.lower(&cp("foo.ts"))
		.unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
	}

	// ── rename ──

	#[test]
	fn rename_symbol() {
		let op = Verb::Rename { to: "newName".into() }
			.lower(&cp("foo.ts::oldName"))
			.unwrap();
		match op {
			Op::SymbolRename { new_name, .. } => assert_eq!(new_name.0, "newName"),
			other => panic!("{other:?}"),
		}
	}

	#[test]
	fn rename_css_class_id_customprop() {
		let class = Verb::Rename { to: "renamed".into() }
			.lower(&cp("style.css::.my-class"))
			.unwrap();
		assert!(matches!(class, Op::CssRenameClassToken { ref find, .. } if find == ".my-class"));

		let id = Verb::Rename { to: "renamed".into() }
			.lower(&cp("style.css::#my-id"))
			.unwrap();
		assert!(matches!(id, Op::CssRenameIdToken { ref find, .. } if find == "#my-id"));

		let prop = Verb::Rename { to: "--brand".into() }
			.lower(&cp("style.css::--accent"))
			.unwrap();
		assert!(matches!(prop, Op::CssRenameCustomProp { ref find, .. } if find == "--accent"));
	}

	#[test]
	fn rename_bare_file_errors() {
		let err = Verb::Rename { to: "x".into() }.lower(&cp("foo.ts")).unwrap_err();
		assert_eq!(err.variant, DiagnosticVariant::IncompatibleTargetShape);
	}

	// ── delete ──

	#[test]
	fn delete_bare_file_is_filedelete() {
		let op = Verb::Delete { allow_sibling_delete: false }
			.lower(&cp("foo.ts"))
			.unwrap();
		assert!(matches!(op, Op::FileDelete { .. }), "{op:?}");
	}

	#[test]
	fn delete_symbol_is_symboldelete() {
		let op = Verb::Delete { allow_sibling_delete: true }
			.lower(&cp("foo.ts::deadFn"))
			.unwrap();
		assert!(matches!(op, Op::SymbolDelete { allow_sibling_delete: true, .. }), "{op:?}");
	}

	#[test]
	fn delete_css_selector_is_removedeadstyle() {
		let op = Verb::Delete { allow_sibling_delete: false }
			.lower(&cp("style.css::.dead"))
			.unwrap();
		assert!(matches!(op, Op::CssRemoveDeadStyle { .. }), "{op:?}");
	}

	// ── patch ──

	#[test]
	fn patch_is_filepatch() {
		let op = Verb::Patch { diff: "--- a\n+++ b\n".into() }
			.lower(&cp("foo.ts"))
			.unwrap();
		assert!(matches!(op, Op::FilePatch { .. }), "{op:?}");
	}

	// ── restructure ──

	#[test]
	fn restructure_move_is_symbolmove() {
		let op = Verb::Restructure { op: RestructureOp::Move { direction: Direction::Up } }
			.lower(&cp("foo.ts::Cls.m"))
			.unwrap();
		assert!(matches!(op, Op::SymbolMove { direction: Direction::Up, .. }), "{op:?}");
	}

	#[test]
	fn restructure_transpose_is_symboltranspose() {
		let op = Verb::Restructure { op: RestructureOp::Transpose { column: 3 } }
			.lower(&cp("foo.ts::m"))
			.unwrap();
		assert!(matches!(op, Op::SymbolTranspose { column: 3, .. }), "{op:?}");
	}

	#[test]
	fn restructure_splice_is_symbolsplice() {
		let op = Verb::Restructure { op: RestructureOp::Splice { mode: SpliceMode::Up } }
			.lower(&cp("foo.ts::wrapper"))
			.unwrap();
		assert!(matches!(op, Op::SymbolSplice { mode: SpliceMode::Up, .. }), "{op:?}");
	}

	#[test]
	fn restructure_clone_is_symbolclone() {
		let op = Verb::Restructure {
			op: RestructureOp::Clone { rename_to: Some(Identifier("copy".into())) },
		}
		.lower(&cp("foo.ts::orig"))
		.unwrap();
		assert!(matches!(op, Op::SymbolClone { rename_to: Some(_), .. }), "{op:?}");
	}

	#[test]
	fn restructure_promote_demote_are_heading_ops() {
		let promote = Verb::Restructure { op: RestructureOp::Promote }
			.lower(&cp("doc.md::Intro"))
			.unwrap();
		assert!(matches!(promote, Op::HeadingPromote { .. }), "{promote:?}");

		let demote = Verb::Restructure { op: RestructureOp::Demote }
			.lower(&cp("doc.md::Intro"))
			.unwrap();
		assert!(matches!(demote, Op::HeadingDemote { .. }), "{demote:?}");
	}

	// ── undo/redo guard ──

	#[test]
	fn undo_redo_do_not_lower() {
		assert!(Verb::Undo.lower(&cp("foo.ts")).is_err());
		assert!(Verb::Redo.lower(&cp("foo.ts")).is_err());
	}

	// ── deserialization shape ──

	#[test]
	fn verb_deserializes_from_action_json() {
		let v: Verb = serde_json::from_value(serde_json::json!({
			"kind": "replace", "content": "x", "matching": "raw"
		}))
		.unwrap();
		assert!(matches!(v, Verb::Replace { matching: Matching::Raw, .. }));

		let r: Verb = serde_json::from_value(serde_json::json!({
			"kind": "restructure", "op": "move", "direction": "down"
		}))
		.unwrap();
		assert!(matches!(
			r,
			Verb::Restructure { op: RestructureOp::Move { direction: Direction::Down } }
		));

		let ren: Verb =
			serde_json::from_value(serde_json::json!({ "kind": "rename", "to": "z" })).unwrap();
		assert!(matches!(ren, Verb::Rename { .. }));
	}
}
