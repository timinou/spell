use std::path::{Path, PathBuf};

use crate::{
	ast::{CodePath, FsSegment, Locator, MutationOutcome},
	op::{LineAt, Op},
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

/// Bounds-check a 1-indexed line number against the file's line count.
///
/// Returns the validated 1-indexed line, or a diagnostic naming the
/// actual file length so the caller can re-read with fresh numbers.
fn check_line_in_text(text: &str, line: u32) -> Result<usize, Diagnostic> {
	let count = text_to_lines(text).len();
	let line = line as usize;
	if line == 0 || line > count.max(1) {
		return Err(Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("line {line} out of range (file has {count} line(s))"),
			span:    None,
		});
	}
	Ok(line)
}

fn text_to_lines(text: &str) -> Vec<String> {
	let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
	if text.ends_with('\n') && !lines.is_empty() {
		lines.pop();
	}
	lines
}

fn lines_to_text(lines: &[String]) -> String {
	let mut text = lines.join("\n");
	if !text.is_empty() {
		text.push('\n');
	}
	text
}


fn read_file(path: &Path) -> Result<(String, Vec<String>), Diagnostic> {
	let text = std::fs::read_to_string(path).map_err(|e| Diagnostic {
		variant: DiagnosticVariant::Inaccessible,
		message: format!("cannot read file: {e}"),
		span:    None,
	})?;
	let lines = text_to_lines(&text);
	Ok((text, lines))
}

fn write_file(path: &Path, lines: &[String]) -> Result<String, Diagnostic> {
	let text = lines_to_text(lines);
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

/// Pure in-memory text transformation without disk I/O.
/// Returns `None` if this op is not a text mutation handled by this resolver.
pub fn apply_to_text(
	op: &Op,
	source: &str,
) -> Option<Result<(String, MutationOutcome), Diagnostic>> {
	match op {
		Op::FileAppend { content, .. } => {
			let mut lines = text_to_lines(source);
			let new_lines = content.lines();
			lines.extend(new_lines);
			let new_text = lines_to_text(&lines);
			let diff = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count: if diff.is_some() { 1 } else { 0 },
				diff,
				created: false,
				target_summary: None,
			})))
		},
		Op::FilePrepend { content, .. } => {
			let mut prepended = content.lines();
			prepended.extend(text_to_lines(source));
			let new_text = lines_to_text(&prepended);
			let diff = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count: if diff.is_some() { 1 } else { 0 },
				diff,
				created: false,
				target_summary: None,
			})))
		},
		Op::FilePatch { diff, .. } => {
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
			let new_text = match diffy::apply(source, &patch) {
				Ok(n) => n,
				Err(e) => {
					return Some(Err(Diagnostic {
						variant: DiagnosticVariant::ParseError,
						message: format!("failed to apply patch: {e}"),
						span:    None,
					}));
				},
			};
			let diff_out = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count:     if diff_out.is_some() { 1 } else { 0 },
				diff:           diff_out,
				created:        false,
				target_summary: None,
			})))
		},
		Op::LineReplace { span, content, .. } => {
			let start_line = match check_line_in_text(source, span.start.line()) {
				Ok(n) => n,
				Err(e) => return Some(Err(e)),
			};
			let end_line = match span.end {
				Some(end) => match check_line_in_text(source, end.line()) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				},
				None => start_line,
			};
			let file_lines = text_to_lines(source);
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
			let new_text = lines_to_text(&new_lines);
			if source == new_text {
				return Some(Ok((new_text, MutationOutcome {
					edit_count:     0,
					diff:           None,
					created:        false,
					target_summary: None,
				})));
			}
			let diff = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count: 1,
				diff,
				created: false,
				target_summary: None,
			})))
		},
		Op::LineInsert { at, content, .. } => {
			let line_num = match at {
				LineAt::Before { line } => match check_line_in_text(source, line.line()) {
					Ok(n) => n,
					Err(e) => return Some(Err(e)),
				},
				LineAt::After { line } => match check_line_in_text(source, line.line()) {
					Ok(n) => n + 1,
					Err(e) => return Some(Err(e)),
				},
			};
			let old = source.to_string();
			let mut file_lines = text_to_lines(source);
			let text_lines: Vec<String> = content.lines();
			let insert_idx = line_num.saturating_sub(1);
			for (i, l) in text_lines.into_iter().enumerate() {
				if insert_idx + i <= file_lines.len() {
					file_lines.insert(insert_idx + i, l);
				} else {
					file_lines.push(l);
				}
			}
			let new_text = lines_to_text(&file_lines);
			if old == new_text {
				return Some(Ok((new_text, MutationOutcome {
					edit_count:     0,
					diff:           None,
					created:        false,
					target_summary: None,
				})));
			}
			let diff = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count: 1,
				diff,
				created: false,
				target_summary: None,
			})))
		},
		Op::LineAppend { at, content, .. } => {
			let line_num = match check_line_in_text(source, at.line()) {
				Ok(n) => n + 1,
				Err(e) => return Some(Err(e)),
			};
			let old = source.to_string();
			let mut file_lines = text_to_lines(source);
			let text_lines: Vec<String> = content.lines();
			let insert_idx = line_num.saturating_sub(1);
			for (i, l) in text_lines.into_iter().enumerate() {
				if insert_idx + i <= file_lines.len() {
					file_lines.insert(insert_idx + i, l);
				} else {
					file_lines.push(l);
				}
			}
			let new_text = lines_to_text(&file_lines);
			if old == new_text {
				return Some(Ok((new_text, MutationOutcome {
					edit_count:     0,
					diff:           None,
					created:        false,
					target_summary: None,
				})));
			}
			let diff = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count: 1,
				diff,
				created: false,
				target_summary: None,
			})))
		},
		Op::LinePrepend { at, content, .. } => {
			let line_num = match check_line_in_text(source, at.line()) {
				Ok(n) => n,
				Err(e) => return Some(Err(e)),
			};
			let old = source.to_string();
			let mut file_lines = text_to_lines(source);
			let text_lines: Vec<String> = content.lines();
			let insert_idx = line_num.saturating_sub(1);
			for (i, l) in text_lines.into_iter().enumerate() {
				if insert_idx + i <= file_lines.len() {
					file_lines.insert(insert_idx + i, l);
				} else {
					file_lines.push(l);
				}
			}
			let new_text = lines_to_text(&file_lines);
			if old == new_text {
				return Some(Ok((new_text, MutationOutcome {
					edit_count:     0,
					diff:           None,
					created:        false,
					target_summary: None,
				})));
			}
			let diff = make_diff(source, &new_text);
			Some(Ok((new_text, MutationOutcome {
				edit_count: 1,
				diff,
				created: false,
				target_summary: None,
			})))
		},
		_ => None,
	}
}

impl MutationResolver for super::TextResolver {
	fn try_apply(
		&self,
		op: &Op,
		_cancel: &CancellationToken,
	) -> Option<Result<MutationOutcome, Diagnostic>> {
		// Fast-path: reject non-text ops before touching disk
		if apply_to_text(op, "").is_none() {
			return None;
		}
		let path = match resolve_target_path(&self.root, op.target_codepath()) {
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
		let (new_text, mut outcome) = match apply_to_text(op, &old)? {
			Ok(r) => r,
			Err(e) => return Some(Err(e)),
		};
		if let Err(e) = std::fs::write(&path, &new_text) {
			return Some(Err(Diagnostic {
				variant: DiagnosticVariant::Inaccessible,
				message: format!("cannot write file: {e}"),
				span:    None,
			}));
		}
		outcome.target_summary = Some(path.to_string_lossy().to_string());
		Some(Ok(outcome))
	}
}

#[cfg(test)]
mod tests {
	use super::super::TextResolver;
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
		let op = Op::LineReplace {
			target,
			span: LineSpan { start: LineAnchor(2), end: None },
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
	fn replace_line_out_of_range_reports_clearly() {
		let dir = tempfile::tempdir().unwrap();
		let root = dir.path().to_path_buf();
		std::fs::write(root.join("a.txt"), "foo\nbar\nbaz\n").unwrap();
		let resolver = TextResolver::new(root.clone());
		let target = bare_file_target("a.txt");
		let op = Op::LineReplace {
			target,
			span: LineSpan { start: LineAnchor(99), end: None },
			content: ActionContent::Single("qux".to_string()),
		};
		let err = resolver
			.try_apply(&op, &CancellationToken::new())
			.expect("should return Some")
			.unwrap_err();
		assert!(matches!(err.variant, DiagnosticVariant::ParseError));
		assert!(err.message.contains("line 99") && err.message.contains("3 line"),
			"expected helpful out-of-range diagnostic, got: {}", err.message);
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
		let op = Op::LineInsert {
			target,
			at: LineAt::Before { line: LineAnchor(2) },
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
		let op = Op::LineInsert {
			target,
			at: LineAt::After { line: LineAnchor(1) },
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
