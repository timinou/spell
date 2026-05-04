use pi_code_path::{ast::Predicate, dialect::LanguageDialect};
use tree_sitter::Node;

/// Evaluate a simple predicate that does not require subquery evaluation.
///
/// Positional predicates (`Ordinal`, `Range`) are handled by the caller
/// after result-set collection.  `HasDescendant` / `HasAncestor` are also
/// handled by the walker so that it can supply a subquery evaluator.
pub fn eval(pred: &Predicate, node: &Node, src: &str, dialect: &LanguageDialect) -> bool {
	match pred {
		Predicate::Ordinal(_) | Predicate::Range { .. } => true,
		Predicate::KindFilter(kind) => node.kind() == kind.as_str(),
		Predicate::AnchorFilter(name) => dialect
			.anchors
			.iter()
			.any(|a| a.name == name.as_str() && (a.matcher)(node, src)),
		Predicate::Attribute { name, value } => {
			if name == "name" {
				if let Some(child) = node.child_by_field_name("name") {
					if let Some(text) = src.get(child.start_byte()..child.end_byte()) {
						if text == value.as_str() {
							return true;
						}
					}
				}
				if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
					if text == value.as_str() {
						return true;
					}
				}
				return false;
			}
			// v1: accept all non-"name" attributes.
			true
		},
		Predicate::TextMatch(pattern) => {
			// TODO: switch to real regex when regex is directly available.
			if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
				return text.contains(pattern.as_str());
			}
			false
		},
		Predicate::LiteralMatch(lit) => {
			if let Some(text) = src.get(node.start_byte()..node.end_byte()) {
				return text.contains(lit.as_str());
			}
			false
		},
		Predicate::Compare { .. } => false,
		Predicate::Flag(_) => true,
		Predicate::Length { .. } => false,
		Predicate::Count { .. } => false,
		Predicate::HasDescendant(_) | Predicate::HasAncestor(_) => {
			// Delegated to the walker which owns subquery evaluation.
			true
		},
	}
}
