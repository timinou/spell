use std::path::PathBuf;

use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

/// Resolves `artifact://<path>` to files under a given root directory.
pub struct ArtifactHandler {
	pub root: PathBuf,
}

impl SchemeHandler for ArtifactHandler {
	fn scheme(&self) -> &'static str {
		"artifact"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		let target = self.root.join(path);
		if !target.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::ArtifactNotFound,
				message: format!("artifact not found: artifact://{path}"),
				span: None,
			});
		}

		let content = std::fs::read_to_string(&target).ok().map(|value| Content::Text { value });
		Ok(NodeRef {
			locator: format!("artifact://{path}"),
			range: 0..0,
			kind: "§artifact".into(),
			content,
			metadata: Default::default(),
			diagnostics: vec![],
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;

	#[test]
	fn artifact_happy_path() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join("session/tool")).unwrap();
		let mut f = std::fs::File::create(root.join("session/tool/1.txt")).unwrap();
		write!(f, "hello artifact").unwrap();

		let h = ArtifactHandler { root };
		let node = h.handle("session/tool/1.txt", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "artifact://session/tool/1.txt");
		assert_eq!(node.kind, "§artifact");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn artifact_missing_file() {
		let dir = tempfile::tempdir().unwrap();
		let h = ArtifactHandler {
			root: dir.path().to_path_buf(),
		};
		let err = h.handle("nope.txt", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::ArtifactNotFound));
		assert!(err.message.contains("artifact not found"));
	}
}
