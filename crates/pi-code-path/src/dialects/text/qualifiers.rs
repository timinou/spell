//! Qualifier resolution for the text dialect.
//!
//! `#raw`, `#bytes`, `#text`, `#match`, `#captures[N]`, `#lines[a..b]`,
//! `#image`, `#thumbnail[N]`.

use std::collections::HashMap;
use std::sync::Arc;

use crate::ast::Qualifier;
use crate::resolver::traits::FormatExtractor;
use crate::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

use super::axes::line_steps;

use crate::ast::{Axis, Head, Predicate, Step};

/// Resolve a text-dialect qualifier against `node`.
pub fn resolve_qualifier(
    node: &NodeRef,
    content: &[u8],
    qual: &Qualifier,
    extractors: &[Arc<dyn FormatExtractor>],
) -> Result<NodeRef, Diagnostic> {
    match qual.name.as_str() {
        "raw" => resolve_raw(node, content),
        "bytes" => resolve_bytes(node, content),
        "text" => resolve_text(node, content, extractors),
        "match" => resolve_match(node, content),
        "captures" => resolve_captures(node, qual.args.as_deref()),
        "lines" => resolve_lines(node, content, qual.args.as_deref()),
        "image" => resolve_image(node),
        "thumbnail" => resolve_thumbnail(node, qual.args.as_deref()),
        _ => Err(Diagnostic {
            variant: DiagnosticVariant::UnsupportedOperation,
            message: format!("unknown qualifier: {}", qual.name),
            span:    None,
        }),
    }
}

fn resolve_raw(node: &NodeRef, content: &[u8]) -> Result<NodeRef, Diagnostic> {
    let (text, diag) = decode_text(content);
    let mut node = node.clone();
    node.content = Some(Content::Text { value: text });
    if let Some(d) = diag {
        node.diagnostics.push(d);
    }
    Ok(node)
}

fn resolve_bytes(node: &NodeRef, content: &[u8]) -> Result<NodeRef, Diagnostic> {
    let mut node = node.clone();
    node.content = Some(Content::Bytes {
        artifact_uri: format!("artifact://{}", node.locator),
        size:         content.len() as u64,
    });
    Ok(node)
}

fn resolve_text(
    node: &NodeRef,
    content: &[u8],
    extractors: &[Arc<dyn FormatExtractor>],
) -> Result<NodeRef, Diagnostic> {
    let ext = std::path::Path::new(&node.locator)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    for ex in extractors {
        if ex.extracts(ext) {
            let text = ex.extract(content, &crate::resolver::traits::CancellationToken::new())?;
            let mut node = node.clone();
            node.content = Some(Content::ExtractedText {
                source_kind: ext.to_string(),
                text,
                mime_type:   None,
            });
            return Ok(node);
        }
    }

    // Fallback to #raw behaviour.
    resolve_raw(node, content)
}

fn resolve_match(node: &NodeRef, content: &[u8]) -> Result<NodeRef, Diagnostic> {
    let pattern = node
        .metadata
        .get("pattern")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if pattern.is_empty() {
        return Err(Diagnostic {
            variant: DiagnosticVariant::UnsupportedOperation,
            message: "#match requires preceding TextMatch predicate".into(),
            span:    None,
        });
    }

    let re = regex::Regex::new(pattern).map_err(|e| Diagnostic {
        variant: DiagnosticVariant::ParseError,
        message: format!("invalid regex: {e}"),
        span:    None,
    })?;

    let text = String::from_utf8_lossy(content);
    let m = re.find(&text).ok_or_else(|| Diagnostic {
        variant: DiagnosticVariant::NoMatches,
        message: "no regex match found for #match".into(),
        span:    None,
    })?;

    let mut node = node.clone();
    node.content = Some(Content::Text {
        value: m.as_str().to_string(),
    });
    node.range = m.start()..m.end();
    Ok(node)
}

fn resolve_captures(node: &NodeRef, args: Option<&str>) -> Result<NodeRef, Diagnostic> {
    let idx: usize = args
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let captures = node
        .metadata
        .get("captures")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let value = captures
        .get(idx)
        .and_then(|v| v.as_str())
        .ok_or_else(|| Diagnostic {
            variant: DiagnosticVariant::UnsupportedOperation,
            message: format!("capture index {idx} out of bounds"),
            span:    None,
        })?
        .to_string();

    let mut node = node.clone();
    node.content = Some(Content::Text { value });
    Ok(node)
}

fn resolve_lines(
    node: &NodeRef,
    content: &[u8],
    args: Option<&str>,
) -> Result<NodeRef, Diagnostic> {
    let (start, end) = parse_line_range(args)?;
    let step = Step {
        axis:       Some(Axis::Structural),
        head:       Head::NodeKind("line".to_string()),
        predicates: vec![Predicate::Range {
            start: Some(start),
            end:   Some(end),
        }],
    };
    let lines = line_steps(content, &step);
    let text: String = lines
        .into_iter()
        .filter_map(|n| n.content)
        .filter_map(|c| match c {
            Content::Text { value } => Some(value),
            _ => None,
        })
        .collect();

    let mut node = node.clone();
    node.content = Some(Content::Text { value: text });
    Ok(node)
}

fn parse_line_range(args: Option<&str>) -> Result<(isize, isize), Diagnostic> {
    let s = args.unwrap_or("");
    if let Some((a, b)) = s.split_once("..") {
        let start = if a.is_empty() {
            1
        } else {
            a.parse::<isize>().map_err(|_| Diagnostic {
                variant: DiagnosticVariant::ParseError,
                message: format!("invalid line range start: {a}"),
                span:    None,
            })?
        };
        let end = if b.is_empty() {
            isize::MAX
        } else {
            b.parse::<isize>().map_err(|_| Diagnostic {
                variant: DiagnosticVariant::ParseError,
                message: format!("invalid line range end: {b}"),
                span:    None,
            })?
        };
        return Ok((start, end));
    }
    let n = s.parse::<isize>().map_err(|_| Diagnostic {
        variant: DiagnosticVariant::ParseError,
        message: format!("invalid line range: {s}"),
        span:    None,
    })?;
    Ok((n, n))
}

fn resolve_image(node: &NodeRef) -> Result<NodeRef, Diagnostic> {
    let mut node = node.clone();
    node.content = Some(Content::Image {
        handle:    format!("image://{}", node.locator),
        mime_type: "image/png".to_string(),
        width:     None,
        height:    None,
    });
    node.metadata.insert(
        "image".to_string(),
        serde_json::Value::String("placeholder".to_string()),
    );
    Ok(node)
}

fn resolve_thumbnail(node: &NodeRef, args: Option<&str>) -> Result<NodeRef, Diagnostic> {
    let _size = args.and_then(|s| s.parse::<u32>().ok()).unwrap_or(256);
    let mut node = node.clone();
    node.content = Some(Content::Image {
        handle:    format!("thumbnail://{}", node.locator),
        mime_type: "image/png".to_string(),
        width:     Some(_size),
        height:    Some(_size),
    });
    Ok(node)
}

/// Decode bytes to text.  On invalid UTF-8 fall back to latin-1 lossy
/// and emit an `EncodingFallback` diagnostic.
fn decode_text(content: &[u8]) -> (String, Option<Diagnostic>) {
    match std::str::from_utf8(content) {
        Ok(s) => (s.to_string(), None),
        Err(_) => {
            let text: String = content.iter().map(|b| *b as char).collect();
            let diag = Diagnostic {
                variant: DiagnosticVariant::EncodingFallback,
                message: "file is not valid UTF-8; using latin-1 lossy fallback".into(),
                span:    None,
            };
            (text, Some(diag))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualifier_raw_utf8() {
        let node = NodeRef {
            locator:     "test.txt".to_string(),
            range:       0..0,
            kind:        "§file".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        let qual = Qualifier {
            name: "raw".to_string(),
            args: None,
        };
        let out = resolve_qualifier(&node, b"hello world", &qual, &[]).unwrap();
        assert_eq!(
            out.content,
            Some(Content::Text { value: "hello world".to_string() })
        );
    }

    #[test]
    fn qualifier_raw_latin1_fallback() {
        let node = NodeRef {
            locator:     "test.txt".to_string(),
            range:       0..0,
            kind:        "§file".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        let qual = Qualifier {
            name: "raw".to_string(),
            args: None,
        };
        // 0xE9 is 'é' in latin-1 but invalid UTF-8
        let bytes = vec![0x68, 0xE9, 0x6C, 0x6C, 0x6F];
        let out = resolve_qualifier(&node, &bytes, &qual, &[]).unwrap();
        assert!(out.diagnostics.iter().any(|d| matches!(
            d.variant,
            DiagnosticVariant::EncodingFallback
        )));
        assert_eq!(
            out.content,
            Some(Content::Text { value: "héllo".to_string() })
        );
    }

    #[test]
    fn qualifier_bytes() {
        let node = NodeRef {
            locator:     "test.txt".to_string(),
            range:       0..0,
            kind:        "§file".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        let qual = Qualifier {
            name: "bytes".to_string(),
            args: None,
        };
        let out = resolve_qualifier(&node, b"data", &qual, &[]).unwrap();
        match out.content {
            Some(Content::Bytes { artifact_uri, size }) => {
                assert_eq!(size, 4);
                assert!(artifact_uri.contains("test.txt"));
            }
            other => panic!("expected Bytes, got {other:?}"),
        }
    }

    #[test]
    fn qualifier_lines_slice() {
        let node = NodeRef {
            locator:     "test.txt".to_string(),
            range:       0..0,
            kind:        "§file".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        let qual = Qualifier {
            name: "lines".to_string(),
            args: Some("2..3".to_string()),
        };
        let content = b"a\nb\nc\nd\n";
        let out = resolve_qualifier(&node, content, &qual, &[]).unwrap();
        assert_eq!(
            out.content,
            Some(Content::Text { value: "b\nc\n".to_string() })
        );
    }

    #[test]
    fn qualifier_image_placeholder() {
        let node = NodeRef {
            locator:     "img.png".to_string(),
            range:       0..0,
            kind:        "§file".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        let qual = Qualifier {
            name: "image".to_string(),
            args: None,
        };
        let out = resolve_qualifier(&node, b"", &qual, &[]).unwrap();
        match out.content {
            Some(Content::Image { handle, .. }) => {
                assert!(handle.contains("img.png"));
            }
            other => panic!("expected Image, got {other:?}"),
        }
        assert_eq!(
            out.metadata.get("image"),
            Some(&serde_json::Value::String("placeholder".to_string()))
        );
    }

    #[test]
    fn qualifier_captures() {
        let mut node = NodeRef {
            locator:     "test.txt".to_string(),
            range:       0..0,
            kind:        "§line".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        node.metadata.insert(
            "captures".to_string(),
            serde_json::Value::Array(vec![
                serde_json::Value::String("first".to_string()),
                serde_json::Value::String("second".to_string()),
            ]),
        );
        let qual = Qualifier {
            name: "captures".to_string(),
            args: Some("1".to_string()),
        };
        let out = resolve_qualifier(&node, b"", &qual, &[]).unwrap();
        assert_eq!(
            out.content,
            Some(Content::Text { value: "second".to_string() })
        );
    }

    #[test]
    fn qualifier_captures_out_of_bounds() {
        let mut node = NodeRef {
            locator:     "test.txt".to_string(),
            range:       0..0,
            kind:        "§line".to_string(),
            content:     None,
            metadata:    HashMap::new(),
            diagnostics: Vec::new(),
        };
        node.metadata.insert(
            "captures".to_string(),
            serde_json::Value::Array(vec![]),
        );
        let qual = Qualifier {
            name: "captures".to_string(),
            args: Some("0".to_string()),
        };
        let res = resolve_qualifier(&node, b"", &qual, &[]);
        assert!(res.is_err());
    }
}
