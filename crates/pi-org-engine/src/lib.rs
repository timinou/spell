//! Native org-mode engine using tree-sitter for parsing.
//!
//! Provides:
//! - `OrgBuffer`: parse org files, extract items with
//!   properties/body/clock/effort
//! - `query`: filter/sort/paginate org items (replaces org-ql)
//! - `graph`: dependency graph, cycle detection, wave computation (replaces
//!   elisp graph tools)
//! - `markdown`: org-to-markdown conversion (replaces uniorg pipeline)
//! - `section`: byte-range-based section editing

pub mod buffer;
pub mod clock;
pub mod diff;
pub mod edge;
pub mod edit;
pub mod effort;
pub mod graph;
pub mod item;
pub mod locate;
pub mod markdown;
pub mod query;
pub mod section;
pub mod timestamp;

pub use buffer::{OrgBuffer, extract_items_from_buffer, extract_items_from_source};
pub use edit::*;
pub use item::OrgItem;
pub use locate::*;
