//! Per-dialect NameLexer implementations.
//!
//! Each dialect defines:
//! - A `NamePayload`-shaped representation of its identifier syntax.
//! - A `NameLexer` impl that parses, renders, and matches.
//! - A `LanguageDialect` factory wiring its anchors, qualifiers, and edge
//!   kinds.
//!
//! Per spec README §1, dialects are kernel-pluggable. The 9 code dialects
//! listed in `specs/code-graph/code-path-dialects/` (TS, Rust, Python, Go,
//! Haskell, HTML, CSS, Markdown/Org, Elixir) each get a module here. The 3
//! baseline dialects (FS, Text, URI) are kernel-baked.

pub mod css;
pub mod elixir;
pub mod fs;
pub mod go;
pub mod haskell;
pub mod html;
pub mod mdorg;
pub mod python;
pub mod rust;
pub mod text;
pub mod typescript;

pub use css::{CssName, CssNameLexer, css_dialect};
pub use elixir::{ExName, ExNameLexer, ExSegment, elixir_dialect};
pub use go::{GoName, GoNameLexer, GoSegment, go_dialect};
pub use haskell::{HsName, HsNameLexer, HsSegment, haskell_dialect};
pub use html::{HtmlName, HtmlNameLexer, html_dialect};
pub use mdorg::{MdName, MdNameLexer, MdSegment, markdown_dialect};
pub use python::{PyName, PyNameLexer, PySegment, python_dialect};
pub use rust::{RustName, RustNameLexer, RustSegment, rust_dialect};
pub use typescript::{TsName, TsNameLexer, TsSegment, typescript_dialect};
