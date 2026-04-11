use std::fmt::Write as _;

use imara_diff::{Algorithm, Diff, InternedInput, TokenSource};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
	pub old_start: u32,
	pub old_count: u32,
	pub new_start: u32,
	pub new_count: u32,
	pub kind:      DiffKind,
	pub content:   String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
	Added,
	Removed,
	Changed,
}

/// Compute line-based diff between two source strings.
pub fn diff_lines(old: &str, new: &str) -> Vec<DiffHunk> {
	let old_lines = split_lines(old);
	let new_lines = split_lines(new);
	let input = InternedInput::new(LineSource::new(&old_lines), LineSource::new(&new_lines));
	let diff = Diff::compute(Algorithm::Myers, &input);
	let mut hunks = Vec::new();
	for hunk in diff.hunks() {
		let old_start = hunk.before.start as usize;
		let old_end = hunk.before.end as usize;
		let new_start = hunk.after.start as usize;
		let new_end = hunk.after.end as usize;
		let old_count = old_end.saturating_sub(old_start);
		let new_count = new_end.saturating_sub(new_start);
		let kind = match (old_count, new_count) {
			(0, 0) => continue,
			(0, _) => DiffKind::Added,
			(_, 0) => DiffKind::Removed,
			_ => DiffKind::Changed,
		};
		let mut content = String::new();
		let _ = writeln!(
			&mut content,
			"@@ -{},{} +{},{} @@",
			old_start + 1,
			old_count,
			new_start + 1,
			new_count
		);
		for line in &old_lines[old_start..old_end] {
			content.push('-');
			content.push_str(line);
		}
		for line in &new_lines[new_start..new_end] {
			content.push('+');
			content.push_str(line);
		}
		hunks.push(DiffHunk {
			old_start: (old_start + 1) as u32,
			old_count: old_count as u32,
			new_start: (new_start + 1) as u32,
			new_count: new_count as u32,
			kind,
			content,
		});
	}
	hunks
}

fn split_lines(input: &str) -> Vec<String> {
	if input.is_empty() {
		return Vec::new();
	}
	input.split_inclusive('\n').map(ToOwned::to_owned).collect()
}

struct LineSource<'a> {
	lines: &'a [String],
}
impl<'a> LineSource<'a> {
	const fn new(lines: &'a [String]) -> Self {
		Self { lines }
	}
}
impl<'a> TokenSource for LineSource<'a> {
	type Token = &'a str;
	type Tokenizer = std::iter::Map<std::slice::Iter<'a, String>, fn(&'a String) -> &'a str>;

	fn tokenize(&self) -> Self::Tokenizer {
		self.lines.iter().map(String::as_str)
	}

	fn estimate_tokens(&self) -> u32 {
		self.lines.len() as u32
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn test_diff_empty_to_content() {
		let hunks = diff_lines("", "a\nb\n");
		assert_eq!(hunks.len(), 1);
		assert_eq!(hunks[0].kind, DiffKind::Added);
		assert_eq!(hunks[0].old_count, 0);
		assert_eq!(hunks[0].new_count, 2);
	}
	#[test]
	fn test_diff_content_to_empty() {
		let hunks = diff_lines("a\nb\n", "");
		assert_eq!(hunks.len(), 1);
		assert_eq!(hunks[0].kind, DiffKind::Removed);
		assert_eq!(hunks[0].old_count, 2);
		assert_eq!(hunks[0].new_count, 0);
	}
	#[test]
	fn test_diff_no_change() {
		assert!(diff_lines("a\nb\n", "a\nb\n").is_empty());
	}
	#[test]
	fn test_diff_single_line_change() {
		let hunks = diff_lines("a\nb\n", "a\nc\n");
		assert_eq!(hunks.len(), 1);
		assert_eq!(hunks[0].kind, DiffKind::Changed);
	}
}
