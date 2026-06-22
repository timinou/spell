//! The `run` NIF: execute an argv vector on brush, capture output, return a
//! structured map (PLAN-011 W0).
//!
//! # Safety contract (never brick the VM)
//!
//! brush execution is blocking and may panic deep in expansion or a builtin.
//! Three guards make this NIF safe to call from the BEAM:
//!
//! 1. **Dirty scheduler** (`schedule = "DirtyCpu"`): the call may block for the
//!    command's whole runtime, so it must never occupy a normal scheduler.
//! 2. **`catch_unwind`**: any panic inside brush is trapped and converted to an
//!    error *map* (`exit: -1`), never propagated across the NIF boundary (which
//!    would abort the emulator). Requires `panic = "unwind"` — set in
//!    Cargo.toml.
//! 3. **Timeout via cancel token**: a long-running command is bounded by
//!    `timeout_ms`; on elapse the brush cancel token fires and we return `exit:
//!    124` (the conventional timeout code).
//!
//! # Output capture
//!
//! `ExecutionResult` only carries the exit code; stdout/stderr are captured by
//! redirecting brush's STDOUT/STDERR fds to temp files, then reading them back
//! after the command completes. Temp files (not OS pipes) are used
//! deliberately: a pipe's ~64KB buffer would deadlock a command that out-runs a
//! drainer, and a temp file needs no concurrent reader. Streaming output is a
//! later wave.

use std::{collections::HashMap, io::Read, panic::AssertUnwindSafe};

use brush_builtins::{BuiltinSet, default_builtins};
use brush_core::{
	CreateOptions, Shell as BrushShell, ShellValue, ShellVariable,
	openfiles::{OpenFile, OpenFiles},
};
use rustler::{Encoder, Env, NifResult, Term};
use tokio_util::sync::CancellationToken;

use crate::argv::{argv_to_program, pipeline_to_program};

/// The structured result of one command, encoded to an Elixir map with string
/// keys (`%{"exit" => int, "out" => binary, "err" => binary}`).
struct RunOutput {
	exit: i64,
	out:  String,
	err:  String,
}

impl RunOutput {
	fn panicked(msg: String) -> Self {
		Self { exit: -1, out: String::new(), err: msg }
	}

	fn encode<'a>(&self, env: Env<'a>) -> Term<'a> {
		Term::map_from_pairs(env, &[
			("exit", self.exit.encode(env)),
			("out", self.out.encode(env)),
			("err", self.err.encode(env)),
		])
		.expect("static string keys never collide")
	}
}

/// Run an argv vector on brush and return `%{"exit","out","err"}`.
///
/// `argv` MUST be non-empty (the `sh` builtin validates this BEFORE calling,
/// but we re-check defensively). `env` overrides/extends the process
/// environment. `opts` accepts `cwd` (binary) and `timeout_ms` (integer,
/// default 30_000).
#[rustler::nif(schedule = "DirtyCpu")]
fn run<'a>(
	env: Env<'a>,
	argv: Vec<String>,
	shell_env: HashMap<String, String>,
	opts: HashMap<String, Term<'a>>,
) -> NifResult<Term<'a>> {
	let (cwd, timeout_ms) = parse_opts(&opts);
	let output = guarded(|| run_blocking(&argv, &shell_env, cwd.as_deref(), timeout_ms));
	Ok(output.encode(env))
}

/// Run a multi-stage pipeline on brush and capture its output (PLAN-011 W4).
///
/// `stages` is a list of argv vectors; brush connects stdout->stdin between
/// them (`a | b | c`). Each stage is escaped independently — inject-proof per
/// stage, exactly like [`run`]. The result map is identical in shape to
/// `run`'s, reporting the pipeline's overall exit (its last stage, per shell
/// semantics).
#[rustler::nif(schedule = "DirtyCpu")]
fn pipe<'a>(
	env: Env<'a>,
	stages: Vec<Vec<String>>,
	shell_env: HashMap<String, String>,
	opts: HashMap<String, Term<'a>>,
) -> NifResult<Term<'a>> {
	let (cwd, timeout_ms) = parse_opts(&opts);
	let output = guarded(|| pipe_blocking(&stages, &shell_env, cwd.as_deref(), timeout_ms));
	Ok(output.encode(env))
}

/// Shared opts decode: `cwd` (binary) and `timeout_ms` (integer, default 30s).
fn parse_opts(opts: &HashMap<String, Term<'_>>) -> (Option<String>, u64) {
	let cwd = opts.get("cwd").and_then(|t| t.decode::<String>().ok());
	let timeout_ms = opts
		.get("timeout_ms")
		.and_then(|t| t.decode::<u64>().ok())
		.unwrap_or(30_000);
	(cwd, timeout_ms)
}

/// Run a blocking brush call under `catch_unwind` so a brush panic becomes an
/// error map (exit -1) rather than aborting the BEAM VM.
fn guarded(f: impl FnOnce() -> RunOutput) -> RunOutput {
	match std::panic::catch_unwind(AssertUnwindSafe(f)) {
		Ok(out) => out,
		Err(panic) => RunOutput::panicked(describe_panic(panic.as_ref())),
	}
}

/// Synchronous wrapper: build the AST from argv, then drive brush to
/// completion.
fn run_blocking(
	argv: &[String],
	shell_env: &HashMap<String, String>,
	cwd: Option<&str>,
	timeout_ms: u64,
) -> RunOutput {
	match argv_to_program(argv) {
		Some(program) => block_on_program(program, shell_env, cwd, timeout_ms),
		None => RunOutput { exit: 2, out: String::new(), err: "empty argv".into() },
	}
}

/// Synchronous wrapper for a multi-stage pipeline (PLAN-011 W4). Each stage is
/// its own escaped argv; brush connects stdout->stdin between stages. A stage
/// with an empty argv is rejected (same contract as a single command).
fn pipe_blocking(
	stages: &[Vec<String>],
	shell_env: &HashMap<String, String>,
	cwd: Option<&str>,
	timeout_ms: u64,
) -> RunOutput {
	match pipeline_to_program(stages) {
		Some(program) => block_on_program(program, shell_env, cwd, timeout_ms),
		None => RunOutput {
			exit: 2,
			out:  String::new(),
			err:  "pipeline needs at least one non-empty stage".into(),
		},
	}
}

/// Spin up a single-threaded tokio runtime and drive the async brush execution
/// of an ALREADY-BUILT program to completion, bounded by `timeout_ms`. Shared
/// by the single-command and pipeline paths so timeout/capture/safety are
/// identical.
fn block_on_program(
	program: brush_parser::ast::Program,
	shell_env: &HashMap<String, String>,
	cwd: Option<&str>,
	timeout_ms: u64,
) -> RunOutput {
	let runtime = match tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
	{
		Ok(rt) => rt,
		Err(e) => return RunOutput::panicked(format!("tokio runtime: {e}")),
	};

	runtime.block_on(async move { execute(program, shell_env, cwd, timeout_ms).await })
}

/// Build a non-interactive brush shell, redirect output to temp files, run the
/// pre-built program under a timeout, and read back the captured streams.
async fn execute(
	program: brush_parser::ast::Program,
	shell_env: &HashMap<String, String>,
	cwd: Option<&str>,
	timeout_ms: u64,
) -> RunOutput {
	let create = CreateOptions {
		interactive: false,
		login: false,
		no_profile: true,
		no_rc: true,
		do_not_inherit_env: true,
		builtins: default_builtins(BuiltinSet::BashMode),
		..Default::default()
	};

	let mut shell = match BrushShell::new(create).await {
		Ok(s) => s,
		Err(e) => return RunOutput::panicked(format!("shell init: {e}")),
	};

	// Caller-supplied environment (exported so spawned processes inherit it).
	for (key, value) in shell_env {
		let mut var = ShellVariable::new(ShellValue::String(value.clone()));
		var.export();
		if let Err(e) = shell.env.set_global(key, var) {
			return RunOutput::panicked(format!("env set {key}: {e}"));
		}
	}

	if let Some(dir) = cwd
		&& let Err(e) = shell.set_working_dir(dir)
	{
		return RunOutput { exit: 2, out: String::new(), err: format!("cwd {dir}: {e}") };
	}

	// Capture stdout/stderr to separate temp files.
	let (out_file, out_handle) = match temp_capture() {
		Ok(pair) => pair,
		Err(e) => return RunOutput::panicked(format!("capture stdout: {e}")),
	};
	let (err_file, err_handle) = match temp_capture() {
		Ok(pair) => pair,
		Err(e) => return RunOutput::panicked(format!("capture stderr: {e}")),
	};

	let cancel = CancellationToken::new();
	let mut params = shell.default_exec_params();
	params.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(out_file));
	params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(err_file));
	params.set_cancel_token(cancel.clone());

	// Bound the command by the timeout. On elapse we MUST NOT drop the brush
	// future (that would orphan the spawned child): brush only kills the child
	// when its own cancellation `select!` arm runs. So we fire the cancel token
	// and then KEEP AWAITING the same future, letting brush reap the child and
	// return. See brush-core processes.rs::Process::wait (the cancel arm calls
	// child.kill()).
	let timed_out = {
		let fut = shell.run_program(program, &params);
		tokio::pin!(fut);
		let deadline = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms));
		tokio::pin!(deadline);

		let mut fired = false;
		loop {
			tokio::select! {
				res = &mut fut => {
					match res {
						// Completed (or cancelled): `fired` tells us whether the
						// deadline tripped. A multi-stage pipeline cancellation
						// surfaces as Err(Interrupted) from brush AFTER we fired
						// the token — that is a TIMEOUT, not a generic failure, so
						// we fall through to the `timed_out` branch below (exit
						// 124) instead of reporting exit 1.
						Ok(_result) => break fired,
						Err(_e) if fired => break true,
						Err(e) => {
							return finish(out_handle, err_handle, 1, Some(format!("brush: {e}")));
						},
					}
				},
				() = &mut deadline, if !fired => {
					// Trigger brush's in-flight cancellation, then continue the
					// loop to await the future as it kills the child and unwinds.
					cancel.cancel();
					fired = true;
				},
			}
		}
	};

	// Drop params so the fd handles flush/close before we read the temp files.
	let exit = exit_code_from(&shell);
	drop(params);

	if timed_out {
		finish(out_handle, err_handle, 124, Some("timeout".into()))
	} else {
		finish(out_handle, err_handle, exit, None)
	}
}

/// Read back the captured temp files and assemble the final output.
fn finish(
	mut out_handle: std::fs::File,
	mut err_handle: std::fs::File,
	exit: i64,
	extra_err: Option<String>,
) -> RunOutput {
	use std::io::{Seek, SeekFrom};
	let mut out = String::new();
	let mut err = String::new();
	let _ = out_handle.seek(SeekFrom::Start(0));
	let _ = out_handle.read_to_string(&mut out);
	let _ = err_handle.seek(SeekFrom::Start(0));
	let _ = err_handle.read_to_string(&mut err);
	if let Some(extra) = extra_err {
		if !err.is_empty() && !err.ends_with('\n') {
			err.push('\n');
		}
		err.push_str(&extra);
	}
	RunOutput { exit, out, err }
}

/// Create a temp file and return (write-handle for brush, read-handle for us).
/// Both point at the same on-disk file; brush writes, we seek+read after.
fn temp_capture() -> std::io::Result<(std::fs::File, std::fs::File)> {
	let tmp = tempfile::tempfile()?;
	let read_handle = tmp.try_clone()?;
	Ok((tmp, read_handle))
}

/// brush stores `$?` on the shell after a run; surface it as the exit code.
fn exit_code_from(shell: &BrushShell) -> i64 {
	i64::from(shell.last_result())
}

/// Best-effort extraction of a panic payload's message.
fn describe_panic(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(s) = payload.downcast_ref::<&str>() {
		format!("panic: {s}")
	} else if let Some(s) = payload.downcast_ref::<String>() {
		format!("panic: {s}")
	} else {
		"panic: <non-string payload>".into()
	}
}
