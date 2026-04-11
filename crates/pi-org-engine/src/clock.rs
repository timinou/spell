//! CLOCK entry parsing and duration aggregation.
//!
//! Parses `CLOCK: [start]--[end] => HH:MM` lines and aggregates total clocked
//! time.

use serde::Serialize;

use crate::timestamp::OrgTimestamp;

/// A single CLOCK entry with start, end, and duration in minutes.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ClockEntry {
	pub start:            OrgTimestamp,
	pub end:              OrgTimestamp,
	pub duration_minutes: u32,
}

/// Parse a CLOCK line and extract the duration.
///
/// Format: `CLOCK: [2024-01-15 Mon 09:00]--[2024-01-15 Mon 11:00] =>  2:00`
pub fn parse_clock_line(line: &str) -> Option<ClockEntry> {
	let line = line.trim();
	let rest = line.strip_prefix("CLOCK:")?;
	let rest = rest.trim();

	// Find the two timestamps separated by --
	let dash_pos = rest.find("--")?;
	let start_text = rest[..dash_pos].trim();
	let after_dash = &rest[dash_pos + 2..];

	// End timestamp goes up to ` =>` or end of string
	let end_text = if let Some(arrow_pos) = after_dash.find("=>") {
		after_dash[..arrow_pos].trim()
	} else {
		// No explicit duration — end timestamp is everything remaining
		after_dash.trim()
	};

	let start = OrgTimestamp::parse(start_text)?;
	let end = OrgTimestamp::parse(end_text)?;

	// Try to parse explicit duration after =>
	let duration_minutes = if let Some(arrow_pos) = after_dash.find("=>") {
		let dur_text = after_dash[arrow_pos + 2..].trim();
		parse_duration_hhmm(dur_text).unwrap_or_else(|| compute_duration_minutes(&start, &end))
	} else {
		compute_duration_minutes(&start, &end)
	};

	Some(ClockEntry { start, end, duration_minutes })
}

/// Parse a `HH:MM` or `H:MM` duration string to minutes.
pub fn parse_duration_hhmm(text: &str) -> Option<u32> {
	let parts: Vec<&str> = text.trim().split(':').collect();
	if parts.len() != 2 {
		return None;
	}
	let hours = parts[0].trim().parse::<u32>().ok()?;
	let minutes = parts[1].trim().parse::<u32>().ok()?;
	Some(hours * 60 + minutes)
}

/// Compute duration between two timestamps in minutes.
fn compute_duration_minutes(start: &OrgTimestamp, end: &OrgTimestamp) -> u32 {
	let start_mins = start.to_day_ordinal() as i64 * 24 * 60
		+ i64::from(start.hour.unwrap_or(0)) * 60
		+ i64::from(start.minute.unwrap_or(0));
	let end_mins = end.to_day_ordinal() as i64 * 24 * 60
		+ i64::from(end.hour.unwrap_or(0)) * 60
		+ i64::from(end.minute.unwrap_or(0));
	(end_mins - start_mins).max(0) as u32
}

/// Sum total clocked minutes from a slice of clock entries.
pub fn total_clocked_minutes(entries: &[ClockEntry]) -> u32 {
	entries.iter().map(|e| e.duration_minutes).sum()
}

/// Format minutes as `HH:MM`.
pub fn format_duration(minutes: u32) -> String {
	format!("{}:{:02}", minutes / 60, minutes % 60)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_clock_entry() {
		let entry =
			parse_clock_line("CLOCK: [2024-01-15 Mon 09:00]--[2024-01-15 Mon 11:30] =>  2:30")
				.unwrap();
		assert_eq!(entry.duration_minutes, 150);
	}

	#[test]
	fn parse_clock_no_explicit_duration() {
		let entry =
			parse_clock_line("CLOCK: [2024-01-15 Mon 09:00]--[2024-01-15 Mon 10:00]").unwrap();
		assert_eq!(entry.duration_minutes, 60);
	}

	#[test]
	fn total_clocked() {
		let entries = vec![
			parse_clock_line("CLOCK: [2024-01-15 Mon 09:00]--[2024-01-15 Mon 11:00] =>  2:00")
				.unwrap(),
			parse_clock_line("CLOCK: [2024-01-16 Tue 14:00]--[2024-01-16 Tue 15:30] =>  1:30")
				.unwrap(),
		];
		assert_eq!(total_clocked_minutes(&entries), 210);
		assert_eq!(format_duration(210), "3:30");
	}
}
