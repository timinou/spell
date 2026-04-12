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
	/// Typst, Elixir, Org).
	pub fn with_builtins() -> Result<Self> {
		let mut reg = Self::new();
		reg.register(typescript_profile())?;
		reg.register(rust_profile())?;
		reg.register(python_profile())?;
		reg.register(typst_profile())?;
		reg.register(elixir_profile())?;
		reg.register(org_profile())?;
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
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "function".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["class_declaration".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "class".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["interface_declaration".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "interface".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["type_alias_declaration".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "type".into(),
				body:       BodyExtractor::None,
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["enum_declaration".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "enum".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["lexical_declaration".into(), "variable_declaration".into()],
				name:       NameExtractor::Field { name: "declarator".into() },
				kind:       "variable".into(),
				body:       BodyExtractor::None,
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["method_definition".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "method".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "class_declaration".into(),
			body:         ClassBodyExtractor::Field { name: "body".into() },
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
		procedures:       HashMap::new(),
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
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "fn".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["struct_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "struct".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["enum_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "enum".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["impl_item".into()],
				name:       NameExtractor::Field { name: "type".into() },
				kind:       "impl".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["trait_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "trait".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["mod_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "mod".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["type_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "type".into(),
				body:       BodyExtractor::None,
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["const_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "const".into(),
				body:       BodyExtractor::None,
				visibility: Some("pub".into()),
			},
			DeclarationPattern {
				node_types: vec!["static_item".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "static".into(),
				body:       BodyExtractor::None,
				visibility: Some("pub".into()),
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "impl_item".into(),
			body:         ClassBodyExtractor::Field { name: "body".into() },
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
		procedures:       HashMap::new(),
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
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "function".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["class_definition".into()],
				name:       NameExtractor::Field { name: "name".into() },
				kind:       "class".into(),
				body:       BodyExtractor::Field { name: "body".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["decorated_definition".into()],
				name:       NameExtractor::Field { name: "definition".into() },
				kind:       "decorated".into(),
				body:       BodyExtractor::None,
				visibility: None,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "class_definition".into(),
			body:         ClassBodyExtractor::Field { name: "body".into() },
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
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_python::LANGUAGE.into(),
	}
}

fn typst_profile() -> LanguageProfile {
	let gd = generated::typst::grammar();
	LanguageProfile {
		id:               LanguageId::new("typst"),
		extensions:       vec!["typ".into()],
		declarations:     vec![
			DeclarationPattern {
				node_types: vec!["let".into()],
				name:       NameExtractor::Field { name: "pattern".into() },
				kind:       "let".into(),
				body:       BodyExtractor::Field { name: "value".into() },
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["import".into()],
				name:       NameExtractor::Field { name: "import".into() },
				kind:       "import".into(),
				body:       BodyExtractor::None,
				visibility: None,
			},
			DeclarationPattern {
				node_types: vec!["show".into()],
				name:       NameExtractor::Field { name: "pattern".into() },
				kind:       "show".into(),
				body:       BodyExtractor::Field { name: "value".into() },
				visibility: None,
			},
		],
		class_like:       vec![],
		imports:          vec![ImportPattern {
			node_type:       "import".into(),
			specifier_field: "import".into(),
			is_type_only:    false,
		}],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "ident".into(),
			exclude_parent_types: vec!["comment".into(), "string".into()],
		}],
		separators:       vec![",".into()],
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      codebook_tree_sitter_typst::LANGUAGE.into(),
	}
}

fn elixir_profile() -> LanguageProfile {
	let gd = generated::elixir::grammar();
	LanguageProfile {
		id:               LanguageId::new("elixir"),
		extensions:       vec!["ex".into(), "exs".into()],
		declarations:     vec![DeclarationPattern {
			node_types: vec!["call".into()],
			name:       NameExtractor::Field { name: "target".into() },
			kind:       "def".into(),
			body:       BodyExtractor::Field { name: "do_block".into() },
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
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_elixir::LANGUAGE.into(),
	}
}

fn org_profile() -> LanguageProfile {
	let gd = generated::org::grammar();
	LanguageProfile {
		id:               LanguageId::new("org"),
		extensions:       vec!["org".into()],
		declarations:     vec![DeclarationPattern {
			node_types: vec!["section".into()],
			name:       NameExtractor::ChildField {
				child_type: "headline".into(),
				field:      "item".into(),
			},
			kind:       "heading".into(),
			body:       BodyExtractor::AfterChild { child_type: "headline".into() },
			visibility: None,
		}],
		class_like:       vec![ClassLikePattern {
			node_type:    "section".into(),
			body:         ClassBodyExtractor::Direct,
			member_types: vec!["section".into()],
		}],
		imports:          vec![],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "expr".into(),
			exclude_parent_types: vec!["comment".into()],
		}],
		separators:       vec![" ".into(), ":".into()],
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_org::LANGUAGE.into(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn registry_with_builtins_loads_all_six_languages() {
		let reg = LanguageRegistry::with_builtins().expect("builtins should load");
		assert!(reg.get(&LanguageId::new("typescript")).is_some());
		assert!(reg.get(&LanguageId::new("rust")).is_some());
		assert!(reg.get(&LanguageId::new("python")).is_some());
		assert!(reg.get(&LanguageId::new("typst")).is_some());
		assert!(reg.get(&LanguageId::new("elixir")).is_some());
		assert!(reg.get(&LanguageId::new("org")).is_some());
		assert!(reg.get(&LanguageId::new("haskell")).is_none());
	}

	#[test]
	fn registry_match_path_resolves_extensions() {
		let reg = LanguageRegistry::with_builtins().unwrap();

		let ts = reg.match_path(Path::new("src/foo.ts"));
		assert_eq!(ts.unwrap().id.as_str(), "typescript");
		let tsx = reg.match_path(Path::new("component.tsx"));
		assert_eq!(tsx.unwrap().id.as_str(), "typescript");
		let js = reg.match_path(Path::new("index.js"));
		assert_eq!(js.unwrap().id.as_str(), "typescript");

		let rs = reg.match_path(Path::new("src/main.rs"));
		assert_eq!(rs.unwrap().id.as_str(), "rust");

		let py = reg.match_path(Path::new("script.py"));
		assert_eq!(py.unwrap().id.as_str(), "python");
		let pyi = reg.match_path(Path::new("types.pyi"));
		assert_eq!(pyi.unwrap().id.as_str(), "python");

		let ex = reg.match_path(Path::new("lib/app.ex"));
		assert_eq!(ex.unwrap().id.as_str(), "elixir");
		let exs = reg.match_path(Path::new("test/app_test.exs"));
		assert_eq!(exs.unwrap().id.as_str(), "elixir");

		let org = reg.match_path(Path::new("notes.org"));
		assert_eq!(org.unwrap().id.as_str(), "org");

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
		let typst = reg.get(&LanguageId::new("typst")).unwrap();

		assert!(!ts.production_rules.is_empty(), "TypeScript production rules should not be empty");
		assert!(!ts.all_types.is_empty(), "TypeScript all_types should not be empty");
		assert!(!typst.production_rules.is_empty(), "Typst production rules should not be empty");
		assert!(!typst.all_types.is_empty(), "Typst all_types should not be empty");

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
	fn typst_profile_has_expected_declarations_and_paths() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let typst = reg.get(&LanguageId::new("typst")).unwrap();

		let kinds: Vec<&str> = typst.declarations.iter().map(|d| d.kind.as_str()).collect();
		assert!(kinds.contains(&"let"), "should have let declarations");
		assert!(kinds.contains(&"import"), "should have import declarations");
		assert!(kinds.contains(&"show"), "should have show declarations");

		let show_decl = typst
			.declarations
			.iter()
			.find(|decl| decl.kind == "show")
			.expect("show declaration pattern");
		assert!(matches!(show_decl.name, NameExtractor::Field { .. }));
		assert!(matches!(show_decl.body, BodyExtractor::Field { .. }));
		assert_eq!(
			typst
				.references
				.first()
				.map(|pattern| pattern.node_type.as_str()),
			Some("ident")
		);

		assert_eq!(reg.match_path(Path::new("doc.typ")).unwrap().id.as_str(), "typst");
		assert_eq!(typst.ts_language, codebook_tree_sitter_typst::LANGUAGE.into());
		assert!(!typst.production_rules.is_empty(), "Typst production rules should not be empty");
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
	fn org_profile_has_expected_declarations() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let org = reg.get(&LanguageId::new("org")).unwrap();

		assert_eq!(org.extensions, vec!["org".to_string()]);
		assert_eq!(org.declarations.len(), 1);
		assert!(matches!(org.declarations[0].name, NameExtractor::ChildField { .. }));
		assert!(matches!(
			org.declarations[0].body,
			BodyExtractor::AfterChild { ref child_type } if child_type == "headline"
		));
		assert_eq!(org.class_like.len(), 1);
		assert!(matches!(org.class_like[0].body, ClassBodyExtractor::Direct));
	}

	#[test]
	fn org_profile_parses_document() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let org = reg.get(&LanguageId::new("org")).unwrap();
		let mut parser = tree_sitter::Parser::new();
		parser.set_language(&org.ts_language).expect("org parser");
		let tree = parser.parse("* TODO Heading\nBody\n", None).expect("tree");
		assert_eq!(tree.root_node().kind(), "document");
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
		assert!(
			matches!(profile.declarations[0].name, NameExtractor::Field { ref name } if name == "name")
		);
		assert!(matches!(
			profile.declarations[0].body,
			BodyExtractor::Field { ref name } if name == "body"
		));
	}
}
