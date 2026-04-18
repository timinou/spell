use std::{path::PathBuf, time::SystemTime};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CodeEngineError {
	#[error("I/O error: {0}")]
	Io(#[from] std::io::Error),
	#[error("parse error in {language} file {}: {message}", path.display())]
	Parse { language: String, path: PathBuf, message: String },
	#[error("language not found for path: {}", .0.display())]
	LanguageNotFound(PathBuf),
	#[error("language profile error: {0}")]
	Profile(String),
	#[error("duplicate language registration: {0}")]
	DuplicateLanguage(String),
	#[error("extension conflict: .{ext} already registered to {existing}")]
	ExtensionConflict { ext: String, existing: String },
	#[error("tree-sitter error: {0}")]
	TreeSitter(String),
	#[error("buffer error: {0}")]
	Buffer(String),
	#[error("edit error: {0}")]
	Edit(String),
	#[error("external modification detected for {} (disk: {disk_mtime:?}, buffer: {buffer_mtime:?})", path.display())]
	ExternalModification {
		path:         PathBuf,
		disk_mtime:   Option<SystemTime>,
		buffer_mtime: Option<SystemTime>,
	},
	#[error(
		"{action} refused: replacement drops {} sibling declarations ({}); pass allowSiblingDelete:true to force",
		lost_decls.len(),
		lost_decls.join(", ")
	)]
	UnsafeScopeWrite {
		action:     String,
		lost_decls: Vec<String>,
		original:   usize,
		new:        usize,
	},
	#[error(
		"line {line} is outside the target declaration span ({target_start}..{target_end}); \
		 positional actions under a declaration targetId must anchor a line inside that declaration"
	)]
	LineOutOfTargetScope { line: usize, target_start: usize, target_end: usize },
	#[error(
		"timed out waiting {budget_ms}ms for advisory file lock on {}",
		path.display()
	)]
	LockTimeout { path: PathBuf, budget_ms: u64 },
	#[error("failed to acquire advisory file lock on {}: {reason}", path.display())]
	LockAcquireFailed { path: PathBuf, reason: String },
	#[error("{message}")]
	Refusal {
		message:    String,
		reason:     String,
		confidence: String,
		basis:      String,
		matches:    Option<usize>,
	},
	#[error(
		"peer session {session} committed {code_path} at {peer_commit_ts} (revision {peer_revision}) in {}",
		path.display()
	)]
	PeerConflict {
		session:        String,
		path:           PathBuf,
		code_path:      String,
		peer_revision:  u64,
		peer_commit_ts: u64,
	},
}

pub type Result<T> = std::result::Result<T, CodeEngineError>;
