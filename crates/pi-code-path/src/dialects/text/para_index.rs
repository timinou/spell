//! Paragraph index: blank-line-separated blocks.

use std::ops::Range;

use super::line_index::LineIndex;

/// Byte ranges of each paragraph (non-blank-line-separated block).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParaIndex {
    para_ranges: Vec<Range<usize>>,
}

impl ParaIndex {
    /// Build a paragraph index from raw bytes.
    ///
    /// A paragraph is a maximal consecutive run of non-blank lines.
    /// A "blank" line contains no non-whitespace characters.
    /// The range includes the trailing `\n` of the last line but excludes
    /// separating blank lines.
    pub fn build(content: &[u8]) -> Self {
        let line_index = LineIndex::build(content);
        let mut para_ranges = Vec::new();
        let mut in_para = false;
        let mut para_start = 0usize;
        let mut prev_line_end = 0usize;

        for line_num in 1..=line_index.line_count() {
            let range = line_index.line_range(line_num, content.len()).unwrap_or(0..0);
            let line_bytes = &content[range.clone()];
            let is_blank = line_bytes.iter().all(|b| b.is_ascii_whitespace());

            if !is_blank {
                if !in_para {
                    para_start = range.start;
                    in_para = true;
                }
                prev_line_end = range.end;
            } else if in_para {
                para_ranges.push(para_start..prev_line_end);
                in_para = false;
            }
        }

        if in_para {
            para_ranges.push(para_start..prev_line_end);
        }

        ParaIndex { para_ranges }
    }

    /// 1-indexed paragraph number → byte range.
    pub fn para_range(
        &self,
        n_one_indexed: usize,
        _total_len: usize,
    ) -> Option<Range<usize>> {
        let idx = n_one_indexed.checked_sub(1)?;
        self.para_ranges.get(idx).cloned()
    }

    pub fn para_count(&self) -> usize {
        self.para_ranges.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_file() {
        let idx = ParaIndex::build(b"");
        assert_eq!(idx.para_count(), 0);
        assert_eq!(idx.para_range(1, 0), None);
    }

    #[test]
    fn single_para_no_blanks() {
        let content = b"line1\nline2\nline3";
        let idx = ParaIndex::build(content);
        assert_eq!(idx.para_count(), 1);
        assert_eq!(idx.para_range(1, content.len()), Some(0..17));
    }

    #[test]
    fn two_paras() {
        let content = b"para one\n\npara two\n";
        let idx = ParaIndex::build(content);
        assert_eq!(idx.para_count(), 2);
        assert_eq!(idx.para_range(1, content.len()), Some(0..9));
        assert_eq!(idx.para_range(2, content.len()), Some(10..19));
    }

    #[test]
    fn leading_blank_lines() {
        let content = b"\n\nfirst para\n";
        let idx = ParaIndex::build(content);
        assert_eq!(idx.para_count(), 1);
        assert_eq!(idx.para_range(1, content.len()), Some(2..13));
    }

    #[test]
    fn trailing_blank_lines() {
        let content = b"first para\n\n\n";
        let idx = ParaIndex::build(content);
        assert_eq!(idx.para_count(), 1);
        assert_eq!(idx.para_range(1, content.len()), Some(0..11));
    }

    #[test]
    fn whitespace_only_line_is_blank() {
        let content = b"line1\n   \nline2\n";
        let idx = ParaIndex::build(content);
        assert_eq!(idx.para_count(), 2);
        assert_eq!(idx.para_range(1, content.len()), Some(0..6));
        assert_eq!(idx.para_range(2, content.len()), Some(10..16));
    }

    #[test]
    fn markdown_style_paras() {
        let content = b"# Title\n\nSome text here.\n\n\nMore text.\n";
        let idx = ParaIndex::build(content);
        assert_eq!(idx.para_count(), 3);
        assert_eq!(idx.para_range(1, content.len()), Some(0..8));
        assert_eq!(idx.para_range(2, content.len()), Some(9..25));
        assert_eq!(idx.para_range(3, content.len()), Some(27..38));
    }
}
