use std::{io, path::PathBuf};

use thiserror::Error;

pub type Result<T> = std::result::Result<T, BrokerError>;

#[derive(Debug, Error)]
pub enum BrokerError {
	#[error("io error: {0}")]
	Io(#[from] io::Error),
	#[error("json error: {0}")]
	Json(#[from] serde_json::Error),
	#[error("broker spawn timeout: socket {socket} did not appear within {timeout_ms}ms")]
	BrokerSpawnTimeout { socket: PathBuf, timeout_ms: u64 },
	#[error("broker binary not found via env, sibling exe, or PATH")]
	BrokerBinaryNotFound,
}
