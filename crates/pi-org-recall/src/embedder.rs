//! Embedding lane: trait + worker-backed and mock impls.
//!
//! `WorkerEmbedder` spawns a `pi-embedding-worker` subprocess and communicates
//! over stdin/stdout JSON-RPC. The worker is a singleton shared via `OnceLock`.
//! `MockEmbedder` (test-only) produces deterministic 768-dim vectors from the
//! input string via blake3 hashing.

use std::{
	io::{BufRead, BufReader, BufWriter, Write},
	path::PathBuf,
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

// ---------------------------------------------------------------------------
// Trait (unchanged from stub)
// ---------------------------------------------------------------------------

pub trait Embedder: Send + Sync {
	/// Embed a single query string. Returns a vector of `dim()` floats.
	fn embed_query(&self, text: &str) -> Result<Vec<f32>>;
	/// Embed a batch of strings. Returns one vector per input text.
	fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>>;
	/// Dimensionality of returned embeddings.
	fn dim(&self) -> usize;
}

// ---------------------------------------------------------------------------
// WorkerEmbedder — production impl backed by pi-embedding-worker subprocess
// ---------------------------------------------------------------------------

/// Singleton worker handle.
static WORKER: OnceLock<Mutex<Option<WorkerHandle>>> = OnceLock::new();

struct WorkerHandle {
	_child: Child,
	stdin:  BufWriter<ChildStdin>,
	stdout: BufReader<ChildStdout>,
}

#[derive(Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum WorkerCommand {
	Init,
	EmbedQuery { text: String },
	EmbedBatch { texts: Vec<String> },
}

#[derive(Deserialize)]
struct WorkerResponse {
	ok:      bool,
	error:   Option<String>,
	#[serde(default)]
	dim:    Option<usize>,
	#[serde(default)]
	vector: Option<Vec<f32>>,
	#[serde(default)]
	vectors: Option<Vec<Vec<f32>>>,
}

/// Production embedding implementation that delegates to a subprocess worker.
///
/// The worker is spawned lazily on first use and cached for the lifetime of
/// the process.
pub struct WorkerEmbedder {
	dim: usize,
}

impl WorkerEmbedder {
	/// Create a new `WorkerEmbedder`, spawning the worker if needed.
	pub fn new() -> Result<Self> {
		let dim = with_worker(|worker| {
			let resp = worker.request(&WorkerCommand::Init)?;
			if !resp.ok {
				return Err(Error::Embedder(
					resp.error.unwrap_or_else(|| "init failed".to_string()),
				));
			}
			resp.dim.ok_or_else(|| Error::Embedder("init response missing dim".to_string()))
		})?;
		Ok(Self { dim })
	}
}

impl Embedder for WorkerEmbedder {
	fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
		let vector = with_worker(|worker| {
			let resp = worker.request(&WorkerCommand::EmbedQuery {
				text: text.to_owned(),
			})?;
			if !resp.ok {
				return Err(Error::Embedder(
					resp.error.unwrap_or_else(|| "embed_query failed".to_string()),
				));
			}
			resp.vector.ok_or_else(|| {
				Error::Embedder("embed_query response missing vector".to_string())
			})
		})?;
		Ok(vector)
	}

	fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
		let text_owned: Vec<String> = texts.iter().map(|t| (*t).to_owned()).collect();
		let vectors = with_worker(|worker| {
			let resp = worker.request(&WorkerCommand::EmbedBatch {
				texts: text_owned,
			})?;
			if !resp.ok {
				return Err(Error::Embedder(
					resp.error.unwrap_or_else(|| "embed_batch failed".to_string()),
				));
			}
			resp.vectors.ok_or_else(|| {
				Error::Embedder("embed_batch response missing vectors".to_string())
			})
		})?;
		Ok(vectors)
	}

	fn dim(&self) -> usize {
		self.dim
	}
}

// ---------------------------------------------------------------------------
// Worker lifecycle helpers (vendored from pi-natives)
// ---------------------------------------------------------------------------

fn worker_slot() -> &'static Mutex<Option<WorkerHandle>> {
	WORKER.get_or_init(|| Mutex::new(None))
}

fn with_worker<T>(f: impl FnOnce(&mut WorkerHandle) -> Result<T>) -> Result<T> {
	let mut guard = worker_slot()
		.lock()
		.map_err(|e| Error::WorkerSpawn(format!("worker mutex poisoned: {e}")))?;
	if guard.is_none() {
		*guard = Some(spawn_worker()?);
	}
	let result = {
		let worker = guard
			.as_mut()
			.ok_or_else(|| Error::WorkerSpawn("worker failed to initialize".to_string()))?;
		f(worker)
	};
	if result.is_err()
		&& let Some(mut worker) = guard.take()
	{
		let _ = worker._child.kill();
		let _ = worker._child.wait();
	}
	result
}

fn spawn_worker() -> Result<WorkerHandle> {
	let path = binary_path()?;
	let mut child = Command::new(&path)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::inherit())
		.spawn()
		.map_err(|e| {
			Error::WorkerSpawn(format!("failed to spawn {}: {e}", path.display()))
		})?;
	let stdin = child
		.stdin
		.take()
		.ok_or_else(|| Error::WorkerSpawn("failed to capture worker stdin".to_string()))?;
	let stdout = child
		.stdout
		.take()
		.ok_or_else(|| Error::WorkerSpawn("failed to capture worker stdout".to_string()))?;
	Ok(WorkerHandle {
		_child: child,
		stdin: BufWriter::new(stdin),
		stdout: BufReader::new(stdout),
	})
}

impl WorkerHandle {
	fn request(&mut self, command: &WorkerCommand) -> Result<WorkerResponse> {
		self.ensure_running()?;
		serde_json::to_writer(&mut self.stdin, command)
			.map_err(|e| Error::Embedder(format!("failed to encode request: {e}")))?;
		self.stdin
			.write_all(b"\n")
			.map_err(|e| Error::Embedder(format!("failed to write request: {e}")))?;
		self.stdin
			.flush()
			.map_err(|e| Error::Embedder(format!("failed to flush request: {e}")))?;

		let mut line = String::new();
		let bytes = self
			.stdout
			.read_line(&mut line)
			.map_err(|e| Error::Embedder(format!("failed to read response: {e}")))?;
		if bytes == 0 {
			self.ensure_running()?;
			return Err(Error::Embedder("worker exited before sending a response".to_string()));
		}
		serde_json::from_str::<WorkerResponse>(&line)
			.map_err(|e| Error::Embedder(format!("malformed worker response: {e}")))
	}

	fn ensure_running(&mut self) -> Result<()> {
		if let Some(status) = self._child.try_wait().map_err(|e| {
			Error::WorkerSpawn(format!("failed to poll worker state: {e}"))
		})? {
			return Err(Error::WorkerSpawn(format!(
				"worker exited with status {status}"
			)));
		}
		Ok(())
	}
}

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------

fn binary_path() -> Result<PathBuf> {
	if let Ok(p) = std::env::var("SPELL_EMBEDDING_WORKER_BIN") {
		let pb = PathBuf::from(p);
		if pb.is_file() {
			return Ok(pb);
		}
		return Err(Error::WorkerSpawn(format!(
			"SPELL_EMBEDDING_WORKER_BIN={} points to a non-existent file",
			pb.display()
		)));
	}
	if let Ok(p) = std::env::var("PI_EMBEDDING_WORKER") {
		let pb = PathBuf::from(p);
		if pb.is_file() {
			return Ok(pb);
		}
		return Err(Error::WorkerSpawn(format!(
			"PI_EMBEDDING_WORKER={} points to a non-existent file",
			pb.display()
		)));
	}
	// sibling: next to current_exe
	if let Ok(exe) = std::env::current_exe() {
		if let Some(parent) = exe.parent() {
			let candidate = parent.join("pi-embedding-worker");
			if candidate.is_file() {
				return Ok(candidate);
			}
		}
	}
	// PATH lookup
	if let Ok(path) = which_pi_embedding_worker() {
		return Ok(path);
	}
	Err(Error::WorkerSpawn(
		"pi-embedding-worker binary not found; set SPELL_EMBEDDING_WORKER_BIN".into(),
	))
}

fn which_pi_embedding_worker() -> Result<PathBuf> {
	let path_var = std::env::var_os("PATH").unwrap_or_default();
	for dir in std::env::split_paths(&path_var) {
		let candidate = dir.join("pi-embedding-worker");
		if candidate.is_file() {
			return Ok(candidate);
		}
	}
	Err(Error::WorkerSpawn("not found in PATH".to_string()))
}

// ---------------------------------------------------------------------------
// MockEmbedder — deterministic for tests (no worker needed)
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "test-mock"))]
pub struct MockEmbedder {
	pub dim: usize,
}

#[cfg(any(test, feature = "test-mock"))]
impl MockEmbedder {
	pub fn new() -> Self {
		Self { dim: 768 }
	}
}

#[cfg(any(test, feature = "test-mock"))]
impl Embedder for MockEmbedder {
	fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
		Ok(hash_to_normalized_vec(text, self.dim))
	}

	fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
		Ok(texts.iter().map(|t| hash_to_normalized_vec(t, self.dim)).collect())
	}

	fn dim(&self) -> usize {
		self.dim
	}
}

/// Deterministic pseudo-embedding: blake3 hash → bytes → f32 in [-1,1] →
/// normalize.
#[cfg(any(test, feature = "test-mock"))]
fn hash_to_normalized_vec(text: &str, dim: usize) -> Vec<f32> {
	let hash = blake3::hash(text.as_bytes());
	let bytes = hash.as_bytes();
	let mut vec: Vec<f32> = (0..dim)
		.map(|i| {
			let b = bytes[i % 32];
			(b as i8) as f32 / 127.0
		})
		.collect();
	let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
	if norm > 1e-9 {
		for x in &mut vec {
			*x /= norm;
		}
	}
	vec
}
