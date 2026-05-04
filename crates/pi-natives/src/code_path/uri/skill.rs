use std::path::PathBuf;

use pi_code_path::resolver::{CancellationToken, SchemeHandler};
use pi_code_path::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

/// Resolves `skill://<name>` and `skill://<name>/<file>`.
pub struct SkillHandler {
	pub project_root: PathBuf,
}

impl SchemeHandler for SkillHandler {
	fn scheme(&self) -> &'static str {
		"skill"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		let base = self.project_root.join(".spell/skills");
		let target = if path.contains('/') {
			base.join(path)
		} else {
			base.join(path).join("SKILL.md")
		};

		if !target.exists() {
			return Err(Diagnostic {
				variant: DiagnosticVariant::SkillNotFound,
				message: format!("skill not found: skill://{path}"),
				span: None,
			});
		}

		let content = std::fs::read_to_string(&target).ok().map(|value| Content::Text { value });
		Ok(NodeRef {
			locator: format!("skill://{path}"),
			range: 0..0,
			kind: "§skill".into(),
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
	fn skill_root_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell/skills/canvas")).unwrap();
		let mut f = std::fs::File::create(root.join(".spell/skills/canvas/SKILL.md")).unwrap();
		write!(f, "canvas skill").unwrap();

		let h = SkillHandler { project_root: root };
		let node = h.handle("canvas", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "skill://canvas");
		assert_eq!(node.kind, "§skill");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn skill_subpath_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell/skills/canvas/scripts")).unwrap();
		let mut f = std::fs::File::create(root.join(".spell/skills/canvas/scripts/init.py")).unwrap();
		write!(f, "print('hi')").unwrap();

		let h = SkillHandler { project_root: root };
		let node = h.handle("canvas/scripts/init.py", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "skill://canvas/scripts/init.py");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn skill_missing() {
		let dir = tempfile::tempdir().unwrap();
		let h = SkillHandler {
			project_root: dir.path().to_path_buf(),
		};
		let err = h.handle("missing", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::SkillNotFound));
	}
}
