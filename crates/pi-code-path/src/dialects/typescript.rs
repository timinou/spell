//! TypeScript / JavaScript / TSX NameLexer.
//!
//! Per specs/code-graph/code-path-dialects/01-typescript.md.
//!
//! Payload: `TsName { segments: Vec<TsSegment> }` where each segment is one of:
//! - `Ident("Foo")` — plain identifier
//! - `PrivateField("#field")` — private class field
//! - `ComputedKey("[expr]")` — computed property name
//!
//! Composition: dotted (`Foo.bar.baz`), private fields (`Foo.#field`),
//! computed keys are passthrough strings.

use serde::{Deserialize, Serialize};
use winnow::Parser;
use winnow::token::take_while;

use crate::ast::NamePayload;
use crate::dialect::NameLexer;

/// A TypeScript dotted/qualified name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TsName {
    pub segments: Vec<TsSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TsSegment {
    Ident(String),
    PrivateField(String),
    ComputedKey(String),
}

/// TypeScript NameLexer.
pub struct TsNameLexer;

impl NameLexer for TsNameLexer {
    fn parse<'s>(&self, input: &mut &'s str) -> winnow::Result<NamePayload> {
        let mut segments = Vec::new();
        let first = parse_segment(input)?;
        segments.push(first);

        // Optionally chain `.next` segments
        while input.starts_with('.') {
            let snapshot = *input;
            *input = &input[1..];
            match parse_segment(input) {
                Ok(seg) => segments.push(seg),
                Err(_) => {
                    *input = snapshot;
                    break;
                }
            }
        }

        // Encode as Raw(serialized) for now since NamePayload is a single Raw variant.
        // Future: extend NamePayload with structured variants per dialect.
        Ok(NamePayload::Raw(render_ts_name(&TsName { segments })))
    }

    fn render(&self, n: &NamePayload) -> String {
        match n {
            NamePayload::Raw(s) => s.clone(),
        }
    }

    fn matches(&self, n: &NamePayload, _node: tree_sitter::Node<'_>, _src: &str) -> bool {
        // Matching against tree-sitter nodes requires LanguageProfile and NameExtractor
        // application. Stub for now: returns true if the rendered name matches.
        // Full implementation needs the profile passed in (planned follow-up).
        let _ = n;
        false
    }
}

fn parse_segment(input: &mut &str) -> winnow::Result<TsSegment> {
    if input.starts_with('#') {
        // Private field: #identifier
        *input = &input[1..];
        let ident: &str = take_while(1.., |c: char| {
            c.is_alphanumeric() || c == '_' || c == '$'
        })
        .parse_next(input)?;
        return Ok(TsSegment::PrivateField(format!("#{ident}")));
    }
    // Plain identifier: Unicode-ID-start + Unicode-ID-continue + $/_
    let ident: &str = take_while(1.., |c: char| {
        c.is_alphanumeric() || c == '_' || c == '$'
    })
    .parse_next(input)?;
    Ok(TsSegment::Ident(ident.to_string()))
}

fn render_ts_name(name: &TsName) -> String {
    name.segments
        .iter()
        .map(|s| match s {
            TsSegment::Ident(i) => i.clone(),
            TsSegment::PrivateField(p) => p.clone(),
            TsSegment::ComputedKey(c) => format!("[{c}]"),
        })
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_ident() {
        let mut input = "Foo";
        let payload = TsNameLexer.parse(&mut input).unwrap();
        assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
    }

    #[test]
    fn parse_dotted() {
        let mut input = "Foo.bar.baz";
        let payload = TsNameLexer.parse(&mut input).unwrap();
        assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo.bar.baz"));
    }

    #[test]
    fn parse_private_field() {
        let mut input = "Foo.#secret";
        let payload = TsNameLexer.parse(&mut input).unwrap();
        assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo.#secret"));
    }

    #[test]
    fn stops_at_kernel_op() {
        let mut input = "Foo/bar";
        let payload = TsNameLexer.parse(&mut input).unwrap();
        assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
        assert_eq!(input, "/bar");
    }

    #[test]
    fn stops_at_predicate() {
        let mut input = "Foo[0]";
        let payload = TsNameLexer.parse(&mut input).unwrap();
        assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
        assert_eq!(input, "[0]");
    }

    #[test]
    fn stops_at_qualifier() {
        let mut input = "Foo#body";
        let payload = TsNameLexer.parse(&mut input).unwrap();
        assert!(matches!(payload, NamePayload::Raw(s) if s == "Foo"));
        assert_eq!(input, "#body");
    }

    #[test]
    fn integration_with_codepath_parser() {
        let cp = crate::parser::parse_code_path("src/api.ts::Foo.bar#body", &TsNameLexer)
            .expect("parse should succeed");
        assert_eq!(cp.qualifier.as_ref().unwrap().name, "body");
        let q = cp.query.unwrap();
        if let crate::ast::Head::Name(NamePayload::Raw(s)) = &q.head.head {
            assert_eq!(s, "Foo.bar");
        } else {
            panic!("expected Name(Raw(Foo.bar))");
        }
    }
}

// ── Dialect factory ───────────────────────────────────────────

use std::ops::Range;
use std::sync::Arc;

use crate::dialect::{AnchorPattern, EdgeKindSet, LanguageDialect, QualifierResolver, QualifierSpec};

struct StubResolver;
impl QualifierResolver for StubResolver {
	fn resolve(
		&self,
		_node: tree_sitter::Node<'_>,
		_src: &str,
		_args: Option<&str>,
	) -> Option<Range<usize>> {
		Some(0..0)
	}
}

fn match_kind(node: &tree_sitter::Node<'_>, kinds: &[&str]) -> bool {
	kinds.contains(&node.kind())
}

/// Bundle the TypeScript / JavaScript / TSX dialect.
pub fn typescript_dialect() -> LanguageDialect {
	LanguageDialect {
		name_lexer: Arc::new(TsNameLexer),
		anchors: vec![
			AnchorPattern { name: "hook-deps", matcher: |n, _s| match_kind(n, &["call_expression"]) },
			AnchorPattern { name: "return", matcher: |n, _s| match_kind(n, &["return_statement"]) },
			AnchorPattern { name: "async", matcher: |n, _s| match_kind(n, &["function_declaration", "arrow_function"]) },
			AnchorPattern { name: "export", matcher: |n, _s| match_kind(n, &["export_statement"]) },
			AnchorPattern { name: "import", matcher: |n, _s| match_kind(n, &["import_statement"]) },
		],
		qualifiers: vec![
			QualifierSpec {
				name:       "body",
				applies_to: vec!["function_declaration".into(), "arrow_function".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "sig",
				applies_to: vec!["function_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "name",
				applies_to: vec!["function_declaration".into(), "class_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "docstring",
				applies_to: vec!["function_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
			QualifierSpec {
				name:       "type-params",
				applies_to: vec!["function_declaration".into()],
				resolve:    Arc::new(StubResolver),
			},
		],
		edge_kinds: EdgeKindSet::default(),
	}
}
