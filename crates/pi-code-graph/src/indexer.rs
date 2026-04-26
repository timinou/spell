use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
};

use petgraph::{stable_graph::StableGraph, visit::NodeIndexable};

use crate::{
	cache::{
		CacheStatus, CacheStore, FileFingerprint, GraphCacheEntry, GraphFingerprint, read_git_head,
	},
	error::{CodeGraphError, Result},
	language::{
		ExtractedImportBinding, ExtractedReference, LanguageRegistry, ResolveRequest,
		SupportedLanguage,
	},
	model::{CodeGraph, EdgeKind, FileNode, GraphNode, GraphStats, PersistedCodeGraph, SymbolNode},
};

type ImportBindingMap = BTreeMap<PathBuf, BTreeMap<String, (PathBuf, String)>>;

#[derive(Clone, Debug)]
pub struct BuildGraphOptions {
	pub root:       PathBuf,
	pub cache_name: String,
}

impl BuildGraphOptions {
	pub fn new(root: impl Into<PathBuf>) -> Self {
		Self { root: root.into(), cache_name: "workspace".into() }
	}
}

#[derive(Debug)]
pub struct GraphBuildOutcome {
	pub graph:       CodeGraph,
	pub fingerprint: GraphFingerprint,
}

#[derive(Clone)]
pub struct CodeGraphBuilder {
	registry: LanguageRegistry,
	cache:    CacheStore,
}

#[allow(clippy::missing_const_for_fn, reason = "Builder API may grow non-const setup later")]
impl CodeGraphBuilder {
	pub const fn new(registry: LanguageRegistry, cache: CacheStore) -> Self {
		Self { registry, cache }
	}

	pub const fn cache(&self) -> &CacheStore {
		&self.cache
	}

	pub fn cache_status(&self, root: &Path) -> Result<CacheStatus> {
		let root = fs::canonicalize(root)?;
		if !root.is_dir() {
			return Err(CodeGraphError::InvalidRoot(root));
		}
		Ok(self
			.cache
			.status::<GraphCacheEntry>("workspace", &root, &|path| {
				self.registry.match_path(path).is_some()
			})?)
	}

	pub fn build(&self, options: &BuildGraphOptions) -> Result<GraphBuildOutcome> {
		let root = fs::canonicalize(&options.root)?;
		if !root.is_dir() {
			return Err(CodeGraphError::InvalidRoot(root));
		}
		let mut graph = StableGraph::<GraphNode, EdgeKind>::new();
		let mut file_nodes = BTreeMap::new();
		let mut symbol_nodes = BTreeMap::new();
		let mut file_languages = BTreeMap::<PathBuf, SupportedLanguage>::new();
		let mut file_imports = BTreeMap::<PathBuf, Vec<crate::language::ExtractedImport>>::new();
		let mut import_bindings = ImportBindingMap::new();
		let mut symbol_refs = Vec::<(usize, Vec<ExtractedReference>)>::new();
		let mut files = BTreeMap::new();

		for entry in ignore::WalkBuilder::new(&root)
			.hidden(false)
			.git_ignore(true)
			.git_exclude(true)
			.build()
		{
			let entry =
				entry.map_err(|error| CodeGraphError::Io(std::io::Error::other(error.to_string())))?;
			if !entry
				.file_type()
				.is_some_and(|file_type| file_type.is_file())
			{
				continue;
			}
			let absolute_path = entry.into_path();
			let relative_path = relative_to_root(&root, &absolute_path)?;
			if relative_path.starts_with(".spell") {
				continue;
			}
			let Some(registered) = self.registry.match_path(&absolute_path) else {
				continue;
			};
			let source = fs::read_to_string(&absolute_path)?;
			let metadata = fs::metadata(&absolute_path)?;
			files.insert(relative_path.clone(), FileFingerprint::from_metadata(&metadata)?);

			let extracted = registered.extractor.extract(&relative_path, &source)?;
			file_languages.insert(relative_path.clone(), extracted.language.clone());
			file_imports.insert(relative_path.clone(), extracted.imports.clone());

			let file_index = graph.add_node(GraphNode::File(FileNode {
				path:     relative_path.clone(),
				language: extracted.language.0.clone(),
			}));
			file_nodes.insert(relative_path.clone(), file_index);

			for symbol in extracted.symbols {
				let symbol_index = graph.add_node(GraphNode::Symbol(SymbolNode {
					name:           symbol.name.clone(),
					qualified_name: symbol.qualified_name.clone(),
					file:           relative_path.clone(),
					kind:           symbol.kind,
					exported:       symbol.exported,
					line:           symbol.line,
					column:         symbol.column,
					detail:         symbol.detail,
				}));
				graph.add_edge(file_index, symbol_index, EdgeKind::Defines);
				symbol_nodes
					.insert((relative_path.clone(), symbol.qualified_name.clone()), symbol_index);
				symbol_refs.push((graph.to_index(symbol_index), symbol.references));
			}
		}

		for (path, imports) in &file_imports {
			let Some(language) = file_languages.get(path) else {
				continue;
			};
			let Some(registered) = self.registry.by_language(language) else {
				return Err(CodeGraphError::MissingLanguage(language.0.clone()));
			};
			let Some(&from_index) = file_nodes.get(path) else {
				continue;
			};
			for import in imports {
				let resolved = registered.resolver.resolve(ResolveRequest {
					project_root: &root,
					from_file:    path,
					specifier:    &import.specifier,
				})?;
				let Some(target) = resolved else {
					continue;
				};
				let file_edge = if import.is_type_only {
					EdgeKind::TypeImports
				} else if language.as_str() == "clojure" {
					EdgeKind::Requires
				} else {
					EdgeKind::Imports
				};
				let symbol_edge = if import.is_type_only {
					EdgeKind::TypeImports
				} else if language.as_str() == "clojure" {
					EdgeKind::Refers
				} else {
					EdgeKind::References
				};
				if let Some(&to_index) = file_nodes.get(&target) {
					graph.add_edge(from_index, to_index, file_edge);
					for ExtractedImportBinding { imported_name, local_name } in &import.bindings {
						import_bindings
							.entry(path.clone())
							.or_default()
							.insert(local_name.clone(), (target.clone(), imported_name.clone()));
						if let Some(symbol_index) =
							unique_symbol_match_in_file(&graph, &symbol_nodes, &target, imported_name)
						{
							graph.add_edge(from_index, symbol_index, symbol_edge);
						}
					}
				}
			}
		}

		for (symbol_index, references) in symbol_refs {
			let from_index = graph.from_index(symbol_index);
			let from_file = match graph.node_weight(from_index) {
				Some(GraphNode::Symbol(symbol)) => symbol.file.clone(),
				_ => continue,
			};
			for reference in references {
				if let Some(to_index) = resolve_reference_target(
					&graph,
					&symbol_nodes,
					&import_bindings,
					&from_file,
					&reference.target_name,
				) {
					graph.add_edge(from_index, to_index, reference.edge_kind);
				}
			}
		}

		for (from_index, to_index) in collect_style_edges(&graph) {
			graph.add_edge(from_index, to_index, EdgeKind::Styles);
		}
		let stats = build_stats(&graph);
		let fingerprint =
			GraphFingerprint { root: root.clone(), git_head: read_git_head(&root), files };
		let persisted = PersistedCodeGraph {
			root,
			graph,
			stats,
			generated_at_ms: now_ms(),
			git_head: fingerprint.git_head.clone(),
		};
		let graph = CodeGraph::from(persisted);
		self
			.cache
			.save(&options.cache_name, &GraphCacheEntry::new(graph.clone(), fingerprint.clone()))?;
		Ok(GraphBuildOutcome { graph, fingerprint })
	}
}

#[allow(
	clippy::collapsible_if,
	reason = "Expanded branches keep dotted target resolution readable"
)]
fn resolve_reference_target(
	graph: &StableGraph<GraphNode, EdgeKind>,
	symbol_nodes: &BTreeMap<(PathBuf, String), petgraph::stable_graph::NodeIndex>,
	import_bindings: &ImportBindingMap,
	from_file: &Path,
	target_name: &str,
) -> Option<petgraph::stable_graph::NodeIndex> {
	if let Some(&target_index) =
		symbol_nodes.get(&(from_file.to_path_buf(), target_name.to_string()))
	{
		return Some(target_index);
	}
	if let Some(target_index) =
		unique_symbol_match_in_file(graph, symbol_nodes, from_file, target_name)
	{
		return Some(target_index);
	}
	if let Some((namespace, member)) = target_name
		.split_once('.')
		.or_else(|| target_name.split_once('/'))
		&& let Some((target_file, _imported_name)) = import_bindings
			.get(from_file)
			.and_then(|bindings| bindings.get(namespace))
	{
		if let Some(target_index) =
			unique_symbol_match_in_file(graph, symbol_nodes, target_file, member)
		{
			return Some(target_index);
		}
	}
	import_bindings
		.get(from_file)
		.and_then(|bindings| bindings.get(target_name))
		.and_then(|(target_file, imported_name)| {
			unique_symbol_match_in_file(graph, symbol_nodes, target_file, imported_name)
		})
}

fn unique_symbol_match_in_file(
	graph: &StableGraph<GraphNode, EdgeKind>,
	symbol_nodes: &BTreeMap<(PathBuf, String), petgraph::stable_graph::NodeIndex>,
	file: &Path,
	target_name: &str,
) -> Option<petgraph::stable_graph::NodeIndex> {
	let mut matches = symbol_nodes
		.range((file.to_path_buf(), String::new())..)
		.take_while(|((path, _), _)| path == file)
		.filter_map(|((..), &index)| match graph.node_weight(index) {
			Some(GraphNode::Symbol(symbol)) if symbol.name == target_name => Some(index),
			_ => None,
		});
	let first = matches.next()?;
	if matches.next().is_some() {
		return None;
	}
	Some(first)
}

fn collect_style_edges(
	graph: &StableGraph<GraphNode, EdgeKind>,
) -> Vec<(petgraph::stable_graph::NodeIndex, petgraph::stable_graph::NodeIndex)> {
	let css_rules = graph
		.node_indices()
		.filter_map(|index| match graph.node_weight(index) {
			Some(GraphNode::Symbol(symbol)) if symbol.kind == crate::model::SymbolKind::CssRule => {
				Some((index, symbol.name.clone()))
			},
			_ => None,
		});
	let elements = graph
		.node_indices()
		.filter_map(|index| match graph.node_weight(index) {
			Some(GraphNode::Symbol(symbol)) if symbol.kind == crate::model::SymbolKind::Element => {
				Some((index, symbol.name.clone()))
			},
			_ => None,
		})
		.collect::<Vec<_>>();
	let mut edges = std::collections::BTreeSet::new();
	for (rule_index, selector_text) in css_rules {
		for (element_index, element_name) in &elements {
			if selector_matches_element(&selector_text, element_name) {
				edges.insert((graph.to_index(rule_index), graph.to_index(*element_index)));
			}
		}
	}
	edges
		.into_iter()
		.map(|(from, to)| (graph.from_index(from), graph.from_index(to)))
		.collect()
}

fn selector_matches_element(selector_text: &str, element_name: &str) -> bool {
	let element_name = element_name.trim();
	let element_name = element_name.split('[').next().unwrap_or(element_name);
	selector_text
		.split(',')
		.map(str::trim)
		.filter(|selector| !selector.is_empty())
		.any(|selector| simple_selector_matches(selector, element_name))
}

fn simple_selector_matches(selector: &str, element_name: &str) -> bool {
	if selector.contains([' ', '>', '+', '~', '[', ':']) {
		return false;
	}
	if let Some(class_name) = selector.strip_prefix('.') {
		return element_name.contains(&format!(".{class_name}"));
	}
	if let Some(id_name) = selector.strip_prefix('#') {
		return element_name.contains(&format!("#{id_name}"));
	}
	let tag_name = element_name
		.split(['#', '.'])
		.next()
		.unwrap_or(element_name);
	tag_name == selector
}

fn build_stats(graph: &StableGraph<GraphNode, EdgeKind>) -> GraphStats {
	let mut language_counts = BTreeMap::new();
	let mut file_count = 0_u32;
	let mut symbol_count = 0_u32;
	for node in graph.node_weights() {
		match node {
			GraphNode::File(file) => {
				file_count += 1;
				*language_counts.entry(file.language.clone()).or_default() += 1;
			},
			GraphNode::Symbol(_) => symbol_count += 1,
		}
	}
	GraphStats { file_count, symbol_count, edge_count: graph.edge_count() as u32, language_counts }
}

fn relative_to_root(root: &Path, path: &Path) -> Result<PathBuf> {
	path
		.strip_prefix(root)
		.map(Path::to_path_buf)
		.map_err(|_| CodeGraphError::InvalidRoot(root.to_path_buf()))
}

fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as u64
}

#[cfg(test)]
#[test]
fn builder_links_css_rules_to_html_elements() {
	let root = std::env::temp_dir().join(format!("pi-code-graph-styles-{}", std::process::id()));
	let cache_dir = root.join("cache");
	let _ = fs::remove_dir_all(&root);
	fs::create_dir_all(&root).expect("temp dir should be created");
	fs::write(
		root.join("index.html"),
		"<!doctype html><html><head><link href=\"./app.css\" /></head><body><button \
		 class=\"btn\">Save</button></body></html>",
	)
	.expect("html fixture should be written");
	fs::write(root.join("app.css"), ".btn { color: red; }").expect("css fixture should be written");

	let registry = LanguageRegistry::new()
		.with_defaults()
		.expect("defaults should register");
	let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
	let outcome = builder
		.build(&BuildGraphOptions::new(&root))
		.expect("build should succeed");
	assert_eq!(outcome.graph.count_edges(EdgeKind::Imports), 1);
	assert_eq!(outcome.graph.count_edges(EdgeKind::Styles), 1);
	let _ = fs::remove_dir_all(root);
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use super::*;
	use crate::{
		language::{
			ExtractedFile, ExtractedImport, ExtractedImportBinding, ExtractedReference,
			ExtractedSymbol, ImportResolver, LanguageExtractor, LanguageRegistry, ResolveRequest,
			SupportedLanguage,
		},
		model::{EdgeKind, SymbolKind},
	};

	#[derive(Clone)]
	struct FakeExtractor;

	impl LanguageExtractor for FakeExtractor {
		fn language(&self) -> SupportedLanguage {
			SupportedLanguage::new("fake")
		}

		fn matches_path(&self, path: &Path) -> bool {
			path.extension().and_then(|extension| extension.to_str()) == Some("fake")
		}

		fn extract(&self, path: &Path, _source: &str) -> Result<ExtractedFile> {
			let name = path
				.file_stem()
				.and_then(|stem| stem.to_str())
				.unwrap_or("entry");
			let file = match name {
				"dupes" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![
						ExtractedSymbol {
							name:           "process".into(),
							qualified_name: format!("{}::Alpha.process", path.display()),
							kind:           SymbolKind::Method,
							exported:       false,
							line:           1,
							column:         1,
							detail:         None,
							references:     vec![ExtractedReference {
								target_name: "process".into(),
								edge_kind:   EdgeKind::Calls,
							}],
						},
						ExtractedSymbol {
							name:           "process".into(),
							qualified_name: format!("{}::Beta.process", path.display()),
							kind:           SymbolKind::Method,
							exported:       false,
							line:           2,
							column:         1,
							detail:         None,
							references:     Vec::new(),
						},
					],
					imports:  Vec::new(),
				},
				"unique" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![
						ExtractedSymbol {
							name:           "caller".into(),
							qualified_name: format!("{}::caller", path.display()),
							kind:           SymbolKind::Function,
							exported:       true,
							line:           1,
							column:         1,
							detail:         None,
							references:     vec![ExtractedReference {
								target_name: "unique_fn".into(),
								edge_kind:   EdgeKind::Calls,
							}],
						},
						ExtractedSymbol {
							name:           "unique_fn".into(),
							qualified_name: format!("{}::unique_fn", path.display()),
							kind:           SymbolKind::Function,
							exported:       true,
							line:           2,
							column:         1,
							detail:         None,
							references:     Vec::new(),
						},
					],
					imports:  Vec::new(),
				},
				_ => {
					let (imports, references) = match name {
						"caller" => (
							vec![ExtractedImport {
								specifier:    "./callee.fake".into(),
								bindings:     vec![ExtractedImportBinding {
									imported_name: "callee".into(),
									local_name:    "calleeAlias".into(),
								}],
								is_type_only: false,
							}],
							vec![ExtractedReference {
								target_name: "calleeAlias".into(),
								edge_kind:   EdgeKind::Calls,
							}],
						),
						"type_caller" => (
							vec![ExtractedImport {
								specifier:    "./callee.fake".into(),
								bindings:     vec![ExtractedImportBinding {
									imported_name: "callee".into(),
									local_name:    "calleeAlias".into(),
								}],
								is_type_only: true,
							}],
							Vec::new(),
						),
						_ => (Vec::new(), Vec::new()),
					};
					ExtractedFile {
						path: path.to_path_buf(),
						language: self.language(),
						symbols: vec![ExtractedSymbol {
							name: name.into(),
							qualified_name: format!("{}::{name}", path.display()),
							kind: SymbolKind::Function,
							exported: true,
							line: 1,
							column: 1,
							detail: None,
							references,
						}],
						imports,
					}
				},
			};
			Ok(file)
		}
	}

	#[derive(Clone)]
	struct FakeResolver;

	impl ImportResolver for FakeResolver {
		fn language(&self) -> SupportedLanguage {
			SupportedLanguage::new("fake")
		}

		fn resolve(&self, request: ResolveRequest<'_>) -> Result<Option<PathBuf>> {
			if request.specifier == "./callee.fake" {
				return Ok(Some(PathBuf::from("callee.fake")));
			}
			Ok(None)
		}
	}

	#[test]
	fn builder_connects_symbols_and_imports() {
		let root = std::env::temp_dir().join(format!("pi-code-graph-builder-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("caller.fake"), "caller").expect("caller file should be written");
		fs::write(root.join("callee.fake"), "callee").expect("callee file should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");
		assert_eq!(outcome.graph.stats().file_count, 2);
		assert_eq!(outcome.graph.stats().symbol_count, 2);
		assert_eq!(outcome.graph.count_edges(EdgeKind::Imports), 1);
		assert_eq!(outcome.graph.count_edges(EdgeKind::Calls), 1);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn type_only_imports_use_type_imports_edge() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-type-imports-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("type_caller.fake"), "type caller")
			.expect("type caller file should be written");
		fs::write(root.join("callee.fake"), "callee").expect("callee file should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		assert_eq!(outcome.graph.count_edges(EdgeKind::TypeImports), 2);
		assert_eq!(outcome.graph.count_edges(EdgeKind::Imports), 0);
		assert_eq!(outcome.graph.count_edges(EdgeKind::References), 0);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn duplicate_method_names_do_not_collide() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-duplicate-symbols-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("dupes.fake"), "dupes").expect("fixture file should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		assert!(
			outcome
				.graph
				.symbol_names()
				.iter()
				.any(|name| name.ends_with("dupes.fake::Alpha.process"))
		);
		assert!(
			outcome
				.graph
				.symbol_names()
				.iter()
				.any(|name| name.ends_with("dupes.fake::Beta.process"))
		);
		assert_eq!(outcome.graph.count_edges(EdgeKind::Calls), 0);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn unique_bare_name_still_resolves() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-unique-symbol-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("unique.fake"), "unique").expect("fixture file should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		assert_eq!(outcome.graph.count_edges(EdgeKind::Calls), 1);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn builder_cache_status_ignores_spell_sources() {
		let root =
			std::env::temp_dir().join(format!("pi-code-graph-spell-sources-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join(".spell")).expect("spell directory should be created");
		fs::write(root.join("visible.fake"), "visible").expect("visible file should be written");
		fs::write(root.join(".spell/hidden.fake"), "hidden").expect("hidden file should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		fs::write(root.join(".spell/hidden.fake"), "updated hidden")
			.expect("hidden file should be updated");

		let status = builder
			.cache_status(&root)
			.expect("cache status should succeed");
		assert_eq!(status, CacheStatus::Fresh);
		let _ = fs::remove_dir_all(root);
	}
}
