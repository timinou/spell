use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
};

use petgraph::{stable_graph::StableGraph, visit::NodeIndexable};

use crate::{
	cache::{CacheStore, FileFingerprint, GraphCacheEntry, GraphFingerprint, read_git_head},
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
			let Some(registered) = self.registry.match_path(&absolute_path) else {
				continue;
			};
			let relative_path = relative_to_root(&root, &absolute_path)?;
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
				symbol_nodes.insert((relative_path.clone(), symbol.name.clone()), symbol_index);
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
				if let Some(&to_index) = file_nodes.get(&target) {
					graph.add_edge(from_index, to_index, EdgeKind::Imports);
					for ExtractedImportBinding { imported_name, local_name } in &import.bindings {
						import_bindings
							.entry(path.clone())
							.or_default()
							.insert(local_name.clone(), (target.clone(), imported_name.clone()));
						if let Some(&symbol_index) =
							symbol_nodes.get(&(target.clone(), imported_name.clone()))
						{
							graph.add_edge(from_index, symbol_index, EdgeKind::References);
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
					&symbol_nodes,
					&import_bindings,
					&from_file,
					&reference.target_name,
				) {
					graph.add_edge(from_index, to_index, reference.edge_kind);
				}
			}
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
	if let Some((namespace, member)) = target_name.split_once('.')
		&& let Some((target_file, _imported_name)) = import_bindings
			.get(from_file)
			.and_then(|bindings| bindings.get(namespace))
	{
		if let Some(&target_index) = symbol_nodes.get(&(target_file.clone(), member.to_string())) {
			return Some(target_index);
		}
	}
	import_bindings
		.get(from_file)
		.and_then(|bindings| bindings.get(target_name))
		.and_then(|(target_file, imported_name)| {
			symbol_nodes
				.get(&(target_file.clone(), imported_name.clone()))
				.copied()
		})
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
			let mut imports = Vec::new();
			let mut references = Vec::new();
			if name == "caller" {
				imports.push(ExtractedImport {
					specifier:    "./callee.fake".into(),
					bindings:     vec![ExtractedImportBinding {
						imported_name: "callee".into(),
						local_name:    "calleeAlias".into(),
					}],
					is_type_only: false,
				});
				references.push(ExtractedReference {
					target_name: "calleeAlias".into(),
					edge_kind:   EdgeKind::Calls,
				});
			}
			Ok(ExtractedFile {
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
			})
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
}
