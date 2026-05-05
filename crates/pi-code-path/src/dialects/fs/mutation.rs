use std::{
	io::Write as _,
	path::{Path, PathBuf},
};

use crate::{
	ast::{Action, ActionKind, CodePath, FsSegment, Locator, MutationOutcome},
	resolver::{CancellationToken, MutationResolver},
	types::{Diagnostic, DiagnosticVariant},
};

fn resolve_target_path(root: &Path, path: &CodePath) -> Result<PathBuf, Diagnostic> {
	let loc = match &path.locator {
		Locator::Fs(fs) => fs,
		Locator::Uri(_) => {
			return Err(Diagnostic {
				variant: DiagnosticVariant::ParseError,
				message: "mutation target must be a filesystem path".into(),
				span:    None,
			});
		},
	};
	let mut target = root.to_path_buf();
	for seg in &loc.segments {
		match seg {
			FsSegment::Literal(s) => {
				if s == "/" {
					continue;
				}
				target.push(s)
			}
			_ => {
				return Err(Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: "mutation target must be a literal path".into(),
					span:    None,
				});
			},
		}
	}
	Ok(target)
}

fn write_file_atomic(target: &Path, content: &str) -> Result<(), std::io::Error> {
	let parent = target.parent().unwrap_or_else(|| Path::new("."));
	let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
	tmp.write_all(content.as_bytes())?;
	tmp.persist(target)?;
	Ok(())
}

impl MutationResolver for super::FsResolver {
	fn supports(&self, path: &CodePath, kind: ActionKind) -> bool {
		// FEAT-689: only claim filesystem-shaped mutations on bare-file
		// targets. A symbol-target Delete (`a.ts::Foo`) or any qualifier
		// (`a.ts#stat`, `a.ts#raw`, …) MUST go to another resolver
		// instead of nuking the whole host file.
		if !matches!(kind, ActionKind::Create | ActionKind::Write | ActionKind::Delete) {
			return false;
		}
		!path.has_target_query()
	}

	fn apply(
		&self,
		target: &CodePath,
		action: &Action,
		_cancel: &CancellationToken,
	) -> Result<MutationOutcome, Diagnostic> {
		let path = resolve_target_path(&self.root, target)?;
		match action {
			Action::Create { content, force } => {
				if path.exists() && !force {
					return Err(Diagnostic {
						variant: DiagnosticVariant::FileExists,
						message: format!("file already exists: {}", path.display()),
						span:    None,
					});
				}
				let text = content.join("\n");
				write_file_atomic(&path, &text).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("failed to create file: {e}"),
					span:    None,
				})?;
				Ok(MutationOutcome {
					edit_count:     1,
					created:        true,
					target_summary: Some(path.to_string_lossy().to_string()),
					diff:           None,
				})
			},
			Action::Write { content, .. } => {
				let existed = path.exists();
				let text = content.join("\n");
				write_file_atomic(&path, &text).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("failed to write file: {e}"),
					span:    None,
				})?;
				Ok(MutationOutcome {
					edit_count:     1,
					created:        !existed,
					target_summary: Some(path.to_string_lossy().to_string()),
					diff:           None,
				})
			},
			Action::Delete => {
				if !path.exists() {
					return Err(Diagnostic {
						variant: DiagnosticVariant::FileNotFound,
						message: format!("file not found: {}", path.display()),
						span:    None,
					});
				}
				std::fs::remove_file(&path).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("failed to delete file: {e}"),
					span:    None,
				})?;
				Ok(MutationOutcome {
					edit_count:     1,
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
					diff:           None,
				})
			},
			_ => Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: format!("unsupported action for FsResolver: {:?}", action.kind()),
				span:    None,
			}),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::super::FsResolver;
	use crate::{
		ast::{Action, ActionContent, CodePath, FsLocator, FsSegment, Locator},
		resolver::{CancellationToken, MutationResolver},
		types::DiagnosticVariant,
	};

	#[test]
	fn create_new_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let resolver = FsResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("new.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action =
			Action::Create { content: ActionContent::Single("hello".to_string()), force: false };
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert!(outcome.created);
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("new.txt")).unwrap();
		assert_eq!(content, "hello");
	}

	#[test]
	fn create_existing_without_force_errors() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("exists.txt"), "old").unwrap();
		let resolver = FsResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("exists.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action =
			Action::Create { content: ActionContent::Single("new".to_string()), force: false };
		let err = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::FileExists));
	}

	#[test]
	fn create_with_force_overwrites() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("force.txt"), "old").unwrap();
		let resolver = FsResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("force.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action =
			Action::Create { content: ActionContent::Single("new".to_string()), force: true };
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert!(outcome.created);
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("force.txt")).unwrap();
		assert_eq!(content, "new");
	}

	#[test]
	fn write_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("write.txt"), "old").unwrap();
		let resolver = FsResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("write.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Write {
			content: ActionContent::Single("new content".to_string()),
			force:   false,
		};
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("write.txt")).unwrap();
		assert_eq!(content, "new content");
	}

	#[test]
	fn delete_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("del.txt"), "bye").unwrap();
		let resolver = FsResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("del.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Delete;
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		assert!(!root.join("del.txt").exists());
	}

	#[test]
	fn delete_missing_errors() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let resolver = FsResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("missing.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Delete;
		let err = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
	}
}
