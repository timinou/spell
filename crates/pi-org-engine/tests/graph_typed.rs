//! Integration tests for typed-edge graph traversal (FEAT-638).
//!
//! Tests cover `build_typed_graph`, `neighborhood`, `timeline`, and `path`.
//! All fixtures are constructed manually via `make_item` / `with_relations`
//! since the FEAT-631 RELATIONS parser may not be available yet.

use std::collections::HashMap;

use pi_org_engine::edge::EdgeKind;
use pi_org_engine::graph::{
	build_typed_graph, neighborhood, path, timeline, TypedGraphNode, TypedEdge,
};
use pi_org_engine::item::OrgItem;

// ── Helpers ─────────────────────────────────────────────────────

fn make_item(id: &str) -> OrgItem {
	OrgItem {
		id:         id.to_string(),
		title:      format!("Task {id}"),
		state:      "ITEM".to_string(),
		category:   "test".to_string(),
		dir:        "tasks".to_string(),
		file:       format!("/{id}.org"),
		line:       1,
		level:      1,
		properties: HashMap::new(),
		body:       None,
		clocks:     Vec::new(),
		byte_range: (0, 0),
		children:   Vec::new(),
		relations:  Vec::new(),
	}
}

fn with_relations(mut item: OrgItem, relations: Vec<(EdgeKind, &str)>) -> OrgItem {
	item.relations = relations
		.into_iter()
		.map(|(k, t)| (k, t.to_string()))
		.collect();
	item
}

fn with_property(mut item: OrgItem, key: &str, value: &str) -> OrgItem {
	item.properties.insert(key.to_string(), value.to_string());
	item
}

fn sorted_ids(nodes: &[TypedGraphNode]) -> Vec<String> {
	let mut ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
	ids.sort();
	ids
}

// ── Scenario 1 ──────────────────────────────────────────────────

#[test]
fn neighborhood_hops_1_returns_direct_targets() {
	let root = make_item("ROOT");
	let a = with_relations(make_item("A"), vec![(EdgeKind::Involved, "ROOT")]);
	let b = with_relations(make_item("B"), vec![(EdgeKind::Involved, "ROOT")]);
	let c = with_relations(make_item("C"), vec![(EdgeKind::Involved, "ROOT")]);
	let items = vec![root, a, b, c];

	let graph = build_typed_graph(&items);
	let sub = neighborhood(&graph, "ROOT", 1, &[]);

	assert_eq!(sub.nodes.len(), 4, "root + 3 targets = 4 nodes");
	assert_eq!(sub.edges.len(), 3, "3 Involved edges");
}

// ── Scenario 2 ──────────────────────────────────────────────────

#[test]
fn neighborhood_hops_2_follows_transitively() {
	let a = make_item("A");
	let b = with_relations(make_item("B"), vec![(EdgeKind::DerivedFrom, "A")]);
	let c = with_relations(make_item("C"), vec![(EdgeKind::DerivedFrom, "B")]);
	let items = vec![a, b, c];

	let graph = build_typed_graph(&items);
	let sub = neighborhood(&graph, "C", 2, &[]);

	let ids = sorted_ids(&sub.nodes);
	assert_eq!(ids, vec!["A", "B", "C"], "all 3 nodes reachable in 2 hops");
	assert_eq!(sub.edges.len(), 2, "C->B + B->A edges");
}

// ── Scenario 3 ──────────────────────────────────────────────────

#[test]
fn neighborhood_kind_filter_excludes_others() {
	let root = with_relations(make_item("ROOT"), vec![
		(EdgeKind::Involved, "A"),
		(EdgeKind::About, "B"),
		(EdgeKind::Involved, "C"),
	]);
	let a = make_item("A");
	let b = make_item("B");
	let c = make_item("C");
	let items = vec![root, a, b, c];

	let graph = build_typed_graph(&items);
	let sub = neighborhood(&graph, "ROOT", 1, &[EdgeKind::About]);

	assert_eq!(sub.nodes.len(), 2, "ROOT + B only (filtered to About)");
	assert_eq!(sub.edges.len(), 1, "1 About edge");
	assert!(sub.edges[0].kind == EdgeKind::About);
	assert_eq!(sub.edges[0].to, "B");
}

// ── Scenario 4 ──────────────────────────────────────────────────

#[test]
fn neighborhood_includes_inbound_and_outbound_by_default() {
	let a = with_relations(make_item("A"), vec![(EdgeKind::Blocks, "MID")]);
	let mid = with_relations(make_item("MID"), vec![(EdgeKind::Produced, "Z")]);
	let z = make_item("Z");
	let items = vec![a, mid, z];

	let graph = build_typed_graph(&items);
	let sub = neighborhood(&graph, "MID", 1, &[]);

	let ids = sorted_ids(&sub.nodes);
	assert_eq!(ids, vec!["A", "MID", "Z"], "MID + inbound A + outbound Z");
	assert_eq!(sub.edges.len(), 2, "A->MID + MID->Z");
}

// ── Scenario 5 ──────────────────────────────────────────────────

#[test]
fn timeline_orders_episodes_by_at_property() {
	let entity = make_item("EntityX");
	let ep1 = with_property(
		with_relations(make_item("EP-001"), vec![(EdgeKind::About, "EntityX")]),
		"AT",
		"2026-03-15T10:00:00",
	);
	let ep2 = with_property(
		with_relations(make_item("EP-002"), vec![(EdgeKind::About, "EntityX")]),
		"AT",
		"2025-12-01T08:30:00",
	);
	let ep3 = with_property(
		with_relations(make_item("EP-003"), vec![(EdgeKind::About, "EntityX")]),
		"AT",
		"2026-06-20T14:00:00",
	);
	let items = vec![entity, ep1, ep2, ep3];

	let tl = timeline(&items, "EntityX");

	assert_eq!(tl.len(), 3);
	assert_eq!(tl[0].item.id, "EP-002", "oldest first");
	assert_eq!(tl[1].item.id, "EP-001");
	assert_eq!(tl[2].item.id, "EP-003", "most recent last");
	assert!(tl[0].ts.unwrap() < tl[1].ts.unwrap());
	assert!(tl[1].ts.unwrap() < tl[2].ts.unwrap());
}

// ── Scenario 6 ──────────────────────────────────────────────────

#[test]
fn timeline_uses_created_at_when_at_missing() {
	let entity = make_item("EntityX");
	let ep1 = with_property(
		with_relations(make_item("EP-001"), vec![(EdgeKind::About, "EntityX")]),
		"CREATED",
		"2026-03-15",
	);
	let ep2 = with_property(
		with_relations(make_item("EP-002"), vec![(EdgeKind::About, "EntityX")]),
		"CREATED",
		"2026-01-10",
	);
	let items = vec![entity, ep1, ep2];

	let tl = timeline(&items, "EntityX");

	assert_eq!(tl.len(), 2);
	assert_eq!(tl[0].item.id, "EP-002", "older CREATED first");
	assert_eq!(tl[1].item.id, "EP-001");
}

// ── Scenario 7 ──────────────────────────────────────────────────

#[test]
fn path_finds_shortest_typed_chain() {
	let x = make_item("EntityX");
	let e = with_relations(make_item("EP-001"), vec![(EdgeKind::About, "EntityX")]);
	let c = with_relations(make_item("ConceptC"), vec![(EdgeKind::DistilledFrom, "EP-001")]);
	let items = vec![x, c, e];

	let graph = build_typed_graph(&items);
	let found = path(&graph, "ConceptC", "EntityX", &[]);

	assert!(found.is_some(), "path should exist");
	let p = found.unwrap();
	assert_eq!(p.edges.len(), 2, "ConceptC -> EP-001 -> EntityX");
	assert!(p.edges[0].kind == EdgeKind::DistilledFrom);
	assert!(p.edges[1].kind == EdgeKind::About);
	assert_eq!(p.edges[0].from, "ConceptC");
	assert_eq!(p.edges[0].to, "EP-001");
	assert_eq!(p.edges[1].to, "EntityX");
}

// ── Scenario 8 ──────────────────────────────────────────────────

#[test]
fn path_returns_none_when_disconnected() {
	let a = make_item("A");
	let b = make_item("B");
	let c = with_relations(make_item("C"), vec![(EdgeKind::About, "B")]);
	let items = vec![a, b, c];

	let graph = build_typed_graph(&items);
	let found = path(&graph, "A", "C", &[]);

	assert!(found.is_none(), "A and C are disconnected");
}

// ── Scenario 9 ──────────────────────────────────────────────────

#[test]
fn path_filter_excludes_disallowed_kinds() {
	let x = make_item("X");
	let m = with_relations(make_item("M"), vec![(EdgeKind::Mentions, "X")]);
	let a = with_relations(make_item("A"), vec![(EdgeKind::About, "M")]);
	let items = vec![x, m, a];

	let graph = build_typed_graph(&items);
	let found = path(&graph, "A", "X", &[EdgeKind::About]);

	assert!(found.is_none(), "Mentions edge excluded by filter -- no path");
}

// ── Scenario 10 ─────────────────────────────────────────────────

#[test]
fn cycle_in_about_edges_does_not_loop() {
	let a = with_relations(make_item("A"), vec![(EdgeKind::About, "B")]);
	let b = with_relations(make_item("B"), vec![(EdgeKind::About, "A")]);
	let items = vec![a, b];

	let graph = build_typed_graph(&items);
	let sub = neighborhood(&graph, "A", 10, &[]);

	let ids = sorted_ids(&sub.nodes);
	assert_eq!(ids, vec!["A", "B"], "cycle terminates at 2 nodes");
	assert_eq!(sub.edges.len(), 2, "A->B + B->A both present");
}

// ── Scenario 11 ─────────────────────────────────────────────────

#[test]
fn build_typed_graph_treats_legacy_blockers_as_blocks() {
	let mut item_a = make_item("TASK-A");
	item_a.properties.insert("CUSTOM_ID".to_string(), "TASK-A".to_string());
	let mut item_b = make_item("TASK-B");
	item_b.properties.insert("CUSTOM_ID".to_string(), "TASK-B".to_string());
	item_b.properties.insert("BLOCKERS".to_string(), "TASK-A".to_string());

	let item_c = with_relations(make_item("TASK-C"), vec![(EdgeKind::Blocks, "TASK-A")]);

	let items = vec![item_a, item_b, item_c];
	let graph = build_typed_graph(&items);

	let b_edges = graph.out_edges.get("TASK-B").unwrap();
	let c_edges = graph.out_edges.get("TASK-C").unwrap();
	assert!(
		b_edges.iter().any(|e| e.kind == EdgeKind::Blocks && e.to == "TASK-A"),
		"BLOCKERS property -> Blocks edge"
	);
	assert!(
		c_edges.iter().any(|e| e.kind == EdgeKind::Blocks && e.to == "TASK-A"),
		"RELATIONS BLOCKS -> Blocks edge"
	);
}

// ── Scenario 12 ─────────────────────────────────────────────────

#[test]
fn unknown_edge_kind_other_is_traversable() {
	let a = with_relations(make_item("A"), vec![
		(EdgeKind::Other("WHATEVER".to_string()), "B"),
	]);
	let b = make_item("B");
	let items = vec![a, b];

	let graph = build_typed_graph(&items);
	let sub = neighborhood(&graph, "A", 1, &[]);

	assert_eq!(sub.nodes.len(), 2, "A + B reachable via Other edge");
	assert_eq!(sub.edges.len(), 1);
	assert_eq!(sub.edges[0].kind, EdgeKind::Other("WHATEVER".to_string()));
}
