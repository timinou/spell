pub mod buffer;
pub mod coord;
pub mod diff;
pub mod edit;
pub mod error;
pub mod file_lock;
pub mod language;
pub mod line_target;
pub mod navigate;
pub mod outline;
pub mod procedure;
pub mod resolve;
pub mod watcher;

pub use buffer::{
	BufferInfo, BufferRegistry, BufferSnapshot, CodeBuffer, EditRecord, EditResult,
	RevisionSummary, ScopedUndoResult, TextEdit, TransactionOutcome, workspace_root_for,
};
pub use coord::{
	BrokerEndpoint, CommitResult, CoordClient, IntentResult, JournalEntry, JournalReader,
	JournalWriter, NullCoordClient, PeerEdit, PeerInfo, PeerState, SessionId, SocketCoordClient,
	default_journal_root, derive_code_paths, journal_path_for,
};
pub use diff::{DiffHunk, DiffKind, diff_lines};
pub use edit::{DragDirection, SpliceMode};
pub use error::{CodeEngineError, Result};
pub use language::{LanguageId, LanguageProfile, LanguageRegistry};
pub use procedure::{
	Mark, MatchedNode, Procedure, ProcedureBuilder, ProcedureExecutionResult, ProcedureProof,
	ProcedureResult, Transform, apply_procedure, apply_procedure_transform, run_procedure,
};
pub use resolve::{ResolvedSymbol, resolve_symbol};
