//! Synchronous LSP JSON-RPC client.
//!
//! Spawns one child process per LSP server, owns its stdin/stdout/stderr,
//! and exposes a request/notify API that blocks the caller until the
//! response arrives. Push-notifications (`publishDiagnostics`) accumulate
//! into a shared cache the [`super::LspSemanticBackend`] reads on demand.
//!
//! ## Why synchronous
//!
//! The [`crate::semantic::SemanticBackend`] trait is sync (every method
//! returns `T`, not `Future<Output = T>`). An async LSP client would force
//! `block_on` at every trait-method boundary, which means either pulling
//! in a tokio runtime per backend instance or sharing one globally.
//! Synchronous over std::process + threads is simpler, deterministic, and
//! matches the call shape — the agent asks one question at a time.
//!
//! ## Wire framing
//!
//! `Content-Length: N\r\n\r\n<json>` per the LSP base protocol. JSON
//! payloads are typed via `lsp-types`.

use std::{
	collections::HashMap,
	io::{BufRead, BufReader, Read as _, Write},
	process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
	sync::{
		atomic::{AtomicU64, Ordering},
		mpsc, Arc, Mutex, OnceLock,
	},
	thread::{self, JoinHandle},
	time::Duration,
};

use lsp_types::{
	notification::Notification as LspNotification, request::Request as LspRequest,
	InitializeParams, InitializeResult, PublishDiagnosticsParams, ServerCapabilities, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::semantic::Diagnostic as SemanticDiagnostic;

// ── Errors ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum LspClientError {
	SpawnFailed(String),
	HandshakeFailed(String),
	ProtocolError { code: i64, message: String },
	Timeout,
	PipeBroken,
	Serde(String),
}

impl std::fmt::Display for LspClientError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::SpawnFailed(s) => write!(f, "spawn failed: {s}"),
			Self::HandshakeFailed(s) => write!(f, "handshake failed: {s}"),
			Self::ProtocolError { code, message } => write!(f, "lsp error {code}: {message}"),
			Self::Timeout => write!(f, "request timed out"),
			Self::PipeBroken => write!(f, "server pipe broken"),
			Self::Serde(s) => write!(f, "serde error: {s}"),
		}
	}
}
impl std::error::Error for LspClientError {}

// ── JSON-RPC envelopes ──────────────────────────────────────────────

#[derive(Serialize)]
struct JsonRpcRequest<'a> {
	jsonrpc: &'a str,
	id:      u64,
	method:  &'a str,
	params:  Value,
}

#[derive(Serialize)]
struct JsonRpcNotification<'a> {
	jsonrpc: &'a str,
	method:  &'a str,
	params:  Value,
}

#[derive(Deserialize, Debug)]
struct JsonRpcEnvelope {
	#[serde(default)]
	id:     Option<Value>,
	#[serde(default)]
	result: Option<Value>,
	#[serde(default)]
	error:  Option<JsonRpcErrorPayload>,
	#[serde(default)]
	method: Option<String>,
	#[serde(default)]
	params: Option<Value>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcErrorPayload {
	code:    i64,
	message: String,
}

// ── Client ──────────────────────────────────────────────────────────

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, LspClientError>>>>>;
type DiagsCache = Arc<Mutex<HashMap<Url, Vec<SemanticDiagnostic>>>>;

pub struct LspClient {
	child:           Mutex<Child>,
	stdin:           Mutex<ChildStdin>,
	next_id:         AtomicU64,
	pending:         Pending,
	diagnostics:     DiagsCache,
	capabilities:    OnceLock<ServerCapabilities>,
	server_name:     String,
	request_timeout: Duration,
	_reader:         Mutex<Option<JoinHandle<()>>>,
	_stderr:         Mutex<Option<JoinHandle<()>>>,
}

impl LspClient {
	pub fn spawn(
		command: &str,
		args: &[&str],
		root_uri: Url,
		init_options: Option<Value>,
		server_name: impl Into<String>,
		env: &[(String, String)],
		request_timeout: Duration,
	) -> Result<Arc<Self>, LspClientError> {
		let mut cmd = Command::new(command);
		cmd.args(args)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		for (k, v) in env {
			cmd.env(k, v);
		}
		let mut child = cmd
			.spawn()
			.map_err(|e| LspClientError::SpawnFailed(e.to_string()))?;

		let stdin: ChildStdin = child
			.stdin
			.take()
			.ok_or_else(|| LspClientError::HandshakeFailed("stdin pipe missing".into()))?;
		let stdout: ChildStdout = child
			.stdout
			.take()
			.ok_or_else(|| LspClientError::HandshakeFailed("stdout pipe missing".into()))?;
		let stderr: ChildStderr = child
			.stderr
			.take()
			.ok_or_else(|| LspClientError::HandshakeFailed("stderr pipe missing".into()))?;

		let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
		let diagnostics: DiagsCache = Arc::new(Mutex::new(HashMap::new()));
		let server_name = server_name.into();

		let reader_thread =
			spawn_reader_thread(stdout, pending.clone(), diagnostics.clone(), server_name.clone());
		let stderr_thread = spawn_stderr_thread(stderr, server_name.clone());

		let client = Arc::new(Self {
			child:           Mutex::new(child),
			stdin:           Mutex::new(stdin),
			next_id:         AtomicU64::new(1),
			pending,
			diagnostics,
			capabilities:    OnceLock::new(),
			server_name:     server_name.clone(),
			request_timeout,
			_reader:         Mutex::new(Some(reader_thread)),
			_stderr:         Mutex::new(Some(stderr_thread)),
		});

		// Handshake: initialize + initialized.
		let init_params = build_initialize_params(root_uri, init_options);
		let init_result: InitializeResult = client
			.request::<lsp_types::request::Initialize>(init_params)
			.map_err(|e| LspClientError::HandshakeFailed(format!("{e}")))?;
		let _ = client.capabilities.set(init_result.capabilities);
		client.notify::<lsp_types::notification::Initialized>(lsp_types::InitializedParams {});

		Ok(client)
	}

	pub fn server_name(&self) -> &str {
		&self.server_name
	}

	pub fn capabilities(&self) -> ServerCapabilities {
		self.capabilities.get().cloned().unwrap_or_default()
	}

	pub fn request<R>(&self, params: R::Params) -> Result<R::Result, LspClientError>
	where
		R: LspRequest,
		R::Params: Serialize,
		R::Result: for<'de> Deserialize<'de>,
	{
		let id = self.next_id.fetch_add(1, Ordering::Relaxed);
		let (tx, rx) = mpsc::channel();
		self.pending.lock().unwrap().insert(id, tx);

		let body = serde_json::to_value(JsonRpcRequest {
			jsonrpc: "2.0",
			id,
			method: R::METHOD,
			params: serde_json::to_value(params)
				.map_err(|e| LspClientError::Serde(e.to_string()))?,
		})
		.map_err(|e| LspClientError::Serde(e.to_string()))?;
		self.write_frame(&body)?;

		let response = rx
			.recv_timeout(self.request_timeout)
			.map_err(|_| LspClientError::Timeout)?;
		let value = response?;
		serde_json::from_value::<R::Result>(value)
			.map_err(|e| LspClientError::Serde(e.to_string()))
	}

	pub fn notify<N>(&self, params: N::Params)
	where
		N: LspNotification,
		N::Params: Serialize,
	{
		let body = match serde_json::to_value(JsonRpcNotification {
			jsonrpc: "2.0",
			method: N::METHOD,
			params: match serde_json::to_value(params) {
				Ok(v) => v,
				Err(_) => return,
			},
		}) {
			Ok(v) => v,
			Err(_) => return,
		};
		let _ = self.write_frame(&body);
	}

	pub fn diagnostics_for(&self, uri: &Url) -> Vec<SemanticDiagnostic> {
		self.diagnostics
			.lock()
			.unwrap()
			.get(uri)
			.cloned()
			.unwrap_or_default()
	}

	pub fn shutdown(&self) -> Result<(), LspClientError> {
		// Best-effort: ignore the response value (server may return `null`).
		let _ = self.request::<lsp_types::request::Shutdown>(());
		self.notify::<lsp_types::notification::Exit>(());
		Ok(())
	}

	fn write_frame(&self, body: &Value) -> Result<(), LspClientError> {
		let payload = serde_json::to_vec(body).map_err(|e| LspClientError::Serde(e.to_string()))?;
		let mut stdin = self.stdin.lock().unwrap();
		write!(stdin, "Content-Length: {}\r\n\r\n", payload.len())
			.map_err(|_| LspClientError::PipeBroken)?;
		stdin.write_all(&payload).map_err(|_| LspClientError::PipeBroken)?;
		stdin.flush().map_err(|_| LspClientError::PipeBroken)?;
		Ok(())
	}
}

impl Drop for LspClient {
	fn drop(&mut self) {
		let _ = self.shutdown();
		let mut child = match self.child.lock() {
			Ok(c) => c,
			Err(p) => p.into_inner(),
		};
		let _ = child.kill();
		let _ = child.wait();
		if let Some(handle) = self._reader.lock().unwrap().take() {
			let _ = handle.join();
		}
		if let Some(handle) = self._stderr.lock().unwrap().take() {
			let _ = handle.join();
		}
	}
}

// ── Reader thread ───────────────────────────────────────────────────

fn spawn_reader_thread(
	stdout: ChildStdout,
	pending: Pending,
	diagnostics: DiagsCache,
	server_name: String,
) -> JoinHandle<()> {
	thread::Builder::new()
		.name(format!("lsp-reader-{server_name}"))
		.spawn(move || {
			let mut reader = BufReader::new(stdout);
			loop {
				let payload = match read_frame(&mut reader) {
					Ok(p) => p,
					Err(ReadFrameError::Eof) => break,
					Err(_) => break,
				};
				let env: JsonRpcEnvelope = match serde_json::from_slice(&payload) {
					Ok(r) => r,
					Err(_) => continue,
				};

				if let Some(method) = env.method.as_deref() {
					if method == lsp_types::notification::PublishDiagnostics::METHOD {
						if let Some(params) = env.params {
							if let Ok(pd) =
								serde_json::from_value::<PublishDiagnosticsParams>(params)
							{
								let converted = convert_lsp_diagnostics(&pd, &server_name);
								diagnostics.lock().unwrap().insert(pd.uri, converted);
							}
						}
					}
					continue;
				}

				let id = match env.id.as_ref().and_then(value_as_u64) {
					Some(id) => id,
					None => continue,
				};
				let sender = pending.lock().unwrap().remove(&id);
				if let Some(sender) = sender {
					let result = if let Some(err) = env.error {
						Err(LspClientError::ProtocolError {
							code:    err.code,
							message: err.message,
						})
					} else {
						Ok(env.result.unwrap_or(Value::Null))
					};
					let _ = sender.send(result);
				}
			}
		})
		.expect("spawn LSP reader thread")
}

fn spawn_stderr_thread(stderr: ChildStderr, server_name: String) -> JoinHandle<()> {
	thread::Builder::new()
		.name(format!("lsp-stderr-{server_name}"))
		.spawn(move || {
			let reader = BufReader::new(stderr);
			for line in reader.lines().map_while(Result::ok) {
				eprintln!("[lsp:{server_name}] {line}");
			}
		})
		.expect("spawn LSP stderr thread")
}

fn value_as_u64(v: &Value) -> Option<u64> {
	match v {
		Value::Number(n) => n.as_u64(),
		Value::String(s) => s.parse().ok(),
		_ => None,
	}
}

#[derive(Debug)]
enum ReadFrameError {
	Eof,
	Io(std::io::Error),
	Protocol(String),
}

fn read_frame<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, ReadFrameError> {
	let mut content_length: Option<usize> = None;
	loop {
		let mut header = String::new();
		let n = reader.read_line(&mut header).map_err(ReadFrameError::Io)?;
		if n == 0 {
			return Err(ReadFrameError::Eof);
		}
		let trimmed = header.trim_end_matches(['\r', '\n']);
		if trimmed.is_empty() {
			break;
		}
		let Some((key, value)) = trimmed.split_once(':') else {
			continue;
		};
		if key.trim().eq_ignore_ascii_case("content-length") {
			content_length = value.trim().parse().ok();
		}
	}
	let len = content_length
		.ok_or_else(|| ReadFrameError::Protocol("missing Content-Length".into()))?;
	let mut buf = vec![0u8; len];
	reader.read_exact(&mut buf).map_err(ReadFrameError::Io)?;
	Ok(buf)
}

// ── Initialize params ───────────────────────────────────────────────

fn build_initialize_params(root_uri: Url, init_options: Option<Value>) -> InitializeParams {
	#[allow(deprecated)]
	InitializeParams {
		process_id:                Some(std::process::id()),
		root_path:                 None,
		root_uri:                  Some(root_uri.clone()),
		initialization_options:    init_options,
		capabilities:              client_capabilities(),
		trace:                     None,
		workspace_folders:         Some(vec![lsp_types::WorkspaceFolder {
			uri:  root_uri,
			name: "workspace".into(),
		}]),
		client_info:               Some(lsp_types::ClientInfo {
			name:    "spell".into(),
			version: Some(env!("CARGO_PKG_VERSION").into()),
		}),
		locale:                    None,
		work_done_progress_params: lsp_types::WorkDoneProgressParams::default(),
	}
}

fn client_capabilities() -> lsp_types::ClientCapabilities {
	lsp_types::ClientCapabilities {
		text_document: Some(lsp_types::TextDocumentClientCapabilities {
			hover: Some(lsp_types::HoverClientCapabilities {
				dynamic_registration: Some(false),
				content_format:       Some(vec![
					lsp_types::MarkupKind::PlainText,
					lsp_types::MarkupKind::Markdown,
				]),
			}),
			definition:          Some(lsp_types::GotoCapability::default()),
			type_definition:     Some(lsp_types::GotoCapability::default()),
			implementation:      Some(lsp_types::GotoCapability::default()),
			references:          Some(lsp_types::ReferenceClientCapabilities::default()),
			rename:              Some(lsp_types::RenameClientCapabilities {
				prepare_support: Some(true),
				..Default::default()
			}),
			publish_diagnostics: Some(lsp_types::PublishDiagnosticsClientCapabilities::default()),
			signature_help:      Some(lsp_types::SignatureHelpClientCapabilities::default()),
			inlay_hint:          Some(lsp_types::InlayHintClientCapabilities::default()),
			synchronization:     Some(lsp_types::TextDocumentSyncClientCapabilities {
				dynamic_registration: Some(false),
				will_save:            Some(false),
				will_save_wait_until: Some(false),
				did_save:             Some(true),
			}),
			..Default::default()
		}),
		workspace:         Some(lsp_types::WorkspaceClientCapabilities {
			workspace_folders: Some(true),
			..Default::default()
		}),
		window:            None,
		experimental:      None,
		general:           None,
	}
}

// ── Diagnostic conversion ───────────────────────────────────────────

fn convert_lsp_diagnostics(
	params: &PublishDiagnosticsParams,
	server_name: &str,
) -> Vec<SemanticDiagnostic> {
	params
		.diagnostics
		.iter()
		.map(|d| SemanticDiagnostic {
			location: crate::semantic::Location {
				file: lsp_uri_to_pathbuf(&params.uri),
				// LSP is 0-indexed lines/cols; Semantic is 1-indexed (W0g convention).
				line: d.range.start.line + 1,
				col:  d.range.start.character + 1,
				end:  Some((d.range.end.line + 1, d.range.end.character + 1)),
			},
			severity: match d.severity {
				Some(lsp_types::DiagnosticSeverity::ERROR) => crate::semantic::Severity::Error,
				Some(lsp_types::DiagnosticSeverity::WARNING) => crate::semantic::Severity::Warning,
				Some(lsp_types::DiagnosticSeverity::INFORMATION) => {
					crate::semantic::Severity::Info
				},
				Some(lsp_types::DiagnosticSeverity::HINT) => crate::semantic::Severity::Hint,
				_ => crate::semantic::Severity::Info,
			},
			message: d.message.clone(),
			source:  d.source.clone().unwrap_or_else(|| server_name.to_string()),
		})
		.collect()
}

pub(crate) fn lsp_uri_to_pathbuf(uri: &Url) -> std::path::PathBuf {
	uri.to_file_path()
		.unwrap_or_else(|()| std::path::PathBuf::from(uri.as_str()))
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn read_frame_parses_content_length_header() {
		let input = b"Content-Length: 7\r\n\r\n{\"a\":1}";
		let mut reader = std::io::BufReader::new(&input[..]);
		let frame = read_frame(&mut reader).expect("parses");
		assert_eq!(frame, b"{\"a\":1}");
	}

	#[test]
	fn read_frame_handles_multiple_headers() {
		let input = b"Content-Length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
		let mut reader = std::io::BufReader::new(&input[..]);
		let frame = read_frame(&mut reader).expect("parses");
		assert_eq!(frame, b"{}");
	}

	#[test]
	fn read_frame_returns_eof_on_empty_input() {
		let input: &[u8] = b"";
		let mut reader = std::io::BufReader::new(input);
		assert!(matches!(read_frame(&mut reader), Err(ReadFrameError::Eof)));
	}

	#[test]
	fn value_as_u64_accepts_number_or_string() {
		assert_eq!(value_as_u64(&Value::from(42u64)), Some(42));
		assert_eq!(value_as_u64(&Value::from("123")), Some(123));
		assert_eq!(value_as_u64(&Value::Null), None);
	}

	#[test]
	fn convert_lsp_diagnostics_1_indexes_lines_and_cols() {
		let pd = PublishDiagnosticsParams {
			uri: Url::parse("file:///tmp/foo.rs").unwrap(),
			diagnostics: vec![lsp_types::Diagnostic {
				range: lsp_types::Range {
					start: lsp_types::Position { line: 0, character: 0 },
					end:   lsp_types::Position { line: 0, character: 5 },
				},
				severity: Some(lsp_types::DiagnosticSeverity::ERROR),
				message: "oops".into(),
				source: Some("rustc".into()),
				..Default::default()
			}],
			version: None,
		};
		let converted = convert_lsp_diagnostics(&pd, "rust-analyzer");
		assert_eq!(converted.len(), 1);
		let d = &converted[0];
		assert_eq!(d.location.line, 1, "LSP line 0 -> Semantic line 1");
		assert_eq!(d.location.col, 1, "LSP char 0 -> Semantic col 1");
		assert_eq!(d.location.end, Some((1, 6)));
		assert!(matches!(d.severity, crate::semantic::Severity::Error));
		assert_eq!(d.source, "rustc");
	}

	#[test]
	fn convert_lsp_diagnostics_falls_back_to_server_name() {
		let pd = PublishDiagnosticsParams {
			uri: Url::parse("file:///tmp/foo.rs").unwrap(),
			diagnostics: vec![lsp_types::Diagnostic {
				range: lsp_types::Range::default(),
				severity: None,
				message: "no source".into(),
				source: None,
				..Default::default()
			}],
			version: None,
		};
		let converted = convert_lsp_diagnostics(&pd, "my-server");
		assert_eq!(converted[0].source, "my-server");
		assert!(matches!(converted[0].severity, crate::semantic::Severity::Info));
	}
}
