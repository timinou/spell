//! `pi-edit-broker` daemon binary.
//!
//! Self-daemonizes via a manual `fork + setsid` dance when `--daemonize` is
//! supplied. Child writes a pid file and runs [`pi_edit_broker::run_server`];
//! parent exits zero after a brief wait so `spawn_broker_if_absent` can
//! observe the socket.

use std::{
	fs,
	os::unix::fs::OpenOptionsExt,
	path::PathBuf,
	time::{Duration, Instant},
};

use clap::Parser;
use nix::unistd::{ForkResult, fork};
use pi_edit_broker::{BrokerOptions, run_server, spawn};

#[derive(Debug, Parser)]
#[command(name = "pi-edit-broker", version)]
struct Cli {
	#[arg(long)]
	daemonize: bool,
	#[arg(long)]
	socket:    Option<PathBuf>,
	#[arg(long = "pid-file")]
	pid_file:  Option<PathBuf>,
	#[arg(long = "grace-ms")]
	grace_ms:  Option<u64>,
	#[arg(long = "journal-path")]
	journal_path: Option<PathBuf>,
}

fn default_socket() -> PathBuf {
	std::env::var_os("PI_EDIT_BROKER_SOCKET").map_or_else(
		|| {
			let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
			home.join(".spell").join("edit-broker.sock")
		},
		PathBuf::from,
	)
}

fn default_pid_file() -> PathBuf {
	std::env::var_os("PI_EDIT_BROKER_PID_FILE").map_or_else(
		|| {
			let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from);
			home.join(".spell").join("edit-broker.pid")
		},
		PathBuf::from,
	)
}

fn default_grace_ms() -> u64 {
	std::env::var("PI_EDIT_BROKER_GRACE_MS")
		.ok()
		.and_then(|v| v.parse::<u64>().ok())
		.unwrap_or(30_000)
}

fn write_pid_file(path: &PathBuf, pid: u32) -> std::io::Result<()> {
	if let Some(parent) = path.parent()
		&& !parent.as_os_str().is_empty()
	{
		fs::create_dir_all(parent)?;
	}
	let tmp = path.with_extension("pid.tmp");
	fs::OpenOptions::new()
		.create(true)
		.write(true)
		.truncate(true)
		.mode(0o600)
		.open(&tmp)
		.and_then(|mut f| std::io::Write::write_all(&mut f, pid.to_string().as_bytes()))?;
	fs::rename(&tmp, path)?;
	Ok(())
}

fn already_running(pid_file: &PathBuf) -> bool {
	let Ok(contents) = fs::read_to_string(pid_file) else {
		return false;
	};
	let Ok(pid) = contents.trim().parse::<u32>() else {
		return false;
	};
	pi_edit_broker::reaper::pid_alive(pid)
}

fn main() -> std::io::Result<()> {
	let cli = Cli::parse();
	let socket_path = cli.socket.unwrap_or_else(default_socket);
	let pid_path = cli.pid_file.unwrap_or_else(default_pid_file);
	let grace = Duration::from_millis(cli.grace_ms.unwrap_or_else(default_grace_ms));

	if already_running(&pid_path) && spawn::probe(&socket_path) {
		return Ok(());
	}

	if cli.daemonize {
		// SAFETY: single-threaded at this point (clap parse runs before tokio
		// runtime starts); fork is safe.
		match unsafe { fork() } {
			Ok(ForkResult::Parent { child }) => {
				let deadline = Instant::now() + Duration::from_secs(2);
				while Instant::now() < deadline {
					if spawn::probe(&socket_path) {
						break;
					}
					std::thread::sleep(Duration::from_millis(25));
				}
				let _ = child;
				return Ok(());
			},
			Ok(ForkResult::Child) => {
				let _ = nix::unistd::setsid();
			},
			Err(_) => {
				// Fall through to foreground.
			},
		}
	}

	let _ = write_pid_file(&pid_path, std::process::id());

	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()?;

	let run_result = runtime.block_on(async {
		run_server(BrokerOptions {
			socket_path: socket_path.clone(),
			grace,
			broadcast_capacity: 256,
			journal_path: cli.journal_path,
		})
		.await
	});

	let _ = fs::remove_file(&pid_path);
	let _ = fs::remove_file(&socket_path);

	run_result.map_err(std::io::Error::other)
}
