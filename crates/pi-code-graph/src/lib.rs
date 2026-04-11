pub mod cache;
pub mod error;
pub mod indexer;
pub mod language;
pub mod model;
pub mod query;
pub mod search;
pub mod store;

pub use cache::{CacheStatus, CacheStore, FileFingerprint, GraphCacheEntry, GraphFingerprint};
pub use error::{CodeGraphError, Result};
pub use indexer::{BuildGraphOptions, CodeGraphBuilder, GraphBuildOutcome};
pub use language::{
	ElixirExtractor, ElixirImportResolver, ExtractedFile, ExtractedImport, ExtractedImportBinding,
	ExtractedReference, ExtractedSymbol, ImportResolver, LanguageExtractor, LanguageRegistry,
	ResolveRequest, SupportedLanguage, TypeScriptExtractor, TypeScriptImportResolver,
};
pub use model::{
	CodeGraph, EdgeKind, FileNode, GraphNode, GraphStats, PersistedCodeGraph, SymbolKind, SymbolNode,
};
pub use query::{
	GraphCluster, GraphContextResult, GraphDeadCodeItem, GraphDepsResult, GraphFlowResult,
	GraphImpactResult, GraphNodeSummary, GraphSearchMatch, GraphStatus, GraphTraversalLevel,
};
pub use search::{SearchHit, SearchIndex};
pub use pi_code_engine::language::{
	LanguageProfile as EngineLanguageProfile,
	LanguageRegistry as EngineLanguageRegistry,
};

pub use store::GraphStore;
