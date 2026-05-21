pub mod cache;
pub mod chunking;
pub mod error;
pub mod hybrid;
pub mod indexer;
pub mod language;
pub mod model;
pub mod query;
pub mod search;
pub mod store;

pub use cache::{CacheStatus, CacheStore, FileFingerprint, GraphCacheEntry, GraphFingerprint};
pub use chunking::{ChunkResult, extract_chunks};
pub use error::{CodeGraphError, Result};
pub use hybrid::{HybridSearchHit, reciprocal_rank_fusion};
pub use indexer::{BuildGraphOptions, CodeGraphBuilder, GraphBuildOutcome};
pub use language::{
	ElixirExtractor, ElixirImportResolver, EngineProfileExtractor, EngineProfileImportResolver,
	ExtractedFile, ExtractedImport, ExtractedImportBinding, ExtractedReference, ExtractedSymbol,
	ImportResolver, LanguageExtractor, LanguageRegistry, ResolveRequest, SupportedLanguage,
	TypeScriptExtractor, TypeScriptImportResolver,
};
pub use model::{
	CodeGraph, EdgeKind, FileNode, GraphNode, GraphStats, PersistedCodeGraph, SymbolKind, SymbolNode,
};
pub use pi_code_engine::language::{
	LanguageProfile as EngineLanguageProfile, LanguageRegistry as EngineLanguageRegistry,
};
pub use query::{
	GraphCluster, GraphContextResult, GraphDeadCodeItem, GraphDepsResult, GraphFilesResult,
	GraphFlowResult, GraphImpactResult, GraphNodeSummary, GraphSearchMatch, GraphStatus,
	GraphSymbolsResult, GraphTraversalLevel,
};
pub use search::{SearchHit, SearchIndex};
pub use store::GraphStore;
