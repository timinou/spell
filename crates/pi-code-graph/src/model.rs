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
	Namespace,
	Var,
	Protocol,
	Record,
	Multimethod,
	Test,
	Spec,
	Keyword,
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
	Requires,
	Refers,
	Aliases,
	Implements,
	Dispatches,
	Tests,
	UsesKeyword,
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
	vector_index: Option<std::sync::Arc<pi_knowledge_core::vec::VectorIndex>>,
}

impl CodeGraph {
	pub fn new(persisted: PersistedCodeGraph) -> Self {
		let search_index = SearchIndex::build(&persisted);
		Self {
			persisted,
			search_index,
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
	pub fn with_vectors(
		persisted: PersistedCodeGraph,
		vectors: pi_knowledge_core::vec::VectorIndex,
	) -> Self {
		let search_index = SearchIndex::build(&persisted);
		Self { persisted, search_index, vector_index: Some(std::sync::Arc::new(vectors)) }
	}

	/// Access the vector index if available.
	pub fn vector_index(&self) -> Option<&pi_knowledge_core::vec::VectorIndex> {
		self.vector_index.as_deref()
	}
}

impl From<PersistedCodeGraph> for CodeGraph {
	fn from(value: PersistedCodeGraph) -> Self {
		Self::new(value)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn clojure_symbol_and_edge_kinds_serialize_stably() {
		let symbol_kinds = [
			SymbolKind::Namespace,
			SymbolKind::Var,
			SymbolKind::Protocol,
			SymbolKind::Record,
			SymbolKind::Multimethod,
			SymbolKind::Test,
			SymbolKind::Spec,
			SymbolKind::Keyword,
		];
		let encoded = serde_json::to_value(symbol_kinds).expect("symbol kinds serialize");
		assert_eq!(
			encoded,
			serde_json::json!([
				"Namespace",
				"Var",
				"Protocol",
				"Record",
				"Multimethod",
				"Test",
				"Spec",
				"Keyword"
			])
		);

		let edge_kinds = [
			EdgeKind::Requires,
			EdgeKind::Refers,
			EdgeKind::Aliases,
			EdgeKind::Implements,
			EdgeKind::Dispatches,
			EdgeKind::Tests,
			EdgeKind::UsesKeyword,
		];
		let encoded = serde_json::to_value(edge_kinds).expect("edge kinds serialize");
		assert_eq!(
			encoded,
			serde_json::json!([
				"Requires",
				"Refers",
				"Aliases",
				"Implements",
				"Dispatches",
				"Tests",
				"UsesKeyword"
			])
		);
	}
}
