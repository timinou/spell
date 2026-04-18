use std::{collections::BTreeMap, path::PathBuf};

use petgraph::{Directed, stable_graph::StableGraph, visit::IntoEdgeReferences};
use serde::{Deserialize, Serialize};

use crate::search::SearchIndex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileNode {
	pub path:     PathBuf,
	pub language: String,
}

impl FileNode {
	pub fn target_id(&self) -> String {
		self.path.to_string_lossy().to_string()
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SymbolKind {
	Function,
	Class,
	Method,
	Variable,
	Interface,
	TypeAlias,
	Enum,
	Module,
	Macro,
	Template,
	Element,
	CssRule,
	CssProperty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolNode {
	pub name:           String,
	pub qualified_name: String,
	pub file:           PathBuf,
	pub kind:           SymbolKind,
	pub exported:       bool,
	pub line:           u32,
	pub column:         u32,
	pub detail:         Option<String>,
}

impl SymbolNode {
	pub fn target_id(&self) -> &str {
		&self.qualified_name
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GraphNode {
	File(FileNode),
	Symbol(SymbolNode),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EdgeKind {
	Defines,
	Imports,
	Calls,
	References,
	Inherits,
	Renders,
	Styles,
	TypeImports,
	TypeParameterOf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GraphStats {
	pub file_count:      u32,
	pub symbol_count:    u32,
	pub edge_count:      u32,
	pub language_counts: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedCodeGraph {
	pub root:            PathBuf,
	pub graph:           StableGraph<GraphNode, EdgeKind, Directed>,
	pub stats:           GraphStats,
	pub generated_at_ms: u64,
	pub git_head:        Option<String>,
}

#[derive(Debug, Clone)]
pub struct CodeGraph {
	persisted:    PersistedCodeGraph,
	search_index: SearchIndex,
	#[cfg(feature = "semantic")]
	vector_index: Option<pi_code_vectors::VectorIndex>,
}

impl CodeGraph {
	pub fn new(persisted: PersistedCodeGraph) -> Self {
		let search_index = SearchIndex::build(&persisted);
		Self {
			persisted,
			search_index,
			#[cfg(feature = "semantic")]
			vector_index: None,
		}
	}

	pub const fn persisted(&self) -> &PersistedCodeGraph {
		&self.persisted
	}

	pub fn into_persisted(self) -> PersistedCodeGraph {
		self.persisted
	}

	pub const fn search_index(&self) -> &SearchIndex {
		&self.search_index
	}

	pub const fn stats(&self) -> &GraphStats {
		&self.persisted.stats
	}

	pub const fn root(&self) -> &PathBuf {
		&self.persisted.root
	}

	pub const fn graph(&self) -> &StableGraph<GraphNode, EdgeKind, Directed> {
		&self.persisted.graph
	}

	pub fn symbol_names(&self) -> Vec<String> {
		self
			.persisted
			.graph
			.node_weights()
			.filter_map(|node| match node {
				GraphNode::Symbol(symbol) => Some(symbol.qualified_name.clone()),
				GraphNode::File(_) => None,
			})
			.collect()
	}

	pub fn count_edges(&self, kind: EdgeKind) -> usize {
		self
			.persisted
			.graph
			.edge_references()
			.filter(|edge| *edge.weight() == kind)
			.count()
	}

	/// Construct with a pre-built vector index for hybrid search.
	#[cfg(feature = "semantic")]
	pub fn with_vectors(
		persisted: PersistedCodeGraph,
		vectors: pi_code_vectors::VectorIndex,
	) -> Self {
		let search_index = SearchIndex::build(&persisted);
		Self { persisted, search_index, vector_index: Some(vectors) }
	}

	/// Access the vector index if available.
	#[cfg(feature = "semantic")]
	pub const fn vector_index(&self) -> Option<&pi_code_vectors::VectorIndex> {
		self.vector_index.as_ref()
	}
}

impl From<PersistedCodeGraph> for CodeGraph {
	fn from(value: PersistedCodeGraph) -> Self {
		Self::new(value)
	}
}
