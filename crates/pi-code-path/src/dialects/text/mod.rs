//! Text dialect resolver.
//!
//! Operates on opaque bytes with structural axes (`§line`, `§chunk`, `§para`).

pub mod axes;
pub mod line_index;
pub mod para_index;
pub mod qualifiers;
pub mod regex_match;
pub mod stream;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::ast::{CodePath, Combinator, Head, Locator, Predicate, Step};
use crate::dialects::fs::walker::{WalkOpts, walk};
use crate::resolver::traits::{CancellationToken, FormatExtractor, Resolver};
use crate::types::{Content, Diagnostic, DiagnosticVariant, NodeRef};

use super::fs::anchors::DefaultFsAnchorContext;

/// Top-level text resolver.
pub struct TextResolver {
    pub format_extractors: Vec<Arc<dyn FormatExtractor>>,
    pub root:              PathBuf,
}

impl TextResolver {
    pub fn new(root: PathBuf) -> Self {
        Self { format_extractors: Vec::new(), root }
    }

    pub fn with_extractors(mut self, extractors: Vec<Arc<dyn FormatExtractor>>) -> Self {
        self.format_extractors = extractors;
        self
    }
}

impl Resolver for TextResolver {
    fn resolve(
        &self,
        path: &CodePath,
        cancel: &CancellationToken,
    ) -> Result<Vec<NodeRef>, Diagnostic> {
        let fs_loc = match &path.locator {
            Locator::Fs(fs) => fs,
            Locator::Uri(_) => {
                return Err(Diagnostic {
                    variant: DiagnosticVariant::ParseError,
                    message: "TextResolver received URI locator".into(),
                    span:    None,
                });
            }
        };

        let _anchor_ctx = DefaultFsAnchorContext::new(self.root.clone());
        let opts = WalkOpts {
            hidden:    true,
            gitignore: true,
            root:      self.root.clone(),
        };
        let walk_results = walk(fs_loc, &opts, cancel);
        let file_paths: Vec<PathBuf> = walk_results
            .into_iter()
            .filter_map(|r| r.ok())
            .filter(|n| n.kind == "§file")
            .map(|n| {
                if std::path::Path::new(&n.locator).is_absolute() {
                    PathBuf::from(n.locator)
                } else {
                    self.root.join(n.locator)
                }
            })
            .collect();

        if file_paths.is_empty() {
            return Ok(Vec::new());
        }

        let query = match &path.query {
            Some(q) => q,
            None => {
                // No query — return file nodes.
                return Ok(file_paths
                    .into_iter()
                    .map(|p| NodeRef {
                        locator:     p.to_string_lossy().to_string(),
                        range:       0..0,
                        kind:        "§file".to_string(),
                        content:     None,
                        metadata:    HashMap::new(),
                        diagnostics: Vec::new(),
                    })
                    .collect());
            }
        };

        // Apply head step to every file.
        let head_step = &query.head;
        let mut nodes = Vec::new();
        for path in &file_paths {
            if cancel.is_cancelled() {
                break;
            }
            let content = match std::fs::read(path) {
                Ok(c) => c,
                Err(e) => {
                    nodes.push(NodeRef {
                        locator:     path.to_string_lossy().to_string(),
                        range:       0..0,
                        kind:        "§file".to_string(),
                        content:     None,
                        metadata:    HashMap::new(),
                        diagnostics: vec![Diagnostic {
                            variant: DiagnosticVariant::Inaccessible,
                            message: format!("cannot read file: {e}"),
                            span:    None,
                        }],
                    });
                    continue;
                }
            };
            let mut file_nodes = apply_step(&content, head_step, path);
            nodes.append(&mut file_nodes);
        }

        // Process combinator chain.
        for (combinator, step) in &query.chain {
            match combinator {
                Combinator::NextSibling => {
                    nodes = expand_context(&nodes, step, &file_paths, cancel, true);
                }
                Combinator::PrevSibling => {
                    nodes = expand_context(&nodes, step, &file_paths, cancel, false);
                }
                _ => {
                    // Ignore unsupported combinators at this layer.
                }
            }
        }

        // Apply qualifier.
        if let Some(qual) = &path.qualifier {
            let mut out = Vec::new();
            for n in nodes {
                let path = PathBuf::from(&n.locator.split("::").next().unwrap_or(&n.locator));
                let content = match std::fs::read(&path) {
                    Ok(c) => c,
                    Err(_) => {
                        out.push(n);
                        continue;
                    }
                };
                match qualifiers::resolve_qualifier(
                    &n,
                    &content,
                    qual,
                    &self.format_extractors,
                ) {
                    Ok(m) => out.push(m),
                    Err(d) => {
                        let mut n = n;
                        n.diagnostics.push(d);
                        out.push(n);
                    }
                }
            }
            nodes = out;
        }

        Ok(nodes)
    }
}

fn apply_step(content: &[u8], step: &Step, path: &std::path::Path) -> Vec<NodeRef> {
    let mut nodes = match &step.head {
        Head::NodeKind(kind) => match kind.as_str() {
            "line" => axes::line_steps(content, step),
            "para" => axes::para_steps(content, step),
            "chunk" => axes::chunk_steps(content, step),
            _ => axes::line_steps(content, step),
        },
        _ => axes::line_steps(content, step),
    };
    for n in &mut nodes {
        n.locator = format!("{}::{}", path.to_string_lossy(), n.locator);
    }
    nodes
}

/// Expand context for `<<` or `>>` combinators.
///
/// `is_next` = true for `>>` (trailing), false for `<<` (leading).
fn expand_context(
    nodes: &[NodeRef],
    step: &Step,
    _file_paths: &[PathBuf],
    cancel: &CancellationToken,
    is_next: bool,
) -> Vec<NodeRef> {
    let count = context_count(step);
    if count == 0 {
        return nodes.to_vec();
    }

    let mut result = nodes.to_vec();


    for node in nodes {
        if cancel.is_cancelled() {
            break;
        }
        let (path_str, inner_locator) = node.locator.split_once("::").unwrap_or(("", &node.locator));
        let path = PathBuf::from(path_str);
        let content = match std::fs::read(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let idx = line_index::LineIndex::build(&content);
        let line_count = idx.line_count();

        let line_num = parse_line_num(inner_locator);
        let Some(line_num) = line_num else { continue };

        let start_line = if is_next {
            line_num + 1
        } else {
            line_num.saturating_sub(count)
        };
        let end_line = if is_next {
            (line_num + count).min(line_count)
        } else {
            line_num.saturating_sub(1)
        };

        if start_line == 0 || start_line > end_line {
            continue;
        }

        let text = String::from_utf8_lossy(&content);
        for ln in start_line..=end_line {
            let range = idx.line_range(ln, content.len()).unwrap_or(0..0);
            let line_text = text[range.clone()].to_string();
            let ctx_node = NodeRef {
                locator:     format!("{}::<line {}>", path_str, ln),
                range,
                kind:        "§line".to_string(),
                content:     Some(Content::Text { value: line_text }),
                metadata:    HashMap::new(),
                diagnostics: Vec::new(),
            };
            if !result.iter().any(|n| n.locator == ctx_node.locator && n.range == ctx_node.range) {
                result.push(ctx_node);
            }
        }
    }

    result
}

fn context_count(step: &Step) -> usize {
    for pred in &step.predicates {
        if let Predicate::Range { end, .. } = pred {
            return end.unwrap_or(0).max(0) as usize;
        }
    }
    0
}

fn parse_line_num(locator: &str) -> Option<usize> {
    let s = locator.strip_prefix("<line ")?;
    let s = s.strip_suffix(">")?;
    s.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Axis, Head, Predicate, Query};
    use crate::parser::parse_code_path;
    use crate::dialect::NameLexer;
    use winnow::token::take_while;
    use winnow::Parser;

    struct DummyLexer;
    impl NameLexer for DummyLexer {
        fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<crate::ast::NamePayload> {
            let s: &str = take_while(1.., |c: char| c.is_alphanumeric() || c == '_' || c == '.')
                .parse_next(input)?;
            Ok(crate::ast::NamePayload::Raw(s.to_string()))
        }
        fn render(&self, n: &crate::ast::NamePayload) -> String {
            match n { crate::ast::NamePayload::Raw(s) => s.clone() }
        }
        fn matches(&self, _n: &crate::ast::NamePayload, _node: tree_sitter::Node<'_>, _src: &str) -> bool {
            false
        }
    }

    fn make_resolver(root: PathBuf) -> TextResolver {
        TextResolver::new(root)
    }

    #[test]
    fn resolve_line_slice() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\n").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("a.txt::§line[2..3]", &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 2);
        assert!(nodes[0].locator.contains("<line 2>"));
        assert!(nodes[1].locator.contains("<line 3>"));
    }

    #[test]
    fn resolve_text_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"foo\nbar\nbaz\n").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path(r#"a.txt::§line[text~="ba."]"#, &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 2);
        assert!(nodes[0].locator.contains("<line 2>"));
        assert!(nodes[1].locator.contains("<line 3>"));
    }

    #[test]
    fn resolve_qualifier_raw() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"hello world").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("a.txt::§line[1]#raw", &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(
            nodes[0].content,
            Some(Content::Text { value: "hello world".to_string() })
        );
    }

    #[test]
    fn resolve_trailing_context_combinator() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\nl5\n").unwrap();

        let resolver = make_resolver(root.clone());
        // §line[text~="l2"]>>§line[0..2]
        let cp = CodePath {
            locator:   crate::ast::Locator::Fs(crate::ast::FsLocator {
                segments: vec![crate::ast::FsSegment::Literal("a.txt".to_string())],
            }),
            query:     Some(Query {
                head:  Step {
                    axis:       Some(Axis::Structural),
                    head:       Head::NodeKind("line".to_string()),
                    predicates: vec![Predicate::TextMatch(r"l2".to_string())],
                },
                chain: vec![(
                    Combinator::NextSibling,
                    Step {
                        axis:       Some(Axis::Structural),
                        head:       Head::NodeKind("line".to_string()),
                        predicates: vec![Predicate::Range {
                            start: Some(0),
                            end:   Some(2),
                        }],
                    },
                )],
            }),
            qualifier: None,
        };
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        // match line 2 + 2 trailing context lines (3,4) = 3 total
        assert_eq!(nodes.len(), 3);
        let locs: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
        assert!(locs.iter().any(|l| l.contains("<line 2>")));
        assert!(locs.iter().any(|l| l.contains("<line 3>")));
        assert!(locs.iter().any(|l| l.contains("<line 4>")));
    }

    #[test]
    fn resolve_leading_context_combinator() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"l1\nl2\nl3\nl4\nl5\n").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = CodePath {
            locator:   crate::ast::Locator::Fs(crate::ast::FsLocator {
                segments: vec![crate::ast::FsSegment::Literal("a.txt".to_string())],
            }),
            query:     Some(Query {
                head:  Step {
                    axis:       Some(Axis::Structural),
                    head:       Head::NodeKind("line".to_string()),
                    predicates: vec![Predicate::TextMatch(r"l4".to_string())],
                },
                chain: vec![(
                    Combinator::PrevSibling,
                    Step {
                        axis:       Some(Axis::Structural),
                        head:       Head::NodeKind("line".to_string()),
                        predicates: vec![Predicate::Range {
                            start: Some(0),
                            end:   Some(2),
                        }],
                    },
                )],
            }),
            qualifier: None,
        };
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        // match line 4 + 2 leading context lines (2,3) = 3 total
        assert_eq!(nodes.len(), 3);
        let locs: Vec<_> = nodes.iter().map(|n| n.locator.clone()).collect();
        assert!(locs.iter().any(|l| l.contains("<line 2>")));
        assert!(locs.iter().any(|l| l.contains("<line 3>")));
        assert!(locs.iter().any(|l| l.contains("<line 4>")));
    }

    #[test]
    fn resolve_no_query_returns_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"x").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("a.txt", &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].kind, "§file");
    }

    #[test]
    fn resolve_empty_file_returns_no_lines() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("empty.txt"), b"").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("empty.txt::§line", &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 0);
    }

    #[test]
    fn resolve_para_axis() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("a.txt"), b"p1\n\np2\n\np3\n").unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("a.txt::§para", &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 3);
        assert!(nodes[0].locator.contains("<para 1>"));
    }

    #[test]
    fn resolve_chunk_axis() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let lines: String = (1..=100).map(|i| format!("{i}\n")).collect();
        std::fs::write(root.join("a.txt"), lines).unwrap();

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("a.txt::§chunk[n=25]", &DummyLexer).unwrap();
        let nodes = resolver.resolve(&cp, &CancellationToken::new()).unwrap();
        assert_eq!(nodes.len(), 4);
        assert!(nodes[0].locator.contains("<chunk 1>"));
    }

    #[test]
    fn resolve_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        for i in 0..10 {
            std::fs::write(root.join(format!("{i}.txt")), b"a\n").unwrap();
        }

        let resolver = make_resolver(root.clone());
        let cp = parse_code_path("*.txt::§line", &DummyLexer).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let nodes = resolver.resolve(&cp, &cancel).unwrap();
        assert!(nodes.len() < 10);
    }
}
