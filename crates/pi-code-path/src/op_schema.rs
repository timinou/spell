//! Op schema introspection — metadata about every Op variant.
//!
//! Source of truth for JS-side code generation (Wave C). Each OpKind
//! variant has an associated `OpSchema` describing its target family,
//! fields, and description. The match in [`Op::schema_for`] is
//! compile-time exhaustive: adding a new `OpKind` variant breaks the
//! build until a match arm is added here.
//!
//! # Design decisions (PLAN-308 D-2, D-3)
//! - NAPI carries STRUCTURED METADATA (not JSON Schema). Each language renders
//!   schema natively.
//! - 12-case `FieldType` enum mediates the FFI.
//! - Source of truth: hand-written match. No macro magic.

use serde::{Deserialize, Serialize};
use strum::IntoEnumIterator;

use crate::op::{Op, OpKind};

// ── Schema types ─────────────────────────────────────────────────

/// Schema for one Op variant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpSchema {
	/// CamelCase kind string (e.g. `"fileCreate"`, `"symbolReplace"`).
	pub kind:          &'static str,
	/// Which target type this Op operates on.
	pub target_family: TargetFamily,
	/// Ordered field descriptors — `target` is always first.
	pub fields:        Vec<FieldSchema>,
	/// Human-readable description of what this Op does.
	pub description:   &'static str,
}

/// One field within an [`OpSchema`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FieldSchema {
	/// Field name as it appears in JSON (camelCase).
	pub name:        &'static str,
	/// The conceptual type of this field.
	pub type_name:   FieldType,
	/// Whether this field must always be provided.
	pub required:    bool,
	/// Human-readable field description.
	pub description: &'static str,
}

/// Which target family an Op variant belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetFamily {
	File,
	Symbol,
	Css,
	Heading,
}

/// Conceptual field type — used by JS codegen to pick the right TypeBox
/// schema builder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
	Content,
	Identifier,
	Bool,
	SymScope,
	Occurrence,
	Direction,
	SpliceMode,
	LineAnchor,
	LineSpan,
	LineAt,
	Diff,
	StringField,
	U32,
}

// ── Helpers ──────────────────────────────────────────────────────

/// Shorthand: a required `StringField` named "target".
fn target_field() -> FieldSchema {
	FieldSchema {
		name:        "target",
		type_name:   FieldType::StringField,
		required:    true,
		description: "Bare file path (no `::` symbol query)",
	}
}

/// Shorthand: target with a scope-aware description for symbol targets.
fn symbol_target_field() -> FieldSchema {
	FieldSchema {
		name:        "target",
		type_name:   FieldType::StringField,
		required:    true,
		description: "Symbol path with `::` locator (e.g. `file.ts::Symbol`)",
	}
}

/// Shorthand: target for CSS operations.
fn css_target_field() -> FieldSchema {
	FieldSchema {
		name:        "target",
		type_name:   FieldType::StringField,
		required:    true,
		description: "CSS target (path with CSS selector locator)",
	}
}

/// Shorthand: target for heading operations.
fn heading_target_field() -> FieldSchema {
	FieldSchema {
		name:        "target",
		type_name:   FieldType::StringField,
		required:    true,
		description: "Heading target (path with heading locator)",
	}
}

fn content_field(required: bool) -> FieldSchema {
	FieldSchema {
		name: "content",
		type_name: FieldType::Content,
		required,
		description: "New file contents (string or string[])",
	}
}

fn find_field(required: bool) -> FieldSchema {
	FieldSchema {
		name: "find",
		type_name: FieldType::Content,
		required,
		description: "Text pattern to search for",
	}
}

fn force_field() -> FieldSchema {
	FieldSchema {
		name:        "force",
		type_name:   FieldType::Bool,
		required:    false,
		description: "Overwrite if exists (default: false)",
	}
}

fn occurrence_field() -> FieldSchema {
	FieldSchema {
		name:        "occurrence",
		type_name:   FieldType::Occurrence,
		required:    false,
		description: "Which match to replace: first, last, all, or 1-indexed N (default: all)",
	}
}

fn diff_field() -> FieldSchema {
	FieldSchema {
		name:        "diff",
		type_name:   FieldType::Diff,
		required:    true,
		description: "Unified diff string to apply",
	}
}

fn scope_field() -> FieldSchema {
	FieldSchema {
		name:        "scope",
		type_name:   FieldType::SymScope,
		required:    false,
		description: "Replacement scope: whole (default), body (content MUST include outer braces { \
		              ... }), or target",
	}
}

fn span_field() -> FieldSchema {
	FieldSchema {
		name:        "span",
		type_name:   FieldType::LineSpan,
		required:    true,
		description: "Inclusive line range: {start, end?} (1-indexed)",
	}
}

fn at_field() -> FieldSchema {
	FieldSchema {
		name:        "at",
		type_name:   FieldType::LineAt,
		required:    true,
		description: "Insertion point: {side: 'before' | 'after', line: <1-indexed>}",
	}
}

fn line_anchor_field() -> FieldSchema {
	FieldSchema {
		name:        "at",
		type_name:   FieldType::LineAnchor,
		required:    true,
		description: "1-indexed line number",
	}
}

fn direction_field() -> FieldSchema {
	FieldSchema {
		name:        "direction",
		type_name:   FieldType::Direction,
		required:    true,
		description: "Move direction: up or down",
	}
}

fn mode_field() -> FieldSchema {
	FieldSchema {
		name:        "mode",
		type_name:   FieldType::SpliceMode,
		required:    true,
		description: "Splice mode: self, up, or down",
	}
}

fn column_field() -> FieldSchema {
	FieldSchema {
		name:        "column",
		type_name:   FieldType::U32,
		required:    true,
		description: "1-indexed column to transpose to",
	}
}

fn new_name_field() -> FieldSchema {
	FieldSchema {
		name:        "newName",
		type_name:   FieldType::Identifier,
		required:    true,
		description: "New name for the symbol",
	}
}

fn rename_to_field() -> FieldSchema {
	FieldSchema {
		name:        "renameTo",
		type_name:   FieldType::Identifier,
		required:    false,
		description: "Clone destination symbol name (optional)",
	}
}

fn allow_sibling_delete_field() -> FieldSchema {
	FieldSchema {
		name:        "allowSiblingDelete",
		type_name:   FieldType::Bool,
		required:    false,
		description: "Allow deleting sibling symbols when removing the last declaration (default: \
		              false)",
	}
}

fn css_find_field() -> FieldSchema {
	FieldSchema {
		name:        "find",
		type_name:   FieldType::Identifier,
		required:    true,
		description: "CSS class/id/custom-property token to find",
	}
}

fn css_replace_field() -> FieldSchema {
	FieldSchema {
		name:        "replace",
		type_name:   FieldType::Identifier,
		required:    true,
		description: "Replacement token",
	}
}

// ── Implementation ───────────────────────────────────────────────

impl Op {
	/// Return schemas for every OpKind variant.
	///
	/// Order matches [`OpKind::iter`] — do NOT reorder.
	pub fn all_schemas() -> Vec<OpSchema> {
		OpKind::iter().map(Self::schema_for).collect()
	}

	/// Return the schema for a single OpKind variant.
	///
	/// # Panics
	/// Panics if the match arm is not exhaustive — this is intentional
	/// (adding a new OpKind without a schema arm is a compile error).
	fn schema_for(kind: OpKind) -> OpSchema {
		match kind {
			OpKind::FileCreate => OpSchema {
				kind:          "fileCreate",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), content_field(true), force_field()],
				description:   "Create a new file with given content",
			},
			OpKind::FileWrite => OpSchema {
				kind:          "fileWrite",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), content_field(true), force_field()],
				description:   "Replace the full content of an existing file",
			},
			OpKind::FileDelete => OpSchema {
				kind:          "fileDelete",
				target_family: TargetFamily::File,
				fields:        vec![target_field()],
				description:   "Delete a file from the filesystem",
			},
			OpKind::FileAppend => OpSchema {
				kind:          "fileAppend",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), content_field(true)],
				description:   "Append content to the end of a file",
			},
			OpKind::FilePrepend => OpSchema {
				kind:          "filePrepend",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), content_field(true)],
				description:   "Prepend content to the beginning of a file",
			},
			OpKind::FilePatch => OpSchema {
				kind:          "filePatch",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), diff_field()],
				description:   "Apply a unified diff patch to a file",
			},
			OpKind::FileFindReplace => OpSchema {
				kind:          "fileFindReplace",
				target_family: TargetFamily::File,
				fields:        vec![
					target_field(),
					find_field(true),
					content_field(true),
					occurrence_field(),
				],
				description:   "Find-and-replace within a file using structural matching (tree-sitter \
				                aware)",
			},
			OpKind::FileRawTextReplace => OpSchema {
				kind:          "fileRawTextReplace",
				target_family: TargetFamily::File,
				fields:        vec![
					target_field(),
					find_field(true),
					content_field(true),
					occurrence_field(),
				],
				description:   "Find-and-replace within a file using raw text matching",
			},

			// Line ops use FileTarget (file + line range) but report
			// TargetFamily::File since they operate on file content.
			OpKind::LineReplace => OpSchema {
				kind:          "lineReplace",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), span_field(), content_field(true)],
				description:   "Replace a range of lines with new content",
			},
			OpKind::LineInsert => OpSchema {
				kind:          "lineInsert",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), at_field(), content_field(true)],
				description:   "Insert content at a specific line number",
			},
			OpKind::LineAppend => OpSchema {
				kind:          "lineAppend",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), line_anchor_field(), content_field(true)],
				description:   "Append content after a specific line (by anchor)",
			},
			OpKind::LinePrepend => OpSchema {
				kind:          "linePrepend",
				target_family: TargetFamily::File,
				fields:        vec![target_field(), line_anchor_field(), content_field(true)],
				description:   "Prepend content before a specific line (by anchor)",
			},

			OpKind::SymbolReplace => OpSchema {
				kind:          "symbolReplace",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), scope_field(), content_field(true)],
				description:   "Replace the body of a symbol with new content",
			},
			OpKind::SymbolRename => OpSchema {
				kind:          "symbolRename",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), new_name_field()],
				description:   "Rename a symbol throughout the file",
			},
			OpKind::SymbolWrap => OpSchema {
				kind:          "symbolWrap",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), content_field(true)],
				description:   "Wrap a symbol with new content (e.g. add a function body)",
			},
			OpKind::SymbolDelete => OpSchema {
				kind:          "symbolDelete",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), allow_sibling_delete_field()],
				description:   "Delete a symbol from its file",
			},
			OpKind::SymbolInsertBefore => OpSchema {
				kind:          "symbolInsertBefore",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), content_field(true)],
				description:   "Insert content before a symbol",
			},
			OpKind::SymbolInsertAfter => OpSchema {
				kind:          "symbolInsertAfter",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), content_field(true)],
				description:   "Insert content after a symbol",
			},
			OpKind::SymbolFindReplace => OpSchema {
				kind:          "symbolFindReplace",
				target_family: TargetFamily::Symbol,
				fields:        vec![
					symbol_target_field(),
					find_field(true),
					content_field(true),
					occurrence_field(),
				],
				description:   "Find-and-replace within a symbol using structural matching",
			},
			OpKind::SymbolRawTextReplace => OpSchema {
				kind:          "symbolRawTextReplace",
				target_family: TargetFamily::Symbol,
				fields:        vec![
					symbol_target_field(),
					find_field(true),
					content_field(true),
					occurrence_field(),
				],
				description:   "Find-and-replace within a symbol using raw text matching",
			},
			OpKind::SymbolMove => OpSchema {
				kind:          "symbolMove",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), direction_field()],
				description:   "Move a symbol up or down within its file",
			},
			OpKind::SymbolClone => OpSchema {
				kind:          "symbolClone",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), rename_to_field()],
				description:   "Clone a symbol (optionally with a new name)",
			},
			OpKind::SymbolSplice => OpSchema {
				kind:          "symbolSplice",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), mode_field()],
				description:   "Splice a node out of the tree, promoting or absorbing children",
			},
			OpKind::SymbolTranspose => OpSchema {
				kind:          "symbolTranspose",
				target_family: TargetFamily::Symbol,
				fields:        vec![symbol_target_field(), column_field()],
				description:   "Transpose a symbol to a different sibling position (1-indexed)",
			},

			OpKind::CssRenameClassToken => OpSchema {
				kind:          "cssRenameClassToken",
				target_family: TargetFamily::Css,
				fields:        vec![css_target_field(), css_find_field(), css_replace_field()],
				description:   "Rename a CSS class selector throughout the stylesheet",
			},
			OpKind::CssRenameIdToken => OpSchema {
				kind:          "cssRenameIdToken",
				target_family: TargetFamily::Css,
				fields:        vec![css_target_field(), css_find_field(), css_replace_field()],
				description:   "Rename a CSS id selector throughout the stylesheet",
			},
			OpKind::CssRenameCustomProp => OpSchema {
				kind:          "cssRenameCustomProp",
				target_family: TargetFamily::Css,
				fields:        vec![css_target_field(), css_find_field(), css_replace_field()],
				description:   "Rename a CSS custom property throughout the stylesheet",
			},
			OpKind::CssRemoveDeadStyle => OpSchema {
				kind:          "cssRemoveDeadStyle",
				target_family: TargetFamily::Css,
				fields:        vec![css_target_field()],
				description:   "Remove a dead/unused style rule from the stylesheet",
			},

			OpKind::HeadingPromote => OpSchema {
				kind:          "headingPromote",
				target_family: TargetFamily::Heading,
				fields:        vec![heading_target_field()],
				description:   "Promote a heading level (e.g. ## → #)",
			},
			OpKind::HeadingDemote => OpSchema {
				kind:          "headingDemote",
				target_family: TargetFamily::Heading,
				fields:        vec![heading_target_field()],
				description:   "Demote a heading level (e.g. # → ##)",
			},
			OpKind::HeadingReplaceBlock => OpSchema {
				kind:          "headingReplaceBlock",
				target_family: TargetFamily::Heading,
				fields:        vec![heading_target_field(), content_field(true)],
				description:   "Replace the content block under a heading",
			},
		}
	}
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use strum::IntoEnumIterator;

	use super::*;

	#[test]
	fn all_schemas_count_matches_op_kind_count() {
		assert_eq!(Op::all_schemas().len(), OpKind::iter().count());
		assert_eq!(Op::all_schemas().len(), 31);
	}

	#[test]
	fn every_op_kind_has_a_schema() {
		let schemas = Op::all_schemas();
		for kind in OpKind::iter() {
			let kind_str = serde_json::to_value(kind)
				.unwrap()
				.as_str()
				.unwrap()
				.to_string();
			assert!(
				schemas.iter().any(|s| s.kind == kind_str),
				"missing schema for OpKind::{:?}",
				kind
			);
		}
	}

	#[test]
	fn every_schema_has_target_field_first() {
		for s in Op::all_schemas() {
			assert_eq!(
				s.fields.first().map(|f| f.name),
				Some("target"),
				"schema {} missing target as first field",
				s.kind
			);
		}
	}

	#[test]
	fn target_family_matches_kind_prefix() {
		for s in Op::all_schemas() {
			let expected = match s.kind {
				k if k.starts_with("file") => TargetFamily::File,
				// line ops use FileTarget (operate on file content)
				k if k.starts_with("line") => TargetFamily::File,
				k if k.starts_with("symbol") => TargetFamily::Symbol,
				k if k.starts_with("css") => TargetFamily::Css,
				k if k.starts_with("heading") => TargetFamily::Heading,
				_ => panic!("unknown prefix in {}", s.kind),
			};
			assert_eq!(s.target_family, expected, "family mismatch for {}", s.kind);
		}
	}

	#[test]
	fn all_schemas_are_non_empty() {
		for s in Op::all_schemas() {
			assert!(!s.fields.is_empty(), "schema {} has no fields", s.kind);
			assert!(!s.description.is_empty(), "schema {} has no description", s.kind);
		}
	}

	#[test]
	fn every_scope_field_is_optional() {
		for s in Op::all_schemas() {
			for f in &s.fields {
				if f.name == "scope" {
					assert!(!f.required, "{}.scope should be optional", s.kind);
				}
				if f.name == "occurrence" {
					assert!(!f.required, "{}.occurrence should be optional", s.kind);
				}
				if f.name == "force" {
					assert!(!f.required, "{}.force should be optional", s.kind);
				}
				if f.name == "allowSiblingDelete" {
					assert!(!f.required, "{}.allowSiblingDelete should be optional", s.kind);
				}
				if f.name == "renameTo" {
					assert!(!f.required, "{}.renameTo should be optional", s.kind);
				}
			}
		}
	}

	#[test]
	fn required_and_optional_fields_correct() {
		for s in Op::all_schemas() {
			for f in &s.fields {
				match f.name {
					// Fields known to be optional across all variants
					"scope" | "occurrence" | "force" | "allowSiblingDelete" | "renameTo" => {
						assert!(!f.required, "{}.{} should be optional", s.kind, f.name);
					},
					_ => {
						// All other fields should be required
						assert!(f.required, "{}.{} should be required", s.kind, f.name);
					},
				}
			}
		}
	}
}
