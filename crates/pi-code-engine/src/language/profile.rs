use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::language::LanguageId;

/// A complete language profile driving outline, navigate, graph extraction, and
/// structural edits.
#[derive(Debug, Clone)]
pub struct LanguageProfile {
	pub id:           LanguageId,
	pub extensions:   Vec<String>,
	pub declarations: Vec<DeclarationPattern>,
	pub class_like:   Vec<ClassLikePattern>,
	pub imports:      Vec<ImportPattern>,
	pub exports:      Vec<ExportPattern>,
	pub references:   Vec<ReferencePattern>,
	pub separators:   Vec<String>,

	/// Build-time generated. Maps `node_type` -> field definitions.
	pub production_rules: ProductionRules,
	/// Build-time generated. Maps `child_type` -> `parent_types`.
	pub inverse_rules:    InverseRules,
	/// All known node types for this language.
	pub all_types:        Vec<String>,
	/// Abstract supertypes (never in real parse tree, used in rule expansion).
	pub supertypes:       Vec<String>,

	/// tree-sitter Language for creating parsers.
	pub ts_language: tree_sitter::Language,
}

/// A declaration pattern: how to find named declarations in the parse tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeclarationPattern {
	pub node_types: Vec<String>,
	pub name_field: String,
	pub kind:       String,
	#[serde(default)]
	pub body_field: Option<String>,
	/// Optional visibility field (e.g., "pub" keyword presence in Rust).
	#[serde(default)]
	pub visibility: Option<String>,
}

/// A class-like container: impl blocks, classes, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassLikePattern {
	pub node_type:    String,
	pub body_field:   String,
	pub member_types: Vec<String>,
}

/// How to find import declarations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPattern {
	pub node_type:       String,
	pub specifier_field: String,
	#[serde(default)]
	pub is_type_only:    bool,
}

/// How to identify exported symbols.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPattern {
	pub node_type:  String,
	/// How export is signaled (e.g., "pub" keyword, "export" keyword, or field
	/// name).
	pub visibility: String,
}

/// How to find references (identifiers that aren't declarations).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferencePattern {
	pub node_type:            String,
	pub exclude_parent_types: Vec<String>,
}

/// Production rules: `node_type` -> field definitions.
pub type ProductionRules = HashMap<String, ProductionRule>;

/// Inverse rules: `child_type` -> `parent_types` that can contain it.
pub type InverseRules = HashMap<String, Vec<String>>;

/// A production rule: which fields a node type has and what child types each
/// field accepts.
#[derive(Debug, Clone, Default)]
pub struct ProductionRule {
	/// Unnamed (positional) children types.
	pub unnamed_children: Vec<String>,
	/// `field_name` -> valid child types.
	pub fields:           HashMap<String, Vec<String>>,
}

/// YAML-loadable profile (subset — no production rules or `ts_language`).
#[derive(Debug, Deserialize)]
pub struct ProfileYaml {
	pub language:     String,
	pub extensions:   Vec<String>,
	#[serde(default)]
	pub declarations: Vec<DeclarationPattern>,
	#[serde(default)]
	pub class_like:   Vec<ClassLikePattern>,
	#[serde(default)]
	pub imports:      Vec<ImportPattern>,
	#[serde(default)]
	pub exports:      Vec<ExportPattern>,
	#[serde(default)]
	pub references:   Vec<ReferencePattern>,
	#[serde(default)]
	pub separators:   Vec<String>,
}

/// Load a profile from JSON string (`serde_yaml` is deprecated; profiles use
/// JSON).
pub fn load_profile_json(json: &str) -> crate::Result<ProfileYaml> {
	serde_json::from_str(json).map_err(|e| crate::CodeEngineError::Profile(e.to_string()))
}
