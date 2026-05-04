//! Set operations over NodeRef streams.
//!
//! Union, intersect, and except are keyed by `(locator, range)` so that
//! the same physical node is never counted twice.

use std::collections::HashSet;

use crate::types::NodeRef;

/// Unique key for a NodeRef.
fn node_key(n: &NodeRef) -> (String, std::ops::Range<usize>) {
	(n.locator.clone(), n.range.clone())
}

/// Dedup a stream of NodeRefs by canonical locator.
fn dedup(nodes: Vec<NodeRef>) -> Vec<NodeRef> {
	let mut seen = HashSet::new();
	let mut out = Vec::new();
	for n in nodes {
		let key = node_key(&n);
		if seen.insert(key) {
			out.push(n);
		}
	}
	out
}

/// Union of two NodeRef sets (deduped, order: A then B-new).
pub fn union(a: Vec<NodeRef>, b: Vec<NodeRef>) -> Vec<NodeRef> {
	let a = dedup(a);
	let b = dedup(b);
	let mut out = a;
	let mut seen: HashSet<_> = out.iter().map(node_key).collect();
	for n in b {
		let key = node_key(&n);
		if seen.insert(key) {
			out.push(n);
		}
	}
	out
}

/// Intersection of two NodeRef sets (preserve A order, keep present in B).
pub fn intersect(a: Vec<NodeRef>, b: Vec<NodeRef>) -> Vec<NodeRef> {
	let a = dedup(a);
	let b_set: HashSet<_> = dedup(b).iter().map(node_key).collect();
	a.into_iter()
		.filter(|n| b_set.contains(&node_key(n)))
		.collect()
}

/// Set difference A \ B (preserve A order, remove elements present in B).
pub fn except(a: Vec<NodeRef>, b: Vec<NodeRef>) -> Vec<NodeRef> {
	let a = dedup(a);
	let b_set: HashSet<_> = dedup(b).iter().map(node_key).collect();
	a.into_iter()
		.filter(|n| !b_set.contains(&node_key(n)))
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn mk_node(locator: &str, start: usize, end: usize) -> NodeRef {
		NodeRef {
			locator:     locator.to_string(),
			range:       start..end,
			kind:        "stub".to_string(),
			content:     None,
			metadata:    Default::default(),
			diagnostics: vec![],
		}
	}

	// ── basic properties ─────────────────────────────────────────

	#[test]
	fn union_basic() {
		let a = vec![mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("b", 0, 1), mk_node("c", 0, 1)];
		let u = union(a, b);
		assert_eq!(u.len(), 3);
		assert_eq!(u[0].locator, "a");
		assert_eq!(u[1].locator, "b");
		assert_eq!(u[2].locator, "c");
	}

	#[test]
	fn intersect_basic() {
		let a = vec![mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("b", 0, 1), mk_node("c", 0, 1)];
		let i = intersect(a, b);
		assert_eq!(i.len(), 1);
		assert_eq!(i[0].locator, "b");
	}

	#[test]
	fn except_basic() {
		let a = vec![mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("b", 0, 1)];
		let e = except(a, b);
		assert_eq!(e.len(), 1);
		assert_eq!(e[0].locator, "a");
	}

	// ── identity with empty ──────────────────────────────────────

	#[test]
	fn union_with_empty() {
		let a = vec![mk_node("a", 0, 1)];
		let u1 = union(a.clone(), vec![]);
		assert_eq!(u1.len(), 1);
		assert_eq!(u1[0].locator, "a");
		let u2 = union(vec![], a);
		assert_eq!(u2.len(), 1);
		assert_eq!(u2[0].locator, "a");
	}

	#[test]
	fn intersect_with_empty() {
		let a = vec![mk_node("a", 0, 1)];
		assert!(intersect(a, vec![]).is_empty());
		assert!(intersect(vec![], vec![mk_node("a", 0, 1)]).is_empty());
	}

	#[test]
	fn except_with_empty() {
		let a = vec![mk_node("a", 0, 1)];
		let e1 = except(a.clone(), vec![]);
		assert_eq!(e1.len(), 1);
		assert_eq!(e1[0].locator, "a");
		assert!(except(vec![], a).is_empty());
	}

	// ── commutativity ────────────────────────────────────────────

	#[test]
	fn union_commutative() {
		let a = vec![mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("c", 0, 1), mk_node("d", 0, 1)];
		let u1 = union(a.clone(), b.clone());
		let u2 = union(b, a);
		assert_eq!(u1.len(), u2.len());
		for n in &u1 {
			assert!(
				u2.iter()
					.any(|m| m.locator == n.locator && m.range == n.range)
			);
		}
	}

	#[test]
	fn intersect_commutative() {
		let a = vec![mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("b", 0, 1), mk_node("c", 0, 1)];
		let i1 = intersect(a.clone(), b.clone());
		let i2 = intersect(b, a);
		assert_eq!(i1.len(), i2.len());
		for n in &i1 {
			assert!(
				i2.iter()
					.any(|m| m.locator == n.locator && m.range == n.range)
			);
		}
	}

	// ── associativity (3-set) ────────────────────────────────────

	#[test]
	fn union_associative() {
		let a = vec![mk_node("a", 0, 1)];
		let b = vec![mk_node("b", 0, 1)];
		let c = vec![mk_node("c", 0, 1)];
		let left = union(union(a.clone(), b.clone()), c.clone());
		let right = union(a, union(b, c));
		assert_eq!(left.len(), right.len());
		for n in &left {
			assert!(
				right
					.iter()
					.any(|m| m.locator == n.locator && m.range == n.range)
			);
		}
	}

	#[test]
	fn intersect_associative() {
		let a = vec![mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("b", 0, 1), mk_node("c", 0, 1)];
		let c = vec![mk_node("b", 0, 1), mk_node("d", 0, 1)];
		let left = intersect(intersect(a.clone(), b.clone()), c.clone());
		let right = intersect(a, intersect(b, c));
		assert_eq!(left.len(), right.len());
		assert_eq!(left.len(), 1);
		assert_eq!(left[0].locator, "b");
	}

	// ── internal duplicates ──────────────────────────────────────

	#[test]
	fn dedup_inside_one_input() {
		let a = vec![mk_node("a", 0, 1), mk_node("a", 0, 1)];
		let b = vec![mk_node("b", 0, 1)];
		let u = union(a, b);
		assert_eq!(u.len(), 2);
	}

	#[test]
	fn except_with_internal_duplicates() {
		let a = vec![mk_node("a", 0, 1), mk_node("a", 0, 1), mk_node("b", 0, 1)];
		let b = vec![mk_node("a", 0, 1)];
		let e = except(a, b);
		assert_eq!(e.len(), 1);
		assert_eq!(e[0].locator, "b");
	}

	// ── range distinguishes nodes ────────────────────────────────

	#[test]
	fn same_locator_different_range() {
		let a = vec![mk_node("x", 0, 5)];
		let b = vec![mk_node("x", 5, 10)];
		let u = union(a.clone(), b.clone());
		assert_eq!(u.len(), 2);
		let i = intersect(a.clone(), b.clone());
		assert!(i.is_empty());
		let e = except(a, b);
		assert_eq!(e.len(), 1);
	}
}
