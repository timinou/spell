//! `JsTsfnCallback` — bridges a JS `ThreadsafeFunction` into the kernel's
//! `SchemeCallback` trait for runtime-registered URI schemes (canvas,
//! MCP-advertised).
//!
//! Execution model (per PLAN-310 D1):
//! - **Sync** from the kernel thread's perspective. We post the body to JS via
//!   `call_with_return_value`, then block on an mpsc channel for the JS return.
//! - **Budgeted** by `SchemeCapabilities::callback_budget`. Timeouts return a
//!   `Cancelled` diagnostic that propagates to the agent.
//! - **Cancellable** via `CancellationToken` — checked on entry and on timeout.

use std::{
	sync::{Arc, mpsc},
	time::Duration,
};

use napi::{
	Status,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use pi_code_path::{
	ResolvedContent, SchemeCallback, SessionContext,
	resolver::traits::CancellationToken,
	types::{Content, Diagnostic, DiagnosticVariant},
};

/// JS-facing return payload from a runtime scheme callback.
///
/// TS callbacks return `{ url, content, mime?, notes?, sourcePath? }`. The
/// kernel converts this into a `ResolvedContent` for the registry.
///
/// `source_path` enables codepath suffix forwarding and brush bash expansion
/// for hybrid schemes (e.g. skill://) where the data is JS-resident at
/// discovery time but ultimately backed by a filesystem path.
#[napi(object)]
pub struct JsResolvedContent {
	pub url:         String,
	pub content:     String,
	pub mime:        Option<String>,
	pub notes:       Option<Vec<String>>,
	pub source_path: Option<String>,
}

/// `SchemeCallback` impl that routes through a JS `ThreadsafeFunction`.
pub struct JsTsfnCallback {
	tsfn:   Arc<ThreadsafeFunction<String, JsResolvedContent>>,
	budget: Duration,
}

impl JsTsfnCallback {
	pub fn new(tsfn: ThreadsafeFunction<String, JsResolvedContent>, budget: Duration) -> Self {
		Self { tsfn: Arc::new(tsfn), budget }
	}
}

impl SchemeCallback for JsTsfnCallback {
	fn resolve(
		&self,
		body: &str,
		_ctx: Option<&SessionContext>,
		cancel: &CancellationToken,
	) -> Result<ResolvedContent, Diagnostic> {
		if cancel.is_cancelled() {
			return Err(cancelled("cancelled before callback dispatch"));
		}

		let (tx, rx) = mpsc::sync_channel::<core::result::Result<JsResolvedContent, String>>(1);
		let body_owned = body.to_string();
		let status = self.tsfn.call_with_return_value(
			Ok(body_owned),
			ThreadsafeFunctionCallMode::Blocking,
			move |result, _env| {
				let send = match result {
					Ok(v) => Ok(v),
					Err(e) => Err(e.reason.clone()),
				};
				let _ = tx.send(send);
				Ok(())
			},
		);
		if status != Status::Ok {
			return Err(callback_err(format!("tsfn dispatch failed: {status:?}")));
		}

		match rx.recv_timeout(self.budget) {
			Ok(Ok(payload)) => Ok(ResolvedContent {
				url:          payload.url,
				source_path:  payload.source_path.map(std::path::PathBuf::from),
				content:      Content::Text { value: payload.content },
				mime:         payload.mime,
				notes:        payload.notes.unwrap_or_default(),
				source_mtime: None,
			}),
			Ok(Err(msg)) => Err(callback_err(sanitize_js_reason(&msg))),
			Err(mpsc::RecvTimeoutError::Timeout) => {
				Err(cancelled(format!("callback budget {:?} exceeded", self.budget)))
			},
			Err(mpsc::RecvTimeoutError::Disconnected) => {
				Err(callback_err("tsfn channel disconnected"))
			},
		}
	}
}

fn callback_err(msg: impl Into<String>) -> Diagnostic {
	Diagnostic { variant: DiagnosticVariant::ParseError, message: msg.into(), span: None }
}
/// JS thrown errors arrive with the message duplicated, prefixed `Error:`,
/// and a multi-line stack trace appended. Strip the noise so the user-facing
/// diagnostic is just the first informative line.
///
/// Input shapes seen in the wild:
///   `"Error: skill not found\nError: skill not found\n    at resolveSkill
/// ..."`   `"skill not found\n    at resolveSkill (/path/...)"`
fn sanitize_js_reason(raw: &str) -> String {
	// First non-empty line, sans "Error: " prefix, sans "at <fn> (...)" suffix.
	let first = raw
		.lines()
		.map(|l| l.trim())
		.find(|l| !l.is_empty() && !l.starts_with("at "))
		.unwrap_or(raw);
	let trimmed = first.strip_prefix("Error: ").unwrap_or(first);
	trimmed.to_string()
}
fn cancelled(msg: impl Into<String>) -> Diagnostic {
	Diagnostic { variant: DiagnosticVariant::Cancelled, message: msg.into(), span: None }
}

#[cfg(test)]
mod sanitize_tests {
	use super::sanitize_js_reason;

	#[test]
	fn strips_error_prefix_and_stack() {
		let input = "Error: skill not found\nError: skill not found\n    at resolveSkill \
		             (/path/to/scheme-bootstrap.ts:126:23)";
		assert_eq!(sanitize_js_reason(input), "skill not found");
	}

	#[test]
	fn handles_plain_message() {
		assert_eq!(sanitize_js_reason("simple message"), "simple message");
	}

	#[test]
	fn handles_message_with_only_stack() {
		let input = "skill not found\n    at resolveSkill (/path)";
		assert_eq!(sanitize_js_reason(input), "skill not found");
	}

	#[test]
	fn handles_leading_whitespace_stack() {
		let input = "\n  Error: foo\n    at fn (/p)";
		assert_eq!(sanitize_js_reason(input), "foo");
	}
}
