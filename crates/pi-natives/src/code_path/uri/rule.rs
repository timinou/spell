use std::path::PathBuf;

use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

/// Resolves `rule://<name>` to the rules directory.
pub struct RuleHandler {
	pub project_root: PathBuf,
}

impl SchemeHandler for RuleHandler {
	fn scheme(&self) -> &'static str {
		"rule"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		let target = self.project_root.join(".spell/rules").join(format!("{path}.md"));

		if !target.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::FileNotFound,
				message: format!("rule not found: rule://{path}"),
				span: None,
			});
		}

		let content = std::fs::read_to_string(&target).ok().map(|value| Content::Text { value });
		Ok(NodeRef {
			locator: format!("rule://{path}"),
			range: 0..0,
			kind: "§rule".into(),
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
	fn rule_happy_path() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell/rules")).unwrap();
		let mut f = std::fs::File::create(root.join(".spell/rules/canvas-activation.md")).unwrap();
		write!(f, "rule body").unwrap();

		let h = RuleHandler { project_root: root };
		let node = h.handle("canvas-activation", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "rule://canvas-activation");
		assert_eq!(node.kind, "§rule");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn rule_missing() {
		let dir = tempfile::tempdir().unwrap();
		let h = RuleHandler {
			project_root: dir.path().to_path_buf(),
		};
		let err = h.handle("missing", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
	}
}
