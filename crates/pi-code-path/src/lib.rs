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
pub mod op_schema;
pub mod introspection;
pub mod op;
pub mod parser;
pub mod renderer;
pub mod resolver;
pub mod diagnostic_render;
pub mod scheme;
pub mod scheme_cache;
pub mod scheme_dispatch;
pub mod types;

pub use ast::*;
pub use dialect::*;
pub use op::{
	CssTarget, FileTarget, HeadingTarget, Identifier, LineAnchor, LineAt, LineSpan, Op, OpKind,
	SymScope, SymbolTarget,
};
pub use parser::{parse_code_path, parse_locator};
pub use renderer::render_code_path;
pub use resolver::traits::MutationResolver;
pub use introspection::*;
pub use op_schema::{FieldSchema, FieldType, OpSchema, TargetFamily};
pub use scheme_cache::SchemeCache;
pub use scheme_dispatch::{validate_scheme_name, SchemeRegistry, RESERVED_SCHEMES};
pub use scheme::{
	CacheKey, CacheStrategy, ContentLoader, FragmentEntry, IndexLookup, LayoutMatch, PathLayout,
	ReadMode, ResolvedAddress, ResolvedContent, RootTemplate, SchemeCallback, SchemeCapabilities,
	SchemeProfile, SessionContext, SynthReducer, SynthSpec,
};
pub use types::*;
