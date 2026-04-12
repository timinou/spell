use std::{
	collections::HashSet,
	env, fs,
	io::{BufRead, BufReader, BufWriter, Write},
	path::{Path, PathBuf},
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	sync::{Mutex, OnceLock},
};

use napi::{Error, Result};
use serde::{Deserialize, Serialize};

const WORKER_ENV_VAR: &str = "PI_EMBEDDING_WORKER";
const WORKER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
const WORKER_BINARY_NAME: &str = "pi-embedding-worker.exe";
#[cfg(not(windows))]
const WORKER_BINARY_NAME: &str = "pi-embedding-worker";

static WORKER: OnceLock<Mutex<Option<EmbeddingWorker>>> = OnceLock::new();

#[allow(dead_code, reason = "explicit init remains part of the worker protocol")]
#[derive(Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum WorkerCommand {
	Init,
	EmbedBatch { texts: Vec<String>, batch_size: Option<usize> },
	EmbedQuery { text: String },
}

#[derive(Deserialize)]
struct WorkerResponse {
	ok:      bool,
	error:   Option<String>,
	vectors: Option<Vec<Vec<f32>>>,
	vector:  Option<Vec<f32>>,
}

struct EmbeddingWorker {
	child:  Child,
	stdin:  BufWriter<ChildStdin>,
	stdout: BufReader<ChildStdout>,
	path:   PathBuf,
}

impl EmbeddingWorker {
	fn spawn() -> Result<Self> {
		let path = resolve_worker_path()?;
		let mut child = Command::new(&path)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit())
			.spawn()
			.map_err(|error| worker_error(format!("failed to spawn {}: {error}", path.display())))?;
		let stdin = child
			.stdin
			.take()
			.ok_or_else(|| worker_error("failed to capture worker stdin"))?;
		let stdout = child
			.stdout
			.take()
			.ok_or_else(|| worker_error("failed to capture worker stdout"))?;
		Ok(Self { child, stdin: BufWriter::new(stdin), stdout: BufReader::new(stdout), path })
	}

	fn request(&mut self, command: &WorkerCommand) -> Result<WorkerResponse> {
		self.ensure_running()?;
		serde_json::to_writer(&mut self.stdin, command)
			.map_err(|error| worker_error(format!("failed to encode request: {error}")))?;
		self
			.stdin
			.write_all(b"\n")
			.map_err(|error| worker_error(format!("failed to write request: {error}")))?;
		self
			.stdin
			.flush()
			.map_err(|error| worker_error(format!("failed to flush request: {error}")))?;

		let mut line = String::new();
		let bytes = self
			.stdout
			.read_line(&mut line)
			.map_err(|error| worker_error(format!("failed to read response: {error}")))?;
		if bytes == 0 {
			self.ensure_running()?;
			return Err(worker_error("worker exited before sending a response"));
		}
		serde_json::from_str::<WorkerResponse>(&line)
			.map_err(|error| worker_error(format!("received malformed worker response: {error}")))
	}

	fn ensure_running(&mut self) -> Result<()> {
		if let Some(status) = self
			.child
			.try_wait()
			.map_err(|error| worker_error(format!("failed to poll worker state: {error}")))?
		{
			return Err(worker_error(format!(
				"worker exited with status {status} ({})",
				self.path.display()
			)));
		}
		Ok(())
	}

	fn stop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

fn worker_slot() -> &'static Mutex<Option<EmbeddingWorker>> {
	WORKER.get_or_init(|| Mutex::new(None))
}

pub fn embed_batch(texts: &[&str], batch_size: Option<usize>) -> Result<Vec<Vec<f32>>> {
	let response = with_worker(|worker| {
		worker
			.request(&WorkerCommand::EmbedBatch {
				texts: texts.iter().map(|text| (*text).to_owned()).collect(),
				batch_size,
			})
			.and_then(expect_ok)
	})?;
	response
		.vectors
		.ok_or_else(|| worker_error("worker response missing `vectors` field"))
}

pub fn embed_query(text: &str) -> Result<Vec<f32>> {
	let response = with_worker(|worker| {
		worker
			.request(&WorkerCommand::EmbedQuery { text: text.to_owned() })
			.and_then(expect_ok)
	})?;
	response
		.vector
		.ok_or_else(|| worker_error("worker response missing `vector` field"))
}

fn with_worker<T>(f: impl FnOnce(&mut EmbeddingWorker) -> Result<T>) -> Result<T> {
	let mut guard = worker_slot()
		.lock()
		.map_err(|error| worker_error(format!("worker mutex poisoned: {error}")))?;
	if guard.is_none() {
		*guard = Some(EmbeddingWorker::spawn()?);
	}
	let result = {
		let worker = guard
			.as_mut()
			.ok_or_else(|| worker_error("worker failed to initialize"))?;
		f(worker)
	};
	if result.is_err() {
		if let Some(mut worker) = guard.take() {
			worker.stop();
		}
	}
	result
}

fn expect_ok(response: WorkerResponse) -> Result<WorkerResponse> {
	if response.ok {
		return Ok(response);
	}
	let reason = response
		.error
		.unwrap_or_else(|| "worker returned an unknown error".to_string());
	Err(worker_error(format!("worker request failed: {reason}")))
}

fn resolve_worker_path() -> Result<PathBuf> {
	if let Some(override_path) = env::var_os(WORKER_ENV_VAR).filter(|value| !value.is_empty()) {
		let candidate = PathBuf::from(override_path);
		return validate_override_path(candidate);
	}

	let candidates = worker_candidates();
	for candidate in &candidates {
		if candidate.is_file() {
			return Ok(candidate.clone());
		}
	}

	let checked = candidates
		.iter()
		.map(|path| format!("  - {}", path.display()))
		.collect::<Vec<_>>()
		.join("\n");
	Err(worker_error(format!(
		"worker binary not found. Checked:\n{checked}\nEnsure {WORKER_BINARY_NAME} is installed \
		 alongside the native addon or set {WORKER_ENV_VAR}."
	)))
}

fn validate_override_path(path: PathBuf) -> Result<PathBuf> {
	if path.is_file() {
		return Ok(path);
	}
	Err(worker_error(format!(
		"{WORKER_ENV_VAR} points to {}, but that file does not exist. Ensure {WORKER_BINARY_NAME} \
		 is installed alongside the native addon or update {WORKER_ENV_VAR}.",
		path.display()
	)))
}

fn worker_candidates() -> Vec<PathBuf> {
	let mut candidates = Vec::new();
	let mut seen = HashSet::new();
	let mut push = |path: PathBuf| {
		if seen.insert(path.clone()) {
			candidates.push(path);
		}
	};

	push(dev_native_dir().join(WORKER_BINARY_NAME));
	if let Some(addon_dir) = loaded_addon_dir() {
		push(addon_dir.join(WORKER_BINARY_NAME));
	}
	if let Some(exec_dir) = current_exe_dir() {
		push(exec_dir.join(WORKER_BINARY_NAME));
	}
	if let Some(versioned_dir) = versioned_native_dir() {
		push(versioned_dir.join(WORKER_BINARY_NAME));
	}
	candidates
}

fn dev_native_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/natives/native")
}

fn current_exe_dir() -> Option<PathBuf> {
	env::current_exe()
		.ok()
		.and_then(|path| path.parent().map(Path::to_path_buf))
}

fn versioned_native_dir() -> Option<PathBuf> {
	let home = home_dir()?;
	#[cfg(windows)]
	{
		let base = env::var_os("LOCALAPPDATA")
			.map(PathBuf::from)
			.unwrap_or_else(|| home.join("AppData/Local"));
		return Some(base.join("spell/natives").join(WORKER_VERSION));
	}
	#[cfg(not(windows))]
	{
		Some(home.join(".local/share/spell/natives").join(WORKER_VERSION))
	}
}

fn home_dir() -> Option<PathBuf> {
	env::var_os("HOME")
		.map(PathBuf::from)
		.or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn worker_error(message: impl Into<String>) -> Error {
	Error::from_reason(format!("Embedding worker unavailable: {}", message.into()))
}

#[cfg(target_os = "linux")]
fn loaded_addon_dir() -> Option<PathBuf> {
	let maps = fs::read_to_string("/proc/self/maps").ok()?;
	for line in maps.lines() {
		let path = line.split_whitespace().last()?;
		if !path.contains("pi_natives") || !path.ends_with(".node") {
			continue;
		}
		let cleaned = path.strip_suffix(" (deleted)").unwrap_or(path);
		if let Some(parent) = Path::new(cleaned).parent() {
			return Some(parent.to_path_buf());
		}
	}
	None
}

#[cfg(not(target_os = "linux"))]
fn loaded_addon_dir() -> Option<PathBuf> {
	None
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
	if let Some(slot) = WORKER.get()
		&& let Ok(mut guard) = slot.lock()
		&& let Some(mut worker) = guard.take()
	{
		worker.stop();
	}
}
