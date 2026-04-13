pub mod cache;
#[cfg(feature = "semantic")]
pub mod chunking;
pub mod error;
#[cfg(feature = "semantic")]
pub mod hybrid;
pub mod indexer;
pub mod language;
pub mod model;
pub mod query;
pub mod search;
pub mod store;

pub use cache::{CacheStatus, CacheStore, FileFingerprint, GraphCacheEntry, GraphFingerprint};
#[cfg(feature = "semantic")]
pub use chunking::{ChunkResult, extract_chunks};
pub use error::{CodeGraphError, Result};
#[cfg(feature = "semantic")]
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
