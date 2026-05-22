//! Negative tests: Deserialize must validate target invariants via Target::new
//! (PLAN-308 P2). Without custom Deserialize impls, serde bypasses ::new and
//! accepts shape-invalid targets that then crash in resolvers.

use pi_code_path::op::*;
use serde_json;

// ── FileTarget ───────────────────────────────────────────────────

#[test]
fn file_target_rejects_uri_locator_via_deserialize() {
	let json = serde_json::json!({
		"kind": "fileWrite",
		"target": {
			"locator": { "Uri": { "scheme": "memory", "path": "root" } },
			"query": null,
			"qualifier": null
		},
		"content": "x"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_err(), "FileTarget should reject URI locator via custom Deserialize");
}

#[test]
fn file_target_rejects_symbol_query_via_deserialize() {
	let json = serde_json::json!({
		"kind": "fileWrite",
		"target": {
			"locator": { "Fs": { "segments": [{ "Literal": "foo.ts" }] } },
			"query": {
				"head": { "axis": null, "head": { "Name": { "Raw": "Foo" } }, "predicates": [] },
				"chain": []
			},
			"qualifier": null
		},
		"content": "x"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_err(), "FileTarget should reject ::Symbol query via custom Deserialize");
}

#[test]
fn file_target_accepts_valid_fs_target_via_deserialize() {
	let json = serde_json::json!({
		"kind": "fileWrite",
		"target": {
			"locator": { "Fs": { "segments": [{ "Literal": "test.rs" }] } },
			"query": null,
			"qualifier": null
		},
		"content": "x"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_ok(), "FileTarget should accept valid FsLocator with no query");
}

// ── SymbolTarget ─────────────────────────────────────────────────

#[test]
fn symbol_target_requires_query_segment_via_deserialize() {
	let json = serde_json::json!({
		"kind": "symbolReplace",
		"target": {
			"locator": { "Fs": { "segments": [{ "Literal": "foo.ts" }] } },
			"query": null,
			"qualifier": null
		},
		"scope": "whole",
		"content": "x"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(
		result.is_err(),
		"SymbolTarget should require ::Symbol query segment via custom Deserialize"
	);
}

#[test]
fn symbol_target_rejects_uri_locator_via_deserialize() {
	let json = serde_json::json!({
		"kind": "symbolReplace",
		"target": {
			"locator": { "Uri": { "scheme": "memory", "path": "root" } },
			"query": {
				"head": { "axis": null, "head": { "Name": { "Raw": "Foo" } }, "predicates": [] },
				"chain": []
			},
			"qualifier": null
		},
		"scope": "whole",
		"content": "x"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_err(), "SymbolTarget should reject URI locator via custom Deserialize");
}

#[test]
fn symbol_target_accepts_valid_symbol_target_via_deserialize() {
	let json = serde_json::json!({
		"kind": "symbolReplace",
		"target": {
			"locator": { "Fs": { "segments": [{ "Literal": "test.rs" }] } },
			"query": {
				"head": { "axis": null, "head": { "Name": { "Raw": "Foo" } }, "predicates": [] },
				"chain": []
			},
			"qualifier": null
		},
		"scope": "whole",
		"content": "x"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_ok(), "SymbolTarget should accept valid FsLocator with ::Symbol query");
}

// ── CssTarget ────────────────────────────────────────────────────

#[test]
fn css_target_rejects_uri_locator_via_deserialize() {
	let json = serde_json::json!({
		"kind": "cssRenameClassToken",
		"target": {
			"locator": { "Uri": { "scheme": "memory", "path": "styles" } },
			"query": null,
			"qualifier": null
		},
		"find": ".old",
		"replace": ".new"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_err(), "CssTarget should reject URI locator via custom Deserialize");
}

#[test]
fn css_target_accepts_valid_fs_target_via_deserialize() {
	let json = serde_json::json!({
		"kind": "cssRenameClassToken",
		"target": {
			"locator": { "Fs": { "segments": [{ "Literal": "styles.css" }] } },
			"query": null,
			"qualifier": null
		},
		"find": ".old",
		"replace": ".new"
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_ok(), "CssTarget should accept valid FsLocator");
}

// ── HeadingTarget ────────────────────────────────────────────────

#[test]
fn heading_target_rejects_uri_locator_via_deserialize() {
	let json = serde_json::json!({
		"kind": "headingPromote",
		"target": {
			"locator": { "Uri": { "scheme": "memory", "path": "doc" } },
			"query": null,
			"qualifier": null
		}
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_err(), "HeadingTarget should reject URI locator via custom Deserialize");
}

#[test]
fn heading_target_accepts_valid_fs_target_via_deserialize() {
	let json = serde_json::json!({
		"kind": "headingPromote",
		"target": {
			"locator": { "Fs": { "segments": [{ "Literal": "doc.md" }] } },
			"query": null,
			"qualifier": null
		}
	});
	let result: Result<Op, _> = serde_json::from_value(json);
	assert!(result.is_ok(), "HeadingTarget should accept valid FsLocator");
}
