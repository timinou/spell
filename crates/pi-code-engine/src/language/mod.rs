mod generated;
mod profile;

use std::{collections::HashMap, path::Path, sync::Arc};

pub use profile::*;

use crate::{
	error::{CodeEngineError, Result},
	procedure::{Procedure, Transform, types},
};

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
	/// Typst, Markdown, Elixir, Org, plus fallback text).
	pub fn with_builtins() -> Result<Self> {
		let mut reg = Self::new();
		reg.register(typescript_profile())?;
		reg.register(rust_profile())?;
		reg.register(python_profile())?;
		reg.register(html_profile())?;
		reg.register(css_profile())?;
		reg.register(typst_profile())?;
		reg.register(markdown_profile())?;
		reg.register(elixir_profile())?;
		reg.register(org_profile())?;
		reg.register(text_profile())?;
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

fn semantic_capabilities(embedded_languages: &[&str]) -> LanguageCapabilities {
	LanguageCapabilities {
		outline:            true,
		read:               true,
		navigate:           true,
		resolve:            true,
		edit:               true,
		graph:              true,
		embedded_languages: embedded_languages
			.iter()
			.map(|language| (*language).to_string())
			.collect(),
	}
}

fn fallback_capabilities() -> LanguageCapabilities {
	LanguageCapabilities::default()
}
fn typescript_profile() -> LanguageProfile {
	let gd = generated::typescript::grammar();
	LanguageProfile {
		id:               LanguageId::new("typescript"),
		capabilities:     semantic_capabilities(&[]),
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
				node_types:    vec!["function_declaration".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "function".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["class_declaration".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "class".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["interface_declaration".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "interface".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["type_alias_declaration".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "type".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["enum_declaration".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "enum".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["lexical_declaration".into(), "variable_declaration".into()],
				name:          NameExtractor::Field { name: "declarator".into() },
				kind:          "variable".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["method_definition".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "method".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "class_declaration".into(),
			body:         ClassBodyExtractor::Field { name: "body".into() },
			filter_field: None,
			filter_names: None,
			member_types: vec![
				"method_definition".into(),
				"public_field_definition".into(),
				"property_definition".into(),
			],
		}],
		imports:          vec![ImportPattern {
			node_type:       "import_statement".into(),
			specifier_field: Some("source".into()),
			specifier:       None,
			filter:          None,
			filter_names:    None,
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
		embedded_regions: vec![],
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
		capabilities:     semantic_capabilities(&[]),
		extensions:       vec!["rs".into()],
		declarations:     vec![
			DeclarationPattern {
				node_types:    vec!["function_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "fn".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["struct_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "struct".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["enum_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "enum".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["impl_item".into()],
				name:          NameExtractor::Field { name: "type".into() },
				kind:          "impl".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["trait_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "trait".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["mod_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "mod".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["type_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "type".into(),
				body:          BodyExtractor::None,
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["const_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "const".into(),
				body:          BodyExtractor::None,
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["static_item".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "static".into(),
				body:          BodyExtractor::None,
				visibility:    Some("pub".into()),
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "impl_item".into(),
			body:         ClassBodyExtractor::Field { name: "body".into() },
			filter_field: None,
			filter_names: None,
			member_types: vec!["function_item".into(), "const_item".into(), "type_item".into()],
		}],
		imports:          vec![ImportPattern {
			node_type:       "use_declaration".into(),
			specifier_field: Some("argument".into()),
			specifier:       None,
			filter:          None,
			filter_names:    None,
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
		embedded_regions: vec![],
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
		capabilities:     semantic_capabilities(&[]),
		extensions:       vec!["py".into(), "pyi".into()],
		declarations:     vec![
			DeclarationPattern {
				node_types:    vec!["function_definition".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "function".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["class_definition".into()],
				name:          NameExtractor::Field { name: "name".into() },
				kind:          "class".into(),
				body:          BodyExtractor::Field { name: "body".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["decorated_definition".into()],
				name:          NameExtractor::Field { name: "definition".into() },
				kind:          "decorated".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "class_definition".into(),
			body:         ClassBodyExtractor::Field { name: "body".into() },
			filter_field: None,
			filter_names: None,
			member_types: vec!["function_definition".into(), "decorated_definition".into()],
		}],
		imports:          vec![
			ImportPattern {
				node_type:       "import_statement".into(),
				specifier_field: Some("name".into()),
				specifier:       None,
				filter:          None,
				filter_names:    None,
				is_type_only:    false,
			},
			ImportPattern {
				node_type:       "import_from_statement".into(),
				specifier_field: Some("module_name".into()),
				specifier:       None,
				filter:          None,
				filter_names:    None,
				is_type_only:    false,
			},
		],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "identifier".into(),
			exclude_parent_types: vec!["comment".into(), "string".into()],
		}],
		separators:       vec![",".into()],
		embedded_regions: vec![],
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_python::LANGUAGE.into(),
	}
}

fn typst_heading_level(line: &str) -> Option<(usize, usize)> {
	let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
	let trimmed = &line[indent..];
	let level = trimmed.chars().take_while(|ch| *ch == '=').count();
	if !(1..=6).contains(&level) {
		return None;
	}
	let rest = trimmed[level..].chars().next();
	if rest.is_some_and(|ch| ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n') {
		return None;
	}
	Some((indent, level))
}

fn typst_shift_headings(text: &str, delta: isize) -> crate::Result<String> {
	let mut out = String::with_capacity(text.len());
	for line in text.split_inclusive('\n') {
		if let Some((indent, level)) = typst_heading_level(line) {
			let new_level = level as isize + delta;
			if !(1..=6).contains(&new_level) {
				return Err(CodeEngineError::Edit(if delta < 0 {
					"Cannot promote h1 heading".into()
				} else {
					"Cannot demote beyond h6".into()
				}));
			}
			let prefix = &line[..indent];
			let trimmed = &line[indent..];
			out.push_str(prefix);
			out.push_str(&"=".repeat(new_level as usize));
			out.push_str(&trimmed[level..]);
			continue;
		}
		out.push_str(line);
	}
	Ok(out)
}

fn typst_promote_heading(text: &str, _options: &serde_json::Value) -> crate::Result<String> {
	typst_shift_headings(text, -1)
}

fn typst_demote_heading(text: &str, _options: &serde_json::Value) -> crate::Result<String> {
	typst_shift_headings(text, 1)
}

fn markdown_fence_marker(line: &str) -> Option<(char, usize)> {
	let trimmed = line.trim_start_matches([' ', '\t']);
	let mut chars = trimmed.chars();
	let marker = chars.next()?;
	if marker != '`' && marker != '~' {
		return None;
	}
	let count = trimmed.chars().take_while(|ch| *ch == marker).count();
	(count >= 3).then_some((marker, count))
}

fn markdown_heading_level(line: &str) -> Option<(usize, usize)> {
	let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
	let trimmed = &line[indent..];
	let level = trimmed.chars().take_while(|ch| *ch == '#').count();
	if !(1..=6).contains(&level) {
		return None;
	}
	let rest = trimmed[level..].chars().next();
	if rest.is_some_and(|ch| ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n') {
		return None;
	}
	Some((indent, level))
}

fn markdown_shift_headings(text: &str, delta: isize) -> crate::Result<String> {
	let mut out = String::with_capacity(text.len());
	let mut in_fence: Option<(char, usize)> = None;
	for line in text.split_inclusive('\n') {
		let trimmed = line.trim_start_matches([' ', '\t']);
		if let Some((marker, count)) = markdown_fence_marker(trimmed) {
			match in_fence {
				Some((open_marker, open_count)) if open_marker == marker && count >= open_count => {
					in_fence = None;
					out.push_str(line);
					continue;
				},
				None => {
					in_fence = Some((marker, count));
					out.push_str(line);
					continue;
				},
				_ => {},
			}
		}
		if in_fence.is_some() {
			out.push_str(line);
			continue;
		}
		if let Some((indent, level)) = markdown_heading_level(line) {
			let new_level = level as isize + delta;
			if !(1..=6).contains(&new_level) {
				return Err(CodeEngineError::Edit(if delta < 0 {
					"Cannot promote h1 heading — already at top level".into()
				} else {
					"Cannot demote h6 heading — already at deepest level".into()
				}));
			}
			let prefix = &line[..indent];
			let trimmed = &line[indent..];
			out.push_str(prefix);
			out.push_str(&"#".repeat(new_level as usize));
			out.push_str(&trimmed[level..]);
			continue;
		}
		out.push_str(line);
	}
	Ok(out)
}

fn replace_markdown_code_block(text: &str, options: &serde_json::Value) -> crate::Result<String> {
	#[derive(Debug)]
	struct CodeBlock {
		content_start: usize,
		content_end:   usize,
		language:      Option<String>,
	}

	let mut blocks = Vec::new();
	let mut offset = 0usize;
	let mut lines = text.split_inclusive('\n');
	while let Some(line) = lines.next() {
		let trimmed = line.trim_start_matches([' ', '\t']);
		let Some((marker, count)) = markdown_fence_marker(trimmed) else {
			offset += line.len();
			continue;
		};
		let language = trimmed[count..]
			.split_whitespace()
			.next()
			.map(str::to_string)
			.filter(|value| !value.is_empty());
		let content_start = offset + line.len();
		offset += line.len();
		let mut content_end = content_start;
		for next_line in lines.by_ref() {
			let next_trimmed = next_line.trim_start_matches([' ', '\t']);
			if let Some((next_marker, next_count)) = markdown_fence_marker(next_trimmed)
				&& next_marker == marker
				&& next_count >= count
			{
				content_end = offset;
				offset += next_line.len();
				break;
			}
			offset += next_line.len();
		}
		blocks.push(CodeBlock { content_start, content_end, language });
	}

	if blocks.is_empty() {
		return Err(CodeEngineError::Edit("No code blocks found in section".into()));
	}

	let target_index = options.get("index").and_then(serde_json::Value::as_u64);
	let target_language = options.get("language").and_then(serde_json::Value::as_str);
	let target = if let Some(index) = target_index {
		blocks.get(index as usize).ok_or_else(|| {
			CodeEngineError::Edit(format!(
				"Code block index {} out of range ({} available)",
				index,
				blocks.len()
			))
		})?
	} else if let Some(language) = target_language {
		blocks
			.iter()
			.find(|block| block.language.as_deref() == Some(language))
			.ok_or_else(|| {
				CodeEngineError::Edit(format!("No code block with language '{language}' found"))
			})?
	} else {
		&blocks[0]
	};

	let mut replacement = options
		.get("content")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("")
		.to_string();
	if !replacement.is_empty() && !replacement.ends_with('\n') {
		replacement.push('\n');
	}
	let mut updated = String::with_capacity(
		text.len() - (target.content_end - target.content_start) + replacement.len(),
	);
	updated.push_str(&text[..target.content_start]);
	updated.push_str(&replacement);
	updated.push_str(&text[target.content_end..]);
	Ok(updated)
}

fn markdown_profile() -> LanguageProfile {
	let gd = generated::markdown::grammar();
	let procedures = HashMap::from([
		(
			"promote".into(),
			Procedure::builder()
				.name("promote")
				.description("Decrease heading level of section and descendant headings")
				.activate(|a| a.nodes(types(&["section"])))
				.transform(Transform::Custom(Arc::new(|text, _options| {
					markdown_shift_headings(text, -1)
				})))
				.build(),
		),
		(
			"demote".into(),
			Procedure::builder()
				.name("demote")
				.description("Increase heading level of section and descendant headings")
				.activate(|a| a.nodes(types(&["section"])))
				.transform(Transform::Custom(Arc::new(|text, _options| {
					markdown_shift_headings(text, 1)
				})))
				.build(),
		),
		(
			"replace-code-block".into(),
			Procedure::builder()
				.name("replace-code-block")
				.description("Replace a fenced code block within a section")
				.activate(|a| a.nodes(types(&["section"])))
				.transform(Transform::Custom(Arc::new(replace_markdown_code_block)))
				.build(),
		),
	]);
	LanguageProfile {
		id: LanguageId::new("markdown"),
		capabilities: semantic_capabilities(&[]),
		extensions: vec!["md".into(), "mdx".into(), "markdown".into()],
		declarations: vec![
			DeclarationPattern {
				node_types:    vec!["section".into()],
				name:          NameExtractor::ChildField {
					child_type: "atx_heading".into(),
					field:      "heading_content".into(),
				},
				kind:          "section".into(),
				body:          BodyExtractor::AfterChild { child_type: "atx_heading".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["minus_metadata".into(), "plus_metadata".into()],
				name:          NameExtractor::Literal { name: "frontmatter".into() },
				kind:          "frontmatter".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like: vec![ClassLikePattern {
			node_type:    "section".into(),
			body:         ClassBodyExtractor::Direct,
			filter_field: None,
			filter_names: None,
			member_types: vec!["section".into()],
		}],
		imports: vec![],
		exports: vec![],
		references: vec![],
		separators: vec![],
		embedded_regions: vec![],
		procedures,
		production_rules: gd.production_rules,
		inverse_rules: gd.inverse_rules,
		all_types: gd.all_types,
		supertypes: gd.supertypes,
		ts_language: tree_sitter_md::LANGUAGE.into(),
	}
}

fn html_profile() -> LanguageProfile {
	let gd = generated::html::grammar();
	LanguageProfile {
		id:               LanguageId::new("html"),
		extensions:       vec!["html".into(), "htm".into()],
		capabilities:     semantic_capabilities(&["css", "javascript"]),
		declarations:     vec![
			DeclarationPattern {
				node_types:    vec!["element".into()],
				name:          NameExtractor::Attributed {
					base:        Box::new(NameExtractor::ChildText { child_type: "tag_name".into() }),
					enrichments: vec![
						AttributeEnrichment {
							within_type:      Some("start_tag".into()),
							attr_name:        "id".into(),
							prefix:           "#".into(),
							take_first_token: false,
						},
						AttributeEnrichment {
							within_type:      Some("start_tag".into()),
							attr_name:        "class".into(),
							prefix:           ".".into(),
							take_first_token: true,
						},
					],
				},
				kind:          "element".into(),
				body:          BodyExtractor::AfterChild { child_type: "start_tag".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["self_closing_tag".into()],
				name:          NameExtractor::Attributed {
					base:        Box::new(NameExtractor::ChildText { child_type: "tag_name".into() }),
					enrichments: vec![
						AttributeEnrichment {
							within_type:      None,
							attr_name:        "id".into(),
							prefix:           "#".into(),
							take_first_token: false,
						},
						AttributeEnrichment {
							within_type:      None,
							attr_name:        "class".into(),
							prefix:           ".".into(),
							take_first_token: true,
						},
					],
				},
				kind:          "element".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["style_element".into()],
				name:          NameExtractor::Literal { name: "style".into() },
				kind:          "style".into(),
				body:          BodyExtractor::AfterChild { child_type: "start_tag".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["script_element".into()],
				name:          NameExtractor::Literal { name: "script".into() },
				kind:          "script".into(),
				body:          BodyExtractor::AfterChild { child_type: "start_tag".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "element".into(),
			body:         ClassBodyExtractor::Direct,
			filter_field: None,
			filter_names: None,
			member_types: vec![
				"element".into(),
				"self_closing_tag".into(),
				"style_element".into(),
				"script_element".into(),
			],
		}],
		imports:          vec![],
		exports:          vec![],
		references:       vec![],
		separators:       vec![],
		embedded_regions: vec![
			EmbeddedRegionPattern {
				host_node_type:     "style_element".into(),
				content_child_type: "raw_text".into(),
				guest_language:     "css".into(),
			},
			EmbeddedRegionPattern {
				host_node_type:     "script_element".into(),
				content_child_type: "raw_text".into(),
				guest_language:     "javascript".into(),
			},
		],
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_html::LANGUAGE.into(),
	}
}

fn css_profile() -> LanguageProfile {
	let gd = generated::css::grammar();
	LanguageProfile {
		id:               LanguageId::new("css"),
		extensions:       vec!["css".into()],
		capabilities:     semantic_capabilities(&[]),
		declarations:     vec![
			DeclarationPattern {
				node_types:    vec!["rule_set".into()],
				name:          NameExtractor::ChildText { child_type: "selectors".into() },
				kind:          "rule".into(),
				body:          BodyExtractor::AfterChild { child_type: "selectors".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["media_statement".into()],
				name:          NameExtractor::Literal { name: "@media".into() },
				kind:          "at-rule".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["supports_statement".into()],
				name:          NameExtractor::Literal { name: "@supports".into() },
				kind:          "at-rule".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["keyframes_statement".into()],
				name:          NameExtractor::ChildText { child_type: "keyframes_name".into() },
				kind:          "keyframes".into(),
				body:          BodyExtractor::AfterChild { child_type: "keyframes_name".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["declaration".into()],
				name:          NameExtractor::ChildText { child_type: "property_name".into() },
				kind:          "property".into(),
				body:          BodyExtractor::AfterChild { child_type: "property_name".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like:       vec![
			ClassLikePattern {
				node_type:    "rule_set".into(),
				body:         ClassBodyExtractor::Field { name: "block".into() },
				filter_field: None,
				filter_names: None,
				member_types: vec!["declaration".into()],
			},
			ClassLikePattern {
				node_type:    "media_statement".into(),
				body:         ClassBodyExtractor::Field { name: "block".into() },
				filter_field: None,
				filter_names: None,
				member_types: vec![
					"rule_set".into(),
					"media_statement".into(),
					"supports_statement".into(),
					"keyframes_statement".into(),
				],
			},
			ClassLikePattern {
				node_type:    "supports_statement".into(),
				body:         ClassBodyExtractor::Field { name: "block".into() },
				filter_field: None,
				filter_names: None,
				member_types: vec![
					"rule_set".into(),
					"media_statement".into(),
					"supports_statement".into(),
					"keyframes_statement".into(),
				],
			},
		],
		imports:          vec![ImportPattern {
			node_type:       "import_statement".into(),
			specifier_field: Some("string_value".into()),
			specifier:       None,
			filter:          None,
			filter_names:    None,
			is_type_only:    false,
		}],
		exports:          vec![],
		references:       vec![
			ReferencePattern {
				node_type:            "class_name".into(),
				exclude_parent_types: vec!["comment".into(), "string_value".into()],
			},
			ReferencePattern {
				node_type:            "id_name".into(),
				exclude_parent_types: vec!["comment".into(), "string_value".into()],
			},
			ReferencePattern {
				node_type:            "tag_name".into(),
				exclude_parent_types: vec!["comment".into(), "string_value".into()],
			},
			ReferencePattern {
				node_type:            "property_name".into(),
				exclude_parent_types: vec!["comment".into()],
			},
		],
		separators:       vec![",".into()],
		embedded_regions: vec![],
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_css::LANGUAGE.into(),
	}
}
fn typst_profile() -> LanguageProfile {
	let gd = generated::typst::grammar();
	let procedures = HashMap::from([
		(
			"promote".into(),
			Procedure::builder()
				.name("promote")
				.description("Decrease Typst heading level")
				.activate(|a| a.nodes(types(&["section"])))
				.transform(Transform::Custom(Arc::new(typst_promote_heading)))
				.build(),
		),
		(
			"demote".into(),
			Procedure::builder()
				.name("demote")
				.description("Increase Typst heading level")
				.activate(|a| a.nodes(types(&["section"])))
				.transform(Transform::Custom(Arc::new(typst_demote_heading)))
				.build(),
		),
	]);
	LanguageProfile {
		id: LanguageId::new("typst"),
		capabilities: semantic_capabilities(&[]),
		extensions: vec!["typ".into()],
		declarations: vec![
			DeclarationPattern {
				node_types:    vec!["let".into()],
				name:          NameExtractor::Field { name: "pattern".into() },
				kind:          "let".into(),
				body:          BodyExtractor::Field { name: "value".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["import".into()],
				name:          NameExtractor::Field { name: "import".into() },
				kind:          "import".into(),
				body:          BodyExtractor::None,
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["show".into()],
				name:          NameExtractor::Field { name: "pattern".into() },
				kind:          "show".into(),
				body:          BodyExtractor::Field { name: "value".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
			DeclarationPattern {
				node_types:    vec!["section".into()],
				name:          NameExtractor::ChildText { child_type: "text".into() },
				kind:          "heading".into(),
				body:          BodyExtractor::AfterChild { child_type: "heading".into() },
				visibility:    None,
				filter_names:  None,
				name_from_arg: false,
			},
		],
		class_like: vec![],
		imports: vec![ImportPattern {
			node_type:       "import".into(),
			specifier_field: Some("import".into()),
			specifier:       None,
			filter:          None,
			filter_names:    None,
			is_type_only:    false,
		}],
		exports: vec![],
		references: vec![ReferencePattern {
			node_type:            "ident".into(),
			exclude_parent_types: vec!["comment".into(), "string".into()],
		}],
		separators: vec![",".into()],
		embedded_regions: vec![],
		procedures,
		production_rules: gd.production_rules,
		inverse_rules: gd.inverse_rules,
		all_types: gd.all_types,
		supertypes: gd.supertypes,
		ts_language: codebook_tree_sitter_typst::LANGUAGE.into(),
	}
}

fn elixir_profile() -> LanguageProfile {
	let gd = generated::elixir::grammar();
	LanguageProfile {
		id:               LanguageId::new("elixir"),
		capabilities:     semantic_capabilities(&[]),
		extensions:       vec!["ex".into(), "exs".into()],
		declarations:     vec![
			DeclarationPattern {
				node_types:    vec!["call".into()],
				name:          NameExtractor::Field { name: "target".into() },
				kind:          "module".into(),
				body:          BodyExtractor::Field { name: "do_block".into() },
				visibility:    None,
				filter_names:  Some(vec!["defmodule".into()]),
				name_from_arg: true,
			},
			DeclarationPattern {
				node_types:    vec!["call".into()],
				name:          NameExtractor::Field { name: "target".into() },
				kind:          "def".into(),
				body:          BodyExtractor::Field { name: "do_block".into() },
				visibility:    None,
				filter_names:  Some(vec!["def".into()]),
				name_from_arg: true,
			},
			DeclarationPattern {
				node_types:    vec!["call".into()],
				name:          NameExtractor::Field { name: "target".into() },
				kind:          "defp".into(),
				body:          BodyExtractor::Field { name: "do_block".into() },
				visibility:    None,
				filter_names:  Some(vec!["defp".into()]),
				name_from_arg: true,
			},
			DeclarationPattern {
				node_types:    vec!["call".into()],
				name:          NameExtractor::Field { name: "target".into() },
				kind:          "macro".into(),
				body:          BodyExtractor::Field { name: "do_block".into() },
				visibility:    None,
				filter_names:  Some(vec!["defmacro".into()]),
				name_from_arg: true,
			},
			DeclarationPattern {
				node_types:    vec!["call".into()],
				name:          NameExtractor::Field { name: "target".into() },
				kind:          "macrop".into(),
				body:          BodyExtractor::Field { name: "do_block".into() },
				visibility:    None,
				filter_names:  Some(vec!["defmacrop".into()]),
				name_from_arg: true,
			},
		],
		class_like:       vec![ClassLikePattern {
			node_type:    "call".into(),
			body:         ClassBodyExtractor::Field { name: "do_block".into() },
			filter_field: Some("target".into()),
			filter_names: Some(vec!["defmodule".into()]),
			member_types: vec!["call".into()],
		}],
		imports:          vec![ImportPattern {
			node_type:       "call".into(),
			specifier_field: Some("arguments".into()),
			specifier:       None,
			filter:          Some(NameExtractor::Field { name: "target".into() }),
			filter_names:    Some(vec![
				"import".into(),
				"alias".into(),
				"require".into(),
				"use".into(),
			]),
			is_type_only:    false,
		}],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "identifier".into(),
			exclude_parent_types: vec!["comment".into(), "string".into()],
		}],
		separators:       vec![",".into()],
		embedded_regions: vec![],
		procedures:       HashMap::new(),
		production_rules: gd.production_rules,
		inverse_rules:    gd.inverse_rules,
		all_types:        gd.all_types,
		supertypes:       gd.supertypes,
		ts_language:      tree_sitter_elixir::LANGUAGE.into(),
	}
}

fn text_profile() -> LanguageProfile {
	LanguageProfile {
		id:               LanguageId::new("text"),
		capabilities:     fallback_capabilities(),
		extensions:       vec![],
		declarations:     vec![],
		class_like:       vec![],
		imports:          vec![],
		exports:          vec![],
		references:       vec![],
		separators:       vec![],
		embedded_regions: vec![],
		procedures:       HashMap::new(),
		production_rules: HashMap::new(),
		inverse_rules:    HashMap::new(),
		all_types:        vec![],
		supertypes:       vec![],
		ts_language:      tree_sitter_md::LANGUAGE.into(),
	}
}

fn org_profile() -> LanguageProfile {
	let gd = generated::org::grammar();
	LanguageProfile {
		id:               LanguageId::new("org"),
		capabilities:     semantic_capabilities(&[]),
		extensions:       vec!["org".into()],
		declarations:     vec![DeclarationPattern {
			node_types:    vec!["section".into()],
			name:          NameExtractor::ChildField {
				child_type: "headline".into(),
				field:      "item".into(),
			},
			kind:          "heading".into(),
			body:          BodyExtractor::AfterChild { child_type: "headline".into() },
			visibility:    None,
			filter_names:  None,
			name_from_arg: false,
		}],
		class_like:       vec![ClassLikePattern {
			node_type:    "section".into(),
			body:         ClassBodyExtractor::Direct,
			filter_field: None,
			filter_names: None,
			member_types: vec!["section".into()],
		}],
		imports:          vec![],
		exports:          vec![],
		references:       vec![ReferencePattern {
			node_type:            "expr".into(),
			exclude_parent_types: vec!["comment".into()],
		}],
		separators:       vec![" ".into(), ":".into()],
		embedded_regions: vec![],
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
	fn registry_with_builtins_loads_all_languages() {
		let reg = LanguageRegistry::with_builtins().expect("builtins should load");
		assert!(reg.get(&LanguageId::new("typescript")).is_some());
		assert!(reg.get(&LanguageId::new("rust")).is_some());
		assert!(reg.get(&LanguageId::new("python")).is_some());
		assert!(reg.get(&LanguageId::new("html")).is_some());
		assert!(reg.get(&LanguageId::new("css")).is_some());
		assert!(reg.get(&LanguageId::new("typst")).is_some());
		assert!(reg.get(&LanguageId::new("markdown")).is_some());
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

		let html = reg.match_path(Path::new("templates/index.html"));
		assert_eq!(html.unwrap().id.as_str(), "html");
		let htm = reg.match_path(Path::new("templates/partial.htm"));
		assert_eq!(htm.unwrap().id.as_str(), "html");
		let css = reg.match_path(Path::new("styles/app.css"));
		assert_eq!(css.unwrap().id.as_str(), "css");

		let md = reg.match_path(Path::new("README.md"));
		assert_eq!(md.unwrap().id.as_str(), "markdown");
		let mdx = reg.match_path(Path::new("docs/guide.mdx"));
		assert_eq!(mdx.unwrap().id.as_str(), "markdown");
		let markdown = reg.match_path(Path::new("docs/guide.markdown"));
		assert_eq!(markdown.unwrap().id.as_str(), "markdown");

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
	fn markdown_profile_has_expected_declarations_and_procedures() {
		let reg = LanguageRegistry::with_builtins().unwrap();
		let markdown = reg.get(&LanguageId::new("markdown")).unwrap();

		assert_eq!(markdown.extensions, vec![
			"md".to_string(),
			"mdx".to_string(),
			"markdown".to_string()
		]);
		assert_eq!(markdown.declarations.len(), 2);
		assert!(matches!(markdown.declarations[0].name, NameExtractor::ChildField { .. }));
		assert!(matches!(
			markdown.declarations[0].body,
			BodyExtractor::AfterChild { ref child_type } if child_type == "atx_heading"
		));
		assert!(matches!(markdown.declarations[1].name, NameExtractor::Literal { .. }));
		assert_eq!(markdown.class_like.len(), 1);
		assert!(matches!(markdown.class_like[0].body, ClassBodyExtractor::Direct));
		assert!(markdown.procedures.contains_key("promote"));
		assert!(markdown.procedures.contains_key("demote"));
		assert!(markdown.procedures.contains_key("replace-code-block"));
		assert_eq!(reg.match_path(Path::new("README.md")).unwrap().id.as_str(), "markdown");
		assert_eq!(markdown.ts_language, tree_sitter_md::LANGUAGE.into());
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

#[test]
fn registry_registers_text_fallback_without_extensions() {
	let reg = LanguageRegistry::with_builtins().unwrap();
	let text = reg.get(&LanguageId::new("text")).unwrap();
	assert!(text.extensions.is_empty());
	assert_eq!(text.ts_language, tree_sitter_md::LANGUAGE.into());
}
