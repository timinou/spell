//! CodePath v3 query algebra: parser, AST, dialects, and resolver.
//!
//! Implements the shared query algebra defined in
//! `specs/code-graph/code-path.md` and the dialect contract in
//! `specs/code-graph/code-path-dialects/README.md`.
//!
//! Architecture:
//! - `ast`: AST types (CodePath, Locator, Query, Step, Combinator, ...)
//! - `dialect`: NameLexer trait + LanguageDialect struct (per-language
//!   pluggable)
//! - `types`: NodeRef, Content, Diagnostic — the unified return shape
//! - `parser`: winnow-based grammar parser
//! - `renderer`: AST → canonical text (round-trip)

pub mod ast;
pub mod dialect;
pub mod dialects;
pub mod parser;
pub mod renderer;
pub mod resolver;
pub mod types;

pub use ast::*;
pub use dialect::*;
pub use parser::{parse_code_path, parse_locator};
pub use renderer::render_code_path;
pub use resolver::traits::MutationResolver;
pub use types::*;
