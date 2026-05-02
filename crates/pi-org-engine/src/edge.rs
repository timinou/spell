//! Typed edge kinds for the org graph memory model.
//!
//! Edges are written into a dedicated `:RELATIONS:` drawer next to
//! `:PROPERTIES:`, with one `KIND: target-id` line per edge. Kinds are
//! canonical uppercase tokens; unknown tokens become `EdgeKind::Other(String)`
//! so the parser is forward-compatible.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable identifier for an org item across files. Currently a plain
/// `CUSTOM_ID` string; later may become an interned id.
pub type ItemId = String;

/// Typed edge kind in the org graph.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EdgeKind {
	Involved,
	About,
	Produced,
	DistilledFrom,
	Mentions,
	Supersedes,
	DerivedFrom,
	Blocks,
	Action,
	Other(String),
}

impl EdgeKind {
	/// Canonical uppercase token for the kind.
	#[must_use]
	pub fn token(&self) -> String {
		match self {
			Self::Involved => "INVOLVED".into(),
			Self::About => "ABOUT".into(),
			Self::Produced => "PRODUCED".into(),
			Self::DistilledFrom => "DISTILLED_FROM".into(),
			Self::Mentions => "MENTIONS".into(),
			Self::Supersedes => "SUPERSEDES".into(),
			Self::DerivedFrom => "DERIVED_FROM".into(),
			Self::Blocks => "BLOCKS".into(),
			Self::Action => "ACTION".into(),
			Self::Other(s) => s.clone(),
		}
	}

	/// Parse a kind token. Unknown tokens become `Other(uppercase)`.
	#[must_use]
	pub fn parse(s: &str) -> Self {
		let upper = s.trim().to_ascii_uppercase();
		match upper.as_str() {
			"INVOLVED" => Self::Involved,
			"ABOUT" => Self::About,
			"PRODUCED" => Self::Produced,
			"DISTILLED_FROM" => Self::DistilledFrom,
			"MENTIONS" => Self::Mentions,
			"SUPERSEDES" => Self::Supersedes,
			"DERIVED_FROM" => Self::DerivedFrom,
			"BLOCKS" => Self::Blocks,
			"ACTION" => Self::Action,
			_ => Self::Other(upper),
		}
	}

	/// True for kinds defined by the v1 model. `Other` returns false.
	#[must_use]
	pub const fn is_known(&self) -> bool {
		!matches!(self, Self::Other(_))
	}
}

impl fmt::Display for EdgeKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.token())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_known_tokens() {
		assert_eq!(EdgeKind::parse("INVOLVED"), EdgeKind::Involved);
		assert_eq!(EdgeKind::parse("involved"), EdgeKind::Involved);
		assert_eq!(EdgeKind::parse(" ABOUT "), EdgeKind::About);
		assert_eq!(EdgeKind::parse("DISTILLED_FROM"), EdgeKind::DistilledFrom);
	}

	#[test]
	fn parse_unknown_kind() {
		match EdgeKind::parse("foo_bar") {
			EdgeKind::Other(s) => assert_eq!(s, "FOO_BAR"),
			other => panic!("expected Other, got {other:?}"),
		}
	}

	#[test]
	fn token_round_trip() {
		for k in [
			EdgeKind::Involved,
			EdgeKind::About,
			EdgeKind::Produced,
			EdgeKind::DistilledFrom,
			EdgeKind::Mentions,
			EdgeKind::Supersedes,
			EdgeKind::DerivedFrom,
			EdgeKind::Blocks,
			EdgeKind::Action,
		] {
			assert_eq!(EdgeKind::parse(&k.token()), k);
		}
	}
}
