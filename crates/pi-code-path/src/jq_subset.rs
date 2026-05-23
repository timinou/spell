//! Minimal jq subset used by the `#json:` codepath qualifier.
//!
//! Supports field access (`.foo`, `.foo.bar`), index access (`[0]`,
//! `[42]`), and quoted-string keys (`["weird key"]`). Anything else
//! (filters, pipes, recursive descent) is out of scope — use real jq
//! externally if needed.
//!
//! Mirrors `packages/coding-agent/src/internal-urls/json-query.ts` so the
//! cutover from TS handler → kernel qualifier is byte-equivalent for the
//! supported subset.

use serde_json::Value;

/// One step in a jq path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
	/// `.foo` — object field by name.
	Field(String),
	/// `[N]` — array index by zero-based position.
	Index(usize),
}

/// Parse a jq subset expression into a sequence of steps. Returns an empty
/// vec for the empty expression (identity).
///
/// Grammar:
///   expr  := step*
///   step  := '.' ident
///          | '[' inner ']'
///   inner := digits | "'" str "'" | '"' str '"' | ident
pub fn parse(expr: &str) -> Result<Vec<Step>, String> {
	let trimmed = expr.trim();
	if trimmed.is_empty() {
		return Ok(Vec::new());
	}
	let mut input = trimmed;
	if let Some(rest) = input.strip_prefix('.') {
		input = rest;
	}
	if input.is_empty() {
		return Ok(Vec::new());
	}

	let mut steps = Vec::new();
	let bytes = input.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		let c = bytes[i] as char;
		if c == '.' {
			i += 1;
			continue;
		}
		if c == '[' {
			// find matching ]
			let mut j = i + 1;
			while j < bytes.len() && bytes[j] != b']' {
				j += 1;
			}
			if j == bytes.len() {
				return Err(format!("missing ']' in {expr}"));
			}
			let raw = input[i + 1..j].trim();
			if raw.is_empty() {
				return Err(format!("empty [] in {expr}"));
			}
			let first = raw.as_bytes()[0];
			if first == b'"' || first == b'\'' {
				let quote = first as char;
				if !raw.ends_with(quote) {
					return Err(format!("unterminated quoted key in {expr}"));
				}
				let inner = &raw[1..raw.len() - 1];
				let unesc = inner.replace("\\\"", "\"").replace("\\'", "'").replace("\\\\", "\\");
				steps.push(Step::Field(unesc));
			} else if raw.bytes().all(|b| b.is_ascii_digit()) {
				let n: usize = raw.parse().map_err(|e| format!("bad index in {expr}: {e}"))?;
				steps.push(Step::Index(n));
			} else {
				// bare identifier — treat as field
				steps.push(Step::Field(raw.to_string()));
			}
			i = j + 1;
			continue;
		}
		// identifier-like field name (alphanumeric/underscore/hyphen)
		let mut j = i;
		while j < bytes.len() {
			let cc = bytes[j] as char;
			if cc.is_ascii_alphanumeric() || cc == '_' || cc == '-' {
				j += 1;
			} else {
				break;
			}
		}
		if j == i {
			return Err(format!("unexpected '{c}' in {expr}"));
		}
		steps.push(Step::Field(input[i..j].to_string()));
		i = j;
	}
	Ok(steps)
}

/// Apply a parsed jq subset to a JSON value. Returns Null on a missing
/// field or out-of-bounds index (matching jq behavior).
pub fn apply(mut value: Value, steps: &[Step]) -> Value {
	for step in steps {
		value = match (step, value) {
			(Step::Field(name), Value::Object(mut map)) => map.remove(name).unwrap_or(Value::Null),
			(Step::Field(_), _) => Value::Null,
			(Step::Index(n), Value::Array(mut arr)) => {
				if *n < arr.len() {
					arr.swap_remove(*n)
				} else {
					Value::Null
				}
			},
			(Step::Index(_), _) => Value::Null,
		};
	}
	value
}

/// Convenience: parse expression + apply to a JSON string. Returns Err for
/// invalid JSON or invalid expression.
pub fn eval(json_text: &str, expr: &str) -> Result<Value, String> {
	let steps = parse(expr)?;
	let v: Value = serde_json::from_str(json_text).map_err(|e| format!("invalid JSON: {e}"))?;
	Ok(apply(v, &steps))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_empty() {
		assert_eq!(parse("").unwrap(), Vec::<Step>::new());
		assert_eq!(parse(".").unwrap(), Vec::<Step>::new());
	}

	#[test]
	fn parse_dotted_fields() {
		assert_eq!(
			parse(".foo.bar").unwrap(),
			vec![Step::Field("foo".into()), Step::Field("bar".into())]
		);
	}

	#[test]
	fn parse_array_index() {
		assert_eq!(parse(".foo[0]").unwrap(), vec![Step::Field("foo".into()), Step::Index(0)]);
	}

	#[test]
	fn parse_quoted_key() {
		assert_eq!(
			parse(".foo[\"weird key\"]").unwrap(),
			vec![Step::Field("foo".into()), Step::Field("weird key".into())]
		);
	}

	#[test]
	fn apply_field() {
		let json = r#"{"a": {"b": 1}}"#;
		let v = eval(json, ".a.b").unwrap();
		assert_eq!(v, serde_json::json!(1));
	}

	#[test]
	fn apply_index() {
		let json = r#"{"foo": ["bar", "baz"]}"#;
		let v = eval(json, ".foo[1]").unwrap();
		assert_eq!(v, serde_json::json!("baz"));
	}

	#[test]
	fn apply_missing_field_returns_null() {
		let json = r#"{"a": 1}"#;
		let v = eval(json, ".missing").unwrap();
		assert_eq!(v, Value::Null);
	}

	#[test]
	fn apply_oob_index_returns_null() {
		let json = r#"[1, 2]"#;
		let v = eval(json, "[42]").unwrap();
		assert_eq!(v, Value::Null);
	}

	#[test]
	fn apply_field_on_non_object_returns_null() {
		let json = r#"[1, 2]"#;
		let v = eval(json, ".foo").unwrap();
		assert_eq!(v, Value::Null);
	}

	#[test]
	fn bad_json_errors() {
		assert!(eval("not json", ".foo").is_err());
	}

	#[test]
	fn unterminated_bracket_errors() {
		assert!(parse(".foo[0").is_err());
	}

	#[test]
	fn empty_bracket_errors() {
		assert!(parse(".foo[]").is_err());
	}
}
