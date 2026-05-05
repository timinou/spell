use std::path::{Path, PathBuf};

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

/// Compute a 2-character hash for a line.
///
/// TODO: Cross-language parity with TS `computeLineHash` in `hashline.ts`.
/// The TS side uses Bun's xxHash32 with a custom nibble alphabet; this Rust
/// implementation uses a simple FNV-1a truncation until a parity test is added.
pub(crate) fn compute_line_hash(_idx: usize, line: &str) -> String {
	let normalized = line.replace('\r', "").trim_end().to_string();
	let mut hash: u64 = 0xcbf29ce484222325; // FNV offset basis
	for byte in normalized.bytes() {
		hash ^= byte as u64;
		hash = hash.wrapping_mul(0x100000001b3);
	}
	let alphabet = b"ZPMQVRWSNKTXJBYH";
	let high = ((hash >> 4) & 0x0f) as usize;
	let low = (hash & 0x0f) as usize;
	format!("{}{}", alphabet[high] as char, alphabet[low] as char)
}

fn verify_anchor(path: &Path, pos: &str) -> Result<usize, Diagnostic> {
	let parts: Vec<&str> = pos.split('#').collect();
	if parts.len() != 2 {
		return Err(Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("invalid anchor format: {pos}"),
			span:    None,
		});
	}
	let line_num: usize = parts[0].parse().map_err(|_| Diagnostic {
		variant: DiagnosticVariant::ParseError,
		message: format!("invalid line number in anchor: {pos}"),
		span:    None,
	})?;
	let expected_hash = parts[1];

	let content = std::fs::read_to_string(path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("cannot read file for anchor verification: {e}"),
		span:    None,
	})?;
	let lines: Vec<&str> = content.split('\n').collect();
	let line_idx = line_num.saturating_sub(1);
	let actual_line = lines.get(line_idx).unwrap_or(&"");
	let actual_hash = compute_line_hash(line_num, actual_line);
	if actual_hash != expected_hash {
		return Err(Diagnostic {
			variant: DiagnosticVariant::StaleAnchor,
			message: format!(
				"anchor hash mismatch at line {line_num}: expected {expected_hash}, got {actual_hash}"
			),
			span:    None,
		});
	}
	Ok(line_num)
}

fn read_file(path: &Path) -> Result<(String, Vec<String>), Diagnostic> {
	let text = std::fs::read_to_string(path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("cannot read file: {e}"),
		span:    None,
	})?;
	let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
	if text.ends_with('\n') && !lines.is_empty() {
		lines.pop();
	}
	Ok((text, lines))
}

fn write_file(path: &Path, lines: &[String]) -> Result<String, Diagnostic> {
	let mut text = lines.join("\n");
	if !text.is_empty() {
		text.push('\n');
	}
	std::fs::write(path, &text).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("cannot write file: {e}"),
		span:    None,
	})?;
	Ok(text)
}

fn make_diff(old: &str, new: &str) -> Option<String> {
	if old == new {
		return None;
	}
	let patch = diffy::create_patch(old, new);
	Some(patch.to_string())
}

impl MutationResolver for super::TextResolver {
	fn supports(&self, _path: &CodePath, kind: ActionKind) -> bool {
		// TextResolver currently treats every CodePath the same way — it
		// always rewrites the whole file. The path-aware signature is in
		// place for FEAT-689 dispatch correctness; future text-axis
		// edits (per-line splice, etc.) can refine it.
		matches!(
			kind,
			ActionKind::Append
				| ActionKind::Prepend
				| ActionKind::Insert
				| ActionKind::Replace
				| ActionKind::Patch
		)
	}

	fn apply(
		&self,
		target: &CodePath,
		action: &Action,
		_cancel: &CancellationToken,
	) -> Result<MutationOutcome, Diagnostic> {
		let path = resolve_target_path(&self.root, target)?;
		match action {
			Action::Append { lines } => {
				let (_old_text, mut file_lines) = read_file(&path)?;
				let old = std::fs::read_to_string(&path).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("cannot read file: {e}"),
					span:    None,
				})?;
				let new_lines: Vec<String> = lines.lines();
				file_lines.extend(new_lines);
				let new = write_file(&path, &file_lines)?;
				Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				})
			},
			Action::Prepend { lines } => {
				let old = std::fs::read_to_string(&path).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("cannot read file: {e}"),
					span:    None,
				})?;
				let (_old_text, mut file_lines) = read_file(&path)?;
				let mut prepended: Vec<String> = lines.lines();
				prepended.append(&mut file_lines);
				let new = write_file(&path, &prepended)?;
				Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				})
			},
			Action::Insert { pos, line, lines } => {
				let line_num = if let Some(pos) = pos {
					verify_anchor(&path, pos)?
				} else if let Some(line) = line {
					*line as usize
				} else {
					return Err(Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: "insert requires pos or line".into(),
						span:    None,
					});
				};
				let (old, mut file_lines) = read_file(&path)?;
				let text_lines: Vec<String> = lines.lines();
				let insert_idx = line_num.saturating_sub(1);
				for (i, l) in text_lines.into_iter().enumerate() {
					if insert_idx + i <= file_lines.len() {
						file_lines.insert(insert_idx + i, l);
					} else {
						file_lines.push(l);
					}
				}
				let new = write_file(&path, &file_lines)?;
				if old == new {
					return Ok(MutationOutcome {
						edit_count:     0,
						diff:           None,
						created:        false,
						target_summary: Some(path.to_string_lossy().to_string()),
					});
				}
				Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				})
			},
			Action::Replace { pos, end, line, lines } => {
				let start_line = if let Some(pos) = pos {
					verify_anchor(&path, pos)?
				} else if let Some(line) = line {
					*line as usize
				} else {
					return Err(Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: "replace requires pos or line".into(),
						span:    None,
					});
				};

				let end_line = if let Some(end) = end {
					let parts: Vec<&str> = end.split('#').collect();
					if parts.len() != 2 {
						return Err(Diagnostic {
							variant: DiagnosticVariant::ParseError,
							message: format!("invalid end anchor format: {end}"),
							span:    None,
						});
					}
					parts[0].parse::<usize>().map_err(|_| Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: format!("invalid end line number: {end}"),
						span:    None,
					})?
				} else {
					start_line
				};

				let (old, file_lines) = read_file(&path)?;
				let replacement_lines: Vec<String> =
					lines.as_ref().map(|l| l.lines()).unwrap_or_default();

				let start_idx = start_line.saturating_sub(1);
				let end_idx = end_line
					.saturating_sub(1)
					.min(file_lines.len().saturating_sub(1));

				let mut new_lines = file_lines.clone();
				for _ in start_idx..=end_idx {
					if start_idx < new_lines.len() {
						new_lines.remove(start_idx);
					}
				}
				for (i, l) in replacement_lines.iter().enumerate() {
					new_lines.insert(start_idx + i, l.clone());
				}

				let new = write_file(&path, &new_lines)?;
				if old == new {
					return Ok(MutationOutcome {
						edit_count:     0,
						diff:           None,
						created:        false,
						target_summary: Some(path.to_string_lossy().to_string()),
					});
				}
				Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				})
			},
			Action::Patch { diff } => {
				let old = std::fs::read_to_string(&path).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("cannot read file: {e}"),
					span:    None,
				})?;
				let patch = diffy::Patch::from_str(diff).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("invalid diff format: {e}"),
					span:    None,
				})?;
				let new = diffy::apply(&old, &patch).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::ParseError,
					message: format!("failed to apply patch: {e}"),
					span:    None,
				})?;
				std::fs::write(&path, &new).map_err(|e| Diagnostic {
					variant: DiagnosticVariant::Inaccessible,
					message: format!("cannot write file: {e}"),
					span:    None,
				})?;
				Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				})
			},
			_ => Err(Diagnostic {
				variant: DiagnosticVariant::UnsupportedOperation,
				message: format!("unsupported action for TextResolver: {:?}", action.kind()),
				span:    None,
			}),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{super::TextResolver, compute_line_hash};
	use crate::{
		ast::{Action, ActionContent, CodePath, FsLocator, FsSegment, Locator},
		resolver::{CancellationToken, MutationResolver},
		types::DiagnosticVariant,
	};

	#[test]
	fn append_to_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "line1\nline2\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Append {
			lines: ActionContent::Multi(vec!["line3".to_string(), "line4".to_string()]),
		};
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "line1\nline2\nline3\nline4\n");
	}

	#[test]
	fn prepend_to_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "line2\nline3\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Prepend {
			lines: ActionContent::Multi(vec!["line0".to_string(), "line1".to_string()]),
		};
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "line0\nline1\nline2\nline3\n");
	}

	#[test]
	fn replace_by_pos_hash_match() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let hash = compute_line_hash(2, "bar");
		let pos = format!("2#{hash}");
		let action = Action::Replace {
			pos:   Some(pos),
			end:   None,
			line:  None,
			lines: Some(ActionContent::Single("qux".to_string())),
		};
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\nqux\nbaz\n");
	}

	#[test]
	fn replace_stale_hash() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Replace {
			pos:   Some("2#ZZ".to_string()),
			end:   None,
			line:  None,
			lines: Some(ActionContent::Single("qux".to_string())),
		};
		let err = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::StaleAnchor));
	}

	#[test]
	fn patch_diff() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let diff = "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n foo\n-bar\n+qux\n baz\n".to_string();
		let action = Action::Patch { diff };
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\nqux\nbaz\n");
	}

	#[test]
	fn replace_idempotent_same_content() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let hash = compute_line_hash(2, "bar");
		let pos = format!("2#{hash}");
		let action = Action::Replace {
			pos:   Some(pos),
			end:   None,
			line:  None,
			lines: Some(ActionContent::Single("bar".to_string())),
		};
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 0);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\nbar\nbaz\n");
	}

	#[test]
	fn replace_same_content_non_idempotent_emits_noop() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = CodePath {
			locator:   Locator::Fs(FsLocator {
				segments: vec![FsSegment::Literal("a.txt".to_string())],
			}),
			query:     None,
			qualifier: None,
		};
		let action = Action::Replace {
			pos:   None,
			end:   None,
			line:  Some(2),
			lines: Some(ActionContent::Single("bar".to_string())),
		};
		let outcome = resolver
			.apply(&target, &action, &CancellationToken::new())
			.unwrap();
		assert_eq!(outcome.edit_count, 0);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\nbar\nbaz\n");
	}
}
