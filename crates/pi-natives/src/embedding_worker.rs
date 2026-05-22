
/// Execution mode for the knowledge daemon dispatch path.
///
/// - `Daemon`: route recall queries over the Unix socket to the
///   user-scoped `pi-knowledge-worker`; fail-loud on RPC errors.
/// - `Inprocess`: bypass the daemon entirely; use the in-process
///   `WarmEngine` directly (useful for CI, offline, and tests).
///
/// Set via `PI_KNOWLEDGE_WORKER=inprocess` (case-insensitive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerMode {
	Daemon,
	Inprocess,
}

static WORKER_MODE: OnceLock<Mutex<Option<WorkerMode>>> = OnceLock::new();

/// Return the resolved worker mode. Reads `PI_KNOWLEDGE_WORKER` from env
/// once at first call; subsequent calls return the cached value. Defaults
/// to [`WorkerMode::Daemon`].
pub fn worker_mode() -> WorkerMode {
	let slot = WORKER_MODE.get_or_init(|| Mutex::new(None));
	let mut guard = slot.lock().expect("worker mode mutex poisoned");
	*guard.get_or_insert_with(read_worker_mode_from_env)
}

/// Re-read `PI_KNOWLEDGE_WORKER` from env on the next call to
/// [`worker_mode()`]. This is NOT thread-safe with respect to concurrent
/// [`worker_mode()`] callers that already resolved — intended for test
/// teardown where no concurrent access exists.
pub fn reset_worker_mode_for_tests() {
	if let Some(slot) = WORKER_MODE.get()
		&& let Ok(mut guard) = slot.lock()
	{
		*guard = None;
	}
}

fn read_worker_mode_from_env() -> WorkerMode {
	match env::var("PI_KNOWLEDGE_WORKER") {
		Ok(v) if v.eq_ignore_ascii_case("inprocess") => WorkerMode::Inprocess,
		Ok(v) => {
			eprintln!(
				"[pi-natives] warning: unknown PI_KNOWLEDGE_WORKER value \"{v}\", expected \"inprocess\" or a binary path; defaulting to worker mode Daemon"
			);
			WorkerMode::Daemon
		},
		Err(_) => WorkerMode::Daemon,
	}
}

use std::{
	collections::HashSet,
	env, fs,
	io::{BufRead, BufReader, BufWriter, Write},
	path::{Path, PathBuf},
	process::{Child, ChildStdin, ChildStdout, Command, Stdio},
	sync::{Mutex, OnceLock},
	time::{Duration, Instant},
};

#[cfg(unix)]
use std::{os::unix::net::UnixStream, thread};

use napi::{Error, Result};
use serde::{Deserialize, Serialize};

/// Primary client env var (PLAN-315). Falls back to `WORKER_ENV_VAR_LEGACY`.
const WORKER_ENV_VAR: &str = "PI_KNOWLEDGE_WORKER";
/// Legacy name retained for one release after PLAN-315 rename.
const WORKER_ENV_VAR_LEGACY: &str = "PI_EMBEDDING_WORKER";
/// Override for the user-scoped daemon socket (PLAN-315). Falls back to
/// `WORKER_SOCKET_ENV_VAR_LEGACY`.
const WORKER_SOCKET_ENV_VAR: &str = "PI_KNOWLEDGE_WORKER_SOCKET";
const WORKER_SOCKET_ENV_VAR_LEGACY: &str = "PI_EMBEDDING_WORKER_SOCKET";

/// Helper: read env var, preferring new name then legacy.
fn read_worker_env() -> Option<std::ffi::OsString> {
	let val = env::var_os(WORKER_ENV_VAR).or_else(|| env::var_os(WORKER_ENV_VAR_LEGACY));
	// "inprocess" is a mode signal, not a binary path — fall through to legacy.
	if val.as_deref().is_some_and(|v| v.eq_ignore_ascii_case("inprocess")) {
		return env::var_os(WORKER_ENV_VAR_LEGACY);
	}
	val
}

fn read_worker_socket_env() -> Option<std::ffi::OsString> {
	env::var_os(WORKER_SOCKET_ENV_VAR).or_else(|| env::var_os(WORKER_SOCKET_ENV_VAR_LEGACY))
}

/// Identifier of the embedder model the worker is expected to use. Persisted
/// in `KnowledgeMeta::embedder_model` so a model swap invalidates every
/// existing vector cache without further intervention. W2 ships Jina v2 base
/// code (768-dim). W2.5 flipped it to BAAI/bge-m3 (1024-dim, multilingual)
/// to unify code-graph + memory embedding lanes.
/// every workspace silently rebuilds on next load.
pub const EMBEDDER_MODEL: &str = "BAAI/bge-m3";

/// Dimensionality of vectors produced by `EMBEDDER_MODEL`. Must stay in sync.
pub const EMBEDDER_DIM: usize = 1024;
const WORKER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
const WORKER_BINARY_NAME: &str = "pi-knowledge-worker.exe";
#[cfg(windows)]
const WORKER_BINARY_NAME_LEGACY: &str = "pi-embedding-worker.exe";
#[cfg(not(windows))]
const WORKER_BINARY_NAME: &str = "pi-knowledge-worker";
#[cfg(not(windows))]
const WORKER_BINARY_NAME_LEGACY: &str = "pi-embedding-worker";

/// Maximum time we wait for a freshly-spawned daemon to bind its socket. After
/// this we give up Path 2 and fall back to the in-process subprocess (Path 3).
#[cfg(unix)]
const DAEMON_SPAWN_DEADLINE: Duration = Duration::from_secs(5);
#[cfg(unix)]
const DAEMON_SPAWN_POLL: Duration = Duration::from_millis(25);

static WORKER: OnceLock<Mutex<Option<WorkerTransport>>> = OnceLock::new();

#[cfg(test)]
static TEST_ENV_LOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());

/// Acquire exclusive (writer) access to process env state. Tests that
/// mutate HOME/PI_EMBEDDING_WORKER/WORKER must hold this guard.
#[cfg(test)]
pub(crate) fn lock_test_env() -> std::sync::RwLockWriteGuard<'static, ()> {
	TEST_ENV_LOCK
		.write()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Acquire shared (reader) access to process env state. Tests that only
/// *read* HOME via subprocess (e.g. `git init`, `ignore::WalkBuilder`)
/// take this guard so they can run in parallel with each other but
/// block any writer mid-transition.
#[cfg(test)]
pub(crate) fn lock_test_env_read() -> std::sync::RwLockReadGuard<'static, ()> {
	TEST_ENV_LOCK
		.read()
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

/// Generic knowledge-protocol request body. Used for the PLAN-315
/// open/close/stats/search/about/neighbors/since commands. Each variant
/// is `(command_name, args_json)`; the wire frame is constructed by hand
/// rather than via `Serialize` so the args can be an arbitrary `Value`.
#[derive(Debug, Clone)]
pub(crate) struct KnowledgeRequest {
	pub(crate) command: &'static str,
	pub(crate) args:    serde_json::Value,
}

impl Serialize for KnowledgeRequest {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
		use serde::ser::SerializeMap;
		let args_obj = self.args.as_object();
		let field_count = 1 + args_obj.map_or(0, serde_json::Map::len);
		let mut map = serializer.serialize_map(Some(field_count))?;
		map.serialize_entry("command", self.command)?;
		if let Some(obj) = args_obj {
			for (k, v) in obj {
				map.serialize_entry(k, v)?;
			}
		}
		map.end()
	}
}

#[derive(Deserialize)]
struct WorkerResponse {
	ok:      bool,
	error:   Option<String>,
	vectors: Option<Vec<Vec<f32>>>,
	vector:  Option<Vec<f32>>,
}

/// Daemon capabilities learned at `init` time. Cached on the transport so
/// repeated `supports()` calls don't re-init. PLAN-315 W1 ships v=2; v=1
/// is the pre-rename embedder daemon with embed_* only.
#[derive(Debug, Default, Clone)]
pub struct Capabilities {
	pub protocol_version:   u32,
	pub supported_commands: Vec<String>,
}

impl Capabilities {
	pub fn supports(&self, cmd: &str) -> bool {
		self.supported_commands.iter().any(|c| c == cmd)
	}

	pub fn knowledge_capable(&self) -> bool {
		self.protocol_version >= 2 && self.supports("search")
	}
}

/// One of two transport modes used by the client. `Subprocess` is the
/// legacy per-process stdin/stdout worker (and the path tests still drive
/// via `PI_EMBEDDING_WORKER`). `Socket` talks to the shared user-scoped
/// daemon over a Unix domain socket.
enum WorkerTransport {
	Subprocess(EmbeddingWorker),
	#[cfg(unix)]
	Socket(SocketClient),
}

impl WorkerTransport {
	fn request(&mut self, command: &WorkerCommand) -> Result<WorkerResponse> {
		match self {
			Self::Subprocess(worker) => worker.request(command),
			#[cfg(unix)]
			Self::Socket(client) => client.request(command),
		}
	}

	/// PLAN-315 W2: request a knowledge-protocol command, returning the raw
	/// JSON response. Used by the search/about/neighbors/since dispatch path.
	fn request_raw(&mut self, request: &KnowledgeRequest) -> Result<serde_json::Value> {
		match self {
			Self::Subprocess(worker) => worker.request_raw(request),
			#[cfg(unix)]
			Self::Socket(client) => client.request_raw(request),
		}
	}

	fn stop(&mut self) {
		match self {
			Self::Subprocess(worker) => worker.stop(),
			#[cfg(unix)]
			Self::Socket(_) => { /* dropping the stream is enough */ },
		}
	}
}

/// Static capability cache. Populated on first successful `init` against
/// the active transport; cleared by `reset_for_tests`.
static CAPS: OnceLock<Mutex<Option<Capabilities>>> = OnceLock::new();

fn caps_slot() -> &'static Mutex<Option<Capabilities>> {
	CAPS.get_or_init(|| Mutex::new(None))
}

/// Return cached capabilities, performing `init` if necessary. Best-effort:
/// on transport failure returns empty (v=0, no commands) so callers fall
/// through to the in-process WarmEngine path.
pub fn capabilities() -> Capabilities {
	if let Ok(guard) = caps_slot().lock()
		&& let Some(caps) = guard.as_ref()
	{
		return caps.clone();
	}
	let init_req = KnowledgeRequest { command: "init", args: serde_json::Value::Object(Default::default()) };
	let caps = match with_worker(|worker| worker.request_raw(&init_req)) {
		Ok(response) => parse_capabilities(&response),
		Err(_) => Capabilities::default(),
	};
	if let Ok(mut guard) = caps_slot().lock() {
		*guard = Some(caps.clone());
	}
	caps
}

/// Convenience: does the active transport speak protocol v2 with the
/// knowledge surface? Memoised via `CAPS`.
pub fn knowledge_capable() -> bool {
	capabilities().knowledge_capable()
}

/// Issue a knowledge-protocol command and return the raw response object.
/// Caller is responsible for checking the `ok` field and decoding
/// command-specific payload fields.
pub fn knowledge_request(
	command: &'static str,
	args: serde_json::Value,
) -> Result<serde_json::Value> {
	with_worker(|worker| worker.request_raw(&KnowledgeRequest { command, args }))
}

fn parse_capabilities(response: &serde_json::Value) -> Capabilities {
	if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
		return Capabilities::default();
	}
	let protocol_version = response
		.get("protocol_version")
		.and_then(serde_json::Value::as_u64)
		.unwrap_or(1) as u32;
	let supported_commands = response
		.get("supported_commands")
		.and_then(serde_json::Value::as_array)
		.map(|arr| {
			arr.iter()
				.filter_map(|v| v.as_str().map(str::to_owned))
				.collect()
		})
		.unwrap_or_default();
	Capabilities { protocol_version, supported_commands }
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

	fn request_raw(&mut self, request: &KnowledgeRequest) -> Result<serde_json::Value> {
		self.ensure_running()?;
		serde_json::to_writer(&mut self.stdin, request)
			.map_err(|error| worker_error(format!("failed to encode raw request: {error}")))?;
		self.stdin
			.write_all(b"\n")
			.map_err(|error| worker_error(format!("failed to write raw request: {error}")))?;
		self.stdin
			.flush()
			.map_err(|error| worker_error(format!("failed to flush raw request: {error}")))?;

		let mut line = String::new();
		let bytes = self
			.stdout
			.read_line(&mut line)
			.map_err(|error| worker_error(format!("failed to read raw response: {error}")))?;
		if bytes == 0 {
			self.ensure_running()?;
			return Err(worker_error("worker exited before sending a raw response"));
		}
		serde_json::from_str::<serde_json::Value>(&line)
			.map_err(|error| worker_error(format!("received malformed raw response: {error}")))
	}

	fn stop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

/// Shared-daemon Unix-socket transport. Same JSON-RPC framing as
/// `EmbeddingWorker`: one request line in, one response line out.
#[cfg(unix)]
struct SocketClient {
	socket_path: PathBuf,
	reader:      BufReader<UnixStream>,
	writer:      BufWriter<UnixStream>,
}

#[cfg(unix)]
impl SocketClient {
	fn connect(socket_path: PathBuf, stream: UnixStream) -> Result<Self> {
		let writer_stream = stream.try_clone().map_err(|error| {
			worker_error(format!(
				"failed to clone socket handle for {}: {error}",
				socket_path.display()
			))
		})?;
		Ok(Self {
			socket_path,
			reader: BufReader::new(stream),
			writer: BufWriter::new(writer_stream),
		})
	}

	fn request(&mut self, command: &WorkerCommand) -> Result<WorkerResponse> {
		serde_json::to_writer(&mut self.writer, command).map_err(|error| {
			worker_error(format!(
				"failed to encode socket request to {}: {error}",
				self.socket_path.display()
			))
		})?;
		self.writer.write_all(b"\n").map_err(|error| {
			worker_error(format!(
				"failed to write socket request to {}: {error}",
				self.socket_path.display()
			))
		})?;
		self.writer.flush().map_err(|error| {
			worker_error(format!(
				"failed to flush socket request to {}: {error}",
				self.socket_path.display()
			))
		})?;

		let mut line = String::new();
		let bytes = self.reader.read_line(&mut line).map_err(|error| {
			worker_error(format!(
				"failed to read socket response from {}: {error}",
				self.socket_path.display()
			))
		})?;
		if bytes == 0 {
			return Err(worker_error(format!(
				"daemon closed socket {} before sending a response",
				self.socket_path.display()
			)));
		}
		serde_json::from_str::<WorkerResponse>(&line)
			.map_err(|error| worker_error(format!("received malformed daemon response: {error}")))
	}

	fn request_raw(&mut self, request: &KnowledgeRequest) -> Result<serde_json::Value> {
		serde_json::to_writer(&mut self.writer, request).map_err(|error| {
			worker_error(format!(
				"failed to encode raw socket request to {}: {error}",
				self.socket_path.display()
			))
		})?;
		self.writer.write_all(b"\n").map_err(|error| {
			worker_error(format!(
				"failed to write raw socket request to {}: {error}",
				self.socket_path.display()
			))
		})?;
		self.writer.flush().map_err(|error| {
			worker_error(format!(
				"failed to flush raw socket request to {}: {error}",
				self.socket_path.display()
			))
		})?;

		let mut line = String::new();
		let bytes = self.reader.read_line(&mut line).map_err(|error| {
			worker_error(format!(
				"failed to read raw socket response from {}: {error}",
				self.socket_path.display()
			))
		})?;
		if bytes == 0 {
			return Err(worker_error(format!(
				"daemon closed socket {} before sending a raw response",
				self.socket_path.display()
			)));
		}
		serde_json::from_str::<serde_json::Value>(&line)
			.map_err(|error| worker_error(format!("received malformed raw daemon response: {error}")))
	}
}

fn worker_slot() -> &'static Mutex<Option<WorkerTransport>> {
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

fn with_worker<T>(f: impl FnOnce(&mut WorkerTransport) -> Result<T>) -> Result<T> {
	let mut guard = worker_slot()
		.lock()
		.map_err(|error| worker_error(format!("worker mutex poisoned: {error}")))?;
	if guard.is_none() {
		*guard = Some(acquire()?);
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

/// Choose a transport for the next request. Precedence:
///
/// 1. `PI_EMBEDDING_WORKER` set → always per-process subprocess (preserves
///    test fixtures that point at the mock binary).
/// 2. `PI_EMBEDDING_WORKER_SOCKET` or the default daemon socket reachable →
///    use the shared user-scoped daemon (PLAN-310 W3).
/// 3. Default daemon binary resolvable → spawn it, wait for its socket, and
///    use it.
/// 4. Otherwise fall back to the in-process subprocess so the existing
///    behaviour still works (CI containers without `XDG_RUNTIME_DIR`, etc.).
fn acquire() -> Result<WorkerTransport> {
	if read_worker_env()
		.as_ref()
		.is_some_and(|value| !value.is_empty())
	{
		return Ok(WorkerTransport::Subprocess(EmbeddingWorker::spawn()?));
	}

	#[cfg(unix)]
	{
		let socket = explicit_socket_or_default();
		if let Ok(stream) = UnixStream::connect(&socket) {
			return Ok(WorkerTransport::Socket(SocketClient::connect(socket, stream)?));
		}
		if let Ok(daemon_bin) = resolve_worker_path()
			&& spawn_daemon(&daemon_bin, &socket).is_ok()
			&& wait_for_socket(&socket, DAEMON_SPAWN_DEADLINE).is_ok()
			&& let Ok(stream) = UnixStream::connect(&socket)
		{
			return Ok(WorkerTransport::Socket(SocketClient::connect(socket, stream)?));
		}
	}

	Ok(WorkerTransport::Subprocess(EmbeddingWorker::spawn()?))
}

/// Where the user-scoped daemon binds. PLAN-310 W3.
///
/// Order of preference:
/// - `$XDG_RUNTIME_DIR/spell/embed.sock`
/// - `/tmp/spell-<uid>/embed.sock` (fallback when `XDG_RUNTIME_DIR` is unset,
///   which is rare on Linux but happens inside minimal containers).
#[cfg(unix)]
fn default_socket_path() -> PathBuf {
	let base: PathBuf = if let Some(xdg) =
		env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty())
	{
		PathBuf::from(xdg).join("spell")
	} else {
		// SAFETY: `getuid` is always safe — it cannot fail and has no side effects.
		let uid = unsafe { libc::getuid() };
		PathBuf::from(format!("/tmp/spell-{uid}"))
	};
	let primary = base.join("knowledge.sock");
	let legacy = base.join("embed.sock");
	// If the legacy socket exists and the primary does not, prefer the
	// legacy path (so a daemon spawned by an older client is reached).
	// Otherwise the new primary name is canonical.
	if !primary.exists() && legacy.exists() {
		return legacy;
	}
	primary
}

#[cfg(unix)]
fn explicit_socket_or_default() -> PathBuf {
	if let Some(value) = read_worker_socket_env().filter(|value| !value.is_empty()) {
		return PathBuf::from(value);
	}
	default_socket_path()
}

#[cfg(unix)]
fn spawn_daemon(binary: &Path, socket: &Path) -> Result<()> {
	Command::new(binary)
		.arg("--socket")
		.arg(socket)
		.arg("--daemonize")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.map(|_| ())
		.map_err(|error| {
			worker_error(format!(
				"failed to spawn daemon {} for socket {}: {error}",
				binary.display(),
				socket.display()
			))
		})
}

#[cfg(unix)]
fn wait_for_socket(socket: &Path, deadline: Duration) -> Result<()> {
	let start = Instant::now();
	while start.elapsed() < deadline {
		if UnixStream::connect(socket).is_ok() {
			return Ok(());
		}
		thread::sleep(DAEMON_SPAWN_POLL);
	}
	Err(worker_error(format!(
		"daemon socket {} did not appear within {} ms",
		socket.display(),
		deadline.as_millis()
	)))
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
	if let Some(override_path) = env::var_os(WORKER_ENV_VAR)
		.filter(|value| !value.is_empty())
		.filter(|value| !value.eq_ignore_ascii_case("inprocess"))
	{
		return validate_override_path(PathBuf::from(override_path), WORKER_ENV_VAR);
	}
	if let Some(override_path) =
		env::var_os(WORKER_ENV_VAR_LEGACY).filter(|value| !value.is_empty())
	{
		return validate_override_path(PathBuf::from(override_path), WORKER_ENV_VAR_LEGACY);
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

fn validate_override_path(path: PathBuf, env_var_source: &str) -> Result<PathBuf> {
	if path.is_file() {
		return Ok(path);
	}
	Err(worker_error(format!(
		"{env_var_source} points to {}, but that file does not exist. Ensure {WORKER_BINARY_NAME} \
		 is installed alongside the native addon or update {env_var_source}.",
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

	for name in [WORKER_BINARY_NAME, WORKER_BINARY_NAME_LEGACY] {
		push(dev_native_dir().join(name));
		if let Some(addon_dir) = loaded_addon_dir() {
			push(addon_dir.join(name));
		}
		if let Some(exec_dir) = current_exe_dir() {
			push(exec_dir.join(name));
		}
		if let Some(versioned_dir) = versioned_native_dir() {
			push(versioned_dir.join(name));
		}
		if let Some(user_data_dir) = user_data_native_dir() {
			push(user_data_dir.join(name));
		}
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

/// Reset the cached worker + capabilities. Used by tests + by callers
/// that need to force re-acquisition after changing env vars. Safe to call
/// from any thread; concurrent users block on the worker mutex.
pub fn reset_for_tests() {
	if let Some(slot) = WORKER.get()
		&& let Ok(mut guard) = slot.lock()
		&& let Some(mut worker) = guard.take()
	{
		worker.stop();
	}
	if let Some(slot) = CAPS.get()
		&& let Ok(mut guard) = slot.lock()
	{
		*guard = None;
	}
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, path::Path, sync::MutexGuard};

	use super::*;

	struct TestWorkerEnv {
		_guard:          std::sync::RwLockWriteGuard<'static, ()>,
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
		// W2.5 bumped mock dim from 3 -> 1024 (REAL_DIM) to match bge-m3 EMBEDDER_DIM.
		// Mock generator: v[0]=1, v[1]=seed (1+index), v[2]=batch_len; rest zero.
		assert_eq!(batch.len(), 2);
		assert_eq!(batch[0].len(), 1024);
		assert_eq!(batch[0][0], 1.0);
		assert_eq!(batch[0][1], 1.0);   // seed = index + 1 = 1
		assert_eq!(batch[0][2], 2.0);   // batch_len = 2
		assert_eq!(batch[1][1], 2.0);   // seed = index + 1 = 2

		let query = embed_query("graph").expect("query embedding should succeed");
		// Mock query: v[0]=1, v[1]=max(text.len(),1), v[2]=1.
		assert_eq!(query.len(), 1024);
		assert_eq!(&query[..3], &[1.0, 5.0, 1.0]);
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
		assert_eq!(query.len(), 1024);
		assert_eq!(&query[..3], &[1.0, 5.0, 1.0]);
		let _ = fs::remove_file(state_file);
	}
}

#[cfg(all(test, unix))]
mod socket_tests {
	//! PLAN-310 W3 client tests. Live in the same crate (not in `tests/`) so
	//! they share `TEST_ENV_LOCK` with the existing subprocess tests — env-var
	//! manipulation across these and `mod tests` above would race otherwise.

	use std::{
		ffi::OsString,
		io::{BufRead, BufReader, Write},
		os::unix::net::UnixListener,
		path::PathBuf,
		sync::MutexGuard,
		thread::{self, JoinHandle},
	};

	use super::*;

	/// RAII wrapper that snapshots and restores all env vars the dispatcher
	/// reads, plus serialises tests through `TEST_ENV_LOCK`.
	struct SocketEnv {
		_guard:                 std::sync::RwLockWriteGuard<'static, ()>,
		original_worker:        Option<OsString>,
		original_worker_legacy: Option<OsString>,
		original_socket:        Option<OsString>,
		original_socket_legacy: Option<OsString>,
		original_mode:          Option<OsString>,
		original_state:         Option<OsString>,
	}

	impl SocketEnv {
		fn new() -> Self {
			let guard = lock_test_env();
			let original_worker = env::var_os(WORKER_ENV_VAR);
			let original_worker_legacy = env::var_os(WORKER_ENV_VAR_LEGACY);
			let original_socket = env::var_os(WORKER_SOCKET_ENV_VAR);
			let original_socket_legacy = env::var_os(WORKER_SOCKET_ENV_VAR_LEGACY);
			let original_mode = env::var_os("PI_TEST_EMBEDDING_WORKER_MODE");
			let original_state = env::var_os("PI_TEST_EMBEDDING_WORKER_STATE_FILE");
			// SAFETY: `lock_test_env()` above gates all parallel access to these
			// process-wide env vars; no other thread observes the racy window.
			unsafe {
				env::remove_var(WORKER_ENV_VAR);
				env::remove_var(WORKER_ENV_VAR_LEGACY);
				env::remove_var(WORKER_SOCKET_ENV_VAR);
				env::remove_var(WORKER_SOCKET_ENV_VAR_LEGACY);
				env::remove_var("PI_TEST_EMBEDDING_WORKER_MODE");
				env::remove_var("PI_TEST_EMBEDDING_WORKER_STATE_FILE");
			}
			reset_for_tests();
			Self {
				_guard: guard,
				original_worker,
				original_worker_legacy,
				original_socket,
				original_socket_legacy,
				original_mode,
				original_state,
			}
		}

		fn set_worker_env(path: &Path) {
			// SAFETY: serialised through `TEST_ENV_LOCK` via `SocketEnv::new`.
			unsafe { env::set_var(WORKER_ENV_VAR, path) }
		}

		fn set_worker_mode(mode: &str) {
			// SAFETY: serialised through `TEST_ENV_LOCK` via `SocketEnv::new`.
			unsafe { env::set_var("PI_TEST_EMBEDDING_WORKER_MODE", mode) }
		}

		fn set_socket_env(path: &Path) {
			// SAFETY: serialised through `TEST_ENV_LOCK` via `SocketEnv::new`.
			unsafe { env::set_var(WORKER_SOCKET_ENV_VAR, path) }
		}
	}

	impl Drop for SocketEnv {
		fn drop(&mut self) {
			// SAFETY: still holding `TEST_ENV_LOCK` from `SocketEnv::new`; no
			// concurrent reader can observe the restore window.
			unsafe {
				restore(WORKER_ENV_VAR, self.original_worker.as_ref());
				restore(WORKER_ENV_VAR_LEGACY, self.original_worker_legacy.as_ref());
				restore(WORKER_SOCKET_ENV_VAR, self.original_socket.as_ref());
				restore(WORKER_SOCKET_ENV_VAR_LEGACY, self.original_socket_legacy.as_ref());
				restore("PI_TEST_EMBEDDING_WORKER_MODE", self.original_mode.as_ref());
				restore("PI_TEST_EMBEDDING_WORKER_STATE_FILE", self.original_state.as_ref());
			}
			reset_for_tests();
		}
	}

	unsafe fn restore(name: &str, value: Option<&OsString>) {
		// SAFETY: callers (only `SocketEnv::drop`) hold `TEST_ENV_LOCK`.
		unsafe {
			match value {
				Some(value) => env::set_var(name, value),
				None => env::remove_var(name),
			}
		}
	}

	fn mock_worker_path() -> PathBuf {
		Path::new(env!("CARGO_MANIFEST_DIR")).join("test-bin/mock_embedding_worker.js")
	}

	fn unique_socket_path(name: &str) -> PathBuf {
		let unique = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.expect("time should be monotonic")
			.as_nanos();
		env::temp_dir().join(format!("pi-natives-{name}-{unique}-{}.sock", std::process::id()))
	}

	fn canned_vector() -> Vec<f32> {
		// Distinguishable from the mock subprocess output (`[1.0, len, 1.0, …]`)
		// so `assert_eq!` tells us which transport answered.
		let mut v = vec![0.0_f32; EMBEDDER_DIM];
		v[0] = 7.0;
		v[1] = 8.0;
		v[2] = 9.0;
		v
	}

	fn mock_vector_for(text: &str) -> Vec<f32> {
		// Mirrors `mock_embedding_worker.js` `buildQueryVector` shape.
		let mut v = vec![0.0_f32; EMBEDDER_DIM];
		v[0] = 1.0;
		v[1] = text.len().max(1) as f32;
		v[2] = 1.0;
		v
	}

	/// Spawn a one-shot listener that accepts a single connection and writes
	/// the supplied canned response. Returns the join handle so the test can
	/// drain any background panic.
	fn spawn_canned_listener(socket: PathBuf, vector: Vec<f32>) -> JoinHandle<()> {
		let listener = UnixListener::bind(&socket).expect("bind canned listener");
		thread::spawn(move || {
			let (stream, _) = listener.accept().expect("accept canned conn");
			let reader_stream = stream.try_clone().expect("clone stream");
			let mut reader = BufReader::new(reader_stream);
			let mut writer = stream;
			let mut line = String::new();
			reader.read_line(&mut line).expect("read request");
			let payload = serde_json::json!({ "ok": true, "vector": vector });
			let mut bytes = serde_json::to_vec(&payload).expect("encode response");
			bytes.push(b'\n');
			writer.write_all(&bytes).expect("write response");
			writer.flush().expect("flush response");
			let _ = socket;
		})
	}

	#[test]
	fn client_prefers_explicit_pi_embedding_worker_env_var() {
		let _env = SocketEnv::new();
		SocketEnv::set_worker_env(&mock_worker_path());
		SocketEnv::set_worker_mode("success");
		// Point socket at a path that does not exist — must be ignored.
		SocketEnv::set_socket_env(Path::new("/nonexistent/spell/embed.sock"));

		let vector = embed_query("alpha").expect("subprocess path should serve query");
		assert_eq!(vector, mock_vector_for("alpha"));
	}

	#[test]
	fn client_uses_socket_when_daemon_listening() {
		let _env = SocketEnv::new();
		let socket = unique_socket_path("socket-listener");
		let _ = fs::remove_file(&socket);
		let handle = spawn_canned_listener(socket.clone(), canned_vector());
		SocketEnv::set_socket_env(&socket);

		let vector = embed_query("alpha").expect("socket path should serve query");
		assert_eq!(vector, canned_vector());

		handle.join().expect("listener thread should finish cleanly");
		let _ = fs::remove_file(&socket);
	}

	#[test]
	fn client_falls_back_to_subprocess_on_socket_connect_failure() {
		let _env = SocketEnv::new();
		SocketEnv::set_worker_env(&mock_worker_path());
		SocketEnv::set_worker_mode("success");
		SocketEnv::set_socket_env(Path::new("/nonexistent/spell/embed.sock"));

		// Same observable result as the explicit-env test: subprocess answers.
		// We use a distinct test name to document the fallback contract.
		let vector = embed_query("omega").expect("subprocess fallback should serve query");
		assert_eq!(vector, mock_vector_for("omega"));
	}

	#[test]
	fn client_recovers_from_dead_socket() {
		let _env = SocketEnv::new();
		let socket = unique_socket_path("socket-recovery");
		let _ = fs::remove_file(&socket);

		// Stage 1: bind a listener that accepts once and drops the conn before
		// responding. Subsequent connects refuse with ECONNREFUSED.
		let dead_socket = socket.clone();
		let dead_handle = thread::spawn(move || {
			let listener = UnixListener::bind(&dead_socket).expect("bind dead listener");
			let (_stream, _) = listener.accept().expect("accept dead conn");
			// Drop stream + listener immediately → peer sees EOF on read.
		});
		SocketEnv::set_socket_env(&socket);

		let first = embed_query("first");
		assert!(first.is_err(), "dead-socket request must surface an error");
		dead_handle.join().expect("dead listener thread should finish");
		let _ = fs::remove_file(&socket);

		// Stage 2: bring up a healthy listener at the same path. The dispatcher
		// must re-acquire a fresh transport (because `with_worker` clears the
		// slot on error) and succeed.
		let handle = spawn_canned_listener(socket.clone(), canned_vector());
		let second = embed_query("second").expect("recovery query should succeed");
		assert_eq!(second, canned_vector());
		handle.join().expect("listener thread should finish cleanly");
		let _ = fs::remove_file(&socket);
	}
}
