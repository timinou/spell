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
					// PLAN-318 W5: re-exports (e.g. `export * from`, `pub use`)
					// get an additional Aliases edge so the EdgeResolver can
					// follow re-export chains transitively when resolving def→.
					if import.is_reexport {
						graph.add_edge(from_index, to_index, EdgeKind::Aliases);
					}
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

 	let workspace_name_index = build_workspace_name_index(&graph, &symbol_nodes);
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
 					&workspace_name_index,
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
	workspace_name_index: &BTreeMap<String, petgraph::stable_graph::NodeIndex>,
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
	if let Some(target_index) = import_bindings
		.get(from_file)
		.and_then(|bindings| bindings.get(target_name))
		.and_then(|(target_file, imported_name)| {
			unique_symbol_match_in_file(graph, symbol_nodes, target_file, imported_name)
		}) {
		return Some(target_index);
	}
	// S5: workspace-unique fallback. Engine-profile languages (Rust, Python,
	// Go, …) do not yet populate import_bindings, so S3/S4 always miss for
	// their cross-file references. As a last resort, if exactly ONE symbol in
	// the whole workspace bears the target name, link to it. Ambiguity (0 or
	// ≥2 matches) yields no edge — a missing edge is safer than a wrong one.
	// The index is precomputed once per build (O(symbols)); this lookup is O(log n).
	workspace_name_index.get(target_name).copied()
}

/// Build the S5 workspace-unique name index: `name → NodeIndex` containing only
/// names that are unique across the entire workspace. Names borne by two or
/// more symbols are omitted, so a lookup hit guarantees an unambiguous target.
/// Computed once per graph build to keep S5 resolution O(log n) per reference
/// rather than O(symbols) per reference.
fn build_workspace_name_index(
	graph: &StableGraph<GraphNode, EdgeKind>,
	symbol_nodes: &BTreeMap<(PathBuf, String), petgraph::stable_graph::NodeIndex>,
) -> BTreeMap<String, petgraph::stable_graph::NodeIndex> {
	let mut unique: BTreeMap<String, petgraph::stable_graph::NodeIndex> = BTreeMap::new();
	let mut ambiguous: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
	for &index in symbol_nodes.values() {
		if let Some(GraphNode::Symbol(symbol)) = graph.node_weight(index) {
			if ambiguous.contains(&symbol.name) {
				continue;
			}
			if unique.remove(&symbol.name).is_some() {
				ambiguous.insert(symbol.name.clone());
			} else {
				unique.insert(symbol.name.clone(), index);
			}
		}
	}
	unique
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
				// S5 fixtures: bare-name reference to a symbol in ANOTHER file with
				// NO import binding (engine_profile languages do not populate
				// import_bindings). S1–S4 all miss; only the workspace-unique
				// fallback can resolve these.
				"xref_caller" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![ExtractedSymbol {
						name:           "xref_caller".into(),
						qualified_name: format!("{}::xref_caller", path.display()),
						kind:           SymbolKind::Function,
						exported:       true,
						line:           1,
						column:         1,
						detail:         None,
						references:     vec![ExtractedReference {
							target_name: "lonely_target".into(),
							edge_kind:   EdgeKind::Calls,
						}],
					}],
					imports:  Vec::new(),
				},
				"xref_target" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![ExtractedSymbol {
						name:           "lonely_target".into(),
						qualified_name: format!("{}::lonely_target", path.display()),
						kind:           SymbolKind::Function,
						exported:       true,
						line:           1,
						column:         1,
						detail:         None,
						references:     Vec::new(),
					}],
					imports:  Vec::new(),
				},
				// Same bare-name reference, but TWO definitions in two other files
				// → ambiguous → S5 must NOT create an edge.
				"ambig_caller" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![ExtractedSymbol {
						name:           "ambig_caller".into(),
						qualified_name: format!("{}::ambig_caller", path.display()),
						kind:           SymbolKind::Function,
						exported:       true,
						line:           1,
						column:         1,
						detail:         None,
						references:     vec![ExtractedReference {
							target_name: "ambig_target".into(),
							edge_kind:   EdgeKind::Calls,
						}],
					}],
					imports:  Vec::new(),
				},
				"ambig_a" | "ambig_b" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![ExtractedSymbol {
						name:           "ambig_target".into(),
						qualified_name: format!("{}::ambig_target", path.display()),
						kind:           SymbolKind::Function,
						exported:       true,
						line:           1,
						column:         1,
						detail:         None,
						references:     Vec::new(),
					}],
					imports:  Vec::new(),
				},
				// Same-file shadow: a local `shadowed` plus a remote `shadowed`.
				// S2 (same-file unique) must win over S5; edge stays intra-file.
				"shadow_local" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![
						ExtractedSymbol {
							name:           "shadow_caller".into(),
							qualified_name: format!("{}::shadow_caller", path.display()),
							kind:           SymbolKind::Function,
							exported:       true,
							line:           1,
							column:         1,
							detail:         None,
							references:     vec![ExtractedReference {
								target_name: "shadowed".into(),
								edge_kind:   EdgeKind::Calls,
							}],
						},
						ExtractedSymbol {
							name:           "shadowed".into(),
							qualified_name: format!("{}::shadowed", path.display()),
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
				"shadow_remote" => ExtractedFile {
					path:     path.to_path_buf(),
					language: self.language(),
					symbols:  vec![ExtractedSymbol {
						name:           "shadowed".into(),
						qualified_name: format!("{}::shadowed", path.display()),
						kind:           SymbolKind::Function,
						exported:       true,
						line:           1,
						column:         1,
						detail:         None,
						references:     Vec::new(),
					}],
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
								is_reexport:  false,
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
								is_reexport:  false,
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

	// --- F-4a: workspace-unique cross-file fallback (S5) ---

	#[test]
	fn resolves_workspace_unique_cross_file_reference() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-xref-unique-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("xref_caller.fake"), "xref_caller")
			.expect("caller fixture should be written");
		fs::write(root.join("xref_target.fake"), "xref_target")
			.expect("target fixture should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		// Bare-name ref across files, no import binding: only S5 can link it.
		assert_eq!(
			outcome.graph.count_edges(EdgeKind::Calls),
			1,
			"workspace-unique target must resolve cross-file via S5 fallback"
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn skips_ambiguous_cross_file_name() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-xref-ambig-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("ambig_caller.fake"), "ambig_caller")
			.expect("caller fixture should be written");
		fs::write(root.join("ambig_a.fake"), "ambig_a")
			.expect("ambig_a fixture should be written");
		fs::write(root.join("ambig_b.fake"), "ambig_b")
			.expect("ambig_b fixture should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		// Two defs of the same name → ambiguous → no false edge.
		assert_eq!(
			outcome.graph.count_edges(EdgeKind::Calls),
			0,
			"ambiguous workspace name must NOT create an edge (silence > wrong edge)"
		);
		let _ = fs::remove_dir_all(root);
	}

	#[test]
	fn prefers_same_file_over_workspace_fallback() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-xref-shadow-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(&root).expect("temp dir should be created");
		fs::write(root.join("shadow_local.fake"), "shadow_local")
			.expect("local fixture should be written");
		fs::write(root.join("shadow_remote.fake"), "shadow_remote")
			.expect("remote fixture should be written");

		let mut registry = LanguageRegistry::new();
		registry
			.register(Arc::new(FakeExtractor), Arc::new(FakeResolver))
			.expect("registration should succeed");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		// `shadowed` exists locally AND remotely. S2 (same-file unique) must win,
		// so the edge is intra-file and there is exactly ONE Calls edge — not two,
		// and not an ambiguity-induced zero.
		assert_eq!(
			outcome.graph.count_edges(EdgeKind::Calls),
			1,
			"same-file resolution (S2) must take precedence over workspace fallback (S5)"
		);
		let _ = fs::remove_dir_all(root);
	}

	/// Count References edges whose BOTH endpoints are Symbol nodes. This
	/// excludes the file-level import edges that `mod x;` declarations create,
	/// isolating symbol-to-symbol reference resolution (the F-4b outcome).
	fn count_symbol_references(graph: &CodeGraph) -> usize {
		use petgraph::visit::{EdgeRef, IntoEdgeReferences};
		let g = graph.graph();
		g.edge_references()
			.filter(|edge| *edge.weight() == EdgeKind::References)
			.filter(|edge| {
				matches!(g.node_weight(edge.source()), Some(GraphNode::Symbol(_)))
					&& matches!(g.node_weight(edge.target()), Some(GraphNode::Symbol(_)))
			})
			.count()
	}

	// --- F-4b: precise Rust import-binding resolution (S3/S4), end-to-end
	// through the real EngineProfileExtractor + EngineProfileImportResolver.
	// The referenced name `render` is DELIBERATELY ambiguous workspace-wide
	// (two definitions) so the S5 unique-name fallback CANNOT resolve it —
	// only the precise `use crate::widget::render` binding can pick the right
	// target. This is the litmus test that engine-profile cross-file binding
	// resolution actually works, not just the unique-name safety net.
	#[test]
	fn rust_use_binding_resolves_ambiguous_cross_file_reference() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-rust-binding-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src")).expect("src dir should be created");
		fs::write(
			root.join("Cargo.toml"),
			"[package]\nname = \"fixture\"\nversion = \"0.0.0\"\n",
		)
		.expect("Cargo.toml should be written");
		// lib.rs imports render from the widget module specifically.
		fs::write(
			root.join("src/lib.rs"),
			"mod widget;\nmod decoy;\nuse crate::widget::render;\npub fn run() { render(); }\n",
		)
		.expect("lib.rs should be written");
		fs::write(root.join("src/widget.rs"), "pub fn render() {}\n")
			.expect("widget.rs should be written");
		// Decoy: a SECOND `render`, making the bare name ambiguous workspace-wide.
		fs::write(root.join("src/decoy.rs"), "pub fn render() {}\n")
			.expect("decoy.rs should be written");

		let registry = LanguageRegistry::new().with_defaults().expect("defaults should register");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		// The engine-profile extractor classifies a bare-identifier call
		// `render()` as a References edge (the Calls kind is reserved for
		// method/qualified-call syntax). What F-4b proves is that the cross-file
		// reference RESOLVES to exactly one target via the `use` binding (S4),
		// even though `render` is defined in two files. Exactly one References
		// edge among symbol nodes is the litmus.
		assert_eq!(
			count_symbol_references(&outcome.graph),
			1,
			"`use crate::widget::render` binding must resolve the ambiguous reference \
			 to exactly one cross-file target"
		);
		let _ = fs::remove_dir_all(root);
	}

	// Negative control: same ambiguous `render`, but NO `use` import. The bare
	// call cannot bind precisely (S3/S4 need a binding) and S5 refuses the
	// ambiguous name — so NO edge must form. Guards against an over-eager
	// fallback silently linking to an arbitrary `render`.
	#[test]
	fn rust_bare_call_without_use_does_not_resolve_ambiguous_name() {
		let root = std::env::temp_dir()
			.join(format!("pi-code-graph-rust-nobind-{}", std::process::id()));
		let cache_dir = root.join("cache");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(root.join("src")).expect("src dir should be created");
		fs::write(
			root.join("Cargo.toml"),
			"[package]\nname = \"fixture\"\nversion = \"0.0.0\"\n",
		)
		.expect("Cargo.toml should be written");
		fs::write(
			root.join("src/lib.rs"),
			"mod widget;\nmod decoy;\npub fn run() { render(); }\n",
		)
		.expect("lib.rs should be written");
		fs::write(root.join("src/widget.rs"), "pub fn render() {}\n")
			.expect("widget.rs should be written");
		fs::write(root.join("src/decoy.rs"), "pub fn render() {}\n")
			.expect("decoy.rs should be written");

		let registry = LanguageRegistry::new().with_defaults().expect("defaults should register");
		let builder = CodeGraphBuilder::new(registry, CacheStore::new(cache_dir));
		let outcome = builder
			.build(&BuildGraphOptions::new(&root))
			.expect("build should succeed");

		// No `use` → no binding (S3/S4 miss) and S5 refuses the ambiguous name,
		// so the reference must resolve to ZERO symbol targets. Asserting on
		// symbol-to-symbol References edges (not the file-level import edges the
		// `mod` decls create) isolates the resolution outcome we care about.
		assert_eq!(
			count_symbol_references(&outcome.graph),
			0,
			"ambiguous bare `render()` with no import must NOT resolve to any target"
		);
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
