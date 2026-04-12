use std::{
	io::{self, BufRead, Write},
	panic::{self, AssertUnwindSafe},
	sync::{Mutex, OnceLock},
};

use pi_code_vectors::EmbeddingEngine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

static ENGINE: OnceLock<Mutex<Option<EmbeddingEngine>>> = OnceLock::new();

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
	Init,
	EmbedBatch { texts: Vec<String>, batch_size: Option<usize> },
	EmbedQuery { text: String },
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
	let engine = EmbeddingEngine::new(false).map_err(|error| error.to_string())?;
	let mut slot = engine_slot()
		.lock()
		.map_err(|error| format!("mutex poisoned: {error}"))?;
	*slot = Some(engine);
	Ok(())
}

fn with_engine<T>(mut f: impl FnMut(&EmbeddingEngine) -> Result<T, String>) -> Result<T, String> {
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
			Ok(json!({"initialized": true}))
		},
		Command::EmbedBatch { texts, batch_size } => with_engine(|engine| {
			let docs: Vec<&str> = texts.iter().map(String::as_str).collect();
			let vectors = engine
				.embed_batch(&docs, batch_size)
				.map_err(|error| error.to_string())?;
			Ok(json!({"vectors": vectors}))
		}),
		Command::EmbedQuery { text } => with_engine(|engine| {
			let vector = engine
				.embed_query(&text)
				.map_err(|error| error.to_string())?;
			Ok(json!({"vector": vector}))
		}),
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

fn write_response(response: &Response) -> Result<(), String> {
	let mut stdout = io::stdout().lock();
	serde_json::to_writer(&mut stdout, response).map_err(|error| error.to_string())?;
	stdout.write_all(b"\n").map_err(|error| error.to_string())?;
	stdout.flush().map_err(|error| error.to_string())
}

fn main() {
	let stdin = io::stdin();
	let mut reader = stdin.lock();
	let mut line = String::new();

	loop {
		line.clear();
		match reader.read_line(&mut line) {
			Ok(0) => break,
			Ok(_) => {
				let line = line.trim_end_matches(['\r', '\n']);
				let response = process_line(line);
				if let Err(error) = write_response(&response) {
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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn deserializes_init_command() {
		let command: Command = serde_json::from_str(r#"{"command":"init"}"#).expect("command");
		assert_eq!(command, Command::Init);
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
}
