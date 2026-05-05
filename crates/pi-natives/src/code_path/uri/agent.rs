use std::path::PathBuf;

use pi_code_path::{
	resolver::{CancellationToken, SchemeHandler},
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

/// Resolves `agent://<id>` to agent JSON blobs.
pub struct AgentHandler {
	pub agent_blobs_root: PathBuf,
}

impl SchemeHandler for AgentHandler {
	fn scheme(&self) -> &'static str {
		"agent"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		// Sub-path (jq-style) is out of scope this iteration.
		if path.contains('/') || path.contains('.') || path.contains('[') {
			return Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: format!("agent sub-path not yet supported: agent://{path}"),
				span:    None,
			});
		}

		let target = self.agent_blobs_root.join(format!("{path}.json"));
		if !target.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::AgentNotFound,
				message: format!("agent not found: agent://{path}"),
				span:    None,
			});
		}

		let content = std::fs::read_to_string(&target)
			.ok()
			.map(|value| Content::Text { value });
		Ok(NodeRef {
			locator: format!("agent://{path}"),
			range: 0..0,
			kind: "§agent".into(),
			content,
			metadata: Default::default(),
			diagnostics: vec![],
		})
	}
}

#[cfg(test)]
mod tests {
	use std::io::Write;

	use super::*;

	#[test]
	fn agent_happy_path() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let mut f = std::fs::File::create(root.join("abc123.json")).unwrap();
		write!(f, "{{}}").unwrap();

		let h = AgentHandler { agent_blobs_root: root };
		let node = h.handle("abc123", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "agent://abc123");
		assert_eq!(node.kind, "§agent");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn agent_missing() {
		let dir = tempfile::tempdir().unwrap();
		let h = AgentHandler { agent_blobs_root: dir.path().to_path_buf() };
		let err = h.handle("missing", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::AgentNotFound));
	}

	#[test]
	fn agent_subpath_rejected() {
		let dir = tempfile::tempdir().unwrap();
		let h = AgentHandler { agent_blobs_root: dir.path().to_path_buf() };
		let err = h.handle("abc/.foo", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::UnsupportedOperation));
	}
}
