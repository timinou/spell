use std::path::PathBuf;

use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

/// Resolves `local://<NAME>.md` to the local plan-artifact directory.
pub struct LocalHandler {
	pub project_root: PathBuf,
}

impl SchemeHandler for LocalHandler {
	fn scheme(&self) -> &'static str {
		"local"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		let target = self.project_root.join(".spell/local").join(path);

		if !target.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::FileNotFound,
				message: format!("local file not found: local://{path}"),
				span: None,
			});
		}

		let content = std::fs::read_to_string(&target).ok().map(|value| Content::Text { value });
		Ok(NodeRef {
			locator: format!("local://{path}"),
			range: 0..0,
			kind: "§local".into(),
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
	fn local_happy_path() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell/local")).unwrap();
		let mut f = std::fs::File::create(root.join(".spell/local/MY_PLAN.md")).unwrap();
		write!(f, "plan body").unwrap();

		let h = LocalHandler { project_root: root };
		let node = h.handle("MY_PLAN.md", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "local://MY_PLAN.md");
		assert_eq!(node.kind, "§local");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn local_missing_file() {
		let dir = tempfile::tempdir().unwrap();
		let h = LocalHandler {
			project_root: dir.path().to_path_buf(),
		};
		let err = h.handle("MISSING.md", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
	}
}
