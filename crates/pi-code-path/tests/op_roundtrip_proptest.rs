//! Round-trip serialization test for each OpKind variant.
//! Ensures serde `tag = "kind", rename_all = "camelCase"` + field-level
//! renames produce JSON that TS codegen can emit and Rust can consume.

use pi_code_path::{ast::*, op::*};
use serde_json;
use strum::IntoEnumIterator;

fn bare_code_path() -> CodePath {
	CodePath {
		locator:   Locator::Fs(FsLocator {
			segments: vec![FsSegment::Literal("test.rs".to_string())],
		}),
		query:     None,
		qualifier: None,
	}
}

fn symbol_code_path() -> CodePath {
	CodePath {
		locator:   Locator::Fs(FsLocator {
			segments: vec![FsSegment::Literal("test.rs".to_string())],
		}),
		query:     Some(Query::single(Step {
			axis:       None,
			head:       Head::Name(NamePayload::Raw("Foo".to_string())),
			predicates: vec![],
		})),
		qualifier: None,
	}
}

/// Build a sample Op for every OpKind, covering edge cases.
fn sample_op(kind: OpKind) -> Op {
	let bare = bare_code_path();
	let sym = symbol_code_path();

	match kind {
		OpKind::FileCreate => Op::FileCreate {
			target:  FileTarget::new(bare).unwrap(),
			content: ActionContent::Single("hello".into()),
			force:   true,
		},
		OpKind::FileWrite => Op::FileWrite {
			target:  FileTarget::new(bare).unwrap(),
			content: ActionContent::Multi(vec!["a".into(), "b".into()]),
			force:   false,
		},
		OpKind::FileDelete => Op::FileDelete { target: FileTarget::new(bare).unwrap() },
		OpKind::FileAppend => Op::FileAppend {
			target:  FileTarget::new(bare).unwrap(),
			content: ActionContent::Single("appended".into()),
		},
		OpKind::FilePrepend => Op::FilePrepend {
			target:  FileTarget::new(bare).unwrap(),
			content: ActionContent::Single("prepended".into()),
		},
		OpKind::FilePatch => Op::FilePatch {
			target: FileTarget::new(bare).unwrap(),
			diff:   "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new".into(),
		},
		OpKind::FileFindReplace => Op::FileFindReplace {
			target:     FileTarget::new(bare).unwrap(),
			find:       ActionContent::Single("old".into()),
			content:    ActionContent::Single("new".into()),
			occurrence: Some(Occurrence::All),
		},
		OpKind::FileRawTextReplace => Op::FileRawTextReplace {
			target:     FileTarget::new(bare).unwrap(),
			find:       ActionContent::Single("foo".into()),
			content:    ActionContent::Single("bar".into()),
			occurrence: Some(Occurrence::Index(2)),
		},

		OpKind::LineReplace => Op::LineReplace {
			target:  FileTarget::new(bare).unwrap(),
			span:    LineSpan {
				start: LineAnchor { line: 5, hash: "AB".into() },
				end:   Some(LineAnchor { line: 10, hash: "CD".into() }),
			},
			content: ActionContent::Single("replacement".into()),
		},
		OpKind::LineInsert => Op::LineInsert {
			target:  FileTarget::new(bare).unwrap(),
			at:      LineAt::Before { anchor: LineAnchor { line: 3, hash: "EF".into() } },
			content: ActionContent::Multi(vec!["x".into(), "y".into()]),
		},
		OpKind::LineAppend => Op::LineAppend {
			target:  FileTarget::new(bare).unwrap(),
			at:      LineAnchor { line: 7, hash: "GH".into() },
			content: ActionContent::Single("tail".into()),
		},
		OpKind::LinePrepend => Op::LinePrepend {
			target:  FileTarget::new(bare).unwrap(),
			at:      LineAnchor { line: 1, hash: "IJ".into() },
			content: ActionContent::Single("head".into()),
		},

		OpKind::SymbolReplace => Op::SymbolReplace {
			target:  SymbolTarget::new(sym).unwrap(),
			scope:   SymScope::Whole,
			content: ActionContent::Single("new body".into()),
		},
		OpKind::SymbolRename => Op::SymbolRename {
			target:   SymbolTarget::new(sym).unwrap(),
			new_name: Identifier("Bar".into()),
		},
		OpKind::SymbolWrap => Op::SymbolWrap {
			target:  SymbolTarget::new(sym).unwrap(),
			content: ActionContent::Single("wrapper".into()),
		},
		OpKind::SymbolDelete => Op::SymbolDelete {
			target:               SymbolTarget::new(sym).unwrap(),
			allow_sibling_delete: true,
		},
		OpKind::SymbolInsertBefore => Op::SymbolInsertBefore {
			target:  SymbolTarget::new(sym).unwrap(),
			content: ActionContent::Single("before".into()),
		},
		OpKind::SymbolInsertAfter => Op::SymbolInsertAfter {
			target:  SymbolTarget::new(sym).unwrap(),
			content: ActionContent::Single("after".into()),
		},
		OpKind::SymbolFindReplace => Op::SymbolFindReplace {
			target:     SymbolTarget::new(sym).unwrap(),
			find:       ActionContent::Single("old".into()),
			content:    ActionContent::Single("new".into()),
			occurrence: Some(Occurrence::First),
		},
		OpKind::SymbolRawTextReplace => Op::SymbolRawTextReplace {
			target:     SymbolTarget::new(sym).unwrap(),
			find:       ActionContent::Single("old".into()),
			content:    ActionContent::Multi(vec!["new1".into(), "new2".into()]),
			occurrence: None,
		},
		OpKind::SymbolMove => {
			Op::SymbolMove { target: SymbolTarget::new(sym).unwrap(), direction: Direction::Down }
		},
		OpKind::SymbolClone => Op::SymbolClone {
			target:    SymbolTarget::new(sym).unwrap(),
			rename_to: Some(Identifier("Cloned".into())),
		},
		OpKind::SymbolSplice => {
			Op::SymbolSplice { target: SymbolTarget::new(sym).unwrap(), mode: SpliceMode::OnlySelf }
		},
		OpKind::SymbolTranspose => {
			Op::SymbolTranspose { target: SymbolTarget::new(sym).unwrap(), column: 3 }
		},

		OpKind::CssRenameClassToken => Op::CssRenameClassToken {
			target:  CssTarget::new(bare).unwrap(),
			find:    ".old-class".into(),
			replace: ".new-class".into(),
		},
		OpKind::CssRenameIdToken => Op::CssRenameIdToken {
			target:  CssTarget::new(bare).unwrap(),
			find:    "#old-id".into(),
			replace: "#new-id".into(),
		},
		OpKind::CssRenameCustomProp => Op::CssRenameCustomProp {
			target:  CssTarget::new(bare).unwrap(),
			find:    "--old".into(),
			replace: "--new".into(),
		},
		OpKind::CssRemoveDeadStyle => {
			Op::CssRemoveDeadStyle { target: CssTarget::new(bare).unwrap() }
		},

		OpKind::HeadingPromote => Op::HeadingPromote { target: HeadingTarget::new(bare).unwrap() },
		OpKind::HeadingDemote => Op::HeadingDemote { target: HeadingTarget::new(bare).unwrap() },
		OpKind::HeadingReplaceBlock => Op::HeadingReplaceBlock {
			target:  HeadingTarget::new(bare).unwrap(),
			content: ActionContent::Multi(vec!["new".into(), "block".into()]),
		},
	}
}

#[test]
fn all_op_kinds_roundtrip() {
	for kind in OpKind::iter() {
		let op = sample_op(kind);
		let json = serde_json::to_string(&op).unwrap_or_else(|e| panic!("serialize {kind:?}: {e}"));

		let deserialized: Op = serde_json::from_str(&json)
			.unwrap_or_else(|e| panic!("deserialize {kind:?}: {e}\nJSON: {json}"));

		assert_eq!(op, deserialized, "round-trip mismatch for {kind:?}\nJSON: {json}",);
	}
}

#[test]
fn action_content_single_roundtrip() {
	let c = ActionContent::Single("single line".into());
	let json = serde_json::to_string(&c).unwrap();
	let back: ActionContent = serde_json::from_str(&json).unwrap();
	assert_eq!(c, back);
	assert_eq!(json, r#""single line""#);
}

#[test]
fn action_content_multi_roundtrip() {
	let c = ActionContent::Multi(vec!["a".into(), "b".into()]);
	let json = serde_json::to_string(&c).unwrap();
	let back: ActionContent = serde_json::from_str(&json).unwrap();
	assert_eq!(c, back);
	assert_eq!(json, r#"["a","b"]"#);
}

#[test]
fn occurrence_all_roundtrip() {
	let o = Occurrence::All;
	let json = serde_json::to_string(&o).unwrap();
	let back: Occurrence = serde_json::from_str(&json).unwrap();
	assert_eq!(o, back);
	assert_eq!(json, r#""all""#);
}

#[test]
fn occurrence_index_roundtrip() {
	let o = Occurrence::Index(3);
	let json = serde_json::to_string(&o).unwrap();
	let back: Occurrence = serde_json::from_str(&json).unwrap();
	assert_eq!(o, back);
	assert_eq!(json, r#"3"#);
}

#[test]
fn symbol_clone_no_rename_roundtrip() {
	let sym = symbol_code_path();
	let op = Op::SymbolClone { target: SymbolTarget::new(sym).unwrap(), rename_to: None };
	let json = serde_json::to_string(&op).unwrap();
	let back: Op = serde_json::from_str(&json).unwrap();
	assert_eq!(op, back);
	// rename_to: None serializes as null (serde default)
	assert!(json.contains("renameTo"), "renameTo should be present in JSON: {json}");
}

#[test]
fn symbol_delete_no_sibling_roundtrip() {
	let sym = symbol_code_path();
	let op = Op::SymbolDelete {
		target:               SymbolTarget::new(sym).unwrap(),
		allow_sibling_delete: false,
	};
	let json = serde_json::to_string(&op).unwrap();
	let back: Op = serde_json::from_str(&json).unwrap();
	assert_eq!(op, back);
	// allow_sibling_delete: false serializes (serde default)
	assert!(
		json.contains("allowSiblingDelete"),
		"allowSiblingDelete should be present in JSON: {json}"
	);
}

#[test]
fn op_tag_field_is_camelcase() {
	// Verify the JSON tag uses camelCase variant names
	let op = Op::FileCreate {
		target:  FileTarget::new(bare_code_path()).unwrap(),
		content: ActionContent::Single("x".into()),
		force:   false,
	};
	let json = serde_json::to_string(&op).unwrap();
	let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
	let kind = parsed.get("kind").and_then(|v| v.as_str()).unwrap();
	assert_eq!(kind, "fileCreate", "tag should be camelCase: {json}");

	// Verify field renames work
	let rename = Op::SymbolRename {
		target:   SymbolTarget::new(symbol_code_path()).unwrap(),
		new_name: Identifier("Bar".into()),
	};
	let json2 = serde_json::to_string(&rename).unwrap();
	let parsed2: serde_json::Value = serde_json::from_str(&json2).unwrap();
	assert!(parsed2.get("newName").is_some(), "newName field should exist in JSON: {json2}");
	assert!(parsed2.get("new_name").is_none(), "new_name (snake) should NOT exist in JSON: {json2}");
}
