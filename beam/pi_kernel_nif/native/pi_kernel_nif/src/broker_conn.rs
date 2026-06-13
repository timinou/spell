//! Gate 3 (P3.8 / PLAN-334): the BEAM-side trigger of the owner-reclaim path.
//!
//! P3.5 proved the BROKER end — a dropped connection reclaims its edit-intents
//! so a second owner can acquire (crates/pi-edit-broker/tests/owner_reclaim.rs).
//! This module wires the BEAM TRIGGER: an owner's broker connection is held
//! open inside a rustler `ResourceArc` for the duration of the hold. When the
//! owning BEAM process dies, rustler's `Resource::down` monitor callback fires
//! and we drop the connection; the `UnixStream`'s `Drop` closes the socket; the
//! broker's existing disconnect-deregister (conn.rs:134) frees that owner's
//! intents. A second owner then acquires the same file — no deadlock.
//!
//! Why a held connection (socket-per-owner) and not the pid reaper: a killed
//! BEAM *process* shares the node OS pid, so the broker's `kill(pid,0)` reaper
//! never sees it die. The owner MUST be reclaimed via connection-drop, which is
//! exactly what the monitored ResourceArc provides.

use std::{
	io::{BufRead, BufReader, Write},
	os::unix::net::UnixStream,
	path::PathBuf,
	sync::Mutex,
};

use pi_edit_broker::{ClientMessage, ServerMessage, spawn_broker_if_absent};
use rustler::{Encoder, Env, LocalPid, Monitor, Resource, ResourceArc, Term};

/// A held broker connection owned by one BEAM process. The `UnixStream` is kept
/// open for the lifetime of the `ResourceArc`; dropping the resource (on the
/// owner's `:DOWN` or GC) closes it and the broker reclaims the owner's intents.
pub struct BrokerConnection {
	/// The live stream. `None` once explicitly released. Behind a `Mutex` so the
	/// `down` callback and an explicit release can't race on the close.
	stream: Mutex<Option<UnixStream>>,
	/// The owner id this connection belongs to (diagnostic / future use).
	#[allow(dead_code)]
	owner:  String,
}

impl BrokerConnection {
	fn close(&self) {
		// Taking the stream out of the Option drops it → the OS closes the
		// socket → the broker sees the disconnect and deregisters this owner.
		let mut guard = self.stream.lock().unwrap();
		guard.take();
	}
}

#[rustler::resource_impl]
impl Resource for BrokerConnection {
	const IMPLEMENTS_DOWN: bool = true;

	/// Process-monitor callback: the owning BEAM process died. Close the held
	/// connection so the broker reclaims this owner's intents.
	fn down<'a>(&'a self, _env: Env<'a>, _pid: LocalPid, _mon: Monitor) {
		self.close();
	}
}

fn read_line(reader: &mut BufReader<UnixStream>) -> Option<ServerMessage> {
	let mut line = String::new();
	match reader.read_line(&mut line) {
		Ok(0) | Err(_) => None,
		Ok(_) => serde_json::from_str(line.trim_end()).ok(),
	}
}

/// claim_intent(socket, broker_bin, owner, file, code_path) — open a broker
/// connection for `owner`, Hello + Intent on `file`/`code_path`, monitor the
/// calling process, and return `{:ok, resource, granted}`. The connection is
/// HELD inside the resource; when the caller process dies, `down` closes it and
/// the broker reclaims the intent.
///
/// `socket` + `broker_bin` are passed explicitly (not via env): `System.put_env`
/// on the Elixir side does NOT reliably reach the NIF's `std::env::var_os`, so
/// the host hands the paths in directly. `broker_bin` empty = let the broker's
/// own resolution (sibling exe / PATH) find it.
///
/// DirtyIo-scheduled: this does blocking socket I/O (a cold broker spawn polls up
/// to ~2s, plus blocking connect + read_line for the Hello/Welcome + IntentAck).
/// A regular-scheduler NIF must return in <1ms, so this MUST run on a dirty I/O
/// scheduler to avoid stalling the BEAM scheduler it lands on.
#[rustler::nif(schedule = "DirtyIo")]
fn claim_intent<'a>(
	env: Env<'a>,
	socket: String,
	broker_bin: String,
	owner: String,
	file: String,
	code_path: String,
) -> Result<Term<'a>, String> {
	let socket = PathBuf::from(socket);
	let bin = if broker_bin.is_empty() { None } else { Some(PathBuf::from(broker_bin)) };
	spawn_broker_if_absent(&socket, bin.as_deref()).map_err(|e| format!("spawn broker: {e}"))?;

	let stream = UnixStream::connect(&socket).map_err(|e| format!("connect: {e}"))?;
	let mut writer = stream.try_clone().map_err(|e| format!("clone: {e}"))?;
	let mut reader = BufReader::new(stream.try_clone().map_err(|e| format!("clone: {e}"))?);

	let send = |w: &mut UnixStream, msg: &ClientMessage| -> Result<(), String> {
		let mut bytes = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
		bytes.push(b'\n');
		w.write_all(&bytes).map_err(|e| e.to_string())
	};

	// Hello (register the owner) — drain the Welcome.
	send(&mut writer, &ClientMessage::Hello {
		session_id:   owner.clone(),
		pid:          std::process::id(),
		cwd:          PathBuf::from("/"),
		project_name: Some("pi_kernel_nif".into()),
		started_at:   0,
		open_files:   Vec::new(),
	})?;
	let _ = read_line(&mut reader);

	// Intent on the file/code-path (long TTL: prove RECLAIM not expiry).
	send(&mut writer, &ClientMessage::Intent {
		file:          PathBuf::from(&file),
		code_paths:    vec![code_path.clone()],
		base_revision: 1,
		ttl_ms:        600_000,
	})?;

	// Read past any broadcast events to the IntentAck.
	let granted = loop {
		match read_line(&mut reader) {
			Some(ServerMessage::IntentAck { granted, .. }) => break granted,
			Some(ServerMessage::IntentConflict { .. }) => break false,
			Some(_) => continue,
			None => return Err("broker closed before IntentAck".into()),
		}
	};

	let resource = ResourceArc::new(BrokerConnection {
		stream: Mutex::new(Some(stream)),
		owner:  owner.clone(),
	});

	// Monitor the calling process: on its :DOWN, `Resource::down` fires and
	// closes the held connection → broker reclaims this owner's intents.
	let caller = env.pid();
	let _ = env.monitor(&resource, &caller);

	// Return `(resource, granted)`; rustler wraps the Ok in `{:ok, ...}`, so the
	// Elixir side sees `{:ok, {resource, granted}}` → unwrapped by the wrapper.
	Ok((resource, granted).encode(env))
}

/// release_intent(resource) — explicitly drop the held connection (the owner is
/// done). Idempotent with the :DOWN path.
#[rustler::nif]
fn release_intent(resource: ResourceArc<BrokerConnection>) -> rustler::Atom {
	resource.close();
	rustler::types::atom::ok()
}
