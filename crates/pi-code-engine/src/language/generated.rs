//! Build-time generated production rules from tree-sitter node-types.json.
//!
//! Each language module provides:
//! - `production_rules()` -> `HashMap` of node type -> field definitions
//! - `inverse_rules()` -> `HashMap` of child type -> parent types
//! - `ALL_TYPES` -> all known node types
//! - `SUPERTYPES` -> abstract supertypes

use std::collections::HashMap;

use crate::language::profile::{InverseRules, ProductionRule, ProductionRules};

/// Generated data for a single language grammar.
pub struct GeneratedGrammar {
	pub production_rules: ProductionRules,
	pub inverse_rules:    InverseRules,
	pub all_types:        Vec<String>,
	pub supertypes:       Vec<String>,
}

// Each grammar's generated data is loaded via include! from build.rs output.
// The generated files define a function `grammar() -> GeneratedGrammar`.

macro_rules! include_grammar {
	($mod_name:ident, $file:expr) => {
		pub mod $mod_name {
			use super::*;
			include!(concat!(env!("OUT_DIR"), "/", $file));
		}
	};
}

include_grammar!(typescript, "grammar_typescript.rs");
include_grammar!(rust_lang, "grammar_rust.rs");
include_grammar!(python, "grammar_python.rs");
include_grammar!(typst, "grammar_typst.rs");
include_grammar!(elixir, "grammar_elixir.rs");
include_grammar!(markdown, "grammar_markdown.rs");

include_grammar!(html, "grammar_html.rs");
include_grammar!(css, "grammar_css.rs");
include_grammar!(org, "grammar_org.rs");
