use std::path::PathBuf;

use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

/// Resolves `pi://<path>` to internal Spell documentation.
pub struct PiHandler {
	pub project_root: PathBuf,
}

impl SchemeHandler for PiHandler {
	fn scheme(&self) -> &'static str {
		"pi"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		let target = self.project_root.join(".spell/pi").join(path);

		if !target.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::PiPathNotFound,
				message: format!("pi path not found: pi://{path}"),
				span: None,
			});
		}

		let content = std::fs::read_to_string(&target).ok().map(|value| Content::Text { value });
		Ok(NodeRef {
			locator: format!("pi://{path}"),
			range: 0..0,
			kind: "§pi".into(),
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
	fn pi_happy_path() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell/pi/docs")).unwrap();
		let mut f = std::fs::File::create(root.join(".spell/pi/docs/index.md")).unwrap();
		write!(f, "pi docs").unwrap();

		let h = PiHandler { project_root: root };
		let node = h.handle("docs/index.md", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "pi://docs/index.md");
		assert_eq!(node.kind, "§pi");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn pi_missing_path() {
		let dir = tempfile::tempdir().unwrap();
		let h = PiHandler {
			project_root: dir.path().to_path_buf(),
		};
		let err = h.handle("missing.md", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::PiPathNotFound));
	}
}
