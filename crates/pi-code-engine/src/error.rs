use std::path::PathBuf;

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

	#[error("{message}")]
	Refusal {
		message:    String,
		reason:     String,
		confidence: String,
		basis:      String,
		matches:    Option<usize>,
	},
}

pub type Result<T> = std::result::Result<T, CodeEngineError>;
