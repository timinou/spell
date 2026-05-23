//! Integration tests for introspection functions.
//!
//! Each test asserts the returned vec is non-empty, all entries are
//! well-formed (no empty strings in required fields), and counts match
//! expectations.

use pi_code_path::introspection::{
	DIAGNOSTIC_VARIANT_COUNT_MIN, EDGE_KIND_COUNT, OP_KIND_COUNT, QUALIFIER_COUNT_MIN,
	list_diagnostic_variants, list_edge_kinds, list_op_kinds, list_qualifiers,
};

#[test]
fn integration_list_op_kinds_31() {
	let kinds = list_op_kinds();
	assert_eq!(kinds.len(), OP_KIND_COUNT, "expected {OP_KIND_COUNT} op kinds");
	for info in &kinds {
		assert!(!info.kind.is_empty(), "kind must not be empty");
		assert!(!info.family.is_empty(), "family for {} must not be empty", info.kind);
		assert!(!info.target_shape.is_empty(), "target_shape for {} must not be empty", info.kind);
		for rf in &info.required_fields {
			assert!(!rf.is_empty(), "required field for {} must not be empty", info.kind);
		}
	}
}

#[test]
fn integration_list_qualifiers_8_plus() {
	let quals = list_qualifiers();
	assert!(!quals.is_empty(), "qualifier list must not be empty");
	assert!(
		quals.len() >= QUALIFIER_COUNT_MIN,
		"expected at least {QUALIFIER_COUNT_MIN} qualifiers, got {}",
		quals.len()
	);
	for q in &quals {
		assert!(!q.name.is_empty(), "qualifier name must not be empty");
		assert!(!q.applies_to.is_empty(), "applies_to for {} must not be empty", q.name);
	}
}

#[test]
fn integration_list_edge_kinds_5() {
	let edges = list_edge_kinds();
	assert_eq!(edges.len(), EDGE_KIND_COUNT, "expected {EDGE_KIND_COUNT} edge kinds");
	for e in &edges {
		assert!(!e.symbol.is_empty(), "symbol must not be empty");
		assert!(!e.name.is_empty(), "name must not be empty");
		assert!(!e.description.is_empty(), "description must not be empty");
	}
}

#[test]
fn integration_list_diagnostic_variants_19_plus() {
	let variants = list_diagnostic_variants();
	assert!(!variants.is_empty(), "diagnostic variant list must not be empty");
	assert!(
		variants.len() >= DIAGNOSTIC_VARIANT_COUNT_MIN,
		"expected at least {DIAGNOSTIC_VARIANT_COUNT_MIN} variants, got {}",
		variants.len()
	);
	for d in &variants {
		assert!(!d.variant.is_empty(), "variant name must not be empty");
		assert!(!d.template.is_empty(), "template for {} must not be empty", d.variant);
		assert!(
			d.severity == "error" || d.severity == "warning" || d.severity == "info",
			"severity for {} must be one of error/warning/info, got {}",
			d.variant,
			d.severity
		);
	}
}

/// Sanity: all four core functions return non-empty at once.
#[test]
fn integration_all_four_functions_work() {
	assert!(!list_op_kinds().is_empty());
	assert!(!list_qualifiers().is_empty());
	assert!(!list_edge_kinds().is_empty());
	assert!(!list_diagnostic_variants().is_empty());
}
