use std::path::{Path, PathBuf};

use crate::{
	ast::{ActionContent, CodePath, FsSegment, Locator, MutationOutcome},
	op::{LineAnchor, LineAt, LineSpan, Op},
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
	fn try_apply(
		&self,
		op: &Op,
		_cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>> {
		match op {
			Op::FileAppend { target, content } => {
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let old = match std::fs::read_to_string(&path) {
					Ok(s) => s,
					Err(e) => {
						return Some(Err(Diagnostic {
							variant: DiagnosticVariant::Inaccessible,
							message: format!("cannot read file: {e}"),
							span:    None,
						}));
					},
				};
				let (_, mut file_lines) = match read_file(&path) {
					Ok(f) => f,
					Err(e) => return Some(Err(e)),
				};
				let new_lines: Vec<String> = content.lines();
				file_lines.extend(new_lines);
				let new = match write_file(&path, &file_lines) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			Op::FilePrepend { target, content } => {
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let old = match std::fs::read_to_string(&path) {
					Ok(s) => s,
					Err(e) => {
						return Some(Err(Diagnostic {
							variant: DiagnosticVariant::Inaccessible,
							message: format!("cannot read file: {e}"),
							span:    None,
						}));
					},
				};
				let (_, mut file_lines) = match read_file(&path) {
					Ok(f) => f,
					Err(e) => return Some(Err(e)),
				};
				let mut prepended: Vec<String> = content.lines();
				prepended.append(&mut file_lines);
				let new = match write_file(&path, &prepended) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			Op::FilePatch { target, diff } => {
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let old = match std::fs::read_to_string(&path) {
					Ok(s) => s,
					Err(e) => {
						return Some(Err(Diagnostic {
							variant: DiagnosticVariant::Inaccessible,
							message: format!("cannot read file: {e}"),
							span:    None,
						}));
					},
				};
				let patch = match diffy::Patch::from_str(diff) {
					Ok(p) => p,
					Err(e) => {
						return Some(Err(Diagnostic {
							variant: DiagnosticVariant::ParseError,
							message: format!("invalid diff format: {e}"),
							span:    None,
						}));
					},
				};
				let new = match diffy::apply(&old, &patch) {
					Ok(n) => n,
					Err(e) => {
						return Some(Err(Diagnostic {
							variant: DiagnosticVariant::ParseError,
							message: format!("failed to apply patch: {e}"),
							span:    None,
						}));
					},
				};
				if let Err(e) = std::fs::write(&path, &new) {
					return Some(Err(Diagnostic {
						variant: DiagnosticVariant::Inaccessible,
						message: format!("cannot write file: {e}"),
						span:    None,
					}));
				}
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			Op::LineReplace { target, span, content } => {
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let start_line =
					match verify_anchor(&path, &format!("{}#{}", span.start.line, span.start.hash)) {
						Ok(n) => n,
						Err(e) => return Some(Err(e)),
					};
				let end_line = if let Some(ref end_anchor) = span.end {
					end_anchor.line as usize
				} else {
					start_line
				};
				let (old, file_lines) = match read_file(&path) {
					Ok(f) => f,
					Err(e) => return Some(Err(e)),
				};
				let replacement_lines: Vec<String> = content.lines();
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
				let new = match write_file(&path, &new_lines) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				if old == new {
					return Some(Ok(MutationOutcome {
						edit_count:     0,
						diff:           None,
						created:        false,
						target_summary: Some(path.to_string_lossy().to_string()),
					}));
				}
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			Op::LineInsert { target, at, content } => {
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let line_num = match at {
					LineAt::Before { anchor } => {
						match verify_anchor(&path, &format!("{}#{}", anchor.line, anchor.hash)) {
							Ok(n) => n,
							Err(e) => return Some(Err(e)),
						}
					},
					LineAt::After { anchor } => {
						match verify_anchor(&path, &format!("{}#{}", anchor.line, anchor.hash)) {
							Ok(n) => n + 1,
							Err(e) => return Some(Err(e)),
						}
					},
				};
				let (old, mut file_lines) = match read_file(&path) {
					Ok(f) => f,
					Err(e) => return Some(Err(e)),
				};
				let text_lines: Vec<String> = content.lines();
				let insert_idx = line_num.saturating_sub(1);
				for (i, l) in text_lines.into_iter().enumerate() {
					if insert_idx + i <= file_lines.len() {
						file_lines.insert(insert_idx + i, l);
					} else {
						file_lines.push(l);
					}
				}
				let new = match write_file(&path, &file_lines) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				if old == new {
					return Some(Ok(MutationOutcome {
						edit_count:     0,
						diff:           None,
						created:        false,
						target_summary: Some(path.to_string_lossy().to_string()),
					}));
				}
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			Op::LineAppend { target, at, content } => {
				// LineAppend is semantically "insert after anchor"
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let line_num = match verify_anchor(&path, &format!("{}#{}", at.line, at.hash)) {
					Ok(n) => n + 1, // insert AFTER the anchor line
					Err(e) => return Some(Err(e)),
				};
				let (old, mut file_lines) = match read_file(&path) {
					Ok(f) => f,
					Err(e) => return Some(Err(e)),
				};
				let text_lines: Vec<String> = content.lines();
				let insert_idx = line_num.saturating_sub(1);
				for (i, l) in text_lines.into_iter().enumerate() {
					if insert_idx + i <= file_lines.len() {
						file_lines.insert(insert_idx + i, l);
					} else {
						file_lines.push(l);
					}
				}
				let new = match write_file(&path, &file_lines) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				if old == new {
					return Some(Ok(MutationOutcome {
						edit_count:     0,
						diff:           None,
						created:        false,
						target_summary: Some(path.to_string_lossy().to_string()),
					}));
				}
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			Op::LinePrepend { target, at, content } => {
				// LinePrepend is semantically "insert before anchor"
				let path = match resolve_target_path(&self.root, target.as_codepath()) {
					Ok(p) => p,
					Err(e) => return Some(Err(e)),
				};
				let line_num = match verify_anchor(&path, &format!("{}#{}", at.line, at.hash)) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				let (old, mut file_lines) = match read_file(&path) {
					Ok(f) => f,
					Err(e) => return Some(Err(e)),
				};
				let text_lines: Vec<String> = content.lines();
				let insert_idx = line_num.saturating_sub(1);
				for (i, l) in text_lines.into_iter().enumerate() {
					if insert_idx + i <= file_lines.len() {
						file_lines.insert(insert_idx + i, l);
					} else {
						file_lines.push(l);
					}
				}
				let new = match write_file(&path, &file_lines) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				};
				if old == new {
					return Some(Ok(MutationOutcome {
						edit_count:     0,
						diff:           None,
						created:        false,
						target_summary: Some(path.to_string_lossy().to_string()),
					}));
				}
				Some(Ok(MutationOutcome {
					edit_count:     1,
					diff:           make_diff(&old, &new),
					created:        false,
					target_summary: Some(path.to_string_lossy().to_string()),
				}))
			},
			_ => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{super::TextResolver, compute_line_hash};
	use crate::{
		ast::{ActionContent, CodePath, FsLocator, FsSegment, Locator},
		op::{FileTarget, LineAnchor, LineAt, LineSpan, Op},
		resolver::{CancellationToken, MutationResolver},
		types::DiagnosticVariant,
	};

	fn bare_file_target(name: &str) -> FileTarget {
		let cp = CodePath {
			locator:   Locator::Fs(FsLocator { segments: vec![FsSegment::Literal(name.to_string())] }),
			query:     None,
			qualifier: None,
		};
		FileTarget::new(cp).unwrap()
	}

	#[test]
	fn append_to_file() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "line1\nline2\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = bare_file_target("a.txt");
		let op = Op::FileAppend {
			target,
			content: ActionContent::Multi(vec!["line3".to_string(), "line4".to_string()]),
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
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
		let target = bare_file_target("a.txt");
		let op = Op::FilePrepend {
			target,
			content: ActionContent::Multi(vec!["line0".to_string(), "line1".to_string()]),
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "line0\nline1\nline2\nline3\n");
	}

	#[test]
	fn replace_by_line_span() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = bare_file_target("a.txt");
		let hash = compute_line_hash(2, "bar");
		let op = Op::LineReplace {
			target,
			span: LineSpan { start: LineAnchor { line: 2, hash }, end: None },
			content: ActionContent::Single("qux".to_string()),
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
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
		let target = bare_file_target("a.txt");
		let op = Op::LineReplace {
			target,
			span: LineSpan { start: LineAnchor { line: 2, hash: "ZZ".to_string() }, end: None },
			content: ActionContent::Single("qux".to_string()),
		};
		let err = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::StaleAnchor));
	}

	#[test]
	fn patch_diff() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = bare_file_target("a.txt");
		let diff = "--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n foo\n-bar\n+qux\n baz\n".to_string();
		let op = Op::FilePatch { target, diff };
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\nqux\nbaz\n");
	}

	#[test]
	fn insert_before() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = bare_file_target("a.txt");
		let hash = compute_line_hash(2, "bar");
		let op = Op::LineInsert {
			target,
			at: LineAt::Before { anchor: LineAnchor { line: 2, hash } },
			content: ActionContent::Single("inserted".to_string()),
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\ninserted\nbar\n");
	}

	#[test]
	fn insert_after() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = bare_file_target("a.txt");
		let hash = compute_line_hash(1, "foo");
		let op = Op::LineInsert {
			target,
			at: LineAt::After { anchor: LineAnchor { line: 1, hash } },
			content: ActionContent::Single("inserted".to_string()),
		};
		let outcome = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap();
		assert_eq!(outcome.edit_count, 1);
		let content = std::fs::read_to_string(root.join("a.txt")).unwrap();
		assert_eq!(content, "foo\ninserted\nbar\n");
	}

	#[test]
	fn non_text_op_returns_none() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		let resolver = TextResolver::new(root);
		let target = bare_file_target("test.txt");
		let op = Op::FileDelete { target };
		let result = resolver.try_apply(&op, &CancellationToken::new());
		assert!(result.is_none(), "TextResolver should return None for FileDelete");
	}
}
