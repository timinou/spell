//! Org-to-Markdown conversion — replaces uniorg pipeline.
//!
//! Converts org-mode text to CommonMark markdown.
//! Handles headings, emphasis, links, lists, code blocks, tables.

/// Convert org-mode text to Markdown.
pub fn org_to_markdown(org: &str) -> String {
	let mut output = String::with_capacity(org.len());
	let mut in_src_block = false;

	for line in org.lines() {
		let trimmed = line.trim();

		// Source blocks
		if let Some(rest) = trimmed
			.strip_prefix("#+BEGIN_SRC")
			.or_else(|| trimmed.strip_prefix("#+begin_src"))
		{
			in_src_block = true;
			let src_lang = rest.trim();
			output.push_str(&format!("```{src_lang}\n"));
			continue;
		}
		if trimmed.eq_ignore_ascii_case("#+END_SRC") {
			in_src_block = false;
			output.push_str("```\n");
			continue;
		}
		if in_src_block {
			output.push_str(line);
			output.push('\n');
			continue;
		}

		// Example blocks
		if trimmed.eq_ignore_ascii_case("#+BEGIN_EXAMPLE") {
			output.push_str("```\n");
			continue;
		}
		if trimmed.eq_ignore_ascii_case("#+END_EXAMPLE") {
			output.push_str("```\n");
			continue;
		}

		// Quote blocks
		if trimmed.eq_ignore_ascii_case("#+BEGIN_QUOTE") {
			// Quotes will be prefixed per-line in the body
			continue;
		}
		if trimmed.eq_ignore_ascii_case("#+END_QUOTE") {
			continue;
		}

		// Skip keywords/frontmatter
		if trimmed.starts_with("#+") && !trimmed.starts_with("#+CAPTION") {
			continue;
		}

		// Property drawers
		if trimmed == ":PROPERTIES:" || trimmed == ":END:" {
			continue;
		}
		if trimmed.starts_with(':') && trimmed.contains(':') && trimmed.len() > 1 {
			// Property line like `:CUSTOM_ID: value` — skip
			let inner = &trimmed[1..];
			if let Some(colon_pos) = inner.find(':') {
				let key = &inner[..colon_pos];
				if key.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
					continue;
				}
			}
		}

		// Headings: * → #
		if let Some(level_and_rest) = parse_org_heading(trimmed) {
			let (level, text) = level_and_rest;
			let hashes = "#".repeat(level);
			output.push_str(&format!("{hashes} {}\n", convert_inline(text)));
			continue;
		}

		// Horizontal rules
		if trimmed == "-----" || trimmed.starts_with("-----") {
			output.push_str("---\n");
			continue;
		}

		// List items: - and + stay as-is, numbered lists stay as-is
		// Convert org inline markup
		output.push_str(&convert_inline(line));
		output.push('\n');
	}

	output
}

/// Convert org-mode text to plain text (strip all markup).
pub fn org_to_plain_text(org: &str) -> String {
	let mut output = String::with_capacity(org.len());

	for line in org.lines() {
		let trimmed = line.trim();

		// Skip metadata
		if trimmed.starts_with("#+") || trimmed == ":PROPERTIES:" || trimmed == ":END:" {
			continue;
		}
		if trimmed.starts_with(':') && trimmed.contains(':') {
			let inner = &trimmed[1..];
			if let Some(colon_pos) = inner.find(':') {
				let key = &inner[..colon_pos];
				if key.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
					continue;
				}
			}
		}

		// Strip heading stars
		if let Some((_, text)) = parse_org_heading(trimmed) {
			output.push_str(text);
			output.push('\n');
			continue;
		}

		output.push_str(trimmed);
		output.push('\n');
	}

	output
}

/// Parse an org heading line, returning (level, rest_of_line).
fn parse_org_heading(line: &str) -> Option<(usize, &str)> {
	if !line.starts_with('*') {
		return None;
	}
	let level = line.chars().take_while(|c| *c == '*').count();
	if line.len() > level && line.as_bytes()[level] == b' ' {
		Some((level, line[level + 1..].trim()))
	} else {
		None
	}
}

/// Convert org inline markup to markdown.
///
/// - `*bold*` → `**bold**`
/// - `/italic/` → `*italic*`
/// - `~code~` → `` `code` ``
/// - `=verbatim=` → `` `verbatim` ``
/// - `_underline_` → `_underline_` (markdown has no underline, keep as-is)
/// - `+strikethrough+` → `~~strikethrough~~`
/// - `[[url][desc]]` → `[desc](url)`
/// - `[[url]]` → `<url>`
fn convert_inline(text: &str) -> String {
	let mut result = String::with_capacity(text.len());
	let chars: Vec<char> = text.chars().collect();
	let len = chars.len();
	let mut i = 0;

	while i < len {
		// Org links: [[url][desc]] or [[url]]
		if chars[i] == '[' && i + 1 < len && chars[i + 1] == '[' {
			if let Some((link_end, url, desc)) = parse_org_link(&chars, i) {
				if let Some(desc) = desc {
					result.push_str(&format!("[{desc}]({url})"));
				} else {
					result.push_str(&format!("<{url}>"));
				}
				i = link_end;
				continue;
			}
		}

		// Inline markup: must be preceded by whitespace/BOL and followed by
		// whitespace/punctuation/EOL
		if is_markup_char(chars[i]) && is_pre_markup(i, &chars) {
			let marker = chars[i];
			if let Some(end) = find_closing_markup(&chars, i + 1, marker) {
				if is_post_markup(end, &chars) {
					let content: String = chars[i + 1..end].iter().collect();
					match marker {
						'*' => result.push_str(&format!("**{content}**")),
						'/' => result.push_str(&format!("*{content}*")),
						'~' | '=' => result.push_str(&format!("`{content}`")),
						'+' => result.push_str(&format!("~~{content}~~")),
						_ => {
							result.push(marker);
							result.push_str(&content);
							result.push(marker);
						},
					}
					i = end + 1;
					continue;
				}
			}
		}

		result.push(chars[i]);
		i += 1;
	}

	result
}

fn is_markup_char(c: char) -> bool {
	matches!(c, '*' | '/' | '~' | '=' | '_' | '+')
}

fn is_pre_markup(pos: usize, chars: &[char]) -> bool {
	pos == 0
		|| chars[pos - 1].is_whitespace()
		|| matches!(chars[pos - 1], '(' | '{' | '"' | '\'' | '-')
}

fn is_post_markup(pos: usize, chars: &[char]) -> bool {
	pos + 1 >= chars.len()
		|| chars[pos + 1].is_whitespace()
		|| matches!(chars[pos + 1], ')' | '}' | '"' | '\'' | '.' | ',' | ';' | ':' | '!' | '?' | '-')
}

fn find_closing_markup(chars: &[char], start: usize, marker: char) -> Option<usize> {
	for i in start..chars.len() {
		if chars[i] == marker && chars[i - 1] != '\\' {
			return Some(i);
		}
		if chars[i] == '\n' {
			return None; // No multi-line inline markup
		}
	}
	None
}

fn parse_org_link(chars: &[char], start: usize) -> Option<(usize, String, Option<String>)> {
	// [[url][desc]] or [[url]]
	// start is at first [
	let mut i = start + 2; // skip [[
	let mut url = String::new();

	// Read URL until ] or ][
	while i < chars.len() {
		if chars[i] == ']' {
			if i + 1 < chars.len() && chars[i + 1] == '[' {
				// Has description
				i += 2; // skip ][
				let mut desc = String::new();
				while i < chars.len() {
					if chars[i] == ']' && i + 1 < chars.len() && chars[i + 1] == ']' {
						return Some((i + 2, url, Some(desc)));
					}
					desc.push(chars[i]);
					i += 1;
				}
				return None;
			} else if i + 1 < chars.len() && chars[i + 1] == ']' {
				// No description
				return Some((i + 2, url, None));
			}
		}
		url.push(chars[i]);
		i += 1;
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn heading_conversion() {
		let result = org_to_markdown("* Heading 1\n** Heading 2\n");
		assert!(result.contains("# Heading 1"));
		assert!(result.contains("## Heading 2"));
	}

	#[test]
	fn bold_italic() {
		let result = convert_inline("This is *bold* and /italic/ text.");
		assert!(result.contains("**bold**"));
		assert!(result.contains("*italic*"));
	}

	#[test]
	fn code_inline() {
		let result = convert_inline("Use ~code~ or =verbatim= here.");
		assert!(result.contains("`code`"));
		assert!(result.contains("`verbatim`"));
	}

	#[test]
	fn org_link_with_desc() {
		let result = convert_inline("See [[https://example.com][Example]].");
		assert!(result.contains("[Example](https://example.com)"));
	}

	#[test]
	fn org_link_no_desc() {
		let result = convert_inline("See [[https://example.com]].");
		assert!(result.contains("<https://example.com>"));
	}

	#[test]
	fn src_block() {
		let src = "#+BEGIN_SRC rust\nfn main() {}\n#+END_SRC\n";
		let result = org_to_markdown(src);
		assert!(result.contains("```rust"));
		assert!(result.contains("fn main() {}"));
		assert!(result.contains("```\n"));
	}

	#[test]
	fn skip_frontmatter() {
		let src = "#+TITLE: Test\n#+CUSTOM_ID: T-1\n\nBody text.\n";
		let result = org_to_markdown(src);
		assert!(!result.contains("#+TITLE"));
		assert!(result.contains("Body text."));
	}
}
