//! `pi-knowledge-worker` binary.
//!
//! Default mode reads JSON commands from stdin and writes JSON responses to
//! stdout (one per line). Invoked with `--socket <path>` it becomes a
//! user-scoped daemon that serves the same protocol over a Unix socket.
//!
//! Socket-mode features:
//! - `fd_lock`-protected pidfile prevents a second worker from binding.
//! - 30-minute (configurable) idle exit so the worker doesn't pin RAM
//!   indefinitely.
//! - SIGTERM / SIGINT drain in-flight connections before exiting cleanly.
//! - Stale socket files (regular file or dead listener) are unlinked on
//!   startup before rebinding.

mod embedder_adapter;
mod engine;
mod lane_org;
mod repo_cache;

use std::{
	fs::{self, File, OpenOptions, Permissions},
	io::{self, BufRead, BufReader, Write},
	os::{
		fd::AsFd,
		unix::{
			fs::{OpenOptionsExt, PermissionsExt},
			net::{UnixListener, UnixStream},
		},
	},
	panic::{self, AssertUnwindSafe},
	path::{Path, PathBuf},
	process,
	sync::{
		Mutex, OnceLock,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use clap::Parser;
use fd_lock::RwLock as FdLock;
use nix::{
	poll::{PollFd, PollFlags, PollTimeout, poll},
	sys::signal::{self, SaFlags, SigAction, SigHandler, SigSet, Signal},
	unistd::{ForkResult, fork, setsid},
};
use engine::EmbeddingEngine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// =====================================================================
// Shared protocol (used by both stdio and socket modes)
// =====================================================================

static ENGINE: OnceLock<Mutex<Option<EmbeddingEngine>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
	Init,
	EmbedBatch { texts: Vec<String>, batch_size: Option<usize> },
	EmbedQuery { text: String },
	/// PLAN-315 W1: warm-load a repo's knowledge cache (org/memory and/or
	/// code-graph lane). W1 returns a placeholder repo_handle; W2/W3 wire
	/// the actual cache load.
	Open {
		repo_root:        std::path::PathBuf,
		#[serde(default)]
		include_personal: bool,
		#[serde(default)]
		lanes:            Vec<Lane>,
	},
	/// Close a previously-opened repo handle; daemon may evict its cache.
	Close { repo_handle: String },
	/// Report daemon RSS and per-repo cache stats. `repo_handle: None`
	/// returns daemon-wide aggregate.
	Stats {
		#[serde(default)]
		repo_handle: Option<String>,
	},
	/// PLAN-315 W2: org/memory search. Routes to
	/// `pi_knowledge_core::recall::recall` over the warm lane state.
	Search {
		repo_handle: String,
		#[serde(flatten)]
		query:       pi_knowledge_core::recall::RecallQuery,
	},
	/// `about(id)` — node + 1-hop neighbors + distillation lineage.
	About { repo_handle: String, id: String },
	/// BFS expansion from a focus node.
	Neighbors {
		repo_handle: String,
		focus:       String,
		#[serde(default)]
		hops:        u8,
		#[serde(default)]
		kinds:       Vec<String>,
	},
	/// Items modified since timestamp (ISO-8601 string or epoch ms).
	Since {
		repo_handle: String,
		ts:          lane_org::SinceTimestamp,
	},
}

/// Knowledge lane identifier. Two cache shapes live in the daemon:
/// the org/memory recall lane and the code-graph hybrid-search lane.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone, Copy, Hash)]
#[serde(rename_all = "snake_case")]
enum Lane {
	OrgMemory,
	CodeGraph,
}

/// Protocol version. Bumped to 2 when PLAN-315 W1 lands the knowledge
/// command surface. Clients gate features off this number.
const PROTOCOL_VERSION: u32 = 2;

/// Returns the command names this daemon understands. Clients use
/// this list for forward-compatible feature detection.
fn supported_commands() -> &'static [&'static str] {
	&[
		"init",
		"embed_batch",
		"embed_query",
		"open",
		"close",
		"stats",
		"search",
		"about",
		"neighbors",
		"since",
	]
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(untagged)]
enum Response {
	Ok {
		ok:   bool,
		#[serde(flatten)]
		data: Value,
	},
	Err {
		ok:    bool,
		error: String,
	},
}

fn engine_slot() -> &'static Mutex<Option<EmbeddingEngine>> {
	ENGINE.get_or_init(|| Mutex::new(None))
}

fn init_engine() -> Result<(), String> {
let engine = EmbeddingEngine::new(false)?;
	let mut slot = engine_slot()
		.lock()
		.map_err(|error| format!("mutex poisoned: {error}"))?;
	*slot = Some(engine);
	Ok(())
}

pub(crate) fn with_engine<T>(
	mut f: impl FnMut(&EmbeddingEngine) -> Result<T, String>,
) -> Result<T, String> {
	{
		let needs_init = engine_slot()
			.lock()
			.map_err(|error| format!("mutex poisoned: {error}"))?
			.is_none();
		if needs_init {
			init_engine()?;
		}
	}

	let slot = engine_slot()
		.lock()
		.map_err(|error| format!("mutex poisoned: {error}"))?;
	let engine = slot
		.as_ref()
		.ok_or_else(|| "embedding engine unavailable after init".to_string())?;
	f(engine)
}

fn handle_command(command: Command) -> Response {
	match panic::catch_unwind(AssertUnwindSafe(|| match command {
		Command::Init => {
			init_engine()?;
			Ok(json!({
				"initialized": true,
				"protocol_version": PROTOCOL_VERSION,
				"supported_commands": supported_commands(),
			}))
		},
		Command::EmbedBatch { texts, batch_size } => with_engine(|engine| {
			let docs: Vec<&str> = texts.iter().map(String::as_str).collect();
			let vectors = engine.embed_batch(&docs, batch_size)?;
			Ok(json!({"vectors": vectors}))
		}),
		Command::EmbedQuery { text } => with_engine(|engine| {
			let vector = engine.embed_query(&text)?;
			Ok(json!({"vector": vector}))
		}),
		Command::Open { repo_root, include_personal, lanes } => {
			repo_cache::open(&repo_root, include_personal, &lanes)
		},
		Command::Close { repo_handle } => repo_cache::close(&repo_handle),
		Command::Stats { repo_handle } => repo_cache::stats(repo_handle.as_deref()),
		Command::Search { repo_handle, query } => {
			repo_cache::with_org_lane(&repo_handle, |lane| {
				let hits = lane.search(query)?;
				Ok(json!({ "hits": hits }))
			})
		},
		Command::About { repo_handle, id } => {
			repo_cache::with_org_lane(&repo_handle, |lane| lane.about(&id))
		},
		Command::Neighbors { repo_handle, focus, hops, kinds } => {
			repo_cache::with_org_lane(&repo_handle, |lane| lane.neighbors(&focus, hops, &kinds))
		},
		Command::Since { repo_handle, ts } => {
			repo_cache::with_org_lane(&repo_handle, |lane| lane.since(&ts))
		},
	})) {
		Ok(Ok(data)) => Response::Ok { ok: true, data },
		Ok(Err(error)) => Response::Err { ok: false, error },
		Err(_) => Response::Err {
			ok:    false,
			error: "unexpected panic while handling command".to_string(),
		},
	}
}

fn process_line(line: &str) -> Response {
	match serde_json::from_str::<Command>(line) {
		Ok(command) => handle_command(command),
		Err(error) => {
			Response::Err { ok: false, error: format!("malformed JSON or command: {error}") }
		},
	}
}

// =====================================================================
// Legacy stdio mode (unchanged behaviour)
// =====================================================================

fn write_stdio_response(response: &Response) -> Result<(), String> {
	let mut stdout = io::stdout().lock();
	serde_json::to_writer(&mut stdout, response).map_err(|error| error.to_string())?;
	stdout.write_all(b"\n").map_err(|error| error.to_string())?;
	stdout.flush().map_err(|error| error.to_string())
}

fn run_stdio_mode() {
	let stdin = io::stdin();
	let mut reader = stdin.lock();
	let mut line = String::new();

	loop {
		line.clear();
		match reader.read_line(&mut line) {
			Ok(0) => break,
			Ok(_) => {
				let trimmed = line.trim_end_matches(['\r', '\n']);
				let response = process_line(trimmed);
				if let Err(error) = write_stdio_response(&response) {
					let _ = writeln!(io::stderr(), "failed to write response: {error}");
					break;
				}
			},
			Err(error) => {
				let _ = writeln!(io::stderr(), "failed to read stdin: {error}");
				break;
			},
		}
	}
}

// =====================================================================
// Socket-mode daemon
// =====================================================================

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static INFLIGHT: AtomicU64 = AtomicU64::new(0);
static LAST_REQUEST_AT: AtomicU64 = AtomicU64::new(0);

/// Drain grace once shutdown has been requested.
const DRAIN_GRACE: Duration = Duration::from_secs(5);
/// Poll cadence; bounds idle/shutdown reaction latency.
const POLL_INTERVAL_MS: u16 = 500;

fn now_unix() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| d.as_secs())
}

extern "C" fn signal_handler(_: nix::libc::c_int) {
	SHUTDOWN.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() {
	// Flag-set-only handler is async-signal-safe.
	let action = SigAction::new(
		SigHandler::Handler(signal_handler),
		SaFlags::empty(),
		SigSet::empty(),
	);
	// SAFETY: handler only touches an AtomicBool which is signal-safe.
	unsafe {
		let _ = signal::sigaction(Signal::SIGTERM, &action);
		let _ = signal::sigaction(Signal::SIGINT, &action);
		let _ = signal::sigaction(Signal::SIGHUP, &action);
	}
}

/// Resolve the default daemon root directory.
///
/// `$XDG_RUNTIME_DIR/spell` when `XDG_RUNTIME_DIR` is set and writable;
/// otherwise `/tmp/spell-<uid>`.
fn default_runtime_dir() -> PathBuf {
	if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR") {
		let candidate = PathBuf::from(xdg).join("spell");
		if fs::create_dir_all(&candidate).is_ok() {
			return candidate;
		}
	}
	let uid = nix::unistd::Uid::current().as_raw();
	PathBuf::from(format!("/tmp/spell-{uid}"))
}

fn default_pidfile_for(socket: &Path) -> PathBuf {
	socket
		.parent()
		.filter(|p| !p.as_os_str().is_empty())
		.map_or_else(|| PathBuf::from("embed.pid"), |p| p.join("embed.pid"))
}

/// Try to take an exclusive flock on `pidfile`. Returns true on success.
///
/// The lock is held for the lifetime of the process: the underlying
/// `RwLock<File>` is leaked and the guard is forgotten, so neither will be
/// dropped. The kernel releases the flock when the process exits and the fd
/// is closed. When daemonizing via `fork`, the child inherits the open file
/// description, so the lock survives the parent's exit.
fn acquire_pidfile_lock(pidfile: &Path) -> bool {
	if let Some(parent) = pidfile.parent()
		&& !parent.as_os_str().is_empty()
	{
		let _ = fs::create_dir_all(parent);
	}
	let Ok(file) = OpenOptions::new()
		.create(true)
		.read(true)
		.write(true)
		.truncate(false)
		.mode(0o600)
		.open(pidfile)
	else {
		return false;
	};
	let lock: &'static mut FdLock<File> = Box::leak(Box::new(FdLock::new(file)));
	match lock.try_write() {
		Ok(guard) => {
			// Holding the lock for the rest of the process. Dropping the
			// guard would release the flock; forgetting it keeps the lock.
			std::mem::forget(guard);
			true
		},
		Err(_) => false,
	}
}

/// Bind a Unix listener at `socket`, clearing a stale dead-listener / regular
/// file at that path if necessary. Returns `Err` if another live worker is
/// already serving the socket.
fn bind_listener(socket: &Path) -> Result<UnixListener, String> {
	if let Some(parent) = socket.parent()
		&& !parent.as_os_str().is_empty()
	{
		let _ = fs::create_dir_all(parent);
	}
	match UnixListener::bind(socket) {
		Ok(l) => Ok(l),
		Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
			if UnixStream::connect(socket).is_ok() {
				return Err("another worker is already listening".to_string());
			}
			let _ = fs::remove_file(socket);
			UnixListener::bind(socket).map_err(|e| format!("bind failed: {e}"))
		},
		Err(e) => Err(format!("bind failed: {e}")),
	}
}

fn redirect_stdio_to_devnull() {
	let Ok(dev_null) = OpenOptions::new().read(true).write(true).open("/dev/null") else {
		return;
	};
	use std::os::unix::io::AsRawFd;
	let fd = dev_null.as_raw_fd();
	let _ = nix::unistd::dup2(fd, 0);
	let _ = nix::unistd::dup2(fd, 1);
	let _ = nix::unistd::dup2(fd, 2);
}

fn handle_socket_conn(stream: UnixStream) {
	INFLIGHT.fetch_add(1, Ordering::SeqCst);
	let Ok(reader_stream) = stream.try_clone() else {
		INFLIGHT.fetch_sub(1, Ordering::SeqCst);
		return;
	};
	let mut reader = BufReader::new(reader_stream);
	let mut writer = stream;
	let mut line = String::new();
	loop {
		line.clear();
		match reader.read_line(&mut line) {
			Ok(0) => break,
			Ok(_) => {
				let trimmed = line.trim_end_matches(['\r', '\n']);
				LAST_REQUEST_AT.store(now_unix(), Ordering::SeqCst);
				let response = process_line(trimmed);
				let Ok(body) = serde_json::to_vec(&response) else {
					break;
				};
				if writer.write_all(&body).is_err()
					|| writer.write_all(b"\n").is_err()
					|| writer.flush().is_err()
				{
					break;
				}
				LAST_REQUEST_AT.store(now_unix(), Ordering::SeqCst);
			},
			Err(_) => break,
		}
	}
	INFLIGHT.fetch_sub(1, Ordering::SeqCst);
}

fn accept_loop(listener: &UnixListener, idle_secs: u64) {
	if listener.set_nonblocking(true).is_err() {
		return;
	}
	LAST_REQUEST_AT.store(now_unix(), Ordering::SeqCst);
	let timeout = PollTimeout::from(POLL_INTERVAL_MS);

	loop {
		if SHUTDOWN.load(Ordering::SeqCst) {
			break;
		}
		let last = LAST_REQUEST_AT.load(Ordering::SeqCst);
		let idle = now_unix().saturating_sub(last);
		if idle >= idle_secs && INFLIGHT.load(Ordering::SeqCst) == 0 {
			break;
		}

		let fd = listener.as_fd();
		let mut fds = [PollFd::new(fd, PollFlags::POLLIN)];
		match poll(&mut fds, timeout) {
			Ok(_) => {},
			Err(nix::errno::Errno::EINTR) => continue,
			Err(_) => continue,
		}
		let ready = fds[0]
			.revents()
			.is_some_and(|r| r.intersects(PollFlags::POLLIN | PollFlags::POLLHUP));
		if !ready {
			continue;
		}
		match listener.accept() {
			Ok((stream, _addr)) => {
				thread::spawn(move || handle_socket_conn(stream));
			},
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
			Err(_) => {},
		}
	}
}

fn drain_inflight() {
	let deadline = Instant::now() + DRAIN_GRACE;
	while INFLIGHT.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
		thread::sleep(Duration::from_millis(25));
	}
}

fn run_socket_mode(
	socket: PathBuf,
	pidfile: Option<PathBuf>,
	idle_secs: u64,
	daemonize: bool,
) {
	let pidfile = pidfile.unwrap_or_else(|| default_pidfile_for(&socket));

	// 1. Acquire the pidfile flock before doing anything observable.
	//    Contention → another worker is alive → exit silently.
	if !acquire_pidfile_lock(&pidfile) {
		process::exit(0);
	}

	// 2. Optional daemonize. Parent exits without dropping the lock guard.
	if daemonize {
		// SAFETY: single-threaded prior to fork (clap parse only).
		match unsafe { fork() } {
			Ok(ForkResult::Parent { .. }) => {
				// Skip Rust destructors so the leaked FdLock<File> isn't
				// dropped; kernel closes parent's fd, child still references
				// the same open file description, so flock survives.
				process::exit(0);
			},
			Ok(ForkResult::Child) => {
				let _ = setsid();
				redirect_stdio_to_devnull();
			},
			Err(_) => {
				// Fall through to foreground.
			},
		}
	}

	// 3. Write pidfile contents (own pid, post-fork) with 0600 perms.
	let _ = fs::write(&pidfile, format!("{}\n", process::id()));
	let _ = fs::set_permissions(&pidfile, Permissions::from_mode(0o600));

	// 4. Install signal handlers after we know we're the surviving process.
	install_signal_handlers();

	// 5. Bind the listener (clearing stale files).
	let listener = match bind_listener(&socket) {
		Ok(l) => l,
		Err(err) => {
			eprintln!("pi-knowledge-worker: {err}");
			let _ = fs::remove_file(&pidfile);
			process::exit(1);
		},
	};
	let _ = fs::set_permissions(&socket, Permissions::from_mode(0o600));

	// 6. Serve until shutdown / idle.
	accept_loop(&listener, idle_secs);

	// 7. Drain in-flight, then clean up.
	drain_inflight();
	drop(listener);
	let _ = fs::remove_file(&socket);
	let _ = fs::remove_file(&pidfile);
}

// =====================================================================
// CLI entry
// =====================================================================

#[derive(Debug, Parser)]
#[command(name = "pi-knowledge-worker", version)]
struct Cli {
	/// Run as a socket-mode daemon listening at this path.
	#[arg(long)]
	socket:    Option<PathBuf>,
	/// Pidfile path (defaults to `<socket-parent>/embed.pid`).
	#[arg(long)]
	pidfile:   Option<PathBuf>,
	/// Idle exit threshold in seconds (default: 1800 = 30 minutes).
	#[arg(long, default_value_t = 1800)]
	idle_secs: u64,
	/// Fork into the background, write pidfile, exit parent (socket mode only).
	#[arg(long)]
	daemonize: bool,
}

fn main() {
	// Keep `default_runtime_dir` linked: it's part of the public daemon
	// surface even though our CLI always requires an explicit --socket.
	let _ = default_runtime_dir;
	let cli = Cli::parse();
	match cli.socket {
		Some(sock) => run_socket_mode(sock, cli.pidfile, cli.idle_secs, cli.daemonize),
		None => run_stdio_mode(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn deserializes_init_command() {
		let command: Command = serde_json::from_str(r#"{"command":"init"}"#).expect("command");
		assert!(matches!(command, Command::Init));
	}

	#[test]
	fn serializes_error_response() {
		let response = Response::Err { ok: false, error: "bad input".to_string() };
		let json = serde_json::to_string(&response).expect("serialize");
		assert_eq!(json, r#"{"ok":false,"error":"bad input"}"#);
	}

	#[test]
	fn malformed_input_returns_error_response() {
		let response = process_line("not-json");
		match response {
			Response::Err { ok, error } => {
				assert!(!ok);
				assert!(error.contains("malformed JSON"));
			},
			Response::Ok { .. } => panic!("expected error response"),
		}
	}

	#[test]
	fn default_pidfile_lives_next_to_socket() {
		let sock = PathBuf::from("/tmp/spell-test/embed.sock");
		let pid = default_pidfile_for(&sock);
		assert_eq!(pid, PathBuf::from("/tmp/spell-test/embed.pid"));
	}
}
