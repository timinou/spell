use std::{
	collections::BTreeSet,
	path::{Path, PathBuf},
};

use regex::Regex;
use tree_sitter::{Node, Parser};

use crate::{
	error::{CodeGraphError, Result},
	language::{
		ExtractedFile, ExtractedImport, ExtractedImportBinding, ExtractedReference, ExtractedSymbol,
		ImportResolver, LanguageExtractor, ResolveRequest, SupportedLanguage,
	},
	model::{EdgeKind, SymbolKind},
};

const ELIXIR_LANGUAGE: &str = "elixir";
const ELIXIR_EXTENSIONS: &[&str] = &["ex", "exs", "heex"];

#[derive(Clone, Default)]
pub struct ElixirExtractor;

#[derive(Clone, Default)]
pub struct ElixirImportResolver;

impl LanguageExtractor for ElixirExtractor {
	fn language(&self) -> SupportedLanguage {
		SupportedLanguage::new(ELIXIR_LANGUAGE)
	}

	fn matches_path(&self, path: &Path) -> bool {
		path
			.extension()
			.and_then(|extension| extension.to_str())
			.is_some_and(|extension| ELIXIR_EXTENSIONS.contains(&extension))
	}

	fn extract(&self, path: &Path, source: &str) -> Result<ExtractedFile> {
		if path.extension().and_then(|extension| extension.to_str()) == Some("heex") {
			return extract_heex_file(path, source);
		}
		extract_elixir_file(path, source)
	}
}

impl ImportResolver for ElixirImportResolver {
	fn language(&self) -> SupportedLanguage {
		SupportedLanguage::new(ELIXIR_LANGUAGE)
	}

	fn resolve(&self, request: ResolveRequest<'_>) -> Result<Option<PathBuf>> {
		let base_path = module_name_to_path(request.specifier);
		let mut candidates = Vec::with_capacity(8);
		if request.project_root.join("mix.exs").is_file() {
			let lib_base = request.project_root.join("lib").join(&base_path);
			candidates.push(lib_base.with_extension("ex"));
			candidates.push(lib_base.with_extension("exs"));
			candidates.push(lib_base.join("index.ex"));
			candidates.push(lib_base.join("index.exs"));
		}
		let root_base = request.project_root.join(&base_path);
		candidates.push(root_base.with_extension("ex"));
		candidates.push(root_base.with_extension("exs"));
		candidates.push(root_base.join("index.ex"));
		candidates.push(root_base.join("index.exs"));
		Ok(candidates
			.into_iter()
			.find(|candidate| candidate.is_file())
			.and_then(|candidate| {
				candidate
					.strip_prefix(request.project_root)
					.ok()
					.map(Path::to_path_buf)
			}))
	}
}

#[allow(
	clippy::collapsible_if,
	clippy::double_ended_iterator_last,
	clippy::map_unwrap_or,
	clippy::unnecessary_wraps,
	reason = "Regex-based extractor favors straightforward control flow over micro-lint rewrites"
)]
fn extract_elixir_file(path: &Path, source: &str) -> Result<ExtractedFile> {
	let module_re = Regex::new(r"^\s*defmodule\s+([A-Z][A-Za-z0-9_\.]*)").expect("valid regex");
	let function_re =
		Regex::new(r"^\s*def(?:p|macro|macrop|guard|guardp)?\s+([a-z_][A-Za-z0-9_!?]*)")
			.expect("valid regex");
	let alias_re = Regex::new(
		r"^\s*(alias|import|use)\s+([A-Z][A-Za-z0-9_\.]*)(?:,\s+as:\s+([A-Z][A-Za-z0-9_]*))?",
	)
	.expect("valid regex");
	let bare_call_re = Regex::new(r"\b([a-z_][A-Za-z0-9_!?]*)\s*\(").expect("valid regex");
	let remote_call_re =
		Regex::new(r"\b([A-Z][A-Za-z0-9_]*)\.([a-z_][A-Za-z0-9_!?]*)\s*\(").expect("valid regex");

	let mut module_name: Option<String> = None;
	let mut symbols = Vec::new();
	let mut imports = Vec::new();
	let mut current_function: Option<ExtractedSymbol> = None;
	let mut block_depth = 0_i32;

	for (line_index, line) in source.lines().enumerate() {
		if module_name.is_none() {
			if let Some(captures) = module_re.captures(line) {
				let name = captures[1].to_string();
				module_name = Some(name.clone());
				symbols.push(ExtractedSymbol {
					name:           name.clone(),
					qualified_name: qualified_name(path, &[&name]),
					kind:           SymbolKind::Module,
					exported:       true,
					line:           line_index as u32 + 1,
					column:         line.find(&name).unwrap_or(0) as u32 + 1,
					detail:         Some(line.trim().to_string()),
					references:     Vec::new(),
				});
				continue;
			}
		}

		if let Some(captures) = alias_re.captures(line) {
			let full_name = captures[2].to_string();
			let local_name = captures
				.get(3)
				.map(|alias| alias.as_str().to_string())
				.unwrap_or_else(|| {
					full_name
						.split('.')
						.last()
						.unwrap_or(full_name.as_str())
						.to_string()
				});
			imports.push(ExtractedImport {
				specifier:    full_name.clone(),
				bindings:     vec![ExtractedImportBinding { imported_name: full_name, local_name }],
				is_type_only: false,
			});
		}

		if let Some(captures) = function_re.captures(line) {
			if let Some(function) = current_function.take() {
				symbols.push(function);
			}
			let name = captures[1].to_string();
			current_function = Some(ExtractedSymbol {
				name:           name.clone(),
				qualified_name: if let Some(module_name) = &module_name {
					qualified_name(path, &[module_name, &name])
				} else {
					qualified_name(path, &[&name])
				},
				kind:           SymbolKind::Function,
				exported:       !line.trim_start().starts_with("defp"),
				line:           line_index as u32 + 1,
				column:         line.find(&name).unwrap_or(0) as u32 + 1,
				detail:         Some(line.trim().to_string()),
				references:     Vec::new(),
			});
			block_depth = count_do_tokens(line) - count_end_tokens(line);
		}

		if let Some(function) = &mut current_function {
			for captures in remote_call_re.captures_iter(line) {
				let module_alias = captures[1].to_string();
				let function_name = captures[2].to_string();
				function.references.push(ExtractedReference {
					target_name: format!("{module_alias}.{function_name}"),
					edge_kind:   EdgeKind::Calls,
				});
			}
			for captures in bare_call_re.captures_iter(line) {
				let call_name = captures[1].to_string();
				if call_name == "do" || call_name == "end" {
					continue;
				}
				function
					.references
					.push(ExtractedReference { target_name: call_name, edge_kind: EdgeKind::Calls });
			}
			block_depth += count_do_tokens(line) - count_end_tokens(line);
			if block_depth <= 0 && line.trim() == "end" {
				let function = current_function.take().expect("function should exist");
				symbols.push(dedupe_symbol_references(function));
			}
		}
	}

	if let Some(function) = current_function.take() {
		symbols.push(dedupe_symbol_references(function));
	}

	Ok(ExtractedFile {
		path: path.to_path_buf(),
		language: SupportedLanguage::new(ELIXIR_LANGUAGE),
		symbols,
		imports,
	})
}

fn extract_heex_file(path: &Path, source: &str) -> Result<ExtractedFile> {
	let mut parser = Parser::new();
	parser
		.set_language(&tree_sitter_heex::LANGUAGE.into())
		.map_err(|error| CodeGraphError::Parse {
			language: ELIXIR_LANGUAGE.into(),
			path:     path.to_path_buf(),
			message:  error.to_string(),
		})?;
	let tree = parser
		.parse(source, None)
		.ok_or_else(|| CodeGraphError::Parse {
			language: ELIXIR_LANGUAGE.into(),
			path:     path.to_path_buf(),
			message:  "parser returned no tree".into(),
		})?;
	let root = tree.root_node();
	let template_name = path
		.file_stem()
		.and_then(|stem| stem.to_str())
		.unwrap_or("template");
	let mut references = Vec::new();
	visit_named(root, &mut |node| {
		if node.kind() == "component_name" || node.kind() == "tag_name" {
			let name = node_text(node, source);
			if !name.is_empty() && (name.contains('.') || name.starts_with('.')) {
				references.push(ExtractedReference {
					target_name: name.trim_start_matches('.').to_string(),
					edge_kind:   EdgeKind::Renders,
				});
			}
		}
	});
	Ok(ExtractedFile {
		path:     path.to_path_buf(),
		language: SupportedLanguage::new(ELIXIR_LANGUAGE),
		symbols:  vec![ExtractedSymbol {
			name:           template_name.to_string(),
			qualified_name: qualified_name(path, &[template_name]),
			kind:           SymbolKind::Template,
			exported:       true,
			line:           1,
			column:         1,
			detail:         Some(path.display().to_string()),
			references:     dedupe_references(references),
		}],
		imports:  Vec::new(),
	})
}

fn dedupe_symbol_references(mut symbol: ExtractedSymbol) -> ExtractedSymbol {
	symbol.references = dedupe_references(symbol.references);
	symbol
}

fn dedupe_references(refs: Vec<ExtractedReference>) -> Vec<ExtractedReference> {
	let mut seen = BTreeSet::new();
	refs
		.into_iter()
		.filter(|reference| seen.insert((reference.target_name.clone(), reference.edge_kind)))
		.collect()
}

fn visit_named(node: Node<'_>, visitor: &mut impl FnMut(Node<'_>)) {
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		visitor(child);
		visit_named(child, visitor);
	}
}

fn node_text(node: Node<'_>, source: &str) -> String {
	node
		.utf8_text(source.as_bytes())
		.unwrap_or("")
		.trim()
		.to_string()
}

fn qualified_name(path: &Path, segments: &[&str]) -> String {
	let joined = segments.join(".");
	format!("{}::{joined}", path.display())
}

fn count_do_tokens(line: &str) -> i32 {
	line
		.split_whitespace()
		.filter(|token| *token == "do")
		.count() as i32
}

fn count_end_tokens(line: &str) -> i32 {
	line
		.split_whitespace()
		.filter(|token| token.trim_end_matches(',') == "end")
		.count() as i32
}

fn module_name_to_path(module_name: &str) -> PathBuf {
	let mut path = PathBuf::new();
	for segment in module_name.split('.') {
		path.push(camel_to_snake(segment));
	}
	path
}

fn camel_to_snake(value: &str) -> String {
	let mut result = String::new();
	for (index, character) in value.chars().enumerate() {
		if character.is_uppercase() && index > 0 {
			result.push('_');
		}
		result.extend(character.to_lowercase());
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		cache::CacheStore,
		indexer::{BuildGraphOptions, CodeGraphBuilder},
		language::LanguageRegistry,
	};

	#[test]

	fn elixir_extractor_collects_modules_aliases_and_functions() {
		let extractor = ElixirExtractor;
		let source = r#"
defmodule MyApp.Runner do
  alias MyApp.Tools.Helper, as: Helper

  def run do
    Helper.work()
    local_call()
  end
end
"#;
		let file = extractor
			.extract(Path::new("runner.ex"), source)
			.expect("extract should succeed");
		assert!(
			file
				.symbols
				.iter()
				.any(|symbol| symbol.name == "MyApp.Runner")
		);
		assert!(
			file
				.imports
				.iter()
				.any(|import| import.specifier == "MyApp.Tools.Helper")
		);
		assert!(file.symbols.iter().any(|symbol| {
			symbol.name == "run"
				&& symbol
					.references
					.iter()
					.any(|reference| reference.target_name == "Helper.work")
				&& symbol
					.references
					.iter()
					.any(|reference| reference.target_name == "local_call")
		}));
	}

	#[test]
	fn elixir_heex_extractor_collects_component_references() {
		let extractor = ElixirExtractor;
		let source = r#"
<Layout.flash />
<.button>Save</.button>
"#;
		let file = extractor
			.extract(Path::new("show.html.heex"), source)
			.expect("extract should succeed");
		let template = file.symbols.first().expect("template symbol should exist");
		assert!(
			template
				.references
				.iter()
				.any(|reference| reference.target_name == "Layout.flash")
		);
		assert!(
			template
				.references
				.iter()
				.any(|reference| reference.target_name == "button")
		);
	}

	#[test]
	fn elixir_resolver_finds_modules_under_lib() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-elixir-lib-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		std::fs::create_dir_all(root.join("lib/my_app/tools")).expect("lib directory should exist");
		std::fs::write(root.join("mix.exs"), "defmodule MyApp.MixProject do end")
			.expect("mix file should be written");
		std::fs::write(
			root.join("lib/my_app/tools/helper.ex"),
			"defmodule MyApp.Tools.Helper do\nend\n",
		)
		.expect("helper file should be written");

		let resolver = ElixirImportResolver;
		let resolved = resolver
			.resolve(ResolveRequest {
				project_root: &root,
				from_file:    Path::new("lib/main.ex"),
				specifier:    "MyApp.Tools.Helper",
			})
			.expect("resolve should succeed");
		assert_eq!(resolved, Some(PathBuf::from("lib/my_app/tools/helper.ex")));
		let _ = std::fs::remove_dir_all(root);
	}

	#[test]
	fn elixir_resolver_falls_back_to_root_without_mix() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-elixir-root-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		std::fs::create_dir_all(root.join("my_app/tools")).expect("root directory should exist");
		std::fs::write(root.join("my_app/tools/helper.ex"), "defmodule MyApp.Tools.Helper do\nend\n")
			.expect("helper file should be written");

		let resolver = ElixirImportResolver;
		let resolved = resolver
			.resolve(ResolveRequest {
				project_root: &root,
				from_file:    Path::new("main.ex"),
				specifier:    "MyApp.Tools.Helper",
			})
			.expect("resolve should succeed");
		assert_eq!(resolved, Some(PathBuf::from("my_app/tools/helper.ex")));
		let _ = std::fs::remove_dir_all(root);
	}

	#[test]
	fn elixir_builder_resolves_lib_layout() {
		let root = std::env::temp_dir().join(format!("pi-code-graph-elixir-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		std::fs::create_dir_all(root.join("lib/my_app/tools")).expect("directory should exist");
		std::fs::write(root.join("mix.exs"), "defmodule MyApp.MixProject do end")
			.expect("mix file should be written");
		std::fs::write(
			root.join("lib/main.ex"),
			"defmodule MyApp.Runner do\n  alias MyApp.Tools.Helper, as: Helper\n\n  def run do\n    \
			 Helper.work()\n  end\nend\n",
		)
		.expect("main file should be written");
		std::fs::write(
			root.join("lib/my_app/tools/helper.ex"),
			"defmodule MyApp.Tools.Helper do\n  def work, do: :ok\nend\n",
		)
		.expect("helper file should be written");

		let registry = LanguageRegistry::new()
			.with_elixir()
			.expect("registry should build");
		let cache_dir = root.join("cache");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(&cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("graph should build");
		assert_eq!(outcome.graph.count_edges(EdgeKind::Imports), 1);
		assert!(outcome.graph.count_edges(EdgeKind::Calls) >= 1);
		let _ = std::fs::remove_dir_all(root);
	}
}
