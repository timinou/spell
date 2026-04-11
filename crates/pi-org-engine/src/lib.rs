// Pedantic clippy lints that don't affect correctness in this crate.
#![allow(
	clippy::doc_markdown,
	clippy::too_many_arguments,
	clippy::if_not_else,
	clippy::format_push_string,
	clippy::trivially_copy_pass_by_ref,
	clippy::redundant_closure_for_method_calls,
	clippy::needless_lifetimes,
	clippy::map_unwrap_or,
	clippy::collapsible_if,
	clippy::unnecessary_self_imports,
	clippy::use_self,
	clippy::missing_const_for_fn,
	clippy::redundant_else,
	clippy::manual_strip,
	clippy::if_same_then_else,
	clippy::redundant_closure,
	reason = "Pedantic lints from workspace config; not correctness-relevant"
)]

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
pub mod effort;
pub mod graph;
pub mod item;
pub mod markdown;
pub mod query;
pub mod section;
pub mod timestamp;

pub use buffer::OrgBuffer;
pub use item::OrgItem;
