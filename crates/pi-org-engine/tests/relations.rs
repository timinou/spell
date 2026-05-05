//! Integration tests for `:RELATIONS:` drawer parsing and legacy BLOCKERS
//! bridge.
//!
//! These tests drive the parser via `extract_items_from_source()`, which
//! exercises both the tree-sitter path (level-1 headings) and the text-based
//! fallback path (level-2+ headings).

use pi_org_engine::{buffer::extract_items_from_source, edge::EdgeKind};

const TODO: &[&str] = &["ITEM", "DOING", "DONE"];

fn extract(source: &str) -> Vec<pi_org_engine::item::OrgItem> {
	extract_items_from_source(source, TODO, "test", "dir", "/test.org", false).unwrap()
}

fn relations_of(source: &str) -> Vec<(EdgeKind, String)> {
	let items = extract(source);
	assert_eq!(items.len(), 1, "expected exactly one item");
	items[0].relations.clone()
}

// ── 1: Single relation line ──────────────────────────────────────────────

#[test]
fn parses_single_relation_line() {
	let src = concat!("* ITEM Test\n", ":RELATIONS:\n", "INVOLVED: ACT-x\n", ":END:\n",);
	let rels = relations_of(src);
	assert_eq!(rels, vec![(EdgeKind::Involved, "ACT-x".into())]);
}

// ── 2: Multi-value same kind ─────────────────────────────────────────────

#[test]
fn parses_multi_value_same_kind() {
	let src = concat!(
		"* ITEM Test\n",
		":RELATIONS:\n",
		"ABOUT: ENT-article-a1b2\n",
		"ABOUT: ENT-company-acme\n",
		":END:\n",
	);
	let rels = relations_of(src);
	assert_eq!(rels, vec![
		(EdgeKind::About, "ENT-article-a1b2".into()),
		(EdgeKind::About, "ENT-company-acme".into()),
	]);
}

// ── 3: Drawer after PROPERTIES ───────────────────────────────────────────

#[test]
fn parses_drawer_after_properties() {
	let src = concat!(
		"* ITEM Test\n",
		":PROPERTIES:\n",
		":CUSTOM_ID: T-001\n",
		":END:\n",
		":RELATIONS:\n",
		"PRODUCED: ART-tool-log-42\n",
		":END:\n",
	);
	let items = extract(src);
	assert_eq!(items.len(), 1);
	assert_eq!(items[0].relations, vec![(EdgeKind::Produced, "ART-tool-log-42".into())]);
	assert_eq!(items[0].property("CUSTOM_ID"), Some("T-001"));
}

// ── 4: Drawer before PROPERTIES ──────────────────────────────────────────

#[test]
fn parses_drawer_before_properties() {
	// PROPERTIES first (idiomatic), then RELATIONS — tree-sitter only
	// recognizes property_drawer when it's the first drawer after headline.
	let src = concat!(
		"* ITEM Test
",
		":PROPERTIES:
",
		":CUSTOM_ID: T-002
",
		":END:
",
		":RELATIONS:
",
		"DISTILLED_FROM: EP-01HX7Q
",
		":END:
",
	);
	let items = extract(src);
	assert_eq!(items.len(), 1);
	assert_eq!(items[0].relations, vec![(EdgeKind::DistilledFrom, "EP-01HX7Q".into())]);
	assert_eq!(items[0].property("CUSTOM_ID"), Some("T-002"));
}
#[test]
fn legacy_blockers_property_synthesizes_blocks_edges() {
	let src = concat!(
		"* ITEM Test\n",
		":PROPERTIES:\n",
		":CUSTOM_ID: T-003\n",
		":BLOCKERS: x y z\n",
		":END:\n",
	);
	let rels = relations_of(src);
	assert_eq!(rels, vec![
		(EdgeKind::Blocks, "x".into()),
		(EdgeKind::Blocks, "y".into()),
		(EdgeKind::Blocks, "z".into()),
	]);
}

// ── 6: Preserve original BLOCKERS property ───────────────────────────────

#[test]
fn preserves_original_blockers_property() {
	let src = concat!(
		"* ITEM Test\n",
		":PROPERTIES:\n",
		":CUSTOM_ID: T-004\n",
		":BLOCKERS: a b c\n",
		":END:\n",
	);
	let items = extract(src);
	assert_eq!(items[0].property("BLOCKERS"), Some("a b c"));
	assert_eq!(items[0].relations.len(), 3);
}

// ── 7: Unknown kind → EdgeKind::Other ────────────────────────────────────

#[test]
fn unknown_edge_kind_becomes_other() {
	let src = concat!("* ITEM Test\n", ":RELATIONS:\n", "FOO_BAR: x\n", ":END:\n",);
	let rels = relations_of(src);
	assert_eq!(rels.len(), 1);
	match &rels[0] {
		(EdgeKind::Other(k), t) => {
			assert_eq!(k, "FOO_BAR");
			assert_eq!(t, "x");
		},
		other => panic!("expected Other, got {other:?}"),
	}
}

// ── 8: Empty drawer → empty Vec ──────────────────────────────────────────

#[test]
fn empty_drawer_yields_empty_relations() {
	let src = concat!("* ITEM Test\n", ":RELATIONS:\n", ":END:\n",);
	let rels = relations_of(src);
	assert!(rels.is_empty());
}

// ── 9: Malformed line skipped ─────────────────────────────────────────────

#[test]
fn malformed_line_skipped() {
	let src = concat!(
		"* ITEM Test\n",
		":RELATIONS:\n",
		"INVOLVED: ACT-x\n",
		"no-colon-here\n",
		"MENTIONS: ENT-z\n",
		":END:\n",
	);
	let rels = relations_of(src);
	assert_eq!(rels, vec![
		(EdgeKind::Involved, "ACT-x".into()),
		(EdgeKind::Mentions, "ENT-z".into()),
	]);
}

// ── 10: Nested level-2 inherits nothing ──────────────────────────────────

#[test]
fn nested_level_2_inherits_nothing() {
	let src = concat!(
		"* ITEM Parent\n",
		":RELATIONS:\n",
		"INVOLVED: ACT-parent\n",
		":END:\n",
		"** ITEM Child\n",
		":RELATIONS:\n",
		"ABOUT: ENT-child\n",
		":END:\n",
	);
	let items = extract(src);
	assert_eq!(items.len(), 2, "should have 2 flat items");

	let parent = items.iter().find(|i| i.title == "Parent").unwrap();
	assert_eq!(parent.relations, vec![(EdgeKind::Involved, "ACT-parent".into())]);

	let child = items.iter().find(|i| i.title == "Child").unwrap();
	assert_eq!(child.relations, vec![(EdgeKind::About, "ENT-child".into())]);
}

// ── 11: Round-trip via extract_items_from_source ─────────────────────────

#[test]
fn round_trip_via_extract_items_from_source() {
	// Both level-1 (tree-sitter path) and level-2 (text path) with RELATIONS.
	let src = concat!(
		"* ITEM L1\n",
		":RELATIONS:\n",
		"INVOLVED: ACT-one\n",
		":END:\n",
		"** ITEM L2\n",
		":RELATIONS:\n",
		"INVOLVED: ACT-two\n",
		":END:\n",
	);
	let items = extract(src);
	assert_eq!(items.len(), 2);

	let l1 = items.iter().find(|i| i.title == "L1").unwrap();
	assert_eq!(l1.relations, vec![(EdgeKind::Involved, "ACT-one".into())]);

	let l2 = items.iter().find(|i| i.title == "L2").unwrap();
	assert_eq!(l2.relations, vec![(EdgeKind::Involved, "ACT-two".into())]);
}

// ── 12: [[id:…]] wrapper normalized ──────────────────────────────────────

#[test]
fn target_id_with_double_bracket_normalized() {
	let src = concat!("* ITEM Test\n", ":RELATIONS:\n", "ABOUT: [[id:ENT-x]]\n", ":END:\n",);
	let rels = relations_of(src);
	assert_eq!(rels, vec![(EdgeKind::About, "ENT-x".into())]);
}
