mod generated;
mod profile;

use std::{collections::HashMap, path::Path};

pub use profile::*;

use crate::error::{CodeEngineError, Result};

/// Opaque language identifier (e.g., "typescript", "rust").
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LanguageId(String);

impl LanguageId {
	pub fn new(s: impl Into<String>) -> Self {
		Self(s.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl std::fmt::Display for LanguageId {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

/// Central registry of all language profiles.
/// Created once, shared via Arc, immutable after construction.
pub struct LanguageRegistry {
	by_id:        HashMap<LanguageId, LanguageProfile>,
	by_extension: HashMap<String, LanguageId>,
}

impl LanguageRegistry {
	pub fn new() -> Self {
		Self { by_id: HashMap::new(), by_extension: HashMap::new() }
	}

	/// Create a registry with all built-in profiles (TypeScript, Rust, Python,
	/// Elixir).
	pub fn with_builtins() -> Result<Self> {
		let mut reg = Self::new();
		reg.register(typescript_profile())?;
		reg.register(rust_profile())?;
		reg.register(python_profile())?;
		reg.register(elixir_profile())?;
		Ok(reg)
	}

	/// Register a profile. Errors on duplicate language ID or extension
	/// conflicts.
	pub fn register(&mut self, profile: LanguageProfile) -> Result<()> {
		if self.by_id.contains_key(&profile.id) {
			return Err(CodeEngineError::DuplicateLanguage(profile.id.0));
		}
		for ext in &profile.extensions {
			if let Some(existing_id) = self.by_extension.get(ext) {
				return Err(CodeEngineError::ExtensionConflict {
					ext:      ext.clone(),
					existing: existing_id.0.clone(),
				});
			}
		}
		for ext in &profile.extensions {
			self.by_extension.insert(ext.clone(), profile.id.clone());
		}
		self.by_id.insert(profile.id.clone(), profile);
		Ok(())
	}

	/// Match a file path to a language profile by extension.
	pub fn match_path(&self, path: &Path) -> Option<&LanguageProfile> {
		let ext = path.extension()?.to_str()?;
		let id = self.by_extension.get(ext)?;
		self.by_id.get(id)
	}

	pub fn get(&self, id: &LanguageId) -> Option<&LanguageProfile> {
		self.by_id.get(id)
	}

	pub fn languages(&self) -> Vec<&LanguageId> {
		self.by_id.keys().collect()
	}
}

impl Default for LanguageRegistry {
	fn default() -> Self {
		Self::new()
	}
}

// ---------------------------------------------------------------------------
// Built-in profile constructors
// ---------------------------------------------------------------------------

fn typescript_profile() -> LanguageProfile {
	let gd = generated::typescript::grammar();
	LanguageProfile {
		id:               LanguageId::new("typescript"),
		extensions:       vec![
			"ts".into(),
			"tsx".into(),
			"js".into(),
			"jsx".into(),
			"mjs".into(),
			"cjs".into(),
			"mts".into(),
			"cts".into(),
		],
		declarations:     vec![
			DeclarationPattern {
				node_types: vec!["function_declaration".into()],
				name_field: "name".into(),
				kind:       "function".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["class_declaration".into()],
				name_field: "name".into(),
				kind:       "class".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["interface_declaration".into()],
				name_field: "name".into(),
				kind:       "interface".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["type_alias_declaration".into()],
				name_field: "name".into(),
				kind:       "type".into(),
				body_field: None,
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["enum_declaration".into()],
				name_field: "name".into(),
				kind:       "enum".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["lexical_declaration".into(), "variable_declaration".into()],
				name_field: "declarator".into(),
				kind:       "variable".into(),
				body_field: None,
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["method_definition".into()],
				name_field: "name".into(),
				kind:       "method".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "class_declaration".into(),
			body_field:   "body".into(),
			member_types: vec![
				"method_definition".into(),
				"public_field_definition".into(),
				"property_definition".into(),
			],
		}],
		imports:          vec![ImportPattern {
			node_type:       "import_statement".into(),
			specifier_field: "source".into(),
			is_type_only:    false,
		}],
		exports:          vec![ExportPattern {
			node_type:  "export_statement".into(),
			visibility: "export".into(),
		}],
		references:       vec![ReferencePattern {
			node_type:            "identifier".into(),
			exclude_parent_types: vec![
				"comment".into(),
				"string".into(),
				"template_string".into(),
				"string_fragment".into(),
			],
		}],
		separators:       vec![",".into(), ";".into()],
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
	}
}

fn rust_profile() -> LanguageProfile {
	let gd = generated::rust_lang::grammar();
	LanguageProfile {
		id:               LanguageId::new("rust"),
		extensions:       vec!["rs".into()],
		declarations:     vec![
			DeclarationPattern {
				node_types: vec!["function_item".into()],
				name_field: "name".into(),
				kind:       "fn".into(),
				body_field: Some("body".into()),
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["struct_item".into()],
				name_field: "name".into(),
				kind:       "struct".into(),
				body_field: Some("body".into()),
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["enum_item".into()],
				name_field: "name".into(),
				kind:       "enum".into(),
				body_field: Some("body".into()),
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["impl_item".into()],
				name_field: "type".into(),
				kind:       "impl".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["trait_item".into()],
				name_field: "name".into(),
				kind:       "trait".into(),
				body_field: Some("body".into()),
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["mod_item".into()],
				name_field: "name".into(),
				kind:       "mod".into(),
				body_field: Some("body".into()),
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["type_item".into()],
				name_field: "name".into(),
				kind:       "type".into(),
				body_field: None,
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["const_item".into()],
				name_field: "name".into(),
				kind:       "const".into(),
				body_field: None,
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["static_item".into()],
				name_field: "name".into(),
				kind:       "static".into(),
				body_field: None,
				visibility: Some("pub".into()),
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "impl_item".into(),
			body_field:   "body".into(),
			member_types: vec!["function_item".into(), "const_item".into(), "type_item".into()],
		}],
		imports:          vec![ImportPattern {
			node_type:       "use_declaration".into(),
			specifier_field: "argument".into(),
			is_type_only:    false,
		}],
		exports:          vec![ExportPattern {
			node_type:  "function_item".into(),
			visibility: "pub".into(),
		}],
		references:       vec![ReferencePattern {
			node_type:            "identifier".into(),
			exclude_parent_types: vec![
				"line_comment".into(),
				"block_comment".into(),
				"string_literal".into(),
				"raw_string_literal".into(),
			],
		}],
		separators:       vec![",".into(), ";".into()],
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_rust::LANGUAGE.into(),
	}
}

fn python_profile() -> LanguageProfile {
	let gd = generated::python::grammar();
	LanguageProfile {
		id:               LanguageId::new("python"),
		extensions:       vec!["py".into(), "pyi".into()],
		declarations:     vec![
			DeclarationPattern {
				node_types: vec!["function_definition".into()],
				name_field: "name".into(),
				kind:       "function".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["class_definition".into()],
				name_field: "name".into(),
				kind:       "class".into(),
				body_field: Some("body".into()),
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["decorated_definition".into()],
				name_field: "definition".into(),
				kind:       "decorated".into(),
				body_field: None,
				visibility: None,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "class_definition".into(),
			body_field:   "body".into(),
			member_types: vec!["function_definition".into(), "decorated_definition".into()],
		}],
		imports:          vec![
			ImportPattern {
				node_type:       "import_statement".into(),
				specifier_field: "name".into(),
				is_type_only:    false,
			},
			ImportPattern {
				node_type:       "import_from_statement".into(),
				specifier_field: "module_name".into(),
				is_type_only:    false,
			},
		],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "identifier".into(),
			exclude_parent_types: vec!["comment".into(), "string".into()],
		}],
		separators:       vec![",".into()],
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_python::LANGUAGE.into(),
	}
}

fn elixir_profile() -> LanguageProfile {
	let gd = generated::elixir::grammar();
	LanguageProfile {
		id:               LanguageId::new("elixir"),
		extensions:       vec!["ex".into(), "exs".into()],
		declarations:     vec![DeclarationPattern {
			node_types: vec!["call".into()],
			name_field: "target".into(),
			kind:       "def".into(),
			body_field: Some("do_block".into()),
			visibility: None,
		}],
		class_like:       vec![],
		imports:          vec![ImportPattern {
			node_type:       "call".into(),
			specifier_field: "arguments".into(),
			is_type_only:    false,
		}],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "identifier".into(),
			exclude_parent_types: vec!["comment".into(), "string".into()],
		}],
		separators:       vec![",".into()],
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_elixir::LANGUAGE.into(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn registry_with_builtins_loads_all_four_languages() {
		let reg = LanguageRegistry::with_builtins().expect("builtins should load");
		assert!(reg.get(&LanguageId::new("typescript")).is_some());
		assert!(reg.get(&LanguageId::new("rust")).is_some());
		assert!(reg.get(&LanguageId::new("python")).is_some());
		assert!(reg.get(&LanguageId::new("elixir")).is_some());
		assert!(reg.get(&LanguageId::new("haskell")).is_none());
	}

	#[test]
	fn registry_match_path_resolves_extensions() {
		let reg = LanguageRegistry::with_builtins().unwrap();

		// TypeScript variants
		let ts = reg.match_path(Path::new("src/foo.ts"));
		assert_eq!(ts.unwrap().id.as_str(), "typescript");
		let tsx = reg.match_path(Path::new("component.tsx"));
		assert_eq!(tsx.unwrap().id.as_str(), "typescript");
		let js = reg.match_path(Path::new("index.js"));
		assert_eq!(js.unwrap().id.as_str(), "typescript");

		// Rust
		let rs = reg.match_path(Path::new("src/main.rs"));
		assert_eq!(rs.unwrap().id.as_str(), "rust");

		// Python
		let py = reg.match_path(Path::new("script.py"));
		assert_eq!(py.unwrap().id.as_str(), "python");
		let pyi = reg.match_path(Path::new("types.pyi"));
		assert_eq!(pyi.unwrap().id.as_str(), "python");

		// Elixir
		let ex = reg.match_path(Path::new("lib/app.ex"));
		assert_eq!(ex.unwrap().id.as_str(), "elixir");
		let exs = reg.match_path(Path::new("test/app_test.exs"));
		assert_eq!(exs.unwrap().id.as_str(), "elixir");

		// Unknown
		assert!(reg.match_path(Path::new("file.xyz")).is_none());
	}

	#[test]
	fn registry_rejects_duplicate_language() {
		let mut reg = LanguageRegistry::with_builtins().unwrap();
		let dup = rust_profile();
		let result = reg.register(dup);
		assert!(result.is_err());
		let err = result.unwrap_err();
		assert!(err.to_string().contains("duplicate"), "expected duplicate error, got: {err}");
	}

	#[test]
	fn generated_production_rules_nonempty() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let ts = reg.get(&LanguageId::new("typescript")).unwrap();

		assert!(!ts.production_rules.is_empty(), "TypeScript production rules should not be empty");
		assert!(!ts.all_types.is_empty(), "TypeScript all_types should not be empty");

		// Specific rule: if_statement should have condition and consequence fields
		let if_rule = ts.production_rules.get("if_statement");
		assert!(if_rule.is_some(), "if_statement rule should exist");
		let if_rule = if_rule.unwrap();
		assert!(if_rule.fields.contains_key("condition"), "if_statement should have condition field");
		assert!(
			if_rule.fields.contains_key("consequence"),
			"if_statement should have consequence field"
		);
	}

	#[test]
	fn generated_supertypes_present() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let ts = reg.get(&LanguageId::new("typescript")).unwrap();

		assert!(!ts.supertypes.is_empty(), "TypeScript supertypes should not be empty");
		// "expression" and "statement" are standard supertypes in TS grammar
		assert!(
			ts.supertypes.iter().any(|s| s.contains("expression")),
			"should have an expression supertype, got: {:?}",
			ts.supertypes
		);
	}

	#[test]
	fn inverse_rules_nonempty() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let ts = reg.get(&LanguageId::new("typescript")).unwrap();

		assert!(!ts.inverse_rules.is_empty(), "TypeScript inverse rules should not be empty");
	}

	#[test]
	fn rust_profile_has_expected_declarations() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let rs = reg.get(&LanguageId::new("rust")).unwrap();

		let kinds: Vec<&str> = rs.declarations.iter().map(|d| d.kind.as_str()).collect();
		assert!(kinds.contains(&"fn"), "should have fn declarations");
		assert!(kinds.contains(&"struct"), "should have struct declarations");
		assert!(kinds.contains(&"enum"), "should have enum declarations");
		assert!(kinds.contains(&"impl"), "should have impl declarations");
		assert!(kinds.contains(&"trait"), "should have trait declarations");

		assert!(!rs.production_rules.is_empty(), "Rust production rules should not be empty");
	}

	#[test]
	fn all_builtin_profiles_can_create_parser() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		for lang_id in reg.languages() {
			let profile = reg.get(lang_id).unwrap();
			let mut parser = tree_sitter::Parser::new();
			parser
				.set_language(&profile.ts_language)
				.unwrap_or_else(|e| panic!("failed to set language for {lang_id}: {e}"));
			let tree = parser.parse("", None);
			assert!(tree.is_some(), "parser for {lang_id} should parse empty string");
		}
	}

	#[test]
	fn profile_json_loading() {
		let json = r#"{
			"language": "test",
			"extensions": ["test"],
			"declarations": [
				{
					"node_types": ["function_item"],
					"name_field": "name",
					"kind": "fn",
					"body_field": "body"
				}
			],
			"separators": [","]
		}"#;
		let profile = load_profile_json(json).expect("should parse JSON profile");
		assert_eq!(profile.language, "test");
		assert!(profile.extensions.contains(&"test".to_string()));
		assert_eq!(profile.declarations.len(), 1);
		assert_eq!(profile.declarations[0].kind, "fn");
	}
}
