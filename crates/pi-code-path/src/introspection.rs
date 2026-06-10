//! Kernel introspection — source-of-truth metadata about CodePath's own
//! types (Op kinds, qualifiers, edge kinds, diagnostic variants, language
//! dialects).
//!
//! These functions exist so the JS prompt generator (PLAN-306 W10) can
//! render kernel-derived tables without hardcoding.
//!
//! NOTE: `list_language_dialects` depends on `pi-code-engine` which is
//! above `pi-code-path` in the crate graph. It is implemented in the
//! NAPI bridge (`crates/pi-natives/src/code_path/introspection_napi.rs`)
//! instead.

use serde::{Deserialize, Serialize};

// (types used implicitly via manual info struct construction)

// ── Info structs ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpKindInfo {
	pub kind:            String,
	pub family:          String, // "symbol" | "file" | "css" | "heading" | "line"
	pub target_shape:    String, // "path" | "path::Symbol" | "css" | "heading"
	pub required_fields: Vec<String>,
	pub optional_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QualifierInfo {
	pub name:        String,
	pub args_schema: Option<String>,
	pub applies_to:  Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EdgeKindInfo {
	pub symbol:      String,
	pub name:        String,
	pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticVariantInfo {
	pub variant:  String,
	pub severity: String,
	pub template: String,
}

// ── Helpers ──────────────────────────────────────────────────────

fn op_entry(kind: &str, family: &str, target_shape: &str) -> OpKindInfo {
	OpKindInfo {
		kind:            kind.to_string(),
		family:          family.to_string(),
		target_shape:    target_shape.to_string(),
		required_fields: Vec::new(),
		optional_fields: Vec::new(),
	}
}

fn op_with_required(kind: &str, family: &str, target_shape: &str, required: &[&str]) -> OpKindInfo {
	let mut info = op_entry(kind, family, target_shape);
	info.required_fields = required.iter().map(|s| s.to_string()).collect();
	info
}

fn op_with_fields(
	kind: &str,
	family: &str,
	target_shape: &str,
	required: &[&str],
	optional: &[&str],
) -> OpKindInfo {
	let mut info = op_with_required(kind, family, target_shape, required);
	info.optional_fields = optional.iter().map(|s| s.to_string()).collect();
	info
}

const SEVERITY_ERROR: &str = "error";
const SEVERITY_WARNING: &str = "warning";
const SEVERITY_INFO: &str = "info";

// ── list_op_kinds ────────────────────────────────────────────────

/// Enumerate every [`OpKind`] variant with family, target shape, and
/// required/optional field metadata.
pub fn list_op_kinds() -> Vec<OpKindInfo> {
	vec![
		// File family
		op_with_fields("fileCreate", "file", "path", &["content"], &["force"]),
		op_with_fields("fileWrite", "file", "path", &["content"], &["force"]),
		op_entry("fileDelete", "file", "path"),
		op_with_required("fileAppend", "file", "path", &["content"]),
		op_with_required("filePrepend", "file", "path", &["content"]),
		op_with_required("filePatch", "file", "path", &["diff"]),
		op_with_fields("fileFindReplace", "file", "path", &["find", "content"], &["occurrence"]),
		op_with_fields("fileRawTextReplace", "file", "path", &["find", "content"], &["occurrence"]),
		// Line family
		op_with_required("lineReplace", "line", "path", &["span", "content"]),
		op_with_required("lineInsert", "line", "path", &["at", "content"]),
		op_with_required("lineAppend", "line", "path", &["at", "content"]),
		op_with_required("linePrepend", "line", "path", &["at", "content"]),
		// Symbol family
		op_with_fields("symbolReplace", "symbol", "path::Symbol", &["content"], &["scope"]),
		op_with_required("symbolRename", "symbol", "path::Symbol", &["newName"]),
		op_with_required("symbolWrap", "symbol", "path::Symbol", &["content"]),
		op_with_fields("symbolDelete", "symbol", "path::Symbol", &[], &["allowSiblingDelete"]),
		op_with_required("symbolInsertBefore", "symbol", "path::Symbol", &["content"]),
		op_with_required("symbolInsertAfter", "symbol", "path::Symbol", &["content"]),
		op_with_fields("symbolFindReplace", "symbol", "path::Symbol", &["find", "content"], &[
			"occurrence",
		]),
		op_with_fields("symbolRawTextReplace", "symbol", "path::Symbol", &["find", "content"], &[
			"occurrence",
		]),
		op_with_required("symbolMove", "symbol", "path::Symbol", &["direction"]),
		op_with_fields("symbolClone", "symbol", "path::Symbol", &[], &["renameTo"]),
		op_with_required("symbolSplice", "symbol", "path::Symbol", &["mode"]),
		op_with_required("symbolTranspose", "symbol", "path::Symbol", &["column"]),
		// CSS family
		op_with_required("cssRenameClassToken", "css", "css", &["find", "replace"]),
		op_with_required("cssRenameIdToken", "css", "css", &["find", "replace"]),
		op_with_required("cssRenameCustomProp", "css", "css", &["find", "replace"]),
		op_entry("cssRemoveDeadStyle", "css", "css"),
		// Heading family
		op_entry("headingPromote", "heading", "heading"),
		op_entry("headingDemote", "heading", "heading"),
		op_with_required("headingReplaceBlock", "heading", "heading", &["content"]),
	]
}

/// The expected count of OpKind variants — used in tests.
pub const OP_KIND_COUNT: usize = 31;

// ── list_verb_kinds (PLAN-321) ───────────────────────────────────

/// Enumerate the external [`crate::Verb`] surface kinds, in surface order.
///
/// This is the model-facing 6-verb surface (+ undo/redo) that lowers to the
/// 31 [`OpKind`] variants. The hand-authored TS verb schema asserts parity
/// against this list so the Rust enum and the TS union cannot drift.
pub fn list_verb_kinds() -> Vec<String> {
	["replace", "rename", "delete", "patch", "restructure", "undo", "redo"]
		.into_iter()
		.map(String::from)
		.collect()
}

/// Expected count of verb-surface kinds (6 verbs + undo/redo).
pub const VERB_KIND_COUNT: usize = 7;

// ── list_qualifiers ──────────────────────────────────────────────

/// Enumerate all registered qualifiers across FS and text dialects.
pub fn list_qualifiers() -> Vec<QualifierInfo> {
	vec![
		// FS dialect
		QualifierInfo {
			name:        "listing".to_string(),
			args_schema: None,
			applies_to:  vec!["dir".to_string()],
		},
		QualifierInfo {
			name:        "tree".to_string(),
			args_schema: Some("depth=N".to_string()),
			applies_to:  vec!["dir".to_string()],
		},
		QualifierInfo {
			name:        "stat".to_string(),
			args_schema: None,
			applies_to:  vec!["file".to_string(), "dir".to_string()],
		},
		// Text dialect
		QualifierInfo {
			name:        "raw".to_string(),
			args_schema: None,
			applies_to:  vec!["file".to_string()],
		},
		QualifierInfo {
			name:        "bytes".to_string(),
			args_schema: None,
			applies_to:  vec!["file".to_string()],
		},
		QualifierInfo {
			name:        "text".to_string(),
			args_schema: None,
			applies_to:  vec!["file".to_string()],
		},
		QualifierInfo {
			name:        "match".to_string(),
			args_schema: None,
			applies_to:  vec!["file".to_string(), "symbol".to_string()],
		},
		QualifierInfo {
			name:        "captures".to_string(),
			args_schema: Some("N".to_string()),
			applies_to:  vec!["file".to_string(), "symbol".to_string()],
		},
		QualifierInfo {
			name:        "lines".to_string(),
			args_schema: Some("a..b".to_string()),
			applies_to:  vec!["file".to_string()],
		},
		QualifierInfo {
			name:        "image".to_string(),
			args_schema: None,
			applies_to:  vec!["file".to_string()],
		},
		QualifierInfo {
			name:        "thumbnail".to_string(),
			args_schema: Some("N".to_string()),
			applies_to:  vec!["file".to_string()],
		},
	]
}

/// Expected minimum qualifier count.
pub const QUALIFIER_COUNT_MIN: usize = 8;

// ── list_edge_kinds ──────────────────────────────────────────────

/// Enumerate every [`EdgeKind`] variant.
pub fn list_edge_kinds() -> Vec<EdgeKindInfo> {
	vec![
		EdgeKindInfo {
			symbol:      "ref→".to_string(),
			name:        "Reference".to_string(),
			description: "Follow a reference to its definition".to_string(),
		},
		EdgeKindInfo {
			symbol:      "def→".to_string(),
			name:        "Definition".to_string(),
			description: "From a declaration to its references (set-valued). Trailing `→` is sugar for `…def→§*`. Follows re-export chains.".to_string(),
		},
		EdgeKindInfo {
			symbol:      "call→".to_string(),
			name:        "Call".to_string(),
			description: "From a call site to the callee".to_string(),
		},
		EdgeKindInfo {
			symbol:      "import→".to_string(),
			name:        "Import".to_string(),
			description: "From an imported name to the source module".to_string(),
		},
		EdgeKindInfo {
			symbol:      "bind→".to_string(),
			name:        "Bind".to_string(),
			description: "From a use to its binding site (scope-local)".to_string(),
		},
		EdgeKindInfo {
			symbol:      "implements→".to_string(),
			name:        "Implements".to_string(),
			description: "From a type to the interface/trait it implements (TS `implements`, Rust `impl Trait for X`)"
				.to_string(),
		},
		EdgeKindInfo {
			symbol:      "inherits→".to_string(),
			name:        "Inherits".to_string(),
			description: "From a type to its base type (TS `extends`, Python `class X(Base)`)".to_string(),
		},
		EdgeKindInfo {
			symbol:      "dispatches→".to_string(),
			name:        "Dispatches".to_string(),
			description: "From a polymorphic call site to candidate dispatch targets".to_string(),
		},
	]
}

/// Expected edge kind count.
pub const EDGE_KIND_COUNT: usize = 8;

// ── list_diagnostic_variants ─────────────────────────────────────

/// Enumerate every [`DiagnosticVariant`] with severity and message
/// template.
pub fn list_diagnostic_variants() -> Vec<DiagnosticVariantInfo> {
	vec![
		DiagnosticVariantInfo {
			variant:  "parse_error".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "parse failed at position {pos}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "file_not_found".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "file not found: {path}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "artifact_not_found".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "artifact not found: {uri}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "unknown_locator_scheme".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "unknown locator scheme `{scheme}` — available: {available}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "suffix_suggestion".to_string(),
			severity: SEVERITY_WARNING.to_string(),
			template: "no match for `{tried}` — did you mean `{suggestion}`?".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "no_matches".to_string(),
			severity: SEVERITY_WARNING.to_string(),
			template: "zero matches for target `{target}`".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "ambiguous_target".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "ambiguous target: {count} nodes matched; use a more specific path or add \
			           predicates"
				.to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "unsupported_operation".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "unsupported operation: {detail}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "missing_actions".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "edit command requires `actions` parameter".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "unsupported_action_for_resolver".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "no resolver supports action `{action}` for target `{target}`".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "inaccessible".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "cannot access `{path}`: {reason}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "encoding_fallback".to_string(),
			severity: SEVERITY_WARNING.to_string(),
			template: "file is not valid UTF-8; using latin-1 lossy fallback".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "scheme_not_implemented".to_string(),
			severity: SEVERITY_INFO.to_string(),
			template: "scheme `{scheme}` is recognised but not yet implemented in this release"
				.to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "file_exists".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "file `{path}` already exists; use `force: true` to overwrite / `create` to \
			           recreate"
				.to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "stale_anchor".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "anchor `{source}#{hash}` is stale — file has changed since read; re-read the \
			           file"
				.to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "zero_byte_delete_blocked".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "refusing to delete symbol {symbol} — the file would become zero bytes; use a \
			           bare-path target to remove the file instead"
				.to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "cancelled".to_string(),
			severity: SEVERITY_INFO.to_string(),
			template: "operation cancelled".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "range_bounds_inverted".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "line range bounds inverted: start {start} > end {end}".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "range_clamped".to_string(),
			severity: SEVERITY_INFO.to_string(),
			template: "range bounds clamped to file extent ({lines} lines)".to_string(),
		},
		DiagnosticVariantInfo {
			variant:  "incompatible_target_shape".to_string(),
			severity: SEVERITY_ERROR.to_string(),
			template: "incompatible target shape for `{op_kind}`: {detail}".to_string(),
		},
	]
}

/// Expected minimum diagnostic variant count.
pub const DIAGNOSTIC_VARIANT_COUNT_MIN: usize = 19;

// ── list_language_dialects (stub) ────────────────────────────────

/// NOTE: The real implementation lives in the NAPI bridge
/// (`introspection_napi.rs`) because `pi-code-path` cannot depend on
/// `pi-code-engine` (upward dependency). This stub returns empty.
pub fn list_language_dialects_empty() -> Vec<crate::dialect::LanguageDialect> {
	Vec::new()
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn list_op_kinds_is_non_empty() {
		let kinds = list_op_kinds();
		assert!(!kinds.is_empty());
		assert_eq!(kinds.len(), OP_KIND_COUNT);
	}

	#[test]
	fn list_op_kinds_all_well_formed() {
		for info in &list_op_kinds() {
			assert!(!info.kind.is_empty(), "kind must not be empty");
			assert!(!info.family.is_empty(), "family for {} must not be empty", info.kind);
			assert!(!info.target_shape.is_empty(), "target_shape for {} must not be empty", info.kind);
			// No empty strings in required fields
			for rf in &info.required_fields {
				assert!(!rf.is_empty(), "required field for {} must not be empty", info.kind);
			}
		}
	}

	#[test]
	fn list_qualifiers_is_non_empty() {
		let quals = list_qualifiers();
		assert!(!quals.is_empty());
		assert!(quals.len() >= QUALIFIER_COUNT_MIN);
	}

	#[test]
	fn list_qualifiers_all_well_formed() {
		for q in &list_qualifiers() {
			assert!(!q.name.is_empty());
			assert!(!q.applies_to.is_empty(), "applies_to for {} must not be empty", q.name);
		}
	}

	#[test]
	fn list_edge_kinds_is_non_empty() {
		let edges = list_edge_kinds();
		assert!(!edges.is_empty());
		assert_eq!(edges.len(), EDGE_KIND_COUNT);
	}

	#[test]
	fn list_edge_kinds_all_well_formed() {
		for e in &list_edge_kinds() {
			assert!(!e.symbol.is_empty());
			assert!(!e.name.is_empty());
			assert!(!e.description.is_empty());
		}
	}

	#[test]
	fn list_diagnostic_variants_is_non_empty() {
		let variants = list_diagnostic_variants();
		assert!(!variants.is_empty());
		assert!(variants.len() >= DIAGNOSTIC_VARIANT_COUNT_MIN);
	}

	#[test]
	fn list_diagnostic_variants_all_well_formed() {
		for d in &list_diagnostic_variants() {
			assert!(!d.variant.is_empty());
			assert!(!d.template.is_empty());
			assert!(d.severity == "error" || d.severity == "warning" || d.severity == "info");
		}
	}

	#[test]
	fn list_op_kinds_matches_31() {
		assert_eq!(list_op_kinds().len(), OP_KIND_COUNT);
	}

	#[test]
	fn list_edge_kinds_matches_count() {
		assert_eq!(list_edge_kinds().len(), EDGE_KIND_COUNT);
	}

	#[test]
	fn list_verb_kinds_matches_count_and_serde() {
		let kinds = list_verb_kinds();
		assert_eq!(kinds.len(), VERB_KIND_COUNT);
		// Each listed kind must round-trip to a real Verb variant via serde,
		// guaranteeing the introspection list cannot drift from the enum.
		for k in &kinds {
			let json = match k.as_str() {
				"replace" => serde_json::json!({"kind": "replace", "content": "x"}),
				"rename" => serde_json::json!({"kind": "rename", "to": "x"}),
				"delete" => serde_json::json!({"kind": "delete"}),
				"patch" => serde_json::json!({"kind": "patch", "diff": "d"}),
				"restructure" => {
					serde_json::json!({"kind": "restructure", "op": "demote"})
				},
				"undo" => serde_json::json!({"kind": "undo"}),
				"redo" => serde_json::json!({"kind": "redo"}),
				other => panic!("unlisted verb kind: {other}"),
			};
			assert!(
				serde_json::from_value::<crate::Verb>(json).is_ok(),
				"verb kind `{k}` does not deserialize to a Verb variant"
			);
		}
	}
}
