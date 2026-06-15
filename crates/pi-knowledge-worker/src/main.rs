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
//! - Stale socket files (regular file or dead listener) are unlinked on startup
//!   before rebinding.

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
	sync::atomic::{AtomicBool, AtomicU64, Ordering},
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
use pi_knowledge_worker::{Lane, init_engine, lane_org, repo_cache, subscribe, with_engine};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// =====================================================================
// Shared protocol (used by both stdio and socket modes)
// =====================================================================

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
	Init,
	EmbedBatch {
		texts:      Vec<String>,
		batch_size: Option<usize>,
	},
	EmbedQuery {
		text: String,
	},
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
	Close {
		repo_handle: String,
	},
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
	About {
		repo_handle: String,
		id:          String,
	},
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
	/// PLAN-315 W3: code-graph hybrid/bm25/vec search. `kind` defaults to
	/// "hybrid" if unspecified.
	CgSearch {
		repo_handle: String,
		query:       String,
		#[serde(default = "default_cg_kind")]
		kind:        String,
		#[serde(default = "default_cg_limit")]
		limit:       usize,
	},
	/// `cg_definition` — resolve a symbol query to its primary location.
	CgDefinition {
		repo_handle: String,
		query:       String,
	},
	/// `cg_references` — downstream references via graph_impact, bounded
	/// by `max_depth` (default 3).
	CgReferences {
		repo_handle: String,
		query:       String,
		#[serde(default = "default_cg_depth")]
		max_depth:   usize,
	},
	/// `cg_callers` — upstream callers via graph_flow up to `max_depth`.
	CgCallers {
		repo_handle: String,
		query:       String,
		#[serde(default = "default_cg_depth")]
		max_depth:   usize,
	},
}

fn default_cg_kind() -> String {
	"hybrid".to_string()
}
fn default_cg_limit() -> usize {
	20
}
fn default_cg_depth() -> usize {
	3
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
		"subscribe",
		"unsubscribe",
		"cg_search",
		"cg_definition",
		"cg_references",
		"cg_callers",
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
		Command::Search { repo_handle, query } => repo_cache::with_org_lane(&repo_handle, |lane| {
			let hits = lane.search(query)?;
			Ok(json!({ "hits": hits }))
		}),
		Command::About { repo_handle, id } => {
			repo_cache::with_org_lane(&repo_handle, |lane| lane.about(&id))
		},
		Command::Neighbors { repo_handle, focus, hops, kinds } => {
			repo_cache::with_org_lane(&repo_handle, |lane| lane.neighbors(&focus, hops, &kinds))
		},
		Command::Since { repo_handle, ts } => {
			repo_cache::with_org_lane(&repo_handle, |lane| lane.since(&ts))
		},
		Command::CgSearch { repo_handle, query, kind, limit } => {
			repo_cache::with_code_lane(&repo_handle, |lane| {
				let hits = lane.search(&query, &kind, limit)?;
				Ok(json!({ "hits": hits }))
			})
		},
		Command::CgDefinition { repo_handle, query } => {
			repo_cache::with_code_lane(&repo_handle, |lane| {
				let ctx = lane.definition(&query)?;
				Ok(json!({ "context": ctx }))
			})
		},
		Command::CgReferences { repo_handle, query, max_depth } => {
			repo_cache::with_code_lane(&repo_handle, |lane| {
				let impact = lane.references(&query, max_depth)?;
				Ok(json!({ "impact": impact }))
			})
		},
		Command::CgCallers { repo_handle, query, max_depth } => {
			repo_cache::with_code_lane(&repo_handle, |lane| {
				let flow = lane.callers(&query, max_depth)?;
				Ok(json!({ "flow": flow }))
			})
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

	// Stdio mode now supports subscribe + push events too. Same ConnState
	// machinery as socket mode; writer thread serialises responses + events
	// on stdout. This keeps the integration tests — which drive the daemon
	// over stdio — able to exercise the full subscribe lifecycle.
	let (out_tx, out_rx) = std::sync::mpsc::sync_channel(CONN_OUTBOX_DEPTH);
	let conn = std::sync::Arc::new(ConnState {
		subscriptions: std::sync::Mutex::new(std::collections::HashMap::new()),
		out_tx:        out_tx.clone(),
	});

	let writer_handle = thread::spawn(move || {
		let stdout = io::stdout();
		let mut writer = stdout.lock();
		while let Ok(frame) = out_rx.recv() {
			let body = match &frame {
				subscribe::Frame::Response { body } => body,
				subscribe::Frame::Event { body } => body,
			};
			let Ok(bytes) = serde_json::to_vec(body) else {
				continue;
			};
			if writer.write_all(&bytes).is_err()
				|| writer.write_all(b"\n").is_err()
				|| writer.flush().is_err()
			{
				break;
			}
		}
	});

	loop {
		line.clear();
		match reader.read_line(&mut line) {
			Ok(0) => break,
			Ok(_) => {
				let trimmed = line.trim_end_matches(['\r', '\n']);
				let body = process_line_with_conn(&conn, trimmed);
				if conn
					.out_tx
					.send(subscribe::Frame::Response { body })
					.is_err()
				{
					break;
				}
			},
			Err(error) => {
				let _ = writeln!(io::stderr(), "failed to read stdin: {error}");
				break;
			},
		}
	}

	drop(out_tx);
	drop(conn);
	let _ = writer_handle.join();
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
	let action =
		SigAction::new(SigHandler::Handler(signal_handler), SaFlags::empty(), SigSet::empty());
	// SAFETY: handler only touches an AtomicBool which is signal-safe.
	unsafe {
		let _ = signal::sigaction(Signal::SIGTERM, &action);
		let _ = signal::sigaction(Signal::SIGINT, &action);
		let _ = signal::sigaction(Signal::SIGHUP, &action);
	}
}

/// BUG-475 — cap the daemon's CPU affinity so fastembed/ort (which hardcode
/// `with_intra_threads(available_parallelism())` and read the affinity mask)
/// don't peg every core during the warm-load embed.
///
/// `available_parallelism()` on Linux reports the count of CPUs in the
/// process affinity mask, so restricting the mask is the version-independent
/// lever — fastembed exposes no thread knob on `TextInitOptions`.
///
/// Threads = `KNOWLEDGE_EMBED_THREADS` if set (clamped ≥1), else half the
/// available cores (min 1). Must run BEFORE the first embedding-engine init.
/// Best-effort: failures are logged to the (already redirected) stderr and
/// the daemon proceeds uncapped rather than refusing to serve.
fn cap_embed_affinity() {
	use nix::{
		sched::{CpuSet, sched_getaffinity, sched_setaffinity},
		unistd::Pid,
	};

	let available = thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
	let target = std::env::var("KNOWLEDGE_EMBED_THREADS")
		.ok()
		.and_then(|v| v.parse::<usize>().ok())
		.map_or_else(|| (available / 2).max(1), |n| n.clamp(1, available));
	if target >= available {
		return; // No cap needed / requested.
	}

	// Read the current mask so we pin to CPUs the process is actually allowed
	// on (respecting any cgroup/taskset restriction already in effect).
	let Ok(current) = sched_getaffinity(Pid::from_raw(0)) else {
		return;
	};
	let mut set = CpuSet::new();
	let mut picked = 0usize;
	for cpu in 0..CpuSet::count() {
		if picked >= target {
			break;
		}
		if current.is_set(cpu).unwrap_or(false) && set.set(cpu).is_ok() {
			picked += 1;
		}
	}
	if picked == 0 {
		return;
	}
	if let Err(e) = sched_setaffinity(Pid::from_raw(0), &set) {
		eprintln!("pi-knowledge-worker: affinity cap failed: {e}");
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

/// Per-connection state for subscribe-capable sockets. Holds the active
/// `SubscriptionToken`s (drop on connection close auto-deregisters) and
/// the inbound→outbound sync channel.
struct ConnState {
	/// Active subscriptions on this connection. Map allows O(1) unsubscribe.
	subscriptions:
		std::sync::Mutex<std::collections::HashMap<subscribe::SubId, subscribe::SubscriptionToken>>,
	/// Outbound sender shared between command handlers and event publishers.
	out_tx:        std::sync::mpsc::SyncSender<subscribe::Frame>,
}

/// Bounded queue depth between command/event producers and the socket writer.
const CONN_OUTBOX_DEPTH: usize = 256;

fn handle_socket_conn(stream: UnixStream) {
	INFLIGHT.fetch_add(1, Ordering::SeqCst);
	let Ok(reader_stream) = stream.try_clone() else {
		INFLIGHT.fetch_sub(1, Ordering::SeqCst);
		return;
	};
	let mut reader = BufReader::new(reader_stream);

	// One bounded outbox per connection. Both the reader (for responses)
	// and the EventRegistry sinks (for events) push into the same channel
	// so the writer thread serialises wire order.
	let (out_tx, out_rx) = std::sync::mpsc::sync_channel(CONN_OUTBOX_DEPTH);
	let conn = std::sync::Arc::new(ConnState {
		subscriptions: std::sync::Mutex::new(std::collections::HashMap::new()),
		out_tx:        out_tx.clone(),
	});

	// Writer thread drains the outbox.
	let writer_stream = stream;
	let writer_handle = thread::spawn(move || {
		let mut writer = writer_stream;
		while let Ok(frame) = out_rx.recv() {
			let body = match &frame {
				subscribe::Frame::Response { body } => body,
				subscribe::Frame::Event { body } => body,
			};
			let Ok(bytes) = serde_json::to_vec(body) else {
				continue;
			};
			if writer.write_all(&bytes).is_err()
				|| writer.write_all(b"\n").is_err()
				|| writer.flush().is_err()
			{
				break;
			}
		}
		// Out_rx closed (reader hung up) or write error → drop writer side.
		let _ = writer.shutdown(std::net::Shutdown::Both);
	});

	// Reader loop processes commands. Subscribe/Unsubscribe are stateful
	// against ConnState; everything else flows through `process_line`.
	let mut line = String::new();
	loop {
		line.clear();
		match reader.read_line(&mut line) {
			Ok(0) => break,
			Ok(_) => {
				let trimmed = line.trim_end_matches(['\r', '\n']);
				LAST_REQUEST_AT.store(now_unix(), Ordering::SeqCst);
				let response_body = process_line_with_conn(&conn, trimmed);
				if conn
					.out_tx
					.send(subscribe::Frame::Response { body: response_body })
					.is_err()
				{
					break;
				}
				LAST_REQUEST_AT.store(now_unix(), Ordering::SeqCst);
			},
			Err(_) => break,
		}
	}

	// Drop outbound sender so writer drains and exits.
	drop(out_tx);
	drop(conn);
	let _ = writer_handle.join();
	INFLIGHT.fetch_sub(1, Ordering::SeqCst);
}

/// Connection-aware command dispatch. Handles Subscribe / Unsubscribe
/// (which mutate `ConnState`) directly; everything else delegates to
/// `process_line`. Returns the response JSON body (without the `Response`
/// envelope) so the caller can put it on the wire.
fn process_line_with_conn(conn: &std::sync::Arc<ConnState>, line: &str) -> serde_json::Value {
	// Peek at the command name without consuming the full Command enum:
	// Subscribe/Unsubscribe need access to ConnState which Command can't
	// carry without polluting the dispatch type with non-Send state.
	let parsed: Result<serde_json::Value, _> = serde_json::from_str(line);
	let Ok(parsed) = parsed else {
		return serde_json::to_value(Response::Err {
			ok:    false,
			error: format!("malformed JSON: {}", line.chars().take(80).collect::<String>()),
		})
		.unwrap_or(serde_json::Value::Null);
	};
	match parsed.get("command").and_then(|v| v.as_str()) {
		Some("subscribe") => handle_subscribe(conn, &parsed),
		Some("unsubscribe") => handle_unsubscribe(conn, &parsed),
		_ => serde_json::to_value(process_line(line)).unwrap_or(serde_json::Value::Null),
	}
}

fn handle_subscribe(
	conn: &std::sync::Arc<ConnState>,
	request: &serde_json::Value,
) -> serde_json::Value {
	let repo_handle = match request.get("repo_handle").and_then(|v| v.as_str()) {
		Some(s) => s.to_string(),
		None => {
			return serde_json::json!({
				"ok": false,
				"error": "subscribe requires repo_handle",
			});
		},
	};
	let lanes_value = request
		.get("lanes")
		.cloned()
		.unwrap_or(serde_json::json!([]));
	let lanes: Vec<Lane> = match serde_json::from_value(lanes_value) {
		Ok(v) => v,
		Err(e) => {
			return serde_json::json!({
				"ok": false,
				"error": format!("subscribe invalid lanes: {e}"),
			});
		},
	};
	if lanes.is_empty() {
		return serde_json::json!({
			"ok": false,
			"error": "subscribe requires at least one lane",
		});
	};

	let mut sub_ids = Vec::new();
	for lane in &lanes {
		let token = subscribe::registry().subscribe(&repo_handle, *lane, conn.out_tx.clone());
		let sub_id = token.sub_id();
		if let Ok(mut map) = conn.subscriptions.lock() {
			map.insert(sub_id, token);
		}
		sub_ids.push(sub_id);
	}

	serde_json::json!({
		"ok": true,
		"subscription_ids": sub_ids,
		"repo_handle": repo_handle,
		"lanes": lanes,
	})
}

fn handle_unsubscribe(
	conn: &std::sync::Arc<ConnState>,
	request: &serde_json::Value,
) -> serde_json::Value {
	let ids: Vec<u64> = match request.get("subscription_ids") {
		Some(arr) => {
			let Some(arr) = arr.as_array() else {
				return serde_json::json!({
					"ok": false,
					"error": "subscription_ids must be an array",
				});
			};
			arr.iter().filter_map(|v| v.as_u64()).collect()
		},
		None => match request.get("subscription_id").and_then(|v| v.as_u64()) {
			Some(id) => vec![id],
			None => Vec::new(),
		},
	};

	let mut removed = 0u64;
	if let Ok(mut map) = conn.subscriptions.lock() {
		if ids.is_empty() {
			// No ids → unsubscribe ALL of this connection's subscriptions.
			removed = map.len() as u64;
			map.clear();
		} else {
			for id in ids {
				if map.remove(&id).is_some() {
					removed += 1;
				}
			}
		}
	}
	serde_json::json!({ "ok": true, "removed": removed })
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
		// BUG-483: never idle-exit while a lane warm-load is still building.
		// A cold warm of a large corpus outlasts the idle window; exiting
		// mid-embed would discard the build before it persists, forcing a
		// full re-embed (CPU + RAM hog) on the next daemon lifetime.
		if idle >= idle_secs && INFLIGHT.load(Ordering::SeqCst) == 0 && !repo_cache::warm_in_flight()
		{
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

fn run_socket_mode(socket: PathBuf, pidfile: Option<PathBuf>, idle_secs: u64, daemonize: bool) {
	let pidfile = pidfile.unwrap_or_else(|| default_pidfile_for(&socket));

	// 1. Acquire the pidfile flock before doing anything observable. Contention →
	//    another worker is alive → exit silently.
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

	// 4b. BUG-475: cap CPU affinity before any embed work so fastembed/ort
	//     can't saturate every core.
	cap_embed_affinity();

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
