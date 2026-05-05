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

    fn matches(&self, n: &NamePayload, node: tree_sitter::Node<'_>, src: &str) -> bool {
        // FEAT-708: extract the declared name from common TS/TSX
        // declaration kinds and compare to the requested name. The
        // walker's existing fallbacks (name-field text match) cover
        // function/class declarations; this lexer extends coverage to
        // interfaces, type aliases, enums, namespaces, method
        // definitions, and variable declarators bound to functions.
        let target = match n {
            NamePayload::Raw(s) => s.as_str(),
        };
        // Strip dotted suffixes — the walker handles dotted paths via
        // multiple steps. Here we only validate the leaf segment.
        let leaf = target.rsplit('.').next().unwrap_or(target);
        let leaf = leaf.trim_start_matches('#');

        // Direct `name` field on a known declaration kind.
        if matches!(
            node.kind(),
            "function_declaration"
                | "function_signature"
                | "class_declaration"
                | "interface_declaration"
                | "type_alias_declaration"
                | "enum_declaration"
                | "internal_module"
                | "module"
                | "method_definition"
                | "method_signature"
                | "abstract_method_signature"
                | "abstract_class_declaration"
                | "public_field_definition"
                | "property_signature"
                | "namespace_export"
        ) {
            if let Some(name_child) = node.child_by_field_name("name")
                && let Some(text) = src.get(name_child.start_byte()..name_child.end_byte())
            {
                return text.trim_start_matches('#') == leaf;
            }
        }

        // `variable_declarator` whose name binds a function expression
        // or arrow expression — common React-component / hook pattern.
        if node.kind() == "variable_declarator"
            && let Some(name_child) = node.child_by_field_name("name")
            && let Some(text) = src.get(name_child.start_byte()..name_child.end_byte())
        {
            return text == leaf;
        }

        // `lexical_declaration` / `variable_declaration` wrapping a
        // single declarator (the walker often hands us the wrapper).
        if matches!(node.kind(), "lexical_declaration" | "variable_declaration") {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "variable_declarator"
                    && let Some(name_child) = child.child_by_field_name("name")
                    && let Some(text) = src.get(name_child.start_byte()..name_child.end_byte())
                    && text == leaf
                {
                    return true;
                }
            }
        }

        // `export_statement` wrapping a recognized declaration —
        // delegate via the unwrap pattern.
        if node.kind() == "export_statement" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() != "export_statement" && self.matches(n, child, src) {
                    return true;
                }
            }
        }

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

// ── Anchors and qualifiers ──────────────────────────────────────

use std::ops::Range;
use std::sync::Arc;

use crate::dialect::{AnchorPattern, EdgeKindSet, LanguageDialect, QualifierResolver, QualifierSpec};

mod qualifiers {
    use std::ops::Range;
    use tree_sitter::Node;
    use crate::dialect::QualifierResolver;

    pub struct Body;
    impl QualifierResolver for Body {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            if let Some(body) = node.child_by_field_name("body") {
                return Some(body.start_byte()..body.end_byte());
            }
            // Arrow function stored in a variable_declarator's "value" field
            if let Some(value) = node.child_by_field_name("value") {
                if value.kind() == "arrow_function" {
                    return value.child_by_field_name("body")
                        .map(|c| c.start_byte()..c.end_byte());
                }
            }
            None
        }
    }

    pub struct Sig;
    impl QualifierResolver for Sig {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            let target = if let Some(value) = node.child_by_field_name("value") {
                if value.kind() == "arrow_function" { value } else { node }
            } else {
                node
            };
            match target.child_by_field_name("body") {
                Some(body) => Some(target.start_byte()..body.start_byte()),
                None => Some(target.start_byte()..target.end_byte()),
            }
        }
    }

    pub struct Name;
    impl QualifierResolver for Name {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            node.child_by_field_name("name").map(|c| c.start_byte()..c.end_byte())
        }
    }

    pub struct Decorators;
    impl QualifierResolver for Decorators {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            // Strategy 1: direct children (class_declaration)
            let mut first: Option<Node> = None;
            let mut last: Option<Node> = None;
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "decorator" {
                    if first.is_none() {
                        first = Some(child);
                    }
                    last = Some(child);
                }
            }
            if first.is_some() {
                return Some(first.unwrap().start_byte()..last.unwrap().end_byte());
            }
            // Strategy 2: previous siblings (method_definition inside class_body)
            let mut sib = node.prev_sibling();
            while let Some(n) = sib {
                if n.kind() == "decorator" {
                    if first.is_none() {
                        first = Some(n);
                    }
                    last = Some(n);
                } else if n.is_named() {
                    break;
                }
                sib = n.prev_sibling();
            }
            match (first, last) {
                (Some(f), Some(l)) => Some(f.start_byte()..l.end_byte()),
                _ => None,
            }
        }
    }

    pub struct TypeParams;
    impl QualifierResolver for TypeParams {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            let target = if let Some(value) = node.child_by_field_name("value") {
                if value.kind() == "arrow_function" { value } else { node }
            } else {
                node
            };
            target.child_by_field_name("type_parameters")
                .map(|c| c.start_byte()..c.end_byte())
        }
    }

    pub struct ReturnType;
    impl QualifierResolver for ReturnType {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            let target = if let Some(value) = node.child_by_field_name("value") {
                if value.kind() == "arrow_function" { value } else { node }
            } else {
                node
            };
            target.child_by_field_name("return_type")
                .map(|c| c.start_byte()..c.end_byte())
        }
    }

    pub struct JsxChildren;
    impl QualifierResolver for JsxChildren {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            if node.kind() != "jsx_element" {
                return None;
            }
            let opening = node.child_by_field_name("opening_element")?;
            let closing = node.child_by_field_name("closing_element")?;
            let start = opening.end_byte();
            let end = closing.start_byte();
            if start >= end {
                return None;
            }
            Some(start..end)
        }
    }

    pub struct JsxAttrs;
    impl QualifierResolver for JsxAttrs {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            if node.kind() != "jsx_element" && node.kind() != "jsx_self_closing_element" {
                return None;
            }
            let opening = node.child_by_field_name("opening_element")?;
            let mut first: Option<Node> = None;
            let mut last: Option<Node> = None;
            let mut cursor = opening.walk();
            for child in opening.children(&mut cursor) {
                if child.kind() == "jsx_attribute" {
                    if first.is_none() {
                        first = Some(child);
                    }
                    last = Some(child);
                }
            }
            match (first, last) {
                (Some(f), Some(l)) => Some(f.start_byte()..l.end_byte()),
                _ => None,
            }
        }
    }

    pub struct DefaultExport;
    impl QualifierResolver for DefaultExport {
        fn resolve(&self, node: Node<'_>, _src: &str, _args: Option<&str>) -> Option<Range<usize>> {
            if node.kind() != "export_statement" {
                return None;
            }
            // Verify it contains a `default` keyword child
            let mut cursor = node.walk();
            if !node.children(&mut cursor).any(|c| c.kind() == "default") {
                return None;
            }
            Some(node.start_byte()..node.end_byte())
        }
    }
}

fn match_kind(node: &tree_sitter::Node<'_>, kinds: &[&str]) -> bool {
    kinds.contains(&node.kind())
}

fn has_descendant_kind(node: tree_sitter::Node<'_>, kind: &str) -> bool {
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if n.kind() == kind {
            return true;
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            stack.push(child);
        }
    }
    false
}

fn has_descendant_if_with_return(node: tree_sitter::Node<'_>) -> bool {
    let mut stack = vec![node];
    while let Some(n) = stack.pop() {
        if n.kind() == "if_statement" {
            // Check if the consequence (first named child after condition) contains return
            let mut cursor = n.walk();
            let mut found_condition = false;
            for child in n.children(&mut cursor) {
                if found_condition && child.is_named() {
                    if has_descendant_kind(child, "return_statement") {
                        return true;
                    }
                    break;
                }
                if child.kind() == "parenthesized_expression" || child.kind() == "binary_expression" {
                    // condition might be wrapped; look for a direct condition field
                }
                // Heuristic: the first parenthesized_expression or field named condition
            }
            // Fallback: check any descendant of the if_statement
            if has_descendant_kind(n, "return_statement") {
                return true;
            }
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            stack.push(child);
        }
    }
    false
}

/// Bundle the TypeScript / JavaScript / TSX dialect.
pub fn typescript_dialect() -> LanguageDialect {
    LanguageDialect {
        name_lexer: Arc::new(TsNameLexer),
        anchors: vec![
            AnchorPattern {
                name: "return",
                matcher: |n, _s| {
                    match_kind(n, &["function_declaration", "method_definition", "arrow_function"])
                        && has_descendant_kind(*n, "return_statement")
                },
            },
            AnchorPattern {
                name: "guard",
                matcher: |n, _s| {
                    match_kind(n, &["function_declaration", "method_definition", "arrow_function"])
                        && has_descendant_if_with_return(*n)
                },
            },
            AnchorPattern {
                name: "hook-deps",
                matcher: |n, src| {
                    if !match_kind(n, &["call_expression"]) {
                        return false;
                    }
                    // callee is first named child or child_by_field_name("function")
                    let callee = n.child_by_field_name("function");
                    if let Some(c) = callee {
                        if c.kind() == "identifier" {
                            if let Some(text) = src.get(c.start_byte()..c.end_byte()) {
                                return text.starts_with("use");
                            }
                        }
                    }
                    false
                },
            },
            AnchorPattern {
                name: "default-export",
                matcher: |n, _s| {
                    if !match_kind(n, &["export_statement"]) {
                        return false;
                    }
                    let mut cursor = n.walk();
                    n.children(&mut cursor).any(|c| c.kind() == "default")
                },
            },
            AnchorPattern {
                name: "first-import",
                matcher: |n, _s| {
                    if n.kind() != "import_statement" {
                        return false;
                    }
                    let mut sib = n.prev_sibling();
                    while let Some(p) = sib {
                        if p.kind() == "import_statement" {
                            return false;
                        }
                        sib = p.prev_sibling();
                    }
                    true
                },
            },
            AnchorPattern {
                name: "last-import",
                matcher: |n, _s| {
                    if n.kind() != "import_statement" {
                        return false;
                    }
                    let mut sib = n.next_sibling();
                    while let Some(p) = sib {
                        if p.kind() == "import_statement" {
                            return false;
                        }
                        sib = p.next_sibling();
                    }
                    true
                },
            },
            AnchorPattern {
                name: "module-side-effect",
                matcher: |n, _s| {
                    n.kind() == "expression_statement" && n.parent().map_or(false, |p| p.kind() == "program")
                },
            },
        ],
        qualifiers: vec![
            QualifierSpec {
                name:       "body",
                applies_to: vec![
                    "function_declaration".into(),
                    "method_definition".into(),
                    "arrow_function".into(),
                    "variable_declarator".into(),
                ],
                resolve:    Arc::new(qualifiers::Body),
            },
            QualifierSpec {
                name:       "sig",
                applies_to: vec![
                    "function_declaration".into(),
                    "method_definition".into(),
                    "arrow_function".into(),
                    "variable_declarator".into(),
                ],
                resolve:    Arc::new(qualifiers::Sig),
            },
            QualifierSpec {
                name:       "name",
                applies_to: vec![
                    "function_declaration".into(),
                    "class_declaration".into(),
                    "method_definition".into(),
                    "interface_declaration".into(),
                    "type_alias_declaration".into(),
                    "variable_declarator".into(),
                ],
                resolve:    Arc::new(qualifiers::Name),
            },
            QualifierSpec {
                name:       "decorators",
                applies_to: vec![
                    "class_declaration".into(),
                    "method_definition".into(),
                ],
                resolve:    Arc::new(qualifiers::Decorators),
            },
            QualifierSpec {
                name:       "type-params",
                applies_to: vec![
                    "function_declaration".into(),
                    "method_definition".into(),
                    "class_declaration".into(),
                    "interface_declaration".into(),
                    "type_alias_declaration".into(),
                    "variable_declarator".into(),
                ],
                resolve:    Arc::new(qualifiers::TypeParams),
            },
            QualifierSpec {
                name:       "return-type",
                applies_to: vec![
                    "function_declaration".into(),
                    "method_definition".into(),
                    "arrow_function".into(),
                    "variable_declarator".into(),
                ],
                resolve:    Arc::new(qualifiers::ReturnType),
            },
            QualifierSpec {
                name:       "jsx-children",
                applies_to: vec!["jsx_element".into()],
                resolve:    Arc::new(qualifiers::JsxChildren),
            },
            QualifierSpec {
                name:       "jsx-attrs",
                applies_to: vec!["jsx_element".into(), "jsx_self_closing_element".into()],
                resolve:    Arc::new(qualifiers::JsxAttrs),
            },
            QualifierSpec {
                name:       "default-export",
                applies_to: vec!["export_statement".into()],
                resolve:    Arc::new(qualifiers::DefaultExport),
            },
        ],
        edge_kinds: {
            let k = EdgeKindSet::default();
            // TODO: type→ and jsx-prop→ edges deferred until EdgeKind extension
            k
        },
    }
}
