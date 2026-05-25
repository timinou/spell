use std::{
	collections::{BTreeMap, BTreeSet},
	fs,
	path::{Path, PathBuf},
};

use regex::Regex;
use tree_sitter::Parser;

use crate::{
	error::{CodeGraphError, Result},
	language::{
		ExtractedFile, ExtractedImport, ExtractedImportBinding, ExtractedReference, ExtractedSymbol,
		ImportResolver, LanguageExtractor, ResolveRequest, SupportedLanguage,
	},
	model::{EdgeKind, SymbolKind},
};

const CLOJURE_LANGUAGE: &str = "clojure";
const CLOJURE_EXTENSIONS: &[&str] = &["clj", "cljs", "cljc", "bb"];
const DEFAULT_ROOTS: &[&str] = &["src", "test", "dev", "resources"];

#[derive(Clone, Default)]
pub struct ClojureExtractor;

#[derive(Clone, Default)]
pub struct ClojureImportResolver;

#[derive(Debug, Clone)]
struct NamespaceInfo {
	name:    String,
	imports: Vec<ExtractedImport>,
	aliases: BTreeMap<String, String>,
	refers:  BTreeMap<String, String>,
}

impl LanguageExtractor for ClojureExtractor {
	fn language(&self) -> SupportedLanguage {
		SupportedLanguage::new(CLOJURE_LANGUAGE)
	}

	fn matches_path(&self, path: &Path) -> bool {
		path
			.extension()
			.and_then(|extension| extension.to_str())
			.is_some_and(|extension| CLOJURE_EXTENSIONS.contains(&extension))
	}

	fn extract(&self, path: &Path, source: &str) -> Result<ExtractedFile> {
		let mut parser = Parser::new();
		parser
			.set_language(&tree_sitter_clojure::LANGUAGE.into())
			.map_err(|error| CodeGraphError::Parse {
				language: CLOJURE_LANGUAGE.into(),
				path:     path.to_path_buf(),
				message:  error.to_string(),
			})?;
		parser
			.parse(source, None)
			.ok_or_else(|| CodeGraphError::Parse {
				language: CLOJURE_LANGUAGE.into(),
				path:     path.to_path_buf(),
				message:  "parser returned no tree".into(),
			})?;

		let namespace = extract_namespace(source).unwrap_or_else(|| NamespaceInfo {
			name:    namespace_from_path(path),
			imports: Vec::new(),
			aliases: BTreeMap::new(),
			refers:  BTreeMap::new(),
		});
		let mut symbols = vec![ExtractedSymbol {
			name:           namespace.name.clone(),
			qualified_name: qualified_name(path, &namespace.name),
			kind:           SymbolKind::Namespace,
			exported:       true,
			line:           line_column(source, source.find(&namespace.name).unwrap_or(0)).0,
			column:         line_column(source, source.find(&namespace.name).unwrap_or(0)).1,
			detail:         Some(format!("ns {}", namespace.name)),
			references:     Vec::new(),
		}];
		symbols.extend(extract_definitions(path, source, &namespace));
		symbols.extend(extract_keywords(path, source, &namespace.name));

		Ok(ExtractedFile {
			path: path.to_path_buf(),
			language: self.language(),
			symbols,
			imports: namespace.imports,
		})
	}
}

impl ImportResolver for ClojureImportResolver {
	fn language(&self) -> SupportedLanguage {
		SupportedLanguage::new(CLOJURE_LANGUAGE)
	}

	fn resolve(&self, request: ResolveRequest<'_>) -> Result<Option<PathBuf>> {
		let roots = discover_source_roots(request.project_root);
		let namespace_path = namespace_to_path(request.specifier);
		let extensions = ["clj", "cljc", "cljs", "bb"];
		for root in roots {
			for extension in extensions {
				let candidate = request
					.project_root
					.join(&root)
					.join(&namespace_path)
					.with_extension(extension);
				if candidate.is_file() {
					return Ok(candidate
						.strip_prefix(request.project_root)
						.ok()
						.map(Path::to_path_buf));
				}
			}
		}
		Ok(None)
	}
}

fn extract_namespace(source: &str) -> Option<NamespaceInfo> {
	let ns_start = source.find("(ns ")?;
	let ns_form = balanced_slice(&source[ns_start..])?;
	let name_re = Regex::new(r"\(ns\s+([^\s\)]+)").expect("valid ns regex");
	let name = name_re.captures(ns_form)?.get(1)?.as_str().to_string();
	let mut imports = Vec::new();
	let mut aliases = BTreeMap::new();
	let mut refers = BTreeMap::new();
	let require_re = Regex::new(r"\[\s*([^\s\]\)]+)([^\]]*)\]").expect("valid require regex");
	let as_re = Regex::new(r":as\s+([^\s\]\)]+)").expect("valid alias regex");
	let refer_re = Regex::new(r":refer\s+\[([^\]]*)\]").expect("valid refer regex");
	for capture in require_re.captures_iter(ns_form) {
		let Some(specifier) = capture.get(1).map(|value| value.as_str().to_string()) else {
			continue;
		};
		if specifier.starts_with(':') {
			continue;
		}
		let tail = capture.get(2).map_or("", |value| value.as_str());
		let mut bindings = Vec::new();
		if let Some(alias) = as_re.captures(tail).and_then(|alias| alias.get(1)) {
			let alias = alias.as_str().to_string();
			aliases.insert(alias.clone(), specifier.clone());
			bindings.push(ExtractedImportBinding {
				imported_name: specifier.clone(),
				local_name:    alias,
			});
		}
		if let Some(referred) = refer_re.captures(tail).and_then(|refer| refer.get(1)) {
			for local in referred
				.as_str()
				.split_whitespace()
				.filter(|item| *item != ":all")
			{
				refers.insert(local.to_string(), specifier.clone());
				bindings.push(ExtractedImportBinding {
					imported_name: local.to_string(),
					local_name:    local.to_string(),
				});
			}
		}
		if bindings.is_empty() {
			bindings.push(ExtractedImportBinding {
				imported_name: specifier.clone(),
				local_name:    specifier
					.rsplit('.')
					.next()
					.unwrap_or(&specifier)
					.to_string(),
			});
		}
  imports.push(ExtractedImport { specifier, bindings, is_type_only: false, is_reexport: false });
	}
	Some(NamespaceInfo { name, imports, aliases, refers })
}

fn extract_definitions(
	path: &Path,
	source: &str,
	namespace: &NamespaceInfo,
) -> Vec<ExtractedSymbol> {
	let def_re = Regex::new(r"(?m)^\s*\((defn-|defn|defmacro|defmulti|defmethod|defprotocol|defrecord|deftype|deftest|defonce|def)\s+([^\s\[\]\(\)]+)").expect("valid def regex");
	def_re
		.captures_iter(source)
		.filter_map(|capture| {
			let head = capture.get(1)?.as_str();
			let name = capture.get(2)?.as_str().to_string();
			let name_match = capture.get(2)?;
			let kind = match head {
				"defn" | "defn-" => SymbolKind::Function,
				"defmacro" => SymbolKind::Macro,
				"defmulti" => SymbolKind::Multimethod,
				"defmethod" => SymbolKind::Method,
				"defprotocol" => SymbolKind::Protocol,
				"defrecord" => SymbolKind::Record,
				"deftype" => SymbolKind::TypeAlias,
				"deftest" => SymbolKind::Test,
				_ => SymbolKind::Var,
			};
			let (line, column) = line_column(source, name_match.start());
			Some(ExtractedSymbol {
				name: name.clone(),
				qualified_name: qualified_name(path, &format!("{}/{}", namespace.name, name)),
				kind,
				exported: head != "defn-",
				line,
				column,
				detail: Some(format!("{head} {name}")),
				references: collect_references(source, namespace),
			})
		})
		.collect()
}

fn extract_keywords(path: &Path, source: &str, namespace: &str) -> Vec<ExtractedSymbol> {
	let keyword_re = Regex::new(r":{1,2}[A-Za-z0-9_\-.!?'*+]+(?:/[A-Za-z0-9_\-.!?'*+]+)?")
		.expect("valid keyword regex");
	let mut seen = BTreeSet::new();
	keyword_re
		.find_iter(source)
		.filter_map(|match_| {
			let name = match_.as_str().to_string();
			if !seen.insert(name.clone()) {
				return None;
			}
			let (line, column) = line_column(source, match_.start());
			Some(ExtractedSymbol {
				name: name.clone(),
				qualified_name: qualified_name(path, &format!("{namespace}/{name}")),
				kind: SymbolKind::Keyword,
				exported: false,
				line,
				column,
				detail: Some("keyword reference".into()),
				references: Vec::new(),
			})
		})
		.collect()
}

fn collect_references(source: &str, namespace: &NamespaceInfo) -> Vec<ExtractedReference> {
	let mut refs = Vec::new();
	let alias_re = Regex::new(r"\b([A-Za-z0-9_\-.!*+?]+)/(\S+)").expect("valid alias ref regex");
	for capture in alias_re.captures_iter(source) {
		let alias = capture
			.get(1)
			.map(|value| value.as_str())
			.unwrap_or_default();
		let member = capture
			.get(2)
			.map(|value| value.as_str().trim_matches(')'))
			.unwrap_or_default();
		if namespace.aliases.contains_key(alias) {
			refs.push(ExtractedReference {
				target_name: format!("{alias}/{member}"),
				edge_kind:   EdgeKind::Calls,
			});
		}
	}
	for local in namespace.refers.keys() {
		if source.contains(local) {
			refs
				.push(ExtractedReference { target_name: local.clone(), edge_kind: EdgeKind::Refers });
		}
	}
	let keyword_re = Regex::new(r":{1,2}[A-Za-z0-9_\-.!?'*+]+(?:/[A-Za-z0-9_\-.!?'*+]+)?")
		.expect("valid keyword regex");
	for match_ in keyword_re.find_iter(source) {
		refs.push(ExtractedReference {
			target_name: match_.as_str().to_string(),
			edge_kind:   EdgeKind::UsesKeyword,
		});
	}
	dedupe_references(refs)
}

fn dedupe_references(refs: Vec<ExtractedReference>) -> Vec<ExtractedReference> {
	let mut seen = BTreeSet::new();
	refs
		.into_iter()
		.filter(|reference| seen.insert((reference.target_name.clone(), reference.edge_kind)))
		.collect()
}

fn balanced_slice(text: &str) -> Option<&str> {
	let mut depth = 0_i32;
	let mut in_string = false;
	let mut escaped = false;
	for (index, ch) in text.char_indices() {
		if in_string {
			if escaped {
				escaped = false;
			} else if ch == '\\' {
				escaped = true;
			} else if ch == '"' {
				in_string = false;
			}
			continue;
		}
		match ch {
			'"' => in_string = true,
			'(' => depth += 1,
			')' => {
				depth -= 1;
				if depth == 0 {
					return text.get(..=index);
				}
			},
			_ => {},
		}
	}
	None
}

fn namespace_from_path(path: &Path) -> String {
	path
		.with_extension("")
		.components()
		.filter_map(|component| component.as_os_str().to_str())
		.skip_while(|part| matches!(*part, "src" | "test" | "dev"))
		.map(|part| part.replace('_', "-"))
		.collect::<Vec<_>>()
		.join(".")
}

fn namespace_to_path(namespace: &str) -> PathBuf {
	namespace
		.split('.')
		.map(|segment| segment.replace('-', "_"))
		.collect()
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
	fn resolver_maps_namespace_to_source_root_path() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-clojure-resolver-{}", std::process::id()));
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src/foo")).expect("src dir");
		fs::write(root.join("deps.edn"), r#"{:paths ["src" "test"]}"#).expect("deps");
		fs::write(root.join("src/foo/bar_baz.clj"), "(ns foo.bar-baz)").expect("source");
		let resolver = ClojureImportResolver;
		let resolved = resolver
			.resolve(ResolveRequest {
				project_root: &root,
				from_file:    Path::new("src/app/core.clj"),
				specifier:    "foo.bar-baz",
			})
			.unwrap();
		assert_eq!(resolved, Some(PathBuf::from("src/foo/bar_baz.clj")));
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn extractor_indexes_namespace_defs_requires_and_keywords() {
		let source = r#"(ns app.core
  (:require [app.db :as db]
            [app.protocols :refer [fetch!]]))

(defn normalize-name [s]
  (db/connect!)
  (fetch! s)
  {:user/id s})

(defprotocol Store
  (fetch [this id]))

(deftest normalize-name-test
  (normalize-name "Ada"))
"#;
		let extractor = ClojureExtractor;
		let file = extractor
			.extract(Path::new("src/app/core.clj"), source)
			.unwrap();
		assert!(
			file
				.imports
				.iter()
				.any(|import| import.specifier == "app.db")
		);
		assert!(
			file
				.symbols
				.iter()
				.any(|symbol| symbol.name == "app.core" && symbol.kind == SymbolKind::Namespace)
		);
		assert!(
			file
				.symbols
				.iter()
				.any(|symbol| symbol.qualified_name == "src/app/core.clj::app.core/normalize-name")
		);
		assert!(
			file
				.symbols
				.iter()
				.any(|symbol| symbol.name == "Store" && symbol.kind == SymbolKind::Protocol)
		);
		assert!(
			file
				.symbols
				.iter()
				.any(|symbol| symbol.name == ":user/id" && symbol.kind == SymbolKind::Keyword)
		);
		let normalize = file
			.symbols
			.iter()
			.find(|symbol| symbol.name == "normalize-name")
			.expect("normalize symbol");
		assert!(
			normalize
				.references
				.iter()
				.any(|reference| reference.target_name == "db/connect!")
		);
		assert!(
			normalize
				.references
				.iter()
				.any(|reference| reference.edge_kind == EdgeKind::UsesKeyword)
		);
	}

	#[test]
	fn builder_registers_clojure_and_excludes_edn_graph_language() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-clojure-builder-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src/app")).expect("src dir");
		fs::write(root.join("deps.edn"), r#"{:paths ["src"]}"#).expect("deps");
		fs::write(root.join("src/app/db.clj"), "(ns app.db)\n(defn connect! [] nil)\n").expect("db");
		fs::write(
			root.join("src/app/core.clj"),
			"(ns app.core (:require [app.db :as db]))\n(defn run [] (db/connect!))\n",
		)
		.expect("core");
		fs::write(root.join("src/app/config.edn"), "{:app/name \"demo\"}\n").expect("edn");
		let registry = LanguageRegistry::new().with_defaults().expect("defaults");
		assert!(registry.match_path(Path::new("src/app/core.clj")).is_some());
		assert!(
			registry
				.match_path(Path::new("src/app/config.edn"))
				.is_none()
		);
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("graph build");
		assert_eq!(outcome.graph.stats().language_counts.get("edn"), None);
		assert!(
			outcome
				.graph
				.stats()
				.language_counts
				.get("clojure")
				.is_some()
		);
		assert!(outcome.graph.count_edges(EdgeKind::Requires) >= 1);
		let _ = fs::remove_dir_all(root);
	}
}

fn discover_source_roots(project_root: &Path) -> Vec<PathBuf> {
	let mut roots = BTreeSet::<PathBuf>::new();
	if let Ok(content) = fs::read_to_string(project_root.join("deps.edn")) {
		collect_edn_paths(&content, &mut roots);
	}
	if let Ok(content) = fs::read_to_string(project_root.join("project.clj")) {
		collect_project_paths(&content, &mut roots);
	}
	if roots.is_empty() {
		roots.extend(DEFAULT_ROOTS.iter().map(PathBuf::from));
	}
	roots.into_iter().collect()
}

fn collect_edn_paths(content: &str, roots: &mut BTreeSet<PathBuf>) {
	let paths_re = Regex::new(r":(?:extra-)?paths\s+\[([^\]]*)\]").expect("valid deps paths regex");
	let str_re = Regex::new(r#""([^"]+)""#).expect("valid string regex");
	for capture in paths_re.captures_iter(content) {
		if let Some(items) = capture.get(1) {
			roots.extend(
				str_re
					.captures_iter(items.as_str())
					.filter_map(|item| item.get(1))
					.map(|item| PathBuf::from(item.as_str())),
			);
		}
	}
}

fn collect_project_paths(content: &str, roots: &mut BTreeSet<PathBuf>) {
	let paths_re =
		Regex::new(r":(?:source|test)-paths\s+\[([^\]]*)\]").expect("valid project paths regex");
	let str_re = Regex::new(r#""([^"]+)""#).expect("valid string regex");
	for capture in paths_re.captures_iter(content) {
		if let Some(items) = capture.get(1) {
			roots.extend(
				str_re
					.captures_iter(items.as_str())
					.filter_map(|item| item.get(1))
					.map(|item| PathBuf::from(item.as_str())),
			);
		}
	}
}

fn qualified_name(path: &Path, name: &str) -> String {
	format!("{}::{name}", path.display())
}

fn line_column(source: &str, byte: usize) -> (u32, u32) {
	let mut line = 1_u32;
	let mut column = 1_u32;
	for (idx, ch) in source.char_indices() {
		if idx >= byte {
			break;
		}
		if ch == '\n' {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	(line, column)
}
