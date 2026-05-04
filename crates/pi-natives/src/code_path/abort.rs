//! Bridge napi `AbortSignal` to the pi-code-path `CancellationToken`.
//!
//! v1 takes an optional pre-flipped boolean (the JS facade can flip it on
//! abort via a setter callback). Full callback wiring against napi's
//! AbortSignal API requires version-specific glue and is deferred to a
//! follow-up.

use pi_code_path::resolver::CancellationToken;

/// Create a kernel `CancellationToken` wired to an optional cancel flag.
/// When `cancel_flag` is `Some(true)`, the returned token is pre-cancelled.
pub fn bridge_abort_signal(cancel_flag: Option<bool>) -> CancellationToken {
	let token = CancellationToken::new();
	if cancel_flag.unwrap_or(false) {
		token.cancel();
	}
	token
}
