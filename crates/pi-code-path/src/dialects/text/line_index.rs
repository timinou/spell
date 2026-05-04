//! Byte-offset index for newline-separated lines.
//!
//! `\r` is treated as ordinary content; only `\n` terminates a line.

use std::ops::Range;

/// Byte offset of each line start.  offsets[0] is always 0 for a
/// non-empty file; an empty file yields an empty vector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineIndex {
    offsets: Vec<u32>,
}

impl LineIndex {
    /// Scan `content` for `\n` and record the byte offset *after* each
    /// newline as the start of the next line.
    pub fn build(content: &[u8]) -> Self {
        let mut offsets = Vec::new();
        if !content.is_empty() {
            offsets.push(0);
        }
        for (i, &b) in content.iter().enumerate() {
            if b == b'\n' {
                let next = i + 1;
                if next < content.len() {
                    offsets.push(next as u32);
                }
            }
        }
        LineIndex { offsets }
    }

    /// 1-indexed line number → byte range **including** the trailing `\n`
    /// (or up to EOF for the last line).
    pub fn line_range(&self, n_one_indexed: usize, total_len: usize) -> Option<Range<usize>> {
        let idx = n_one_indexed.checked_sub(1)?;
        let start = *self.offsets.get(idx)? as usize;
        let end = if idx + 1 < self.offsets.len() {
            self.offsets[idx + 1] as usize
        } else {
            total_len
        };
        Some(start..end)
    }

    pub fn line_count(&self) -> usize {
        self.offsets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_file() {
        let idx = LineIndex::build(b"");
        assert_eq!(idx.line_count(), 0);
        assert_eq!(idx.line_range(1, 0), None);
    }

    #[test]
    fn single_line_no_trailing_newline() {
        let content = b"hello";
        let idx = LineIndex::build(content);
        assert_eq!(idx.line_count(), 1);
        assert_eq!(idx.line_range(1, content.len()), Some(0..5));
    }

    #[test]
    fn single_line_with_trailing_newline() {
        let content = b"hello\n";
        let idx = LineIndex::build(content);
        assert_eq!(idx.line_count(), 1);
        assert_eq!(idx.line_range(1, content.len()), Some(0..6));
    }

    #[test]
    fn crlf_content() {
        let content = b"line1\r\nline2\r\n";
        let idx = LineIndex::build(content);
        assert_eq!(idx.line_count(), 2);
        assert_eq!(idx.line_range(1, content.len()), Some(0..7));
        assert_eq!(idx.line_range(2, content.len()), Some(7..14));
    }

    #[test]
    fn multi_line() {
        let content = b"a\nb\nc";
        let idx = LineIndex::build(content);
        assert_eq!(idx.line_count(), 3);
        assert_eq!(idx.line_range(1, content.len()), Some(0..2));
        assert_eq!(idx.line_range(2, content.len()), Some(2..4));
        assert_eq!(idx.line_range(3, content.len()), Some(4..5));
    }

    #[test]
    fn out_of_bounds() {
        let content = b"a\nb";
        let idx = LineIndex::build(content);
        assert_eq!(idx.line_range(0, content.len()), None);
        assert_eq!(idx.line_range(3, content.len()), None);
    }

    #[test]
    fn slicing_last_line() {
        let content = b"first\nsecond\nthird";
        let idx = LineIndex::build(content);
		assert_eq!(idx.line_range(3, content.len()), Some(13..18));
    }
}
