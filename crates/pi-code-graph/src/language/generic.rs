use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

use pi_code_engine::language::{
	ClassBodyExtractor, DeclarationPattern, LanguageProfile, LanguageRegistry as EngineRegistry,
	NameExtractor, ReferencePattern,
};
use tree_sitter::{Node, Parser};

use crate::{
	error::{CodeGraphError, Result},
	language::{
		ExtractedFile, ExtractedImport, ExtractedImportBinding, ExtractedReference, ExtractedSymbol,
		ImportResolver, LanguageExtractor, ResolveRequest, SupportedLanguage,
	},
	model::{EdgeKind, SymbolKind},
};

#[derive(Clone)]
pub struct EngineProfileExtractor {
	language: SupportedLanguage,
	registry: Arc<EngineRegistry>,
}

#[derive(Clone)]
pub struct EngineProfileImportResolver {
	language: SupportedLanguage,
}

struct ResolvedName {
	text:   String,
	line:   u32,
	column: u32,
}

impl EngineProfileExtractor {
	pub const fn new(language: SupportedLanguage, registry: Arc<EngineRegistry>) -> Self {
		Self { language, registry }
	}

	fn profile(&self) -> Result<&LanguageProfile> {
		self
			.registry
			.get(&pi_code_engine::language::LanguageId::new(self.language.as_str()))
			.ok_or_else(|| CodeGraphError::MissingLanguage(self.language.0.clone()))
	}
}

impl EngineProfileImportResolver {
	pub const fn new(language: SupportedLanguage) -> Self {
		Self { language }
	}
}

impl LanguageExtractor for EngineProfileExtractor {
	fn language(&self) -> SupportedLanguage {
		self.language.clone()
	}

	fn matches_path(&self, path: &Path) -> bool {
		let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
			return false;
		};
		self.profile().is_ok_and(|profile| {
			profile
				.extensions
				.iter()
				.any(|candidate| candidate == extension)
		})
	}

	fn extract(&self, path: &Path, source: &str) -> Result<ExtractedFile> {
		let profile = self.profile()?;
		let mut parser = Parser::new();
		parser
			.set_language(&profile.ts_language)
			.map_err(|error| CodeGraphError::Parse {
				language: self.language.0.clone(),
				path:     path.to_path_buf(),
				message:  error.to_string(),
			})?;
		let tree = parser
			.parse(source, None)
			.ok_or_else(|| CodeGraphError::Parse {
				language: self.language.0.clone(),
				path:     path.to_path_buf(),
				message:  "parser returned no tree".into(),
			})?;
		let root = tree.root_node();
		let mut imports = Vec::new();
		visit_named(root, &mut |node| imports.extend(imports_for_node(profile, path, source, node)));
		let mut symbols = Vec::new();
		let mut cursor = root.walk();
		for child in root.named_children(&mut cursor) {
			collect_symbol_entry(profile, path, source, child, &[], false, &mut symbols);
		}
		Ok(ExtractedFile { path: path.to_path_buf(), language: self.language(), symbols, imports })
	}
}

impl ImportResolver for EngineProfileImportResolver {
	fn language(&self) -> SupportedLanguage {
		self.language.clone()
	}

	fn resolve(&self, request: ResolveRequest<'_>) -> Result<Option<PathBuf>> {
		match self.language.as_str() {
			"rust" => Ok(resolve_rust_import(request)),
			"python" => Ok(resolve_python_import(request)),
			"typst" => Ok(resolve_relative_import(request, &["typ"])),
			"html" => Ok(resolve_relative_import(request, &["css", "html", "htm"])),
			"markdown" => Ok(resolve_relative_import(request, &["md", "mdx", "markdown"])),
			"org" => Ok(resolve_relative_import(request, &["org"])),
			_ => Ok(None),
		}
	}
}

fn collect_symbol_entry(
	profile: &LanguageProfile,
	path: &Path,
	source: &str,
	node: Node<'_>,
	scope: &[String],
	inherited_exported: bool,
	out: &mut Vec<ExtractedSymbol>,
) {
	if node.kind() == "export_statement" {
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			collect_symbol_entry(profile, path, source, child, scope, true, out);
		}
		return;
	}

	if let Some(decl) = declaration_for(profile, node, source) {
		let Some(name) = resolve_name(source, node, decl) else {
			return;
		};
		let mut qualified_segments = scope.to_vec();
		qualified_segments.push(name.text.clone());
		let symbol_kind = symbol_kind_for(decl.kind.as_str(), !scope.is_empty());
		out.push(ExtractedSymbol {
			name:           name.text.clone(),
			qualified_name: qualified_name(path, &qualified_segments),
			kind:           symbol_kind,
			exported:       inherited_exported || is_exported(node, decl),
			line:           name.line,
			column:         name.column,
			detail:         Some(signature_snippet(source, node, decl)),
			references:     collect_references_for_symbol(profile, source, node),
		});
		for child in class_member_nodes(profile, node, source) {
			collect_symbol_entry(profile, path, source, child, &qualified_segments, false, out);
		}
		return;
	}

	let mut cursor = node.walk();
	let mut candidate_children = node.named_children(&mut cursor).filter(|child| {
		child.kind() == "export_statement" || declaration_for(profile, *child, source).is_some()
	});
	let Some(child) = candidate_children.next() else {
		return;
	};
	if candidate_children.next().is_some() {
		return;
	}
	collect_symbol_entry(profile, path, source, child, scope, inherited_exported, out);
}

fn imports_for_node(
	profile: &LanguageProfile,
	_path: &Path,
	source: &str,
	node: Node<'_>,
) -> Vec<ExtractedImport> {
	let Some(pattern) = import_pattern_for(profile, node) else {
		return Vec::new();
	};
	match profile.id.as_str() {
		"rust" => rust_imports(node, source),
		"python" => python_imports(node, source),
		"typst" => typst_imports(node, source, pattern),
		_ => generic_import(node, source, pattern).into_iter().collect(),
	}
	.into_iter()
	.filter(|import| !import.specifier.is_empty())
	.collect()
}

fn generic_import(
	node: Node<'_>,
	source: &str,
	pattern: &pi_code_engine::language::ImportPattern,
) -> Option<ExtractedImport> {
	if let (Some(filter), Some(filter_names)) = (&pattern.filter, &pattern.filter_names) {
		let resolved_filter = resolve_name_for_extractor(source, node, filter)?;
		if !filter_names
			.iter()
			.any(|candidate| candidate == &resolved_filter.text)
		{
			return None;
		}
	}
	let specifier = if let Some(specifier) = &pattern.specifier {
		resolve_name_for_extractor(source, node, specifier).map(|name| name.text)?
	} else {
		let field = pattern.specifier_field.as_deref()?;
		child_by_field_or_kind(node, field)
			.and_then(|specifier| node_text(source, specifier))
			.map(trim_delimiters)?
	};
	Some(ExtractedImport { specifier, bindings: Vec::new(), is_type_only: pattern.is_type_only })
}

fn rust_imports(node: Node<'_>, source: &str) -> Vec<ExtractedImport> {
	let text = node_text(source, node).unwrap_or_default();
	let mut raw = text.trim();
	if let Some(stripped) = raw.strip_prefix("pub ") {
		raw = stripped.trim_start();
	}
	let Some(stripped) = raw.strip_prefix("use ") else {
		return Vec::new();
	};
	let stripped = stripped.trim().trim_end_matches(';').trim();
	if let Some((prefix, rest)) = stripped.split_once('{') {
		let specifier = prefix.trim().trim_end_matches("::").to_string();
		let inner = rest.split('}').next().unwrap_or("");
		let bindings = inner
			.split(',')
			.filter_map(|item| {
				let item = item.trim();
				if item.is_empty() || item == "*" {
					return None;
				}
				let (imported_name, local_name) = alias_pair(item, "::");
				Some(ExtractedImportBinding { imported_name, local_name })
			})
			.collect::<Vec<_>>();
		return vec![ExtractedImport { specifier, bindings, is_type_only: false }];
	}
	let (path_without_alias, alias) = split_alias(stripped);
	if path_without_alias.ends_with("::*") {
		return vec![ExtractedImport {
			specifier:    path_without_alias.trim_end_matches("::*").to_string(),
			bindings:     Vec::new(),
			is_type_only: false,
		}];
	}
	let imported_name = path_without_alias
		.rsplit("::")
		.next()
		.unwrap_or(path_without_alias)
		.to_string();
	vec![ExtractedImport {
		specifier:    path_without_alias.to_string(),
		bindings:     vec![ExtractedImportBinding {
			imported_name: imported_name.clone(),
			local_name:    alias.unwrap_or(imported_name),
		}],
		is_type_only: false,
	}]
}

fn python_imports(node: Node<'_>, source: &str) -> Vec<ExtractedImport> {
	let text = node_text(source, node).unwrap_or_default();
	let raw = text.trim();
	if let Some(rest) = raw.strip_prefix("import ") {
		return rest
			.split(',')
			.filter_map(|item| {
				let item = item.trim();
				if item.is_empty() {
					return None;
				}
				let (specifier, alias) = split_alias(item);
				let imported_name = specifier
					.rsplit('.')
					.next()
					.unwrap_or(specifier)
					.to_string();
				Some(ExtractedImport {
					specifier:    specifier.to_string(),
					bindings:     vec![ExtractedImportBinding {
						imported_name: imported_name.clone(),
						local_name:    alias.unwrap_or(imported_name),
					}],
					is_type_only: false,
				})
			})
			.collect();
	}
	let Some(rest) = raw.strip_prefix("from ") else {
		return Vec::new();
	};
	let Some((module_specifier, imports_part)) = rest.split_once(" import ") else {
		return Vec::new();
	};
	let bindings = imports_part
		.trim()
		.trim_start_matches('(')
		.trim_end_matches(')')
		.split(',')
		.filter_map(|item| {
			let item = item.trim();
			if item.is_empty() || item == "*" {
				return None;
			}
			let (imported_name, local_name) = alias_pair(item, ".");
			Some(ExtractedImportBinding { imported_name, local_name })
		})
		.collect::<Vec<_>>();
	vec![ExtractedImport {
		specifier: module_specifier.trim().to_string(),
		bindings,
		is_type_only: false,
	}]
}

fn typst_imports(
	node: Node<'_>,
	source: &str,
	pattern: &pi_code_engine::language::ImportPattern,
) -> Vec<ExtractedImport> {
	let Some(mut import) = generic_import(node, source, pattern) else {
		return Vec::new();
	};
	let text = node_text(source, node).unwrap_or_default();
	if let Some((_, rest)) = text.split_once(':') {
		import.bindings = rest
			.split(',')
			.filter_map(|item| {
				let item = item.trim();
				if item.is_empty() {
					return None;
				}
				let (imported_name, local_name) = alias_pair(item, ".");
				Some(ExtractedImportBinding { imported_name, local_name })
			})
			.collect();
	}
	vec![import]
}

fn collect_references_for_symbol(
	profile: &LanguageProfile,
	source: &str,
	root: Node<'_>,
) -> Vec<ExtractedReference> {
	let Some(decl) = declaration_for(profile, root, source) else {
		return Vec::new();
	};
	let Some(name_range) = declaration_name_range(source, root, decl) else {
		return Vec::new();
	};
	let mut references = Vec::new();
	collect_references(profile, source, root, root, name_range, &mut references);
	dedupe_references(references)
}

fn collect_references(
	profile: &LanguageProfile,
	source: &str,
	root: Node<'_>,
	node: Node<'_>,
	name_range: (usize, usize),
	out: &mut Vec<ExtractedReference>,
) {
	if node.id() != root.id()
		&& (declaration_for(profile, node, source).is_some()
			|| import_pattern_for(profile, node).is_some())
	{
		return;
	}
	if let Some(pattern) = reference_pattern_for(profile, node)
		&& !excluded(node, pattern)
		&& (node.start_byte(), node.end_byte()) != name_range
		&& let Some(target_name) = node_text(source, node)
	{
		let target_name = trim_delimiters(target_name);
		if !target_name.is_empty() {
			out.push(ExtractedReference { target_name, edge_kind: EdgeKind::References });
		}
	}
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		collect_references(profile, source, root, child, name_range, out);
	}
}

fn dedupe_references(references: Vec<ExtractedReference>) -> Vec<ExtractedReference> {
	let mut deduped = Vec::new();
	for reference in references {
		if deduped.iter().any(|existing: &ExtractedReference| {
			existing.target_name == reference.target_name && existing.edge_kind == reference.edge_kind
		}) {
			continue;
		}
		deduped.push(reference);
	}
	deduped
}

fn declaration_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
	source: &str,
) -> Option<&'a DeclarationPattern> {
	profile.declarations.iter().find(|decl| {
		if !decl.node_types.iter().any(|kind| kind == node.kind()) {
			return false;
		}
		if let Some(filter_names) = &decl.filter_names {
			let name_text = match &decl.name {
				NameExtractor::Field { name } => node
					.child_by_field_name(name)
					.and_then(|name_node| node_text(source, name_node)),
				_ => None,
			};
			return name_text
				.is_some_and(|name| filter_names.iter().any(|candidate| candidate == name));
		}
		true
	})
}

fn resolve_name(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> Option<ResolvedName> {
	if decl.name_from_arg {
		let args = child_by_field_or_kind(node, "arguments")?;
		let mut cursor = args.walk();
		let first = args.named_children(&mut cursor).next()?;
		let target = first.child_by_field_name("target").unwrap_or(first);
		return resolved_name_from_node(source, target);
	}
	resolve_name_for_extractor(source, node, &decl.name)
}

fn resolve_name_for_extractor(
	source: &str,
	node: Node<'_>,
	extractor: &NameExtractor,
) -> Option<ResolvedName> {
	match extractor {
		NameExtractor::Field { name } => {
			let name_node = node
				.child_by_field_name(name)
				.and_then(|name_node| name_node.child_by_field_name("name").or(Some(name_node)))?;
			resolved_name_from_node(source, name_node).or_else(|| {
				find_named_descendant(node, "variable_declarator")
					.and_then(|declarator| declarator.child_by_field_name("name"))
					.and_then(|name_node| resolved_name_from_node(source, name_node))
			})
		},
		NameExtractor::ChildField { child_type, field } => find_named_child(node, child_type)
			.and_then(|child| child.child_by_field_name(field))
			.and_then(|name_node| resolved_name_from_node(source, name_node)),
		NameExtractor::ChildText { child_type } => find_named_child(node, child_type)
			.or_else(|| find_named_descendant(node, child_type))
			.and_then(|child| resolved_name_from_node(source, child)),
		NameExtractor::Literal { name } => Some(ResolvedName {
			text:   name.clone(),
			line:   node.start_position().row as u32 + 1,
			column: node.start_position().column as u32 + 1,
		}),
		NameExtractor::AttributeValue { within_type, attr_name, prefix, take_first_token } => {
			resolve_attribute_name(
				source,
				node,
				within_type.as_deref(),
				attr_name,
				prefix.as_deref(),
				*take_first_token,
			)
		},
		NameExtractor::Attributed { base, enrichments } => {
			let mut base_name = resolve_name_for_extractor(source, node, base)?;
			for enrichment in enrichments {
				if let Some(extra) = resolve_attribute_name(
					source,
					node,
					enrichment.within_type.as_deref(),
					&enrichment.attr_name,
					Some(enrichment.prefix.as_str()),
					enrichment.take_first_token,
				) {
					base_name.text.push_str(&extra.text);
				}
			}
			Some(base_name)
		},
	}
}

fn declaration_name_range(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<(usize, usize)> {
	if decl.name_from_arg {
		let args = child_by_field_or_kind(node, "arguments")?;
		let mut cursor = args.walk();
		let first = args.named_children(&mut cursor).next()?;
		let target = first.child_by_field_name("target").unwrap_or(first);
		return Some((target.start_byte(), target.end_byte()));
	}
	match &decl.name {
		NameExtractor::Field { name } => node.child_by_field_name(name).map(|name_node| {
			let name_node = name_node.child_by_field_name("name").unwrap_or(name_node);
			(name_node.start_byte(), name_node.end_byte())
		}),
		NameExtractor::ChildField { child_type, field } => find_named_child(node, child_type)
			.and_then(|child| child.child_by_field_name(field))
			.map(|name_node| (name_node.start_byte(), name_node.end_byte())),
		NameExtractor::ChildText { child_type } => find_named_child(node, child_type)
			.or_else(|| find_named_descendant(node, child_type))
			.map(|child| (child.start_byte(), child.end_byte())),
		NameExtractor::Literal { .. } => Some((node.start_byte(), node.start_byte())),
		NameExtractor::AttributeValue { within_type, attr_name, .. } => {
			attribute_value_range(source, node, within_type.as_deref(), attr_name)
		},
		NameExtractor::Attributed { base, .. } => name_range_for_extractor(source, node, base),
	}
}

fn name_range_for_extractor(
	source: &str,
	node: Node<'_>,
	extractor: &NameExtractor,
) -> Option<(usize, usize)> {
	match extractor {
		NameExtractor::Field { name } => node.child_by_field_name(name).map(|name_node| {
			let name_node = name_node.child_by_field_name("name").unwrap_or(name_node);
			(name_node.start_byte(), name_node.end_byte())
		}),
		NameExtractor::ChildField { child_type, field } => find_named_child(node, child_type)
			.and_then(|child| child.child_by_field_name(field))
			.map(|name_node| (name_node.start_byte(), name_node.end_byte())),
		NameExtractor::ChildText { child_type } => find_named_child(node, child_type)
			.or_else(|| find_named_descendant(node, child_type))
			.map(|child| (child.start_byte(), child.end_byte())),
		NameExtractor::Literal { .. } => Some((node.start_byte(), node.start_byte())),
		NameExtractor::AttributeValue { within_type, attr_name, .. } => {
			attribute_value_range(source, node, within_type.as_deref(), attr_name)
		},
		NameExtractor::Attributed { base, .. } => name_range_for_extractor(source, node, base),
	}
}

fn resolve_attribute_name(
	source: &str,
	node: Node<'_>,
	within_type: Option<&str>,
	attr_name: &str,
	prefix: Option<&str>,
	take_first_token: bool,
) -> Option<ResolvedName> {
	let range = attribute_value_range(source, node, within_type, attr_name)?;
	let value = source
		.get(range.0..range.1)?
		.trim()
		.trim_matches('"')
		.trim_matches('\'')
		.trim_matches('`');
	let token = if take_first_token {
		value.split_whitespace().next()?
	} else {
		value
	};
	if token.is_empty() {
		return None;
	}
	Some(ResolvedName {
		text:   prefix.map_or_else(|| token.to_string(), |prefix| format!("{prefix}{token}")),
		line:   node.start_position().row as u32 + 1,
		column: node.start_position().column as u32 + 1,
	})
}

fn attribute_value_range(
	source: &str,
	node: Node<'_>,
	within_type: Option<&str>,
	attr_name: &str,
) -> Option<(usize, usize)> {
	let scope = within_type
		.and_then(|kind| find_named_child(node, kind).or_else(|| find_named_descendant(node, kind)))
		.unwrap_or(node);
	let mut cursor = scope.walk();
	let attribute = scope.named_children(&mut cursor).find(|child| {
		child.kind() == "attribute"
			&& find_named_child(*child, "attribute_name")
				.and_then(|name_node| node_text(source, name_node))
				.is_some_and(|value| value.trim() == attr_name)
	})?;
	let value_node = find_named_child(attribute, "quoted_attribute_value")
		.or_else(|| find_named_child(attribute, "attribute_value"))?;
	Some((value_node.start_byte(), value_node.end_byte()))
}

fn class_member_nodes<'a>(
	profile: &LanguageProfile,
	node: Node<'a>,
	source: &str,
) -> Vec<Node<'a>> {
	let Some(class_like) = profile.class_like.iter().find(|class_like| {
		if class_like.node_type != node.kind() {
			return false;
		}
		if let (Some(filter_field), Some(filter_names)) =
			(&class_like.filter_field, &class_like.filter_names)
		{
			let field_text = node
				.child_by_field_name(filter_field)
				.and_then(|field_node| node_text(source, field_node));
			return field_text.is_some_and(|field_text| {
				filter_names.iter().any(|candidate| candidate == field_text)
			});
		}
		true
	}) else {
		return Vec::new();
	};
	match &class_like.body {
		ClassBodyExtractor::Field { name } => {
			let Some(body) = child_by_field_or_kind(node, name) else {
				return Vec::new();
			};
			let mut cursor = body.walk();
			body
				.named_children(&mut cursor)
				.filter(|child| {
					class_like
						.member_types
						.iter()
						.any(|kind| kind == child.kind())
				})
				.collect()
		},
		ClassBodyExtractor::Direct => {
			let mut cursor = node.walk();
			node
				.named_children(&mut cursor)
				.filter(|child| {
					class_like
						.member_types
						.iter()
						.any(|kind| kind == child.kind())
				})
				.collect()
		},
	}
}

fn child_by_field_or_kind<'a>(node: Node<'a>, name: &str) -> Option<Node<'a>> {
	node
		.child_by_field_name(name)
		.or_else(|| find_named_child(node, name))
}

fn find_named_child<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	node
		.named_children(&mut cursor)
		.find(|child| child.kind() == kind)
}

fn find_named_descendant<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if child.kind() == kind {
			return Some(child);
		}
		if let Some(found) = find_named_descendant(child, kind) {
			return Some(found);
		}
	}
	None
}

fn resolved_name_from_node(source: &str, node: Node<'_>) -> Option<ResolvedName> {
	Some(ResolvedName {
		text:   trim_delimiters(node_text(source, node)?),
		line:   node.start_position().row as u32 + 1,
		column: node.start_position().column as u32 + 1,
	})
}

fn node_text<'a>(source: &'a str, node: Node<'_>) -> Option<&'a str> {
	source.get(node.start_byte()..node.end_byte())
}

fn import_pattern_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
) -> Option<&'a pi_code_engine::language::ImportPattern> {
	profile
		.imports
		.iter()
		.find(|pattern| pattern.node_type == node.kind())
}

fn reference_pattern_for<'a>(
	profile: &'a LanguageProfile,
	node: Node<'_>,
) -> Option<&'a ReferencePattern> {
	profile
		.references
		.iter()
		.find(|pattern| pattern.node_type == node.kind())
}

fn excluded(node: Node<'_>, pattern: &ReferencePattern) -> bool {
	let mut current = Some(node);
	while let Some(node) = current {
		if pattern
			.exclude_parent_types
			.iter()
			.any(|kind| kind == node.kind())
		{
			return true;
		}
		current = node.parent();
	}
	false
}

fn is_exported(node: Node<'_>, decl: &DeclarationPattern) -> bool {
	node
		.parent()
		.is_some_and(|parent| parent.kind() == "export_statement")
		|| decl
			.visibility
			.as_ref()
			.and_then(|field| node.child_by_field_name(field))
			.is_some()
}

fn signature_snippet(source: &str, node: Node<'_>, decl: &DeclarationPattern) -> String {
	let end_byte = declaration_body_start(source, node, decl).unwrap_or_else(|| node.end_byte());
	source[node.start_byte()..end_byte]
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty())
		.collect::<Vec<_>>()
		.join(" ")
		.chars()
		.take(200)
		.collect()
}

fn declaration_body_start(
	source: &str,
	node: Node<'_>,
	decl: &DeclarationPattern,
) -> Option<usize> {
	match &decl.body {
		pi_code_engine::language::BodyExtractor::None => None,
		pi_code_engine::language::BodyExtractor::Field { name } => {
			child_by_field_or_kind(node, name).map(|body| body.start_byte())
		},
		pi_code_engine::language::BodyExtractor::AfterChild { child_type } => {
			find_named_child(node, child_type).map(|child| {
				let mut start = child.end_byte();
				if let Some(rest) = source.get(start..) {
					if rest.starts_with("\r\n") {
						start += 2;
					} else if rest.starts_with('\n') {
						start += 1;
					}
				}
				start
			})
		},
	}
}

fn symbol_kind_for(kind: &str, in_member_scope: bool) -> SymbolKind {
	match kind {
		"function" | "fn" if in_member_scope => SymbolKind::Method,
		"function" | "fn" => SymbolKind::Function,
		"class" | "struct" => SymbolKind::Class,
		"method" => SymbolKind::Method,
		"variable" | "let" | "const" | "static" => SymbolKind::Variable,
		"interface" | "trait" => SymbolKind::Interface,
		"type" => SymbolKind::TypeAlias,
		"enum" => SymbolKind::Enum,
		"template" => SymbolKind::Template,
		"element" | "style" | "script" => SymbolKind::Element,
		"rule" | "at-rule" | "keyframes" => SymbolKind::CssRule,
		"property" => SymbolKind::CssProperty,
		"macro" | "show" | "set" => SymbolKind::Macro,
		"module" | "mod" | "section" | "impl" | "import" => SymbolKind::Module,
		_ => SymbolKind::Variable,
	}
}

fn qualified_name(path: &Path, segments: &[String]) -> String {
	format!("{}::{}", path.display(), segments.join("."))
}

fn trim_delimiters(value: &str) -> String {
	value
		.trim()
		.trim_matches('"')
		.trim_matches('\'')
		.trim_matches('`')
		.to_string()
}

fn split_alias(value: &str) -> (&str, Option<String>) {
	let mut parts = value.splitn(2, " as ");
	let left = parts.next().unwrap_or(value).trim();
	let right = parts.next().map(|alias| alias.trim().to_string());
	(left, right)
}

fn alias_pair(value: &str, separator: &str) -> (String, String) {
	let (imported, alias) = split_alias(value);
	let imported_name = imported
		.rsplit(separator)
		.next()
		.unwrap_or(imported)
		.trim()
		.to_string();
	let local_name = alias.unwrap_or_else(|| imported_name.clone());
	(imported_name, local_name)
}

fn visit_named(node: Node<'_>, visit: &mut impl FnMut(Node<'_>)) {
	visit(node);
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		visit_named(child, visit);
	}
}

fn resolve_relative_import(
	request: ResolveRequest<'_>,
	default_extensions: &[&str],
) -> Option<PathBuf> {
	let specifier = request.specifier.trim();
	if specifier.is_empty() {
		return None;
	}
	let mut candidates = Vec::new();
	let base = request
		.project_root
		.join(request.from_file)
		.parent()
		.map_or_else(|| request.project_root.to_path_buf(), Path::to_path_buf);
	let path = if Path::new(specifier).is_absolute() {
		request.project_root.join(specifier.trim_start_matches('/'))
	} else {
		base.join(specifier)
	};
	candidates.push(path.clone());
	if path.extension().is_none() {
		for extension in default_extensions {
			candidates.push(path.with_extension(extension));
		}
	}
	resolve_candidates(request.project_root, candidates)
}

fn resolve_rust_import(request: ResolveRequest<'_>) -> Option<PathBuf> {
	let normalized = request
		.specifier
		.trim()
		.trim_end_matches(';')
		.trim_end_matches("::*")
		.trim();
	if normalized.is_empty() {
		return None;
	}
	let mut segments = normalized
		.split("::")
		.filter(|segment| !segment.is_empty())
		.collect::<Vec<_>>();
	if segments.is_empty() {
		return None;
	}
	let mut base = request.project_root.join("src");
	if segments.first() == Some(&"crate") {
		segments.remove(0);
	} else if matches!(segments.first(), Some(&"self" | &"super")) {
		base = current_rust_module_dir(request.project_root, request.from_file);
		while matches!(segments.first(), Some(&"self" | &"super")) {
			let head = segments.remove(0);
			if head == "super" {
				base = base.parent().map(Path::to_path_buf).unwrap_or(base);
			}
		}
	}
	if segments.is_empty() {
		return None;
	}
	let candidates = rust_candidate_paths(base, &segments);
	resolve_candidates(request.project_root, candidates)
}

fn current_rust_module_dir(project_root: &Path, from_file: &Path) -> PathBuf {
	let absolute = project_root.join(from_file);
	let parent = absolute
		.parent()
		.map_or_else(|| project_root.to_path_buf(), Path::to_path_buf);
	match absolute.file_stem().and_then(|stem| stem.to_str()) {
		Some("mod" | "lib" | "main") => parent,
		Some(stem) => parent.join(stem),
		None => parent,
	}
}

fn rust_candidate_paths(base: PathBuf, segments: &[&str]) -> Vec<PathBuf> {
	let mut candidates = Vec::new();
	for end in (1..=segments.len()).rev() {
		let relative = segments[..end]
			.iter()
			.fold(PathBuf::new(), |mut path, segment| {
				path.push(segment);
				path
			});
		let file_candidate = base.join(&relative).with_extension("rs");
		candidates.push(file_candidate);
		candidates.push(base.join(&relative).join("mod.rs"));
	}
	candidates
}

fn resolve_python_import(request: ResolveRequest<'_>) -> Option<PathBuf> {
	let specifier = request.specifier.trim();
	if specifier.is_empty() {
		return None;
	}
	let dots = specifier.chars().take_while(|ch| *ch == '.').count();
	let remainder = &specifier[dots..];
	let segments = remainder
		.split('.')
		.filter(|segment| !segment.is_empty())
		.collect::<Vec<_>>();
	let bases = if dots == 0 {
		vec![request.project_root.to_path_buf(), request.project_root.join("src")]
	} else {
		let mut base = request
			.project_root
			.join(request.from_file)
			.parent()
			.map_or_else(|| request.project_root.to_path_buf(), Path::to_path_buf);
		for _ in 1..dots {
			base = base.parent().map(Path::to_path_buf).unwrap_or(base);
		}
		vec![base]
	};
	let mut candidates = Vec::new();
	for base in bases {
		candidates.extend(python_candidate_paths(base, &segments));
	}
	resolve_candidates(request.project_root, candidates)
}

fn python_candidate_paths(base: PathBuf, segments: &[&str]) -> Vec<PathBuf> {
	if segments.is_empty() {
		return vec![base.join("__init__.py")];
	}
	let mut candidates = Vec::new();
	for end in (1..=segments.len()).rev() {
		let relative = segments[..end]
			.iter()
			.fold(PathBuf::new(), |mut path, segment| {
				path.push(segment);
				path
			});
		candidates.push(base.join(&relative).with_extension("py"));
		candidates.push(base.join(&relative).join("__init__.py"));
	}
	candidates
}

fn resolve_candidates(project_root: &Path, candidates: Vec<PathBuf>) -> Option<PathBuf> {
	candidates
		.into_iter()
		.find(|candidate| candidate.is_file())
		.and_then(|candidate| {
			candidate
				.strip_prefix(project_root)
				.ok()
				.map(Path::to_path_buf)
		})
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeMap, fs, sync::Arc};

	use super::*;
	use crate::{CacheStore, CodeGraphBuilder, LanguageRegistry};

	fn engine_registry() -> Arc<EngineRegistry> {
		Arc::new(EngineRegistry::with_builtins().expect("engine registry"))
	}

	#[test]
	fn generic_extractor_collects_rust_symbols_and_imports() {
		let extractor =
			EngineProfileExtractor::new(SupportedLanguage::new("rust"), engine_registry());
		let file = extractor
			.extract(
				Path::new("src/lib.rs"),
				"use crate::tools::runner::Helper;\n\npub struct Runner;\n\nimpl Runner {\n    fn \
				 run(&self) {\n        helper();\n    }\n}\n\nfn helper() {}\n",
			)
			.expect("rust extraction should succeed");
		assert_eq!(file.imports.len(), 1);
		assert_eq!(file.imports[0].specifier, "crate::tools::runner::Helper");
		assert_eq!(file.imports[0].bindings[0].local_name, "Helper");
		let names = file
			.symbols
			.iter()
			.map(|symbol| symbol.qualified_name.clone())
			.collect::<Vec<_>>();
		assert!(names.contains(&"src/lib.rs::Runner".to_string()));
		assert!(names.contains(&"src/lib.rs::Runner.run".to_string()));
		assert!(names.contains(&"src/lib.rs::helper".to_string()));
		let run_symbol = file
			.symbols
			.iter()
			.find(|symbol| symbol.qualified_name == "src/lib.rs::Runner.run")
			.expect("run method should be present");
		assert_eq!(run_symbol.kind, SymbolKind::Method);
		assert!(
			run_symbol
				.references
				.iter()
				.any(|reference| reference.target_name == "helper")
		);
	}

	#[test]
	fn generic_python_import_parser_tracks_relative_aliases() {
		let registry = engine_registry();
		let extractor = EngineProfileExtractor::new(SupportedLanguage::new("python"), registry);
		let file = extractor
			.extract(
				Path::new("pkg/main.py"),
				"from .util import helper as run_helper\nimport pkg.core as core\n\n\ndef run():\n    \
				 run_helper()\n    core.start()\n",
			)
			.expect("python extraction should succeed");
		assert_eq!(file.imports.len(), 2);
		assert_eq!(file.imports[0].specifier, ".util");
		assert_eq!(file.imports[0].bindings[0].local_name, "run_helper");
		assert_eq!(file.imports[1].specifier, "pkg.core");
		assert_eq!(file.imports[1].bindings[0].local_name, "core");
	}

	#[test]
	fn rust_and_python_resolvers_find_local_modules() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-generic-resolver-{}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src/tools/runner")).expect("rust dirs should exist");
		fs::create_dir_all(root.join("pkg")).expect("python dirs should exist");
		fs::write(root.join("src/tools/runner.rs"), "pub struct Helper;")
			.expect("rust file should exist");
		fs::write(root.join("pkg/util.py"), "def helper():\n    pass\n")
			.expect("python file should exist");
		let rust = EngineProfileImportResolver::new(SupportedLanguage::new("rust"));
		let python = EngineProfileImportResolver::new(SupportedLanguage::new("python"));
		assert_eq!(
			rust
				.resolve(ResolveRequest {
					project_root: &root,
					from_file:    Path::new("src/lib.rs"),
					specifier:    "crate::tools::runner::Helper",
				})
				.expect("rust resolve")
				.expect("rust path"),
			PathBuf::from("src/tools/runner.rs")
		);
		assert_eq!(
			python
				.resolve(ResolveRequest {
					project_root: &root,
					from_file:    Path::new("pkg/main.py"),
					specifier:    ".util",
				})
				.expect("python resolve")
				.expect("python path"),
			PathBuf::from("pkg/util.py")
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn with_defaults_registers_engine_language_parity() {
		let registry = LanguageRegistry::new()
			.with_defaults()
			.expect("defaults should build");
		let mut supported = registry
			.supported_languages()
			.into_iter()
			.map(|language| language.0)
			.collect::<Vec<_>>();
		supported.sort();
		assert_eq!(supported, vec![
			"css".to_string(),
			"elixir".to_string(),
			"html".to_string(),
			"markdown".to_string(),
			"org".to_string(),
			"python".to_string(),
			"rust".to_string(),
			"text".to_string(),
			"typescript".to_string(),
			"typst".to_string(),
		]);
	}

	#[test]
	fn builder_indexes_mixed_language_workspace() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-mixed-language-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src")).expect("src dir");
		fs::create_dir_all(root.join("pkg")).expect("pkg dir");
		fs::create_dir_all(root.join("docs")).expect("docs dir");
		fs::create_dir_all(root.join("lib/my_app")).expect("elixir dir");
		fs::write(root.join("src/tool.ts"), "export function tool() { return 1; }").expect("ts file");
		fs::write(root.join("src/lib.rs"), "pub fn run() {}").expect("rust file");
		fs::write(root.join("pkg/main.py"), "def run():\n    return 1\n").expect("python file");
		fs::write(root.join("docs/readme.md"), "# Title\n\n## Child\n").expect("markdown file");
		fs::write(root.join("docs/doc.typ"), "= Title\n#let value = 1\n").expect("typst file");
		fs::write(root.join("docs/plan.org"), "* Title\n** Child\n").expect("org file");
		fs::write(root.join("mix.exs"), "defmodule MixProject do end").expect("mix file");
		fs::write(
			root.join("lib/my_app/app.ex"),
			"defmodule MyApp.App do\n  def run, do: :ok\nend\n",
		)
		.expect("elixir file");

		let graph = CodeGraphBuilder::new(
			LanguageRegistry::new().with_defaults().expect("registry"),
			CacheStore::new(&cache_dir),
		)
		.build(&crate::BuildGraphOptions::new(&root))
		.expect("mixed workspace should index")
		.graph;
		let languages = graph.stats().language_counts.clone();
		let expected = BTreeMap::from([
			("elixir".to_string(), 2_u32),
			("markdown".to_string(), 1_u32),
			("org".to_string(), 1_u32),
			("python".to_string(), 1_u32),
			("rust".to_string(), 1_u32),
			("typescript".to_string(), 1_u32),
			("typst".to_string(), 1_u32),
		]);
		assert_eq!(languages, expected);
		let _ = fs::remove_dir_all(root);
	}
}
