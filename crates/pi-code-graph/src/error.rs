use std::{fmt, io, path::PathBuf};

#[derive(Debug)]
pub enum CodeGraphError {
	Io(io::Error),
	Serialize(bincode::Error),
	WorkspaceCache(pi_workspace_cache::WorkspaceCacheError),
	UnsupportedLanguage(PathBuf),
	DuplicateLanguage(String),
	MissingLanguage(String),
	Parse { language: String, path: PathBuf, message: String },
	InvalidRoot(PathBuf),
}

impl fmt::Display for CodeGraphError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(err) => write!(f, "I/O error: {err}"),
			Self::Serialize(err) => write!(f, "serialization error: {err}"),
			Self::WorkspaceCache(err) => write!(f, "workspace cache error: {err}"),
			Self::UnsupportedLanguage(path) => {
				write!(f, "unsupported language for path {}", path.display())
			},
			Self::DuplicateLanguage(language) => {
				write!(f, "duplicate language registration: {language}")
			},
			Self::MissingLanguage(language) => write!(f, "missing language registration: {language}"),
			Self::Parse { language, path, message } => {
				write!(f, "failed to parse {} file {}: {message}", language, path.display())
			},
			Self::InvalidRoot(path) => write!(f, "invalid graph root {}", path.display()),
		}
	}
}

impl std::error::Error for CodeGraphError {}

impl From<io::Error> for CodeGraphError {
	fn from(value: io::Error) -> Self {
		Self::Io(value)
	}
}

impl From<bincode::Error> for CodeGraphError {
	fn from(value: bincode::Error) -> Self {
		Self::Serialize(value)
	}
}

impl From<pi_workspace_cache::WorkspaceCacheError> for CodeGraphError {
	fn from(value: pi_workspace_cache::WorkspaceCacheError) -> Self {
		Self::WorkspaceCache(value)
	}
}

pub type Result<T> = std::result::Result<T, CodeGraphError>;
