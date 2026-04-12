/// Errors produced by the pi-code-vectors crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
	#[error("Embedding model error: {0}")]
	Embedding(String),
	#[error("IO error: {0}")]
	Io(#[from] std::io::Error),
	#[error("Serialization error: {0}")]
	Serialization(#[from] bincode::Error),
	#[error("Chunking error: {0}")]
	Chunking(String),
	#[error("Vector dimension mismatch: expected {expected}, got {actual}")]
	DimensionMismatch { expected: usize, actual: usize },
}

pub type Result<T> = std::result::Result<T, Error>;
