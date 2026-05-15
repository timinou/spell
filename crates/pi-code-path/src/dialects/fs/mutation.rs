use std::{
	io::Write as _,
	path::{Path, PathBuf},
};

use crate::{
	ast::{ActionContent, CodePath, FsSegment, Locator, MutationOutcome},
	op::Op,
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
			},
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

impl super::FsResolver {
	fn apply_create(
		&self,
		target: &CodePath,
		content: &ActionContent,
		force: bool,
	) -> Result<MutationOutcome, Diagnostic> {
		let path = resolve_target_path(&self.root, target)?;
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
	}

	fn apply_write(
		&self,
		target: &CodePath,
		content: &ActionContent,
		_force: bool,
	) -> Result<MutationOutcome, Diagnostic> {
		let path = resolve_target_path(&self.root, target)?;
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
	}

	fn apply_delete(&self, target: &CodePath) -> Result<MutationOutcome, Diagnostic> {
		let path = resolve_target_path(&self.root, target)?;
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
	}
}

impl MutationResolver for super::FsResolver {
	fn try_apply(
		&self,
		op: &Op,
		_cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>> {
		match op {
			Op::FileCreate { target, content, force } => {
				Some(self.apply_create(target.as_codepath(), content, *force))
			},
			Op::FileWrite { target, content, force } => {
				Some(self.apply_write(target.as_codepath(), content, *force))
			},
			Op::FileDelete { target } => Some(self.apply_delete(target.as_codepath())),
			_ => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::super::FsResolver;
	use crate::{
		ast::{ActionContent, CodePath, FsLocator, FsSegment, Locator},
		op::Op,
		resolver::{CancellationToken, MutationResolver},
		types::DiagnosticVariant,
	};

	fn bare_file_target(name: &str) -> crate::op::FileTarget {
		let cp = CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(name.to_string())] }),
			query:     None,
			qualifier: None,
		};
		crate::op::FileTarget::new(cp).unwrap()
	}

	#[test]
	fn create_new_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let resolver = FsResolver::new(root.clone());
		let target = bare_file_target("new.txt");
		let op = Op::FileCreate {
			target,
			content: ActionContent::Single("hello".to_string()),
			force: false,
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
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
		let target = bare_file_target("exists.txt");
		let op =
			Op::FileCreate { target, content: ActionContent::Single("new".to_string()), force: false };
		let err = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::FileExists));
	}

	#[test]
	fn create_with_force_overwrites() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("force.txt"), "old").unwrap();
		let resolver = FsResolver::new(root.clone());
		let target = bare_file_target("force.txt");
		let op =
			Op::FileCreate { target, content: ActionContent::Single("new".to_string()), force: true };
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
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
		let target = bare_file_target("write.txt");
		let op = Op::FileWrite {
			target,
			content: ActionContent::Single("new content".to_string()),
			force: false,
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
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
		let target = bare_file_target("del.txt");
		let op = Op::FileDelete { target };
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		assert!(!root.join("del.txt").exists());
	}

	#[test]
	fn delete_missing_errors() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let resolver = FsResolver::new(root.clone());
		let target = bare_file_target("missing.txt");
		let op = Op::FileDelete { target };
		let err = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
	}

	#[test]
	fn non_file_op_returns_none() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let resolver = FsResolver::new(root);
		let target = bare_file_target("test.txt");
		let op = Op::FileAppend { target, content: ActionContent::Single("append".to_string()) };
		let result = resolver.try_apply(&op, &CancellationToken::new());
		assert!(result.is_none(), "FsResolver should return None for FileAppend");
	}
}
