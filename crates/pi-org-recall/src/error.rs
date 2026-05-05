//! Errors produced by `pi-org-recall`.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
	#[error("tantivy error: {0}")]
	Tantivy(String),
	#[error("io error: {0}")]
	Io(#[from] std::io::Error),
	#[error("repo hash error: {0}")]
	RepoHash(String),
	#[error("schema error: {0}")]
	Schema(String),
	#[error("worker spawn error: {0}")]
	WorkerSpawn(String),
	#[error("embedder error: {0}")]
	Embedder(String),
	#[error("dimension mismatch: expected {expected}, got {actual}")]
	DimensionMismatch { expected: usize, actual: usize },
	#[error("vector index error: {0}")]
	VectorIndex(String),
	#[error("path not found: {0}")]
	PathNotFound(PathBuf),
	#[error("serialization error: {0}")]
	Serialization(String),
}

impl From<tantivy::TantivyError> for Error {
	fn from(value: tantivy::TantivyError) -> Self {
		Self::Tantivy(value.to_string())
	}
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<pi_code_vectors::Error> for Error {
	fn from(value: pi_code_vectors::Error) -> Self {
		match value {
			pi_code_vectors::Error::Embedding(msg) => Self::Embedder(msg),
			pi_code_vectors::Error::Io(e) => Self::Io(e),
			pi_code_vectors::Error::Serialization(e) => Self::Serialization(e.to_string()),
			pi_code_vectors::Error::Chunking(msg) => Self::VectorIndex(msg),
			pi_code_vectors::Error::DimensionMismatch { expected, actual } => {
				Self::DimensionMismatch { expected, actual }
			},
			pi_code_vectors::Error::IncompatibleIndexVersion { found, expected } => {
				Self::VectorIndex(format!("incompatible version: found {found}, expected {expected}"))
			},
		}
	}
}
