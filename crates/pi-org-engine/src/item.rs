//! Org item extraction from parsed tree-sitter AST.
//!
//! An `OrgItem` represents a task heading (with TODO state or CUSTOM_ID) or
//! a file-level item (frontmatter with CUSTOM_ID).

use std::collections::HashMap;

use serde::Serialize;

use crate::clock::ClockEntry;

/// A single org-mode item (heading or file-level).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct OrgItem {
	/// Unique task ID from CUSTOM_ID property.
	pub id:         String,
	/// Heading title (without TODO keyword or tags).
	pub title:      String,
	/// TODO state (e.g. "DOING", "ITEM").
	pub state:      String,
	/// Category this item belongs to.
	pub category:   String,
	/// Org dir this item belongs to.
	pub dir:        String,
	/// Absolute path to the .org file.
	pub file:       String,
	/// 1-indexed line number of the heading.
	pub line:       usize,
	/// Heading level (0 = file-level, 1+ = heading).
	pub level:      usize,
	/// Properties from the PROPERTIES drawer.
	pub properties: HashMap<String, String>,
	/// Body text (populated when requested).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub body:       Option<String>,
	/// CLOCK entries parsed from the body.
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub clocks:     Vec<ClockEntry>,
	/// Byte range of the entire item in the source file (start, end).
	/// Used for section editing.
	pub byte_range: (usize, usize),
	/// Child items (sub-headings that are also items).
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub children:   Vec<OrgItem>,
}

impl OrgItem {
	/// Get a property value.
	pub fn property(&self, key: &str) -> Option<&str> {
		self.properties.get(key).map(String::as_str)
	}

	/// Get the PRIORITY property, normalized (e.g. "#A" → "A").
	pub fn priority(&self) -> Option<&str> {
		self
			.properties
			.get("PRIORITY")
			.map(|p| p.strip_prefix('#').unwrap_or(p.as_str()))
	}

	/// Get the LAYER property.
	pub fn layer(&self) -> Option<&str> {
		self.property("LAYER")
	}

	/// Get the AGENT property.
	pub fn agent(&self) -> Option<&str> {
		self.property("AGENT")
	}

	/// Get the BLOCKERS property as a list of IDs.
	pub fn blockers(&self) -> Vec<&str> {
		self
			.properties
			.get("BLOCKERS")
			.map(|b| {
				b.split(',')
					.map(str::trim)
					.filter(|s| !s.is_empty())
					.collect()
			})
			.unwrap_or_default()
	}

	/// Total clocked minutes for this item.
	pub fn total_clocked_minutes(&self) -> u32 {
		crate::clock::total_clocked_minutes(&self.clocks)
	}
}
