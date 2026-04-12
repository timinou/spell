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

	/// Language-specific custom operations registered as named procedures.
	pub procedures: HashMap<String, crate::procedure::Procedure>,

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

// ---------------------------------------------------------------------------
// Name / Body / ClassBody extraction strategies
// ---------------------------------------------------------------------------

/// How to extract a declaration's name from the AST.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum NameExtractor {
	/// Name from a named field on the declaration node itself.
	/// Equivalent to `child_by_field_name(name)`.
	Field { name: String },
	/// Name from a child node's field: find first child of `child_type`, then
	/// read its `field`.
	ChildField { child_type: String, field: String },
	/// Name from the full text of a specific child node type.
	ChildText { child_type: String },
	/// Fixed literal name regardless of AST content.
	Literal { name: String },
}

/// How to extract a declaration's body range from the AST.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum BodyExtractor {
	/// No body concept for this declaration.
	None,
	/// Body is a named field on the declaration node.
	Field { name: String },
	/// Body is everything after the first child of this type.
	AfterChild { child_type: String },
}

/// How to find children in a class-like container.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum ClassBodyExtractor {
	/// Children inside a named body field (classes, impl blocks).
	Field { name: String },
	/// Members are direct children of the class-like node itself.
	Direct,
}

/// A declaration pattern: how to find named declarations in the parse tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "DeclarationPatternSerde")]
pub struct DeclarationPattern {
	pub node_types: Vec<String>,
	pub name:       NameExtractor,
	pub kind:       String,
	#[serde(default = "default_body_none")]
	pub body:       BodyExtractor,
	/// Optional visibility field (e.g., "pub" keyword presence in Rust).
	#[serde(default)]
	pub visibility: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum DeclarationPatternSerde {
	Legacy {
		node_types: Vec<String>,
		name_field: String,
		kind:       String,
		#[serde(default)]
		body_field: Option<String>,
		#[serde(default)]
		visibility: Option<String>,
	},
	Modern {
		node_types: Vec<String>,
		name:       NameExtractor,
		kind:       String,
		#[serde(default = "default_body_none")]
		body:       BodyExtractor,
		#[serde(default)]
		visibility: Option<String>,
	},
}

impl From<DeclarationPatternSerde> for DeclarationPattern {
	fn from(value: DeclarationPatternSerde) -> Self {
		match value {
			DeclarationPatternSerde::Legacy {
				node_types,
				name_field,
				kind,
				body_field,
				visibility,
			} => Self {
				node_types,
				name: NameExtractor::Field { name: name_field },
				kind,
				body: body_field.map_or(BodyExtractor::None, |name| BodyExtractor::Field { name }),
				visibility,
			},
			DeclarationPatternSerde::Modern { node_types, name, kind, body, visibility } => {
				Self { node_types, name, kind, body, visibility }
			},
		}
	}
}

fn default_body_none() -> BodyExtractor {
	BodyExtractor::None
}

/// A class-like container: impl blocks, classes, sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "ClassLikePatternSerde")]
pub struct ClassLikePattern {
	pub node_type:    String,
	pub body:         ClassBodyExtractor,
	pub member_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum ClassLikePatternSerde {
	Legacy { node_type: String, body_field: String, member_types: Vec<String> },
	Modern { node_type: String, body: ClassBodyExtractor, member_types: Vec<String> },
}

impl From<ClassLikePatternSerde> for ClassLikePattern {
	fn from(value: ClassLikePatternSerde) -> Self {
		match value {
			ClassLikePatternSerde::Legacy { node_type, body_field, member_types } => {
				Self { node_type, body: ClassBodyExtractor::Field { name: body_field }, member_types }
			},
			ClassLikePatternSerde::Modern { node_type, body, member_types } => {
				Self { node_type, body, member_types }
			},
		}
	}
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
