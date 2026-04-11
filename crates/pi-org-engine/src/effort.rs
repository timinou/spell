//! Effort property parsing and normalization.
//!
//! Org effort values can be `2h`, `30m`, `1h30m`, `1:30`, `2d`, etc.
//! We normalize everything to minutes for comparison.

use serde::Serialize;

/// Parsed effort value in minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Effort(pub u32);

impl Effort {
	/// Parse an effort string into minutes.
	///
	/// Supported formats:
	/// - `2h` → 120
	/// - `30m` → 30
	/// - `1h30m` → 90
	/// - `1:30` → 90
	/// - `2d` → 960 (8h workday)
	/// - `90` → 90 (bare number = minutes)
	pub fn parse(text: &str) -> Option<Self> {
		let text = text.trim();
		if text.is_empty() {
			return None;
		}

		// HH:MM format
		if let Some(colon_pos) = text.find(':') {
			let hours = text[..colon_pos].parse::<u32>().ok()?;
			let minutes = text[colon_pos + 1..].parse::<u32>().ok()?;
			return Some(Self(hours * 60 + minutes));
		}

		// Mixed format: 1h30m, 2h, 30m, 2d
		let mut total = 0u32;
		let mut num_buf = String::new();
		for ch in text.chars() {
			if ch.is_ascii_digit() {
				num_buf.push(ch);
			} else {
				let n = num_buf.parse::<u32>().ok()?;
				num_buf.clear();
				match ch {
					'd' | 'D' => total += n * 8 * 60, // 8h workday
					'h' | 'H' => total += n * 60,
					'm' | 'M' => total += n,
					_ => return None,
				}
			}
		}

		// Trailing bare number
		if !num_buf.is_empty() {
			let n = num_buf.parse::<u32>().ok()?;
			if total == 0 {
				// Bare number = minutes
				total = n;
			} else {
				// Trailing digits after units — treat as minutes
				total += n;
			}
		}

		if total == 0 {
			return None;
		}

		Some(Self(total))
	}

	/// Format effort as human-readable string.
	pub fn display(&self) -> String {
		let mins = self.0;
		if mins >= 60 {
			let h = mins / 60;
			let m = mins % 60;
			if m > 0 {
				format!("{h}h{m}m")
			} else {
				format!("{h}h")
			}
		} else {
			format!("{mins}m")
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_hours() {
		assert_eq!(Effort::parse("2h"), Some(Effort(120)));
	}

	#[test]
	fn parse_minutes() {
		assert_eq!(Effort::parse("30m"), Some(Effort(30)));
	}

	#[test]
	fn parse_mixed() {
		assert_eq!(Effort::parse("1h30m"), Some(Effort(90)));
	}

	#[test]
	fn parse_colon() {
		assert_eq!(Effort::parse("1:30"), Some(Effort(90)));
	}

	#[test]
	fn parse_days() {
		assert_eq!(Effort::parse("2d"), Some(Effort(960)));
	}

	#[test]
	fn parse_bare_number() {
		assert_eq!(Effort::parse("90"), Some(Effort(90)));
	}

	#[test]
	fn display_effort() {
		assert_eq!(Effort(90).display(), "1h30m");
		assert_eq!(Effort(120).display(), "2h");
		assert_eq!(Effort(30).display(), "30m");
	}
}
