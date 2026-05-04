use std::collections::BTreeMap;

use pi_code_path::resolver::{CancellationToken, FormatExtractor};
use pi_code_path::types::{Diagnostic, DiagnosticVariant};

pub struct JsonExtractor;

impl JsonExtractor {
    pub fn new() -> Self {
        JsonExtractor
    }
}

impl Default for JsonExtractor {
    fn default() -> Self {
        Self::new()
    }
}

impl FormatExtractor for JsonExtractor {
    fn extracts(&self, ext: &str) -> bool {
        ext.eq_ignore_ascii_case("json")
    }

    fn extract(&self, bytes: &[u8], _cancel: &CancellationToken) -> Result<String, Diagnostic> {
        let value = serde_json::from_slice::<serde_json::Value>(bytes).map_err(|e| Diagnostic {
            variant: DiagnosticVariant::ParseError,
            message: format!("json parse error: {e}"),
            span: None,
        })?;
        let sorted = sort_value(value);
        serde_json::to_string_pretty(&sorted).map_err(|e| Diagnostic {
            variant: DiagnosticVariant::ParseError,
            message: format!("json serialization error: {e}"),
            span: None,
        })
    }
}

fn sort_value(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let sorted: BTreeMap<String, serde_json::Value> = map
                .into_iter()
                .map(|(k, v)| (k, sort_value(v)))
                .collect();
            serde_json::Value::Object(sorted.into_iter().collect())
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(sort_value).collect())
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(input: &str) -> Result<String, Diagnostic> {
        JsonExtractor.extract(input.as_bytes(), &CancellationToken::new())
    }

    #[test]
    fn simple_object_sorted_keys() {
        let out = extract(r#"{"z":1,"a":2}"#).unwrap();
        assert!(out.contains("\"a\": 2"));
        assert!(out.contains("\"z\": 1"));
        assert!(out.find("\"a\"").unwrap() < out.find("\"z\"").unwrap());
    }

    #[test]
    fn nested_object_sorted() {
        let out = extract(r#"{"outer":{"b":1,"a":2}}"#).unwrap();
        let lines: Vec<_> = out.lines().collect();
        let a_idx = lines.iter().position(|l| l.contains("\"a\"")).unwrap();
        let b_idx = lines.iter().position(|l| l.contains("\"b\"")).unwrap();
        assert!(a_idx < b_idx);
    }

    #[test]
    fn array_preserved() {
        let out = extract(r#"[3,1,2]"#).unwrap();
        assert_eq!(out, "[\n  3,\n  1,\n  2\n]");
    }

    #[test]
    fn empty_object() {
        let out = extract("{}").unwrap();
        assert_eq!(out, "{}");
    }

    #[test]
    fn deeply_nested() {
        let input = r#"{"a":{"b":{"c":{"d":1}}}}"#;
        let out = extract(input).unwrap();
        assert!(out.contains("\"d\": 1"));
    }

    #[test]
    fn unicode_keys() {
        let out = extract(r#"{"日本語":"hello","αβγ":"world"}"#).unwrap();
        assert!(out.contains("日本語"));
        assert!(out.contains("αβγ"));
    }

    #[test]
    fn malformed_json_emits_diagnostic() {
        let err = extract("{not json}").unwrap_err();
        assert!(matches!(err.variant, DiagnosticVariant::ParseError));
        assert!(err.message.contains("json parse error"));
    }
}
