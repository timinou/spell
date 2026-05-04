use pi_code_path::{
	resolver::{CancellationToken, FormatExtractor},
	types::{Diagnostic, DiagnosticVariant},
};

pub struct HtmlReadableExtractor;

impl HtmlReadableExtractor {
	pub fn new() -> Self {
		HtmlReadableExtractor
	}
}

impl Default for HtmlReadableExtractor {
	fn default() -> Self {
		Self::new()
	}
}

impl FormatExtractor for HtmlReadableExtractor {
	fn extracts(&self, ext: &str) -> bool {
		ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm")
	}

	fn extract(&self, bytes: &[u8], _cancel: &CancellationToken) -> Result<String, Diagnostic> {
		let html_str = std::str::from_utf8(bytes).map_err(|e| Diagnostic {
			variant: DiagnosticVariant::ParseError,
			message: format!("html decode error: {e}"),
			span:    None,
		})?;
		let document = scraper::Html::parse_document(html_str);

		// Try main, then article, then body
		let selector = ["main", "article", "body"].iter().find_map(|tag| {
			scraper::Selector::parse(tag)
				.ok()
				.filter(|sel| document.select(sel).next().is_some())
		});

		let text = if let Some(sel) = selector {
			document
				.select(&sel)
				.map(|el| extract_text_from_element(&el))
				.collect::<Vec<_>>()
				.join(" ")
		} else {
			// Fallback: all text in document
			extract_text_from_html(&document)
		};

		Ok(collapse_whitespace(&text))
	}
}

fn extract_text_from_element(el: &scraper::element_ref::ElementRef) -> String {
	let blacklist = ["script", "style", "nav", "header", "footer", "aside", "noscript"];
	let mut parts = Vec::new();
	for child in el.children() {
		match child.value() {
			scraper::node::Node::Text(t) => {
				parts.push(t.text.trim().to_string());
			},
			scraper::node::Node::Element(e) => {
				let tag = e.name().to_ascii_lowercase();
				if blacklist.contains(&tag.as_str()) {
					continue;
				}
				if let Some(child_el) = scraper::element_ref::ElementRef::wrap(child) {
					parts.push(extract_text_from_element(&child_el));
				}
			},
			_ => {},
		}
	}
	parts.join(" ")
}

fn extract_text_from_html(html: &scraper::Html) -> String {
	let mut parts = Vec::new();
	for node in html.tree.nodes() {
		if let scraper::node::Node::Text(t) = node.value() {
			parts.push(t.text.trim().to_string());
		}
	}
	parts.join(" ")
}

fn collapse_whitespace(s: &str) -> String {
	let mut result = String::with_capacity(s.len());
	let mut prev_ws = true; // start true to trim leading
	for ch in s.chars() {
		if ch.is_whitespace() {
			if !prev_ws {
				result.push(' ');
				prev_ws = true;
			}
		} else {
			result.push(ch);
			prev_ws = false;
		}
	}
	if result.ends_with(' ') {
		result.pop();
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	fn extract(input: &str) -> Result<String, Diagnostic> {
		HtmlReadableExtractor.extract(input.as_bytes(), &CancellationToken::new())
	}

	#[test]
	fn typical_article_html() {
		let html = r#"<!DOCTYPE html><html><body><article><h1>Title</h1><p>Hello world</p></article></body></html>"#;
		let out = extract(html).unwrap();
		assert!(out.contains("Title"));
		assert!(out.contains("Hello world"));
	}

	#[test]
	fn fallback_to_body_when_no_semantic_tags() {
		let html = r#"<html><body><div>Some content</div></body></html>"#;
		let out = extract(html).unwrap();
		assert!(out.contains("Some content"));
	}

	#[test]
	fn strips_scripts_and_styles() {
		let html = r#"<html><body><script>alert(1)</script><style>.x{color:red}</style><p>Keep me</p></body></html>"#;
		let out = extract(html).unwrap();
		assert!(!out.contains("alert"));
		assert!(!out.contains("color"));
		assert!(out.contains("Keep me"));
	}

	#[test]
	fn edge_case_empty_body() {
		let html = r#"<html><body></body></html>"#;
		let out = extract(html).unwrap();
		assert_eq!(out, "");
	}

	#[test]
	fn malformed_html_no_panic() {
		let html = r#"<html><body><p>Unclosed"#;
		let out = extract(html).unwrap();
		assert!(out.contains("Unclosed"));
	}
}
