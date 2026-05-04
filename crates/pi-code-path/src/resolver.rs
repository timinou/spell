//! CodePath resolver — walks tree-sitter AST and applies CodePath queries
//! to produce NodeSet/NodeRef results.
//!
//! Architecture:
//! 1. **Locator dispatch**: FS path → file walker; URI → scheme dialect.
//! 2. **Tree-sitter AST walk**: For each file, parse with the appropriate
//!    `LanguageProfile`, then walk the AST applying `Step` filters via combinators.
//! 3. **Edge axis dispatch**: Edge combinators (`def→`, `ref→`, ...) delegate
//!    to `pi-code-graph` for cross-file traversal.
//! 4. **Set operations**: Union, intersect, except over NodeSet results.
//!
//! This module provides the trait + a basic in-memory resolver. Full
//! integration with `pi-code-engine`'s LanguageProfile and `pi-code-graph`'s
//! query API happens at the NAPI layer (PROJ-054), where pi-code-path is
//! consumed alongside those crates without circular dependency.

use std::path::PathBuf;

use crate::ast::{CodePath, Locator};
use crate::types::{Diagnostic, DiagnosticVariant, NodeRef};

/// The resolver trait — implementations are dialect/system-specific.
///
/// The kernel doesn't ship a single resolver; instead, NAPI layer (PROJ-054)
/// composes:
/// - FS resolver (filesystem walker via `ignore` crate)
/// - Text resolver (line-index + grep-regex)
/// - Code resolver (tree-sitter via `pi-code-engine::LanguageProfile`)
/// - Graph resolver (edge axis via `pi-code-graph`)
/// - URI resolvers (one per scheme)
///
/// This trait defines the contract.
pub trait Resolver {
    /// Resolve a parsed CodePath to a NodeSet (sequence of NodeRefs).
    fn resolve(&self, path: &CodePath) -> Result<Vec<NodeRef>, Diagnostic>;
}

/// A no-op resolver useful for tests and stubs.
pub struct StubResolver;

impl Resolver for StubResolver {
    fn resolve(&self, path: &CodePath) -> Result<Vec<NodeRef>, Diagnostic> {
        // Return one NodeRef whose locator string is the rendered locator.
        let locator_str = match &path.locator {
            Locator::Fs(fs) => fs
                .segments
                .iter()
                .map(|s| match s {
                    crate::ast::FsSegment::Literal(l) => l.clone(),
                    crate::ast::FsSegment::Star => "*".to_string(),
                    crate::ast::FsSegment::DoubleStar => "**".to_string(),
                    _ => "?".to_string(),
                })
                .collect::<Vec<_>>()
                .join(""),
            Locator::Uri(uri) => format!("{}://{}", uri.scheme, uri.path),
        };
        Ok(vec![NodeRef {
            locator: locator_str,
            range: 0..0,
            kind: "stub".to_string(),
            content: None,
            metadata: Default::default(),
            diagnostics: Vec::new(),
        }])
    }
}

/// File-system existence check resolver (minimal real resolver for testing).
///
/// For an FS locator, checks whether the file exists at `root` and returns
/// a NodeRef. URI locators currently return UnsupportedOperation.
pub struct FsExistsResolver {
    pub root: PathBuf,
}

impl Resolver for FsExistsResolver {
    fn resolve(&self, path: &CodePath) -> Result<Vec<NodeRef>, Diagnostic> {
        match &path.locator {
            Locator::Fs(fs) => {
                let path_str: String = fs
                    .segments
                    .iter()
                    .map(|s| match s {
                        crate::ast::FsSegment::Literal(l) => l.clone(),
                        _ => "?".to_string(),
                    })
                    .collect();
                let full = self.root.join(&path_str);
                if full.exists() {
                    Ok(vec![NodeRef {
                        locator: path_str,
                        range: 0..0,
                        kind: "§file".to_string(),
                        content: None,
                        metadata: Default::default(),
                        diagnostics: Vec::new(),
                    }])
                } else {
                    Err(Diagnostic {
                        variant: DiagnosticVariant::FileNotFound,
                        message: format!("file not found: {path_str}"),
                        span: None,
                    })
                }
            }
            Locator::Uri(_) => Err(Diagnostic {
                variant: DiagnosticVariant::UnsupportedOperation,
                message: "URI resolver not implemented in FsExistsResolver".to_string(),
                span: None,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dialects::TsNameLexer;
    use crate::parser::parse_code_path;

    #[test]
    fn stub_resolver_returns_node() {
        let cp = parse_code_path("src/api.ts", &TsNameLexer).unwrap();
        let nodes = StubResolver.resolve(&cp).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].locator, "src/api.ts");
    }

    #[test]
    fn fs_exists_resolver_finds_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("test.ts");
        std::fs::write(&file, "export const x = 1;").unwrap();

        let cp = parse_code_path("test.ts", &TsNameLexer).unwrap();
        let resolver = FsExistsResolver {
            root: tmp.path().to_path_buf(),
        };
        let nodes = resolver.resolve(&cp).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].kind, "§file");
    }

    #[test]
    fn fs_exists_resolver_reports_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let cp = parse_code_path("missing.ts", &TsNameLexer).unwrap();
        let resolver = FsExistsResolver {
            root: tmp.path().to_path_buf(),
        };
        let err = resolver.resolve(&cp).unwrap_err();
        assert!(matches!(err.variant, DiagnosticVariant::FileNotFound));
    }
}
