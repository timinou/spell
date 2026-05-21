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

/// Identifier of the embedder model the worker is expected to use. Persisted
/// in `KnowledgeMeta::embedder_model` so a model swap invalidates every
/// existing vector cache without further intervention. W2 ships Jina v2 base
/// code (768-dim); W2.5 flips this constant + `EMBEDDER_DIM` to bge-m3 and
/// every workspace silently rebuilds on next load.
pub const EMBEDDER_MODEL: &str = "jina-embeddings-v2-base-code";

/// Dimensionality of vectors produced by `EMBEDDER_MODEL`. Must stay in sync.
pub const EMBEDDER_DIM: usize = 768;
const WORKER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
const WORKER_BINARY_NAME: &str = "pi-embedding-worker.exe";
#[cfg(not(windows))]
const WORKER_BINARY_NAME: &str = "pi-embedding-worker";

static WORKER: OnceLock<Mutex<Option<EmbeddingWorker>>> = OnceLock::new();

#[cfg(test)]
static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) fn lock_test_env() -> std::sync::MutexGuard<'static, ()> {
	TEST_ENV_LOCK
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
}

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
	if result.is_err()
		&& let Some(mut worker) = guard.take()
	{
		worker.stop();
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
	if let Some(user_data_dir) = user_data_native_dir() {
		push(user_data_dir.join(WORKER_BINARY_NAME));
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
	user_data_native_dir().map(|dir| dir.join(WORKER_VERSION))
}

fn user_data_native_dir() -> Option<PathBuf> {
	let home = home_dir()?;
	#[cfg(windows)]
	{
		let base = env::var_os("LOCALAPPDATA")
			.map(PathBuf::from)
			.unwrap_or_else(|| home.join("AppData/Local"));
		return Some(base.join("spell/natives"));
	}
	#[cfg(not(windows))]
	{
		Some(home.join(".local/share/spell/natives"))
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
		if !path.contains("pi_natives")
			|| !Path::new(path)
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("node"))
		{
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

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, path::Path, sync::MutexGuard};

	use super::*;

	struct TestWorkerEnv {
		_guard:          MutexGuard<'static, ()>,
		original_worker: Option<OsString>,
		original_mode:   Option<OsString>,
		original_state:  Option<OsString>,
	}

	impl TestWorkerEnv {
		fn new(mode: &str, state_file: Option<&Path>) -> Self {
			let guard = lock_test_env();
			let original_worker = env::var_os(WORKER_ENV_VAR);
			let original_mode = env::var_os("PI_TEST_EMBEDDING_WORKER_MODE");
			let original_state = env::var_os("PI_TEST_EMBEDDING_WORKER_STATE_FILE");
			unsafe {
				env::set_var(WORKER_ENV_VAR, mock_worker_path());
				env::set_var("PI_TEST_EMBEDDING_WORKER_MODE", mode);
				match state_file {
					Some(path) => env::set_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE", path),
					None => env::remove_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE"),
				}
			}
			reset_for_tests();
			Self { _guard: guard, original_worker, original_mode, original_state }
		}
	}

	impl Drop for TestWorkerEnv {
		fn drop(&mut self) {
			unsafe {
				match &self.original_worker {
					Some(value) => env::set_var(WORKER_ENV_VAR, value),
					None => env::remove_var(WORKER_ENV_VAR),
				}
				match &self.original_mode {
					Some(value) => env::set_var("PI_TEST_EMBEDDING_WORKER_MODE", value),
					None => env::remove_var("PI_TEST_EMBEDDING_WORKER_MODE"),
				}
				match &self.original_state {
					Some(value) => env::set_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE", value),
					None => env::remove_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE"),
				}
			}
			reset_for_tests();
		}
	}

	fn mock_worker_path() -> PathBuf {
		let bin_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-bin");
		#[cfg(windows)]
		{
			return bin_dir.join("mock_embedding_worker.cmd");
		}
		#[cfg(not(windows))]
		{
			bin_dir.join("mock_embedding_worker.js")
		}
	}

	fn temp_state_file(name: &str) -> PathBuf {
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("time should be monotonic")
			.as_nanos();
		env::temp_dir().join(format!("pi-natives-{name}-{unique}-{}.state", std::process::id()))
	}

	#[test]
	fn worker_override_supports_successful_batch_and_query() {
		let _env = TestWorkerEnv::new("success", None);

		let batch = embed_batch(&["alpha", "beta"], None).expect("batch embedding should succeed");
		assert_eq!(batch, vec![vec![1.0, 1.0, 2.0], vec![1.0, 2.0, 2.0]]);

		let query = embed_query("graph").expect("query embedding should succeed");
		assert_eq!(query, vec![1.0, 5.0, 1.0]);
	}

	#[test]
	fn worker_restarts_after_malformed_response() {
		let state_file = temp_state_file("malformed-once");
		let _env = TestWorkerEnv::new("malformed_once", Some(&state_file));

		let error = embed_query("retry").expect_err("first request should fail");
		assert!(
			error
				.to_string()
				.contains("received malformed worker response"),
			"error should surface malformed response: {error}"
		);

		let query = embed_query("retry").expect("worker should restart after malformed response");
		assert_eq!(query, vec![1.0, 5.0, 1.0]);
		let _ = fs::remove_file(state_file);
	}
}
