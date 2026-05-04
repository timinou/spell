use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, NodeRef};

/// Stub handler for MCP resources (`mcp://<path>`).
pub struct McpHandler;

impl SchemeHandler for McpHandler {
	fn scheme(&self) -> &'static str {
		"mcp"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, pi_code_path::types::Diagnostic> {
		Ok(NodeRef {
			locator: format!("mcp://{path}"),
			range: 0..0,
			kind: "§mcp-resource".into(),
			content: Some(Content::Text {
				value: "<mcp placeholder>".into(),
			}),
			metadata: Default::default(),
			diagnostics: vec![],
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn mcp_stub_returns_placeholder() {
		let h = McpHandler;
		let node = h.handle("resource/name", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "mcp://resource/name");
		assert_eq!(node.kind, "§mcp-resource");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn mcp_stub_any_path() {
		let h = McpHandler;
		let node = h.handle("foo", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "mcp://foo");
	}
}
