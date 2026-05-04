//! Concrete [`FormatExtractor`] implementations for pi-natives.
//!
//! - [`JsonExtractor`] – deterministic pretty-print (sorted keys)
//! - [`HtmlReadableExtractor`] – strip boilerplate, extract article text
//! - [`MarkitdownExtractor`] – shell-out to `markitdown` for office/PDF docs

use std::sync::Arc;

use pi_code_path::resolver::FormatExtractor;

pub mod html;
pub mod json;
pub mod markitdown;

pub use html::HtmlReadableExtractor;
pub use json::JsonExtractor;
pub use markitdown::MarkitdownExtractor;

/// Default extractor chain. Order matters: json and html short-circuit
/// before the heavier markitdown fallback.
pub fn default_extractors() -> Vec<Arc<dyn FormatExtractor>> {
    vec![
        Arc::new(JsonExtractor::new()),
        Arc::new(HtmlReadableExtractor::new()),
        Arc::new(MarkitdownExtractor::new()),
    ]
}
