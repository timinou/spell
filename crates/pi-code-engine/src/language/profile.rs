use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::language::LanguageId;

/// A complete language profile driving outline, navigate, graph extraction, and
/// structural edits.
#[derive(Debug, Clone)]
pub struct LanguageProfile {
	pub id:               LanguageId,
	pub extensions:       Vec<String>,
	pub capabilities:     LanguageCapabilities,
	pub declarations:     Vec<DeclarationPattern>,
	pub class_like:       Vec<ClassLikePattern>,
	pub imports:          Vec<ImportPattern>,
	pub exports:          Vec<ExportPattern>,
	pub references:       Vec<ReferencePattern>,
	pub separators:       Vec<String>,
	pub embedded_regions: Vec<EmbeddedRegionPattern>,

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

	/// CodePath v3 dialect for this language (optional for backward compat).
	pub dialect: Option<pi_code_path::LanguageDialect>,

	/// Node kinds that should be included when escalating from a declaration
	/// to its enclosing statement range (e.g. `export_statement`,
	/// `decorated_definition`).
	pub enclosing_statement_kinds: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct LanguageCapabilities {
	#[serde(default)]
	pub outline:            bool,
	#[serde(default)]
	pub outline_enrichment: bool,
	#[serde(default)]
	pub read:               bool,
	#[serde(default)]
	pub navigate:           bool,
	#[serde(default)]
	pub resolve:            bool,
	#[serde(default)]
	pub edit:               bool,
	#[serde(default)]
	pub graph:              bool,
	#[serde(default)]
	pub embedded_languages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributeEnrichment {
	#[serde(default)]
	pub within_type:      Option<String>,
	pub attr_name:        String,
	pub prefix:           String,
	#[serde(default)]
	pub take_first_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedRegionPattern {
	pub host_node_type:     String,
	pub content_child_type: String,
	pub guest_language:     String,
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
	/// Name from the Nth value child of a Lisp-style list whose first value is a
	/// fixed symbol.
	ListFormArg { head: String, index: usize },
	/// Fixed literal name regardless of AST content.
	Literal { name: String },
	/// Name from an attribute value within the current node or a named
	/// descendant.
	AttributeValue {
		#[serde(default)]
		within_type:      Option<String>,
		attr_name:        String,
		#[serde(default)]
		prefix:           Option<String>,
		#[serde(default)]
		take_first_token: bool,
	},
	/// Compose a base extractor with attribute-derived suffixes such as `#id` or
	/// `.class`.
	Attributed { base: Box<Self>, enrichments: Vec<AttributeEnrichment> },
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum TextListExtractor {
	Field { name: String },
	FieldChildren { field: String, child_types: Vec<String> },
	NamedChildren { child_types: Vec<String> },
	Descendants { node_types: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum PresenceExtractor {
	Field { name: String },
	ChildKind { child_type: String },
	NodeKind { node_types: Vec<String> },
	TextEquals { extractor: NameExtractor, value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ParameterListExtractor {
	pub field: String,
	#[serde(default)]
	pub item_types: Vec<String>,
	#[serde(default)]
	pub name: Option<NameExtractor>,
	#[serde(default)]
	pub ty: Option<NameExtractor>,
	#[serde(default)]
	pub optional_when_node_types: Vec<String>,
	#[serde(default)]
	pub rest_when_node_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeclarationSignatureEnrichment {
	#[serde(default)]
	pub parameters:  Vec<ParameterListExtractor>,
	#[serde(default)]
	pub return_type: Option<NameExtractor>,
	#[serde(default)]
	pub generics:    Vec<TextListExtractor>,
	#[serde(default)]
	pub throws:      Vec<TextListExtractor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeclarationDocEnrichment {
	#[serde(default)]
	pub comment_node_types: Vec<String>,
	#[serde(default)]
	pub tag_prefixes:       Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeclarationOutlineEnrichment {
	#[serde(default)]
	pub modifiers:  Vec<TextListExtractor>,
	#[serde(default)]
	pub decorators: Vec<TextListExtractor>,
	#[serde(default)]
	pub deprecated: Vec<PresenceExtractor>,
	#[serde(default)]
	pub signature:  DeclarationSignatureEnrichment,
	#[serde(default)]
	pub doc:        DeclarationDocEnrichment,
}

/// A declaration pattern: how to find named declarations in the parse tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "DeclarationPatternSerde")]
pub struct DeclarationPattern {
	pub node_types:         Vec<String>,
	pub name:               NameExtractor,
	pub kind:               String,
	#[serde(default = "default_body_none")]
	pub body:               BodyExtractor,
	/// Optional visibility field (e.g., "pub" keyword presence in Rust).
	#[serde(default)]
	pub visibility:         Option<String>,
	/// When set, only match nodes whose name-field text is in this list.
	/// Used to disambiguate uniform node types (e.g. all Elixir constructs are
	/// `call`).
	#[serde(default)]
	pub filter_names:       Option<Vec<String>>,
	/// When true, extract the display name from the first argument child
	/// instead of the name extractor field.
	#[serde(default)]
	pub name_from_arg:      bool,
	#[serde(default)]
	pub outline_enrichment: DeclarationOutlineEnrichment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum DeclarationPatternSerde {
	Legacy {
		node_types:         Vec<String>,
		name_field:         String,
		kind:               String,
		#[serde(default)]
		body_field:         Option<String>,
		#[serde(default)]
		visibility:         Option<String>,
		#[serde(default)]
		filter_names:       Option<Vec<String>>,
		#[serde(default)]
		name_from_arg:      bool,
		#[serde(default)]
		outline_enrichment: DeclarationOutlineEnrichment,
	},
	Modern {
		node_types:         Vec<String>,
		name:               NameExtractor,
		kind:               String,
		#[serde(default = "default_body_none")]
		body:               BodyExtractor,
		#[serde(default)]
		visibility:         Option<String>,
		#[serde(default)]
		filter_names:       Option<Vec<String>>,
		#[serde(default)]
		name_from_arg:      bool,
		#[serde(default)]
		outline_enrichment: DeclarationOutlineEnrichment,
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
				filter_names,
				name_from_arg,
				outline_enrichment,
			} => Self {
				node_types,
				name: NameExtractor::Field { name: name_field },
				kind,
				body: body_field.map_or(BodyExtractor::None, |name| BodyExtractor::Field { name }),
				visibility,
				filter_names,
				name_from_arg,
				outline_enrichment,
			},
			DeclarationPatternSerde::Modern {
				node_types,
				name,
				kind,
				body,
				visibility,
				filter_names,
				name_from_arg,
				outline_enrichment,
			} => Self {
				node_types,
				name,
				kind,
				body,
				visibility,
				filter_names,
				name_from_arg,
				outline_enrichment,
			},
		}
	}
}

const fn default_body_none() -> BodyExtractor {
	BodyExtractor::None
}

/// A class-like container: impl blocks, classes, sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "ClassLikePatternSerde")]
pub struct ClassLikePattern {
	pub node_type:    String,
	pub body:         ClassBodyExtractor,
	pub member_types: Vec<String>,
	/// Field to check for filtering (e.g. "target" for Elixir `call` nodes).
	#[serde(default)]
	pub filter_field: Option<String>,
	/// When set (along with `filter_field`), only treat nodes as class-like
	/// if the filter field text is in this list.
	#[serde(default)]
	pub filter_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum ClassLikePatternSerde {
	Legacy {
		node_type:    String,
		body_field:   String,
		member_types: Vec<String>,
		#[serde(default)]
		filter_field: Option<String>,
		#[serde(default)]
		filter_names: Option<Vec<String>>,
	},
	Modern {
		node_type:    String,
		body:         ClassBodyExtractor,
		member_types: Vec<String>,
		#[serde(default)]
		filter_field: Option<String>,
		#[serde(default)]
		filter_names: Option<Vec<String>>,
	},
}

impl From<ClassLikePatternSerde> for ClassLikePattern {
	fn from(value: ClassLikePatternSerde) -> Self {
		match value {
			ClassLikePatternSerde::Legacy {
				node_type,
				body_field,
				member_types,
				filter_field,
				filter_names,
			} => Self {
				node_type,
				body: ClassBodyExtractor::Field { name: body_field },
				member_types,
				filter_field,
				filter_names,
			},
			ClassLikePatternSerde::Modern {
				node_type,
				body,
				member_types,
				filter_field,
				filter_names,
			} => Self { node_type, body, member_types, filter_field, filter_names },
		}
	}
}

/// How to find import declarations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "ImportPatternSerde")]
pub struct ImportPattern {
	pub node_type:       String,
	#[serde(default)]
	pub specifier_field: Option<String>,
	#[serde(default)]
	pub specifier:       Option<NameExtractor>,
	#[serde(default)]
	pub filter:          Option<NameExtractor>,
	#[serde(default)]
	pub filter_names:    Option<Vec<String>>,
	#[serde(default)]
	pub is_type_only:    bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
enum ImportPatternSerde {
	Legacy {
		node_type:       String,
		specifier_field: String,
		#[serde(default)]
		is_type_only:    bool,
	},
	Modern {
		node_type:       String,
		#[serde(default)]
		specifier_field: Option<String>,
		#[serde(default)]
		specifier:       Option<NameExtractor>,
		#[serde(default)]
		filter:          Option<NameExtractor>,
		#[serde(default)]
		filter_names:    Option<Vec<String>>,
		#[serde(default)]
		is_type_only:    bool,
	},
}

impl From<ImportPatternSerde> for ImportPattern {
	fn from(value: ImportPatternSerde) -> Self {
		match value {
			ImportPatternSerde::Legacy { node_type, specifier_field, is_type_only } => Self {
				node_type,
				specifier_field: Some(specifier_field),
				specifier: None,
				filter: None,
				filter_names: None,
				is_type_only,
			},
			ImportPatternSerde::Modern {
				node_type,
				specifier_field,
				specifier,
				filter,
				filter_names,
				is_type_only,
			} => Self { node_type, specifier_field, specifier, filter, filter_names, is_type_only },
		}
	}
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProductionRule {
	/// Unnamed (positional) children types.
	pub unnamed_children: Vec<String>,
	/// `field_name` -> valid child types.
	pub fields:           HashMap<String, Vec<String>>,
}

/// JSON-loadable profile (subset — no production rules or `ts_language`).
#[derive(Debug, Deserialize)]
pub struct ProfileYaml {
	pub language:         String,
	pub extensions:       Vec<String>,
	#[serde(default)]
	pub capabilities:     LanguageCapabilities,
	#[serde(default)]
	pub declarations:     Vec<DeclarationPattern>,
	#[serde(default)]
	pub class_like:       Vec<ClassLikePattern>,
	#[serde(default)]
	pub imports:          Vec<ImportPattern>,
	#[serde(default)]
	pub exports:          Vec<ExportPattern>,
	#[serde(default)]
	pub references:       Vec<ReferencePattern>,
	#[serde(default)]
	pub separators:       Vec<String>,
	#[serde(default)]
	pub embedded_regions: Vec<EmbeddedRegionPattern>,
}

/// Load a profile from JSON string (`serde_yaml` is deprecated; profiles use
/// JSON).
pub fn load_profile_json(json: &str) -> crate::Result<ProfileYaml> {
	serde_json::from_str(json).map_err(|e| crate::CodeEngineError::Profile(e.to_string()))
}
