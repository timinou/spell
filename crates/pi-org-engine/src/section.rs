//! Section editing — find and replace/append to named sections within an org
//! item.
//!
//! Uses byte ranges from the parsed tree to locate sections by heading text,
//! then returns the edit instructions (byte range + new content).

use serde::Serialize;

/// Result of a section edit operation.
#[derive(Debug, Clone, Serialize)]
pub struct SectionEdit {
	/// Byte offset where the edit starts.
	pub start:   usize,
	/// Byte offset where the edit ends (exclusive).
	pub end:     usize,
	/// New content to insert at [start..end].
	pub content: String,
}

/// Find a section by heading name within an org buffer's source text.
///
/// Returns `(heading_line_end, section_body_start, section_body_end)` byte
/// offsets. The section body runs from after the heading line to the next
/// heading at same or higher level (or end of the item's byte range).
pub fn find_section(
	source: &str,
	item_start: usize,
	item_end: usize,
	section_name: &str,
) -> Option<(usize, usize, usize)> {
	let region = &source[item_start..item_end];
	let mut offset = 0usize;
	let mut found_heading_level = 0usize;
	let mut body_start = 0usize;

	for line in region.lines() {
		let line_start = offset;
		let line_end = offset + line.len();

		if let Some(level) = heading_level(line) {
			let heading_text = extract_heading_text(line, level);

			if found_heading_level > 0 {
				// We were inside our section; this heading ends it
				if level <= found_heading_level {
					// Body is [body_start..line_start]
					return Some((
						item_start + body_start,
						item_start + body_start,
						item_start + line_start,
					));
				}
			}

			if heading_text.eq_ignore_ascii_case(section_name) {
				found_heading_level = level;
				body_start = line_end + 1; // +1 for newline
			}
		}

		offset = line_end + 1; // +1 for newline (approx — handles \n)
	}

	// If we found the heading but reached end of region
	if found_heading_level > 0 {
		return Some((item_start + body_start, item_start + body_start, item_end));
	}

	None
}

/// Create a section edit for replacing the body of a named section.
pub fn edit_section_replace(
	source: &str,
	item_start: usize,
	item_end: usize,
	section_name: &str,
	new_body: &str,
) -> Option<SectionEdit> {
	let (_, body_start, body_end) = find_section(source, item_start, item_end, section_name)?;
	Some(SectionEdit { start: body_start, end: body_end, content: format!("{new_body}\n") })
}

/// Create a section edit for appending to the body of a named section.
pub fn edit_section_append(
	source: &str,
	item_start: usize,
	item_end: usize,
	section_name: &str,
	append_text: &str,
) -> Option<SectionEdit> {
	let (_, _, body_end) = find_section(source, item_start, item_end, section_name)?;
	// Insert before the end of the section body
	let insert_pos = body_end;
	// Ensure there's a newline before appending
	let prefix = if insert_pos > 0 && source.as_bytes().get(insert_pos - 1) != Some(&b'\n') {
		"\n"
	} else {
		""
	};
	Some(SectionEdit {
		start:   insert_pos,
		end:     insert_pos,
		content: format!("{prefix}{append_text}\n"),
	})
}

/// Count leading `*` characters to get heading level.
fn heading_level(line: &str) -> Option<usize> {
	let trimmed = line.trim_start();
	if !trimmed.starts_with('*') {
		return None;
	}
	let level = trimmed.chars().take_while(|c| *c == '*').count();
	// Must be followed by a space
	if trimmed.len() > level && trimmed.as_bytes()[level] == b' ' {
		Some(level)
	} else {
		None
	}
}

/// Extract heading text without stars and tags.
fn extract_heading_text(line: &str, level: usize) -> &str {
	let after_stars = line.trim_start()[level..].trim();
	// Remove trailing tags (e.g. `:tag1:tag2:`)
	if let Some(tag_start) = after_stars.rfind("  :") {
		after_stars[..tag_start].trim()
	} else {
		after_stars
	}
}

/// Apply a section edit to a source string, returning the new source.
pub fn apply_edit(source: &str, edit: &SectionEdit) -> String {
	let mut result = String::with_capacity(source.len() + edit.content.len());
	result.push_str(&source[..edit.start]);
	result.push_str(&edit.content);
	result.push_str(&source[edit.end..]);
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn find_section_basic() {
		let src = "* DOING My Task\n:PROPERTIES:\n:CUSTOM_ID: T-1\n:END:\n\n** Context\nSome \
		           context.\n\n** Implementation\nCode here.\n";
		let result = find_section(src, 0, src.len(), "Context");
		assert!(result.is_some());
		let (_, start, end) = result.unwrap();
		let body = &src[start..end];
		assert!(body.contains("Some context."));
	}

	#[test]
	fn edit_section_replace_body() {
		let src = "** Context\nOld content.\n\n** Implementation\nCode.\n";
		let edit = edit_section_replace(src, 0, src.len(), "Context", "New content.").unwrap();
		let new_src = apply_edit(src, &edit);
		assert!(new_src.contains("New content."));
		assert!(!new_src.contains("Old content."));
		assert!(new_src.contains("** Implementation"));
	}

	#[test]
	fn edit_section_append_body() {
		let src = "** Context\nExisting.\n\n** Implementation\nCode.\n";
		let edit = edit_section_append(src, 0, src.len(), "Context", "Appended.").unwrap();
		let new_src = apply_edit(src, &edit);
		assert!(new_src.contains("Existing."));
		assert!(new_src.contains("Appended."));
	}
}
