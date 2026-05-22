#[derive(Debug, thiserror::Error)]
pub enum Error {
	#[error("I/O error: {0}")]
	Io(#[from] std::io::Error),
	#[error("bincode error: {0}")]
	Bincode(#[from] bincode::Error),
	#[error("cache error: {0}")]
	Cache(#[from] pi_workspace_cache::WorkspaceCacheError),
	#[error("usearch error: {0}")]
	Usearch(String),
	#[error("embedder error: {0}")]
	Embedder(String),
	#[error("watcher error: {0}")]
	Watcher(String),
	#[error("{0}")]
	Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
