//! Regex matching over file content with per-line hits and context windows.

use std::ops::Range;

use regex::Regex;

use crate::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

use super::line_index::LineIndex;

/// A single regex match hit with absolute byte range and capture groups.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchHit {
    pub line_num: usize,
    pub byte_range: Range<usize>,
    pub captures: Vec<String>,
}

/// Run `pattern` against every line of `content` and return all non-overlapping
/// matches.  Fails only if the regex fails to compile.
pub fn match_lines(content: &[u8], pattern: &str) -> Result<Vec<MatchHit>, Diagnostic> {
    let re = Regex::new(pattern).map_err(|e| Diagnostic {
        variant: DiagnosticVariant::ParseError,
        message: format!("invalid regex: {e}"),
        span:    None,
    })?;

    let text = String::from_utf8_lossy(content);
    let line_index = LineIndex::build(content);
    let mut hits = Vec::new();

    for line_num in 1..=line_index.line_count() {
        let range = line_index
            .line_range(line_num, content.len())
            .unwrap_or(0..0);
        let line_text = &text[range.clone()];

        for cap in re.captures_iter(line_text) {
            let m = cap.get(0).expect("capture 0 always exists");
            let abs_start = range.start + m.start();
            let abs_end = range.start + m.end();
            let captures: Vec<String> = cap
                .iter()
                .skip(1)
                .map(|m| m.map(|m| m.as_str().to_string()).unwrap_or_default())
                .collect();
            hits.push(MatchHit {
                line_num,
                byte_range: abs_start..abs_end,
                captures,
            });
        }
    }

    Ok(hits)
}

/// Emit one `NodeRef` per match that spans the match line plus `pre` leading
/// and `post` trailing context lines.
pub fn with_context(
    matches: &[MatchHit],
    content: &[u8],
    pre: usize,
    post: usize,
    line_index: &LineIndex,
) -> Vec<NodeRef> {
    let text = String::from_utf8_lossy(content);
    let mut nodes = Vec::with_capacity(matches.len());

    for hit in matches {
        let start_line = hit.line_num.saturating_sub(pre).max(1);
        let end_line = (hit.line_num + post).min(line_index.line_count());

        let start_range = line_index
            .line_range(start_line, content.len())
            .unwrap_or(0..0);
        let end_range = line_index
            .line_range(end_line, content.len())
            .unwrap_or(0..0);
        let span_range = start_range.start..end_range.end;

        let context_text = text[span_range.clone()].to_string();

        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            "captures".to_string(),
            serde_json::Value::Array(
                hit.captures
                    .iter()
                    .map(|s| serde_json::Value::String(s.clone()))
                    .collect(),
            ),
        );

        nodes.push(NodeRef {
            locator:     format!("<span {}.{}>", hit.line_num, hit.byte_range.start),
            range:       span_range,
            kind:        "§span".to_string(),
            content:     Some(Content::Text {
                value: context_text,
            }),
            metadata,
            diagnostics: Vec::new(),
        });
    }

    nodes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_simple() {
        let content = b"hello world\nfoo bar\nhello again\n";
        let hits = match_lines(content, r"hello").unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line_num, 1);
        assert_eq!(hits[1].line_num, 3);
    }

    #[test]
    fn match_with_captures() {
        let content = b"error: file not found\nwarn: low memory\n";
        let hits = match_lines(content, r"(\w+): (.+)").unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].captures, vec!["error", "file not found"]);
        assert_eq!(hits[1].captures, vec!["warn", "low memory"]);
    }

    #[test]
    fn invalid_regex_returns_diagnostic() {
        let res = match_lines(b"text", r"[invalid");
        assert!(res.is_err());
        let diag = res.unwrap_err();
        assert!(matches!(diag.variant, DiagnosticVariant::ParseError));
    }

    #[test]
    fn trailing_context_window() {
        let content = b"line1\nline2\nline3\nline4\nline5\n";
        let hits = match_lines(content, r"line3").unwrap();
        assert_eq!(hits.len(), 1);
        let line_index = LineIndex::build(content);
        let nodes = with_context(&hits, content, 0, 2, &line_index);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].kind, "§span");
        // line3 + 2 trailing = lines 3,4,5
        assert_eq!(nodes[0].content.as_ref().unwrap().text_value(), "line3\nline4\nline5\n");
    }

    #[test]
    fn leading_context_window() {
        let content = b"line1\nline2\nline3\nline4\nline5\n";
        let hits = match_lines(content, r"line3").unwrap();
        let line_index = LineIndex::build(content);
        let nodes = with_context(&hits, content, 2, 0, &line_index);
        assert_eq!(nodes.len(), 1);
        // 2 leading + line3 = lines 1,2,3
        assert_eq!(nodes[0].content.as_ref().unwrap().text_value(), "line1\nline2\nline3\n");
    }

    #[test]
    fn context_window_clamps_to_bounds() {
        let content = b"line1\nline2\nline3\n";
        let hits = match_lines(content, r"line1").unwrap();
        let line_index = LineIndex::build(content);
        let nodes = with_context(&hits, content, 5, 5, &line_index);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].content.as_ref().unwrap().text_value(), "line1\nline2\nline3\n");
    }

    #[test]
    fn match_byte_range_is_absolute() {
        let content = b"abc\nxyz\n";
        let hits = match_lines(content, r"xyz").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].byte_range, 4..7);
    }
}

// Helper trait for tests to extract text value cleanly.
trait TextValue {
    fn text_value(&self) -> &str;
}

impl TextValue for Content {
    fn text_value(&self) -> &str {
        match self {
            Content::Text { value } => value.as_str(),
            _ => panic!("expected Text content"),
        }
    }
}
