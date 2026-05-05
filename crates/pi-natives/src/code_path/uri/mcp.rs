use pi_code_path::{
	resolver::{CancellationToken, SchemeHandler},
	types::{Diagnostic, DiagnosticVariant},
};

/// Handler for `mcp://` resources.
///
/// MCP scheme is not implemented in the current release.
pub struct McpHandler;

impl SchemeHandler for McpHandler {
	fn scheme(&self) -> &'static str {
		"mcp"
	}

	fn handle(
		&self,
		_path: &str,
		_cancel: &CancellationToken,
	) -> Result<pi_code_path::types::NodeRef, Diagnostic> {
		Err(Diagnostic {
			variant: DiagnosticVariant::SchemeNotImplemented,
			message: "mcp:// scheme not implemented in current release; use direct paths".into(),
			span:    None,
		})
	}
}
