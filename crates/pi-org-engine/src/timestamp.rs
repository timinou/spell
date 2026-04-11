//! Org-mode timestamp parsing.
//!
//! Handles active `<2024-01-15 Mon 09:00>` and inactive `[2024-01-15 Mon
//! 09:00]` timestamps, date ranges, and repeaters.

use serde::Serialize;

/// A parsed org-mode timestamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct OrgTimestamp {
	pub year:   u16,
	pub month:  u8,
	pub day:    u8,
	pub hour:   Option<u8>,
	pub minute: Option<u8>,
	pub active: bool,
}

impl OrgTimestamp {
	/// Parse a timestamp from text like `<2024-01-15 Mon 09:00>` or `[2024-01-15
	/// Mon]`.
	pub fn parse(text: &str) -> Option<Self> {
		let text = text.trim();
		let (inner, active) = if text.starts_with('<') && text.ends_with('>') {
			(&text[1..text.len() - 1], true)
		} else if text.starts_with('[') && text.ends_with(']') {
			(&text[1..text.len() - 1], false)
		} else {
			return None;
		};

		let parts: Vec<&str> = inner.split_whitespace().collect();
		if parts.is_empty() {
			return None;
		}

		let date_parts: Vec<&str> = parts[0].split('-').collect();
		if date_parts.len() != 3 {
			return None;
		}

		let year = date_parts[0].parse::<u16>().ok()?;
		let month = date_parts[1].parse::<u8>().ok()?;
		let day = date_parts[2].parse::<u8>().ok()?;

		// Time is optional, may be in parts[1] (if no day name) or parts[2]
		let mut hour = None;
		let mut minute = None;
		for part in &parts[1..] {
			if let Some((h, m)) = parse_time(part) {
				hour = Some(h);
				minute = Some(m);
				break;
			}
		}

		Some(Self { year, month, day, hour, minute, active })
	}

	/// Convert to days since epoch (2000-01-01) for comparison.
	/// Approximate — ignores leap seconds, just needs ordering.
	pub fn to_day_ordinal(&self) -> i32 {
		let y = i32::from(self.year);
		let m = i32::from(self.month);
		let d = i32::from(self.day);
		// Rata Die calculation (sufficient for ordering)
		let a = (14 - m) / 12;
		let y2 = y - a;
		let m2 = m + 12 * a - 3;
		d + (153 * m2 + 2) / 5 + 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 - 306
	}

	/// Convert to minutes since midnight for time comparison.
	pub fn to_minutes(&self) -> Option<u16> {
		Some(u16::from(self.hour?) * 60 + u16::from(self.minute?))
	}
}

impl PartialOrd for OrgTimestamp {
	fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for OrgTimestamp {
	fn cmp(&self, other: &Self) -> std::cmp::Ordering {
		self
			.to_day_ordinal()
			.cmp(&other.to_day_ordinal())
			.then_with(|| self.to_minutes().cmp(&other.to_minutes()))
	}
}

fn parse_time(s: &str) -> Option<(u8, u8)> {
	let parts: Vec<&str> = s.split(':').collect();
	if parts.len() == 2 {
		let h = parts[0].parse::<u8>().ok()?;
		let m = parts[1].parse::<u8>().ok()?;
		if h < 24 && m < 60 {
			return Some((h, m));
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_active_timestamp() {
		let ts = OrgTimestamp::parse("<2024-01-15 Mon 09:30>").unwrap();
		assert_eq!(ts.year, 2024);
		assert_eq!(ts.month, 1);
		assert_eq!(ts.day, 15);
		assert_eq!(ts.hour, Some(9));
		assert_eq!(ts.minute, Some(30));
		assert!(ts.active);
	}

	#[test]
	fn parse_inactive_date_only() {
		let ts = OrgTimestamp::parse("[2024-03-20 Wed]").unwrap();
		assert_eq!(ts.year, 2024);
		assert_eq!(ts.month, 3);
		assert_eq!(ts.day, 20);
		assert_eq!(ts.hour, None);
		assert!(!ts.active);
	}

	#[test]
	fn ordering() {
		let a = OrgTimestamp::parse("[2024-01-15 Mon 09:00]").unwrap();
		let b = OrgTimestamp::parse("[2024-01-15 Mon 11:00]").unwrap();
		let c = OrgTimestamp::parse("[2024-02-01 Thu]").unwrap();
		assert!(a < b);
		assert!(b < c);
	}
}
