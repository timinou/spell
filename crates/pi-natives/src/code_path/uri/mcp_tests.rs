use pi_code_path::{
	resolver::{CancellationToken, SchemeHandler},
	types::DiagnosticVariant,
};

use super::McpHandler;

#[test]
fn mcp_returns_scheme_not_implemented() {
	let h = McpHandler;
	let err = h
		.handle("server/path", &CancellationToken::new())
		.unwrap_err();
	assert!(matches!(err.variant, DiagnosticVariant::SchemeNotImplemented));
	assert!(err.message.contains("mcp:// scheme not implemented"));
}

#[test]
fn mcp_any_path_returns_same_error() {
	let h = McpHandler;
	let err = h.handle("foo", &CancellationToken::new()).unwrap_err();
	assert!(matches!(err.variant, DiagnosticVariant::SchemeNotImplemented));
}
