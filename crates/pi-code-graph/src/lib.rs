pub mod bm25_adapter;
pub mod cache;
pub mod chunking;
pub mod error;
pub mod hybrid;
pub mod indexer;
pub mod language;
pub mod model;
pub mod query;
pub mod semantic;
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
pub use bm25_adapter::SearchHit;
pub use pi_knowledge_core::bm25::SearchIndex;
pub use semantic::{
	classify_hover_dual, lsp::{LspClient, LspRegistry, LspSemanticBackend, ServerSpec},
	merge_hover, AnnotationSemanticBackend,
	Capabilities as SemanticCapabilities, CompositeSemanticBackend, Confidence,
	Diagnostic as SemanticDiagnostic, HoverDual, HoverOutcome, HoverSource, InferResult,
	InlayHint, InlayKind, LineRange, Location as SemanticLocation, RenameError, SemanticBackend,
	Severity as DiagnosticSeverity, SignatureInfo, TextEdit, TypeRepr, TypeSource, WorkspaceEdit,
};
// normalise_for_compare stays module-internal (FUP-097 reviewer DOC-5):
// the only callers are merge_hover (same module) and its tests.
pub use store::GraphStore;
