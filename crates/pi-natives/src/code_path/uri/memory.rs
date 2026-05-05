use std::path::PathBuf;

use pi_code_path::{
	resolver::{CancellationToken, SchemeHandler},
	types::{Content, Diagnostic, DiagnosticVariant, NodeRef},
};

/// Resolves `memory://<path>` to the memory tree.
pub struct MemoryHandler {
	pub project_root: PathBuf,
}

impl MemoryHandler {
	fn resolve_path(&self, path: &str) -> Option<PathBuf> {
		let direct = self.project_root.join("memory").join(path);
		if direct.exists() {
			return Some(direct);
		}
		let dotted = self.project_root.join(".spell/memory").join(path);
		if dotted.exists() {
			return Some(dotted);
		}
		None
	}
}

impl SchemeHandler for MemoryHandler {
	fn scheme(&self) -> &'static str {
		"memory"
	}

	fn handle(&self, path: &str, _cancel: &CancellationToken) -> Result<NodeRef, Diagnostic> {
		match self.resolve_path(path) {
			Some(target) => {
				let content = std::fs::read_to_string(&target)
					.ok()
					.map(|value| Content::Text { value });
				Ok(NodeRef {
					locator: format!("memory://{path}"),
					range: 0..0,
					kind: "§memory".into(),
					content,
					metadata: Default::default(),
					diagnostics: vec![],
				})
			},
			None => Err(Diagnostic {
				variant: DiagnosticVariant::MemoryPathNotFound,
				message: format!("memory path not found: memory://{path}"),
				span:    None,
			}),
		}
	}
}

#[cfg(test)]
mod tests {
	use std::io::Write;

	use super::*;

	#[test]
	fn memory_direct_folder() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join("memory")).unwrap();
		let mut f = std::fs::File::create(root.join("memory/root")).unwrap();
		write!(f, "memory root").unwrap();

		let h = MemoryHandler { project_root: root };
		let node = h.handle("root", &CancellationToken::new()).unwrap();
		assert_eq!(node.locator, "memory://root");
		assert_eq!(node.kind, "§memory");
		assert!(matches!(node.content, Some(Content::Text { .. })));
	}

	#[test]
	fn memory_dot_spell_fallback() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::create_dir_all(root.join(".spell/memory/skills/canvas")).unwrap();
		let mut f = std::fs::File::create(root.join(".spell/memory/skills/canvas/SKILL.md")).unwrap();
		write!(f, "skill data").unwrap();

		let h = MemoryHandler { project_root: root };
		let node = h
			.handle("skills/canvas/SKILL.md", &CancellationToken::new())
			.unwrap();
		assert_eq!(node.locator, "memory://skills/canvas/SKILL.md");
	}

	#[test]
	fn memory_missing_path() {
		let dir = tempfile::tempdir().unwrap();
		let h = MemoryHandler { project_root: dir.path().to_path_buf() };
		let err = h.handle("missing", &CancellationToken::new()).unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::MemoryPathNotFound));
	}
}
