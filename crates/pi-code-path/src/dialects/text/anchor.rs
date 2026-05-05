//! Line anchor IDs.
//!
//! FEAT-705. Each line emitted by the text dialect carries a 2-character
//! base32 anchor ID derived from the line content. Agents can copy the
//! `LINE#ID` prefix and pass it back as `pos:"<line>#<id>"` on edit
//! actions; the resolver re-validates the hash before applying, so an
//! edit refers to a *content-stable* line rather than a brittle line
//! number that may have drifted.

/// Compute the 2-char base32 anchor ID for `line_text`.
///
/// Strategy:
/// 1. Run a stable inline FNV-1a 32-bit hash over the bytes.
/// 2. Take the low 10 bits (1024 buckets).
/// 3. Encode the 10-bit number using a 32-symbol Crockford-ish alphabet
///    that omits visually ambiguous characters (`I`, `L`, `O`, `0`, `1`).
///
/// FNV-1a is fast, dependency-free, and deterministic across builds.
/// Two characters give 1024 distinct anchors per file — collisions are
/// possible but harmless: a stale anchor simply triggers `AnchorMismatch`
/// and the agent re-reads the line.
pub fn line_anchor_id(line_text: &str) -> String {
	const FNV_OFFSET: u32 = 0x811c_9dc5;
	const FNV_PRIME: u32 = 0x0100_0193;
	let mut hash = FNV_OFFSET;
	for &b in line_text.as_bytes() {
		hash ^= u32::from(b);
		hash = hash.wrapping_mul(FNV_PRIME);
	}
	let bits10 = (hash & 0x3FF) as usize; // 10 low bits
	const ALPHABET: &[u8; 32] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789!";
	// 32 symbols (the trailing `!` is unreachable; we only emit two chars
	// from a 1024-element space, encoded big-endian: hi 5 bits + lo 5 bits).
	let hi = (bits10 >> 5) & 0x1F;
	let lo = bits10 & 0x1F;
	let bytes = [ALPHABET[hi], ALPHABET[lo]];
	// All 32 entries except trailing `!` are valid; mask `!` to `Z` as
	// a defensive fallback (currently unreachable since hi/lo < 32).
	let safe = |c: u8| if c == b'!' { b'Z' } else { c };
	String::from_utf8_lossy(&[safe(bytes[0]), safe(bytes[1])]).into_owned()
}

/// Validate that `expected_id` matches the anchor ID for `line_text`.
/// Returns `None` when matching, or `Some(actual_id)` when drifted.
pub fn anchor_drift(line_text: &str, expected_id: &str) -> Option<String> {
	let actual = line_anchor_id(line_text);
	if actual == expected_id { None } else { Some(actual) }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn anchor_id_deterministic() {
		assert_eq!(line_anchor_id("hello world"), line_anchor_id("hello world"));
		assert_eq!(line_anchor_id(""), line_anchor_id(""));
	}

	#[test]
	fn anchor_id_differs_for_different_text() {
		let a = line_anchor_id("hello");
		let b = line_anchor_id("world");
		assert_ne!(a, b, "distinct text should hash differently (collision possible but unlikely)");
	}

	#[test]
	fn anchor_id_is_2_chars_base32() {
		let id = line_anchor_id("any line of text 12345");
		assert_eq!(id.len(), 2);
		for c in id.chars() {
			assert!(
				matches!(c, 'A'..='H' | 'J' | 'K' | 'M' | 'N' | 'P'..='Z' | '2'..='9'),
				"char {c} outside base32 alphabet"
			);
			assert!(!matches!(c, 'I' | 'L' | 'O'), "ambiguous char {c} in alphabet");
		}
	}

	#[test]
	fn anchor_drift_detects_change() {
		let id = line_anchor_id("first version");
		assert!(anchor_drift("first version", &id).is_none());
		assert!(anchor_drift("second version", &id).is_some());
	}

	#[test]
	fn anchor_id_includes_whitespace() {
		// Trailing whitespace counts toward the hash.
		assert_ne!(line_anchor_id("foo"), line_anchor_id("foo "));
	}
}
