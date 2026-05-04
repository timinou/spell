use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, NodeRef};

/// Stub handler for `jobs://<job-id>`.
/// Real wiring to the job runtime is deferred.
pub struct JobsHandler;

impl SchemeHandler for JobsHandler {
	fn scheme(&self) -> &'static str {
		"jobs"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, pi_code_path::types::Diagnostic> {
		Ok(NodeRef {
			locator: format!("jobs://{path}"),
			range: 0..0,
			kind: "§job".into(),
			content: Some(Content::Text {
				value: "<job placeholder>".into(),
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
	fn jobs_stub_returns_placeholder() {
		let h = JobsHandler;
		let node = h.handle("j-123", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "jobs://j-123");
		assert_eq!(node.kind, "§job");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn jobs_stub_any_id() {
		let h = JobsHandler;
		let node = h.handle("any-id", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "jobs://any-id");
	}
}
