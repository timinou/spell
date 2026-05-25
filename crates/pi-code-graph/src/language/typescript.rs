use std::{
	collections::BTreeSet,
	panic::{self, AssertUnwindSafe},
	path::{Path, PathBuf},
};

use oxc_resolver::{
	ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
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

const TYPESCRIPT_LANGUAGE: &str = "typescript";
const TYPESCRIPT_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

#[derive(Clone, Default)]
pub struct TypeScriptExtractor;

#[derive(Clone, Default)]
pub struct TypeScriptImportResolver;

impl LanguageExtractor for TypeScriptExtractor {
	fn language(&self) -> SupportedLanguage {
		SupportedLanguage::new(TYPESCRIPT_LANGUAGE)
	}

	fn matches_path(&self, path: &Path) -> bool {
		path
			.extension()
			.and_then(|extension| extension.to_str())
			.is_some_and(|extension| TYPESCRIPT_EXTENSIONS.contains(&extension))
	}

	fn extract(&self, path: &Path, source: &str) -> Result<ExtractedFile> {
		let mut parser = Parser::new();
		let language = if is_tsx(path) {
			tree_sitter_typescript::LANGUAGE_TSX
		} else if is_javascript(path) {
			tree_sitter_javascript::LANGUAGE
		} else {
			tree_sitter_typescript::LANGUAGE_TYPESCRIPT
		};
		parser
			.set_language(&language.into())
			.map_err(|error| CodeGraphError::Parse {
				language: TYPESCRIPT_LANGUAGE.into(),
				path:     path.to_path_buf(),
				message:  error.to_string(),
			})?;
		let tree = parser
			.parse(source, None)
			.ok_or_else(|| CodeGraphError::Parse {
				language: TYPESCRIPT_LANGUAGE.into(),
				path:     path.to_path_buf(),
				message:  "parser returned no tree".into(),
			})?;
		let root = tree.root_node();
		let mut imports = Vec::new();
		let mut symbols = Vec::new();
		let mut exported_names = BTreeSet::new();
		let mut cursor = root.walk();
		for child in root.named_children(&mut cursor) {
			match child.kind() {
				"import_statement" => {
					if let Some(import) = parse_import_statement(child, source)? {
						imports.push(import);
					}
				},
				"export_statement" => {
					parse_export_statement(
						child,
						path,
						source,
						&mut imports,
						&mut symbols,
						&mut exported_names,
					)?;
				},
				kind if is_declaration_kind(kind) => {
					extract_declaration(child, path, source, false, &mut symbols)?;
				},
				_ => {},
			}
		}
		for symbol in &mut symbols {
			if exported_names.contains(&symbol.name) {
				symbol.exported = true;
			}
		}
		Ok(ExtractedFile { path: path.to_path_buf(), language: self.language(), symbols, imports })
	}
}

impl ImportResolver for TypeScriptImportResolver {
	fn language(&self) -> SupportedLanguage {
		SupportedLanguage::new(TYPESCRIPT_LANGUAGE)
	}

	#[allow(
		clippy::field_reassign_with_default,
		reason = "Resolver options are assembled in stages to keep the defaults obvious"
	)]
	fn resolve(&self, request: ResolveRequest<'_>) -> Result<Option<PathBuf>> {
		Ok(resolve_import_path(request, |options, from_dir, specifier| {
			let resolver = Resolver::new(options);
			resolver
				.resolve(from_dir, specifier)
				.ok()
				.map(|resolved| resolved.into_path_buf())
		}))
	}
}

fn resolve_import_path(
	request: ResolveRequest<'_>,
	resolve_with: impl FnOnce(ResolveOptions, &Path, &str) -> Option<PathBuf>,
) -> Option<PathBuf> {
	let absolute_from = request.project_root.join(request.from_file);
	let from_dir = absolute_from.parent()?;
	let resolved_path = panic::catch_unwind(AssertUnwindSafe(|| {
		resolve_with(build_resolve_options(request.project_root), from_dir, request.specifier)
	}))
	.ok()
	.flatten()
	.or_else(|| fallback_relative_path(request.project_root, request.from_file, request.specifier));
	resolved_path.and_then(|path| {
		path
			.strip_prefix(request.project_root)
			.ok()
			.map(Path::to_path_buf)
	})
}

#[allow(
	clippy::field_reassign_with_default,
	reason = "Resolver options are assembled in stages to keep the defaults obvious"
)]
fn build_resolve_options(project_root: &Path) -> ResolveOptions {
	let mut options = ResolveOptions::default();
	options.extensions = vec![
		".ts".into(),
		".tsx".into(),
		".mts".into(),
		".cts".into(),
		".js".into(),
		".jsx".into(),
		".mjs".into(),
		".cjs".into(),
		".json".into(),
	];
	options.main_fields = vec!["module".into(), "main".into()];
	options.condition_names = vec!["import".into(), "module".into(), "default".into()];
	options.extension_alias = vec![
		(".js".into(), vec![".ts".into(), ".tsx".into(), ".js".into()]),
		(".mjs".into(), vec![".mts".into(), ".mjs".into()]),
		(".cjs".into(), vec![".cts".into(), ".cjs".into()]),
	];
	let tsconfig_path = project_root.join("tsconfig.json");
	if tsconfig_path.is_file() {
		options.tsconfig = Some(TsconfigDiscovery::Manual(TsconfigOptions {
			config_file: tsconfig_path,
			references:  TsconfigReferences::Auto,
		}));
	}
	options
}

fn parse_export_statement(
	node: Node<'_>,
	path: &Path,
	source: &str,
	imports: &mut Vec<ExtractedImport>,
	symbols: &mut Vec<ExtractedSymbol>,
	exported_names: &mut BTreeSet<String>,
) -> Result<()> {
	if let Some(declaration) = node.child_by_field_name("declaration") {
		return extract_declaration(declaration, path, source, true, symbols);
	}
	if let Some(export_clause) = named_child(node, "export_clause") {
		for export_name in collect_export_names(export_clause, source) {
			exported_names.insert(export_name);
		}
	}
	if let Some(source_node) = node.child_by_field_name("source") {
		let specifier = parse_string_literal(source_node, source);
		if !specifier.is_empty() {
			let bindings = named_child(node, "export_clause")
				.map(|clause| collect_export_bindings(clause, source))
				.unwrap_or_default();
			imports.push(ExtractedImport {
				specifier,
				bindings,
				is_type_only: node_text(node, source).starts_with("export type"),
			});
		}
	}
	Ok(())
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "Shared declaration walker keeps export parsing linear"
)]
fn extract_declaration(
	node: Node<'_>,
	path: &Path,
	source: &str,
	exported: bool,
	symbols: &mut Vec<ExtractedSymbol>,
) -> Result<()> {
	match node.kind() {
		"function_declaration" | "generator_function_declaration" => {
			if let Some(symbol) = function_symbol(node, path, source, exported) {
				symbols.push(symbol);
			}
		},
		"class_declaration" | "abstract_class_declaration" => {
			symbols.extend(class_symbols(node, path, source, exported));
		},
		"interface_declaration" => {
			if let Some(symbol) = type_like_symbol(node, path, source, exported, SymbolKind::Interface)
			{
				symbols.push(symbol);
			}
		},
		"type_alias_declaration" => {
			if let Some(symbol) = type_like_symbol(node, path, source, exported, SymbolKind::TypeAlias)
			{
				symbols.push(symbol);
			}
		},
		"enum_declaration" => {
			if let Some(symbol) = type_like_symbol(node, path, source, exported, SymbolKind::Enum) {
				symbols.push(symbol);
			}
		},
		"lexical_declaration" | "variable_declaration" => {
			symbols.extend(variable_symbols(node, path, source, exported));
		},
		_ => {},
	}
	Ok(())
}

fn function_symbol(
	node: Node<'_>,
	path: &Path,
	source: &str,
	exported: bool,
) -> Option<ExtractedSymbol> {
	let name_node = node.child_by_field_name("name")?;
	let name = node_text(name_node, source);
	Some(ExtractedSymbol {
		name: name.clone(),
		qualified_name: qualified_name(path, &[&name]),
		kind: SymbolKind::Function,
		exported,
		line: name_node.start_position().row as u32 + 1,
		column: name_node.start_position().column as u32 + 1,
		detail: Some(signature_snippet(node, source)),
		references: collect_references(node, source),
	})
}

fn class_symbols(
	node: Node<'_>,
	path: &Path,
	source: &str,
	exported: bool,
) -> Vec<ExtractedSymbol> {
	let Some(name_node) = node.child_by_field_name("name") else {
		return Vec::new();
	};
	let class_name = node_text(name_node, source);
	let mut symbols = vec![ExtractedSymbol {
		name: class_name.clone(),
		qualified_name: qualified_name(path, &[&class_name]),
		kind: SymbolKind::Class,
		exported,
		line: name_node.start_position().row as u32 + 1,
		column: name_node.start_position().column as u32 + 1,
		detail: Some(signature_snippet(node, source)),
		references: collect_heritage_references(node, source),
	}];
	if let Some(body) = node.child_by_field_name("body") {
		let mut cursor = body.walk();
		for child in body.named_children(&mut cursor) {
			if child.kind() != "method_definition" {
				continue;
			}
			let Some(method_name_node) = child.child_by_field_name("name") else {
				continue;
			};
			let method_name = node_text(method_name_node, source);
			symbols.push(ExtractedSymbol {
				name:           method_name.clone(),
				qualified_name: qualified_name(path, &[&class_name, &method_name]),
				kind:           SymbolKind::Method,
				exported:       false,
				line:           method_name_node.start_position().row as u32 + 1,
				column:         method_name_node.start_position().column as u32 + 1,
				detail:         Some(signature_snippet(child, source)),
				references:     collect_references(child, source),
			});
		}
	}
	symbols
}

fn type_like_symbol(
	node: Node<'_>,
	path: &Path,
	source: &str,
	exported: bool,
	kind: SymbolKind,
) -> Option<ExtractedSymbol> {
	let name_node = node.child_by_field_name("name")?;
	let name = node_text(name_node, source);
	Some(ExtractedSymbol {
		name: name.clone(),
		qualified_name: qualified_name(path, &[&name]),
		kind,
		exported,
		line: name_node.start_position().row as u32 + 1,
		column: name_node.start_position().column as u32 + 1,
		detail: Some(signature_snippet(node, source)),
		references: collect_heritage_references(node, source),
	})
}

#[allow(clippy::unnested_or_patterns, reason = "Separate node variants are easier to scan here")]
fn variable_symbols(
	node: Node<'_>,
	path: &Path,
	source: &str,
	exported: bool,
) -> Vec<ExtractedSymbol> {
	let mut symbols = Vec::new();
	let mut cursor = node.walk();
	for declarator in node.named_children(&mut cursor) {
		if declarator.kind() != "variable_declarator" {
			continue;
		}
		let Some(name_node) = declarator.child_by_field_name("name") else {
			continue;
		};
		if name_node.kind() != "identifier" {
			continue;
		}
		let name = node_text(name_node, source);
		let value_node = declarator.child_by_field_name("value");
		let kind = match value_node.map(|value| value.kind()) {
			Some("arrow_function") | Some("function_expression") => SymbolKind::Function,
			Some("class") => SymbolKind::Class,
			_ => SymbolKind::Variable,
		};
		let references = value_node
			.map(|value| collect_references(value, source))
			.unwrap_or_default();
		symbols.push(ExtractedSymbol {
			name: name.clone(),
			qualified_name: qualified_name(path, &[&name]),
			kind,
			exported,
			line: name_node.start_position().row as u32 + 1,
			column: name_node.start_position().column as u32 + 1,
			detail: Some(signature_snippet(declarator, source)),
			references,
		});
	}
	symbols
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "Import parsing keeps a uniform fallible shape with sibling helpers"
)]
fn parse_import_statement(node: Node<'_>, source: &str) -> Result<Option<ExtractedImport>> {
	if let Some(import_require_clause) = named_child(node, "import_require_clause") {
		let specifier = import_require_clause
			.child_by_field_name("source")
			.map(|child| parse_string_literal(child, source))
			.unwrap_or_default();
		let local_name = import_require_clause
			.named_child(0)
			.map(|child| node_text(child, source))
			.unwrap_or_default();
		if specifier.is_empty() || local_name.is_empty() {
			return Ok(None);
		}
		return Ok(Some(ExtractedImport {
			specifier,
			bindings: vec![ExtractedImportBinding { imported_name: "default".into(), local_name }],
			is_type_only: false,
		}));
	}
	let Some(source_node) = node.child_by_field_name("source") else {
		return Ok(None);
	};
	let specifier = parse_string_literal(source_node, source);
	if specifier.is_empty() {
		return Ok(None);
	}
	let bindings = named_child(node, "import_clause")
		.map(|clause| collect_import_bindings(clause, source))
		.unwrap_or_default();
	Ok(Some(ExtractedImport {
		specifier,
		bindings,
		is_type_only: node_text(node, source).starts_with("import type"),
	}))
}

#[allow(
	clippy::map_unwrap_or,
	reason = "Alias fallback reads more directly with unwrap_or_else on the imported name"
)]
fn collect_import_bindings(node: Node<'_>, source: &str) -> Vec<ExtractedImportBinding> {
	let mut bindings = Vec::new();
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		match child.kind() {
			"identifier" => bindings.push(ExtractedImportBinding {
				imported_name: "default".into(),
				local_name:    node_text(child, source),
			}),
			"named_imports" => {
				let mut import_cursor = child.walk();
				for specifier in child.named_children(&mut import_cursor) {
					if specifier.kind() != "import_specifier" {
						continue;
					}
					let imported_name = specifier
						.child_by_field_name("name")
						.map(|field| node_text(field, source))
						.unwrap_or_default();
					let local_name = specifier
						.child_by_field_name("alias")
						.map(|field| node_text(field, source))
						.unwrap_or_else(|| imported_name.clone());
					if !imported_name.is_empty() {
						bindings.push(ExtractedImportBinding { imported_name, local_name });
					}
				}
			},
			"namespace_import" => {
				let alias = child
					.named_child(0)
					.map(|name| node_text(name, source))
					.unwrap_or_default();
				if !alias.is_empty() {
					bindings
						.push(ExtractedImportBinding { imported_name: "*".into(), local_name: alias });
				}
			},
			_ => {},
		}
	}
	bindings
}

#[allow(
	clippy::map_unwrap_or,
	reason = "Alias fallback mirrors import binding parsing for export specifiers"
)]
fn collect_export_bindings(node: Node<'_>, source: &str) -> Vec<ExtractedImportBinding> {
	let mut bindings = Vec::new();
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		if child.kind() != "export_specifier" {
			continue;
		}
		let imported_name = child
			.child_by_field_name("name")
			.map(|field| node_text(field, source))
			.unwrap_or_default();
		let local_name = child
			.child_by_field_name("alias")
			.map(|field| node_text(field, source))
			.unwrap_or_else(|| imported_name.clone());
		if !imported_name.is_empty() {
			bindings.push(ExtractedImportBinding { imported_name, local_name });
		}
	}
	bindings
}

fn collect_export_names(node: Node<'_>, source: &str) -> Vec<String> {
	collect_export_bindings(node, source)
		.into_iter()
		.map(|binding| binding.local_name)
		.collect()
}

fn collect_references(node: Node<'_>, source: &str) -> Vec<ExtractedReference> {
	let mut refs = Vec::new();
	visit_named(node, &mut |child| match child.kind() {
		"call_expression" | "new_expression" => {
			if let Some(target) = child
				.child_by_field_name("function")
				.or_else(|| child.child_by_field_name("constructor"))
			{
				for name in collect_target_names(target, source) {
					refs.push(ExtractedReference {
						target_name: name.clone(),
						edge_kind:   EdgeKind::Calls,
					});
					if child.kind() == "new_expression" {
						refs.push(ExtractedReference {
							target_name: format!("{name}.constructor"),
							edge_kind:   EdgeKind::Calls,
						});
					}
				}
			}
		},
		_ => {},
	});
	dedupe_references(refs)
}

fn collect_heritage_references(node: Node<'_>, source: &str) -> Vec<ExtractedReference> {
	let mut refs = Vec::new();
	visit_named(node, &mut |child| {
		// PLAN-318 W2: differentiate `extends` (Inherits) from `implements`
		// (Implements). Earlier code conflated both into Inherits, making it
		// impossible to ask "who implements this interface?" via the graph.
		let edge_for_clause = match child.kind() {
			"extends_clause" | "extends_type_clause" => EdgeKind::Inherits,
			"implements_clause" => EdgeKind::Implements,
			_ => return,
		};
		let mut clause_cursor = child.walk();
		for clause_child in child.named_children(&mut clause_cursor) {
			collect_heritage_from_type(clause_child, source, &mut refs, edge_for_clause);
		}
	});
	dedupe_references(refs)
}

fn collect_heritage_from_type(
	node: Node<'_>,
	source: &str,
	refs: &mut Vec<ExtractedReference>,
	edge: EdgeKind,
) {
	match node.kind() {
		"type_identifier" | "identifier" | "nested_type_identifier" => {
			let target_name = node_text(node, source);
			if !target_name.is_empty() {
				refs.push(ExtractedReference { target_name, edge_kind: edge });
			}
		},
		"type_arguments" | "type_parameters" => {
			for name in collect_identifier_names(node, source) {
				refs.push(ExtractedReference {
					target_name: name,
					edge_kind:   EdgeKind::TypeParameterOf,
				});
			}
		},
		"generic_type" => {
			let mut cursor = node.walk();
			for child in node.named_children(&mut cursor) {
				collect_heritage_from_type(child, source, refs, edge);
			}
		},
		_ => {
			let mut cursor = node.walk();
			for child in node.named_children(&mut cursor) {
				collect_heritage_from_type(child, source, refs, edge);
			}
		},
	}
}

fn collect_target_names(node: Node<'_>, source: &str) -> Vec<String> {
	match node.kind() {
		"identifier" | "property_identifier" | "private_property_identifier" | "type_identifier" => {
			vec![node_text(node, source)]
		},
		"member_expression" => node
			.child_by_field_name("property")
			.map(|property| vec![node_text(property, source)])
			.unwrap_or_default(),
		"subscript_expression" => Vec::new(),
		_ => {
			let mut names = Vec::new();
			let mut cursor = node.walk();
			for child in node.named_children(&mut cursor) {
				names.extend(collect_target_names(child, source));
			}
			names
		},
	}
}

fn collect_identifier_names(node: Node<'_>, source: &str) -> Vec<String> {
	let mut names = Vec::new();
	collect_identifier_names_into(node, source, &mut names);
	let mut seen = BTreeSet::new();
	names
		.into_iter()
		.filter(|name| seen.insert(name.clone()))
		.collect()
}

fn collect_identifier_names_into(node: Node<'_>, source: &str, names: &mut Vec<String>) {
	match node.kind() {
		"nested_type_identifier" => {
			let name = node_text(node, source);
			if !name.is_empty() {
				names.push(name);
			}
		},
		"identifier" | "property_identifier" | "type_identifier" => {
			let name = node_text(node, source);
			if !name.is_empty() {
				names.push(name);
			}
		},
		_ => {
			let mut cursor = node.walk();
			for child in node.named_children(&mut cursor) {
				collect_identifier_names_into(child, source, names);
			}
		},
	}
}

fn visit_named(node: Node<'_>, visitor: &mut impl FnMut(Node<'_>)) {
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		visitor(child);
		visit_named(child, visitor);
	}
}

fn dedupe_references(refs: Vec<ExtractedReference>) -> Vec<ExtractedReference> {
	let mut seen = BTreeSet::new();
	refs
		.into_iter()
		.filter(|reference| seen.insert((reference.target_name.clone(), reference.edge_kind)))
		.collect()
}

fn named_child<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
	let mut cursor = node.walk();
	node
		.named_children(&mut cursor)
		.find(|child| child.kind() == kind)
}

fn node_text(node: Node<'_>, source: &str) -> String {
	node
		.utf8_text(source.as_bytes())
		.unwrap_or("")
		.trim()
		.to_string()
}

fn parse_string_literal(node: Node<'_>, source: &str) -> String {
	node_text(node, source)
		.trim_matches('"')
		.trim_matches('`')
		.trim_matches('\'')
		.to_string()
}

fn signature_snippet(node: Node<'_>, source: &str) -> String {
	node_text(node, source)
		.lines()
		.next()
		.unwrap_or_default()
		.trim()
		.to_string()
}

fn qualified_name(path: &Path, segments: &[&str]) -> String {
	let joined = segments.join(".");
	format!("{}::{joined}", path.display())
}

fn is_declaration_kind(kind: &str) -> bool {
	matches!(
		kind,
		"function_declaration"
			| "generator_function_declaration"
			| "class_declaration"
			| "abstract_class_declaration"
			| "interface_declaration"
			| "type_alias_declaration"
			| "enum_declaration"
			| "lexical_declaration"
			| "variable_declaration"
	)
}

fn is_javascript(path: &Path) -> bool {
	matches!(
		path.extension().and_then(|extension| extension.to_str()),
		Some("js" | "jsx" | "mjs" | "cjs")
	)
}

fn is_tsx(path: &Path) -> bool {
	matches!(path.extension().and_then(|extension| extension.to_str()), Some("tsx" | "jsx"))
}

fn fallback_relative_path(
	project_root: &Path,
	from_file: &Path,
	specifier: &str,
) -> Option<PathBuf> {
	if !specifier.starts_with('.') {
		return None;
	}
	let base = project_root.join(from_file).parent()?.to_path_buf();
	let direct = base.join(specifier);
	resolve_candidate(direct)
}

fn resolve_candidate(path: PathBuf) -> Option<PathBuf> {
	if path.is_file() {
		return Some(path);
	}
	for extension in ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] {
		let candidate = path.with_extension(extension);
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	for index_name in [
		"index.ts",
		"index.tsx",
		"index.mts",
		"index.cts",
		"index.js",
		"index.jsx",
		"index.mjs",
		"index.cjs",
	] {
		let candidate = path.join(index_name);
		if candidate.is_file() {
			return Some(candidate);
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;
	use crate::{
		cache::CacheStore,
		indexer::{BuildGraphOptions, CodeGraphBuilder},
		language::LanguageRegistry,
	};

	fn new_temp_project(prefix: &str) -> PathBuf {
		std::env::temp_dir().join(format!("{prefix}-{}", std::process::id()))
	}

	#[test]
	fn typescript_extractor_collects_named_imports_and_calls() {
		let extractor = TypeScriptExtractor;
		let source = r#"
import { alpha as beta } from "./dep";
export class Runner implements AgentTool<typeof schema> {
    run() {
        return beta();
    }
}
"#;
		let file = extractor
			.extract(Path::new("runner.ts"), source)
			.expect("extract should succeed");
		assert_eq!(file.imports.len(), 1);
		assert_eq!(file.imports[0].bindings[0].imported_name, "alpha");
		assert_eq!(file.imports[0].bindings[0].local_name, "beta");
		assert!(
			file
				.symbols
				.iter()
				.any(|symbol| symbol.name == "Runner" && symbol.exported)
		);
		assert!(file.symbols.iter().any(|symbol| {
			symbol.name == "run"
				&& symbol
					.references
					.iter()
					.any(|reference| reference.target_name == "beta")
		}));
		// PLAN-318 W2: `implements AgentTool<…>` now produces an
		// Implements edge (not Inherits, which is reserved for `extends`).
		assert!(file.symbols.iter().any(|symbol| {
			symbol.name == "Runner"
				&& symbol.references.iter().any(|reference| {
					reference.target_name == "AgentTool" && reference.edge_kind == EdgeKind::Implements
				})
		}));
	}

	#[test]
	fn typescript_extractor_marks_type_only_imports() {
		let extractor = TypeScriptExtractor;
		let file = extractor
			.extract(
				Path::new("imports.ts"),
				r#"
				import type { Foo } from "./foo";
				import { Bar } from "./bar";
				"#,
			)
			.expect("extract should succeed");

		assert!(
			file
				.imports
				.iter()
				.any(|import| import.specifier == "./foo" && import.is_type_only)
		);
		assert!(
			file
				.imports
				.iter()
				.any(|import| import.specifier == "./bar" && !import.is_type_only)
		);
	}

	#[test]
	fn implements_clause_emits_implements_edge_not_inherits() {
		// PLAN-318 W2: `class Foo implements I` must emit Implements,
		// not Inherits. Inherits is reserved for `extends`.
		let extractor = TypeScriptExtractor;
		let file = extractor
			.extract(
				Path::new("impl.ts"),
				r#"export class Foo implements IThing, JThing {}"#,
			)
			.expect("extract should succeed");
		let foo = file
			.symbols
			.iter()
			.find(|s| s.name == "Foo")
			.expect("Foo symbol should exist");
		assert!(foo.references.iter().any(|r| r.target_name == "IThing"
			&& r.edge_kind == EdgeKind::Implements));
		assert!(foo.references.iter().any(|r| r.target_name == "JThing"
			&& r.edge_kind == EdgeKind::Implements));
		assert!(
			!foo.references.iter().any(|r| r.edge_kind == EdgeKind::Inherits),
			"implements must not emit Inherits"
		);
	}

	#[test]
	fn heritage_distinguishes_base_from_type_param() {
		let extractor = TypeScriptExtractor;
		let file = extractor
			.extract(
				Path::new("heritage.ts"),
				r#"
				import { Bar, Baz, Qux } from "./dep";
				export class Foo extends Bar<Baz> implements Qux {}
				"#,
			)
			.expect("extract should succeed");
		let foo = file
			.symbols
			.iter()
			.find(|symbol| symbol.name == "Foo")
			.expect("Foo symbol should exist");

		assert!(foo.references.iter().any(|reference| {
			reference.target_name == "Bar" && reference.edge_kind == EdgeKind::Inherits
		}));
		// PLAN-318 W2: implements clause → Implements (not Inherits).
		assert!(foo.references.iter().any(|reference| {
			reference.target_name == "Qux" && reference.edge_kind == EdgeKind::Implements
		}));
		assert!(foo.references.iter().any(|reference| {
			reference.target_name == "Baz" && reference.edge_kind == EdgeKind::TypeParameterOf
		}));
		assert!(!foo.references.iter().any(|reference| {
			reference.target_name == "Baz" && reference.edge_kind == EdgeKind::Inherits
		}));
	}

	#[test]
	fn heritage_handles_plain_extends_without_generics() {
		let extractor = TypeScriptExtractor;
		let file = extractor
			.extract(Path::new("plain.ts"), r#"export class Child extends Parent {}"#)
			.expect("extract should succeed");
		let child = file
			.symbols
			.iter()
			.find(|symbol| symbol.name == "Child")
			.expect("Child symbol should exist");

		assert!(child.references.iter().any(|reference| {
			reference.target_name == "Parent" && reference.edge_kind == EdgeKind::Inherits
		}));
		assert!(
			!child
				.references
				.iter()
				.any(|reference| { reference.edge_kind == EdgeKind::TypeParameterOf })
		);
	}

	#[test]
	fn interface_extends_type_clause_separates_params() {
		let extractor = TypeScriptExtractor;
		let file = extractor
			.extract(
				Path::new("wrapper.ts"),
				r#"export interface Wrapper<T> extends Base<T, string> {}"#,
			)
			.expect("extract should succeed");
		let wrapper = file
			.symbols
			.iter()
			.find(|symbol| symbol.name == "Wrapper")
			.expect("Wrapper symbol should exist");

		assert!(wrapper.references.iter().any(|reference| {
			reference.target_name == "Base" && reference.edge_kind == EdgeKind::Inherits
		}));
		assert!(wrapper.references.iter().any(|reference| {
			reference.target_name == "T" && reference.edge_kind == EdgeKind::TypeParameterOf
		}));
		assert!(
			!wrapper
				.references
				.iter()
				.any(|reference| reference.target_name == "string")
		);
	}

	#[test]
	fn new_expression_creates_constructor_reference() {
		let extractor = TypeScriptExtractor;
		let file = extractor
			.extract(
				Path::new("new-expression.ts"),
				r#"
				class Runner { constructor() {} }
				function run() { return new Runner(); }
				"#,
			)
			.expect("extract should succeed");
		let run = file
			.symbols
			.iter()
			.find(|symbol| symbol.name == "run")
			.expect("run symbol should exist");

		assert!(run.references.iter().any(|reference| {
			reference.target_name == "Runner" && reference.edge_kind == EdgeKind::Calls
		}));
		assert!(run.references.iter().any(|reference| {
			reference.target_name == "Runner.constructor" && reference.edge_kind == EdgeKind::Calls
		}));
	}

	#[test]
	fn typescript_resolver_resolves_relative_imports() {
		let root = new_temp_project("pi-code-graph-ts-resolve");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(
			root.join("caller.ts"),
			"import { dep } from './dep';\nexport const caller = dep;\n",
		)
		.expect("caller file should be written");
		fs::write(root.join("dep.ts"), "export const dep = 1;\n")
			.expect("dep file should be written");

		let resolved = TypeScriptImportResolver
			.resolve(ResolveRequest {
				project_root: &root,
				from_file:    Path::new("caller.ts"),
				specifier:    "./dep",
			})
			.expect("resolver should succeed");
		assert_eq!(resolved, Some(PathBuf::from("dep.ts")));
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn typescript_resolver_falls_back_when_resolver_panics() {
		let root = new_temp_project("pi-code-graph-ts-panic-fallback");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(
			root.join("caller.ts"),
			"import { dep } from './dep';\nexport const caller = dep;\n",
		)
		.expect("caller file should be written");
		fs::write(root.join("dep.ts"), "export const dep = 1;\n")
			.expect("dep file should be written");

		let resolved = resolve_import_path(
			ResolveRequest {
				project_root: &root,
				from_file:    Path::new("caller.ts"),
				specifier:    "./dep",
			},
			|_, _, _| panic!("resolver panic"),
		);
		assert_eq!(resolved, Some(PathBuf::from("dep.ts")));
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn typescript_builder_resolves_relative_import_edges() {
		let root = new_temp_project("pi-code-graph-ts-builder-imports");
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(
			root.join("caller.ts"),
			"import { callee } from './callee';\nexport function caller() {\n  return callee();\n}\n",
		)
		.expect("caller file should be written");
		fs::write(root.join("callee.ts"), "export function callee() {\n  return 'ok';\n}\n")
			.expect("callee file should be written");

		let registry = LanguageRegistry::new()
			.with_typescript()
			.expect("registry should build");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(&cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("typescript graph should build");

		assert_eq!(outcome.graph.count_edges(EdgeKind::Imports), 1);
		assert_eq!(outcome.graph.count_edges(EdgeKind::Calls), 1);
		assert!(
			outcome
				.graph
				.symbol_names()
				.iter()
				.any(|name| name.ends_with("caller.ts::caller"))
		);
		assert!(
			outcome
				.graph
				.symbol_names()
				.iter()
				.any(|name| name.ends_with("callee.ts::callee"))
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	#[ignore = "stale: asserted on packages/coding-agent/src/tools/code.ts::CodeTool, but PLAN-306 split code.ts into find/get/edit/create/manage. Update assertion to a current tool symbol when revisiting."]
	fn typescript_builder_indexes_spell_tool_surface() {
		let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
			.parent()
			.and_then(Path::parent)
			.expect("repo root should exist")
			.join("packages/coding-agent/src/tools");
		let cache_dir = std::env::temp_dir().join(format!("pi-code-graph-ts-{}", std::process::id()));
		let registry = LanguageRegistry::new()
			.with_typescript()
			.expect("registry should build");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(&cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("spell tools graph should build");
		assert!(
			outcome
				.graph
				.symbol_names()
				.iter()
				.any(|name| name.ends_with("code.ts::CodeTool"))
		);
		assert!(outcome.graph.count_edges(EdgeKind::Imports) > 0);
		let _ = std::fs::remove_dir_all(cache_dir);
	}
}
